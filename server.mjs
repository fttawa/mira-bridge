#!/usr/bin/env node
/**
 * mira-bridge — 把本机 mirasim-router 包装成 OpenAI 兼容 API
 *
 *   公网子域 → Cloudflare Tunnel → 本服务 → mirasim-router → relay.mirasim.ai
 *
 * 职责：
 *   1. API key 校验（本地生成，常量时间比对）
 *   2. OpenAI /v1/chat/completions ⇄ Anthropic /v1/messages 协议转换（含流式、工具调用、图片）
 *   3. 动态发现 mirasim-router 端口（端口跨重启会变，不能写死）
 *
 * 零外部依赖，仅用 Node 内置模块。要求 Node >= 18。
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 启动日志自己写文件，不靠 shell 重定向 ───────────────────────────────────
// 原先由 start-8787.cmd 用 `>> bridge.task.log 2>&1` 接管 stdout/stderr：
// cmd 会**一直占着这个文件句柄**，于是任何"再起一个实例"的尝试连日志都打不开
// （实测 2026-09-26：看门狗拉起的实例因此静默失败，日志也永远停在旧内容）。
// 改成自己 appendFileSync：每次写完就关，多实例/看门狗并存都不冲突。
const LOG_PATH = process.env.BRIDGE_LOG_FILE || path.join(__dirname, 'bridge.task.log');
const appendLog = (line) => { try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch { /* 日志失败不影响服务 */ } };
for (const method of ['log', 'warn', 'error']) {
  const orig = console[method].bind(console);
  console[method] = (...args) => {
    const line = args.map((a) => (typeof a === 'string' ? a : (a?.stack ?? String(a)))).join(' ');
    orig(line);
    appendLog(line);
  };
}

// ── 出站代理（默认走本机 Clash Verge 的混合端口）────────────────────────────
// Node 的 fetch 默认**不看系统代理**；要走代理必须在进程启动时带
// NODE_USE_ENV_PROXY=1（Node 24 起支持，读 HTTP_PROXY/HTTPS_PROXY/NO_PROXY）。
// 该开关在 bootstrap 阶段生效，脚本里再设已经晚了 —— 所以这里发现没生效就
// 用同样的参数把自己重启一次（父进程退化成薄壳，Ctrl+C 会一起收到）。
const PROXY_URL = (process.env.BRIDGE_PROXY ?? 'http://127.0.0.1:7897').trim();
const PROXY_WANTED = !!PROXY_URL && PROXY_URL !== '0' && PROXY_URL.toLowerCase() !== 'off';
const PROXY_ACTIVE = process.env.NODE_USE_ENV_PROXY === '1' && !!(process.env.HTTPS_PROXY || process.env.HTTP_PROXY);
const NO_PROXY = process.env.BRIDGE_NO_PROXY || '127.0.0.1,localhost,::1';
if (PROXY_WANTED && !PROXY_ACTIVE && process.env.BRIDGE_PROXY_REEXEC !== '1') {
  console.log(`[bridge] 出站代理未生效，带 NODE_USE_ENV_PROXY=1 重启自身 → ${PROXY_URL}`);
  const child = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      NODE_USE_ENV_PROXY: '1',
      HTTP_PROXY: PROXY_URL,
      HTTPS_PROXY: PROXY_URL,
      NO_PROXY,
      BRIDGE_PROXY_REEXEC: '1',
    },
  });
  process.exit(child.status ?? 1);
}

// ── 配置 ────────────────────────────────────────────────────────────────
const PORT = Number(process.env.BRIDGE_PORT || 8787);
const HOST = process.env.BRIDGE_HOST || '127.0.0.1'; // 只听本地，公网暴露交给 tunnel
const KEY_FILE = path.join(__dirname, '.api-key');
const DEFAULT_MAX_TOKENS = Number(process.env.BRIDGE_DEFAULT_MAX_TOKENS || 8192);
// ── 上游客户端指纹：尽量与官方客户端一致 ──────────────────────────────────
// mirasim-router 校验调用方 UA（实测 2026-08-24）：不带 UA 或 UA 不以
// `mirasim/<数字>` 开头一律 403 "this client is not supported"。
// 官方的版本号是内置常量（server.cjs 0.0.362 里 q9() → '0.0.362'，可被 MIRASIM_APP_VERSION 覆盖）。
// 这里默认对齐官方版本而非写死 1.0.0：即使上游将来校验版本区间，也落在合法区间内。
const APP_VERSION = process.env.MIRASIM_APP_VERSION || process.env.BRIDGE_APP_VERSION || '0.0.362';
const UPSTREAM_UA = process.env.BRIDGE_UPSTREAM_UA || `Mirasim/${APP_VERSION}`;

// 官方 CLI 发往 router 的完整身份头（逆向 server.cjs 的 interceptor 装配段还原）：
//   x-mirasim-session  = 'mirasim_' + randomUUID()   （EEs()）
//   x-mirasim-agent    = agent 名（claude / codex 等）
//   x-mirasim-device   = ~/.mirasim/device.json 里的 deviceId（bM() 读取/生成）
//   x-mirasim-account  = accountId（仅登录后；bridge 不代持账号）
//   x-mirasim-client   = uk() → 内置版本号
//   x-mirasim-locale   = LOCALE env || Intl 区域
//   x-mirasim-collect  = 遥测开关，关闭时发 'off'
// router 目前只校验 UA，这些头全部无害；带上它们让请求形态与官方客户端一致。
// BRIDGE_CLIENT_FINGERPRINT=0 可整体关闭。
const CLIENT_FINGERPRINT = process.env.BRIDGE_CLIENT_FINGERPRINT !== '0';
const CLIENT_DEVICE = process.env.BRIDGE_CLIENT_DEVICE || null;
const CLIENT_LOCALE = process.env.BRIDGE_CLIENT_LOCALE || null;
const CLIENT_AGENT = process.env.BRIDGE_CLIENT_AGENT || null;
// 默认为官方客户端的遥测形态：显式声明关闭（官方不开遥测时也发 'off'）
const CLIENT_COLLECT = process.env.BRIDGE_CLIENT_COLLECT || 'off';

// 设备号解析优先级：
//   1) BRIDGE_CLIENT_DEVICE 显式指定
//   2) 官方桌面端 ~/.mirasim/device.json —— 与官方客户端共用同一设备身份，
//      relay 看到的 deviceId 与桌面端完全一致（这是「更像官方」的关键一跳）
//   3) 项目内 .device-id 兜底
const MIRASIM_HOME = process.env.MIRASIM_HOME
  || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.mirasim') : null);

function resolveDeviceId() {
  if (CLIENT_DEVICE) return CLIENT_DEVICE;
  // 读官方 device.json（失败/不存在就落到项目兜底）
  if (MIRASIM_HOME) {
    try {
      const dj = JSON.parse(fs.readFileSync(path.join(MIRASIM_HOME, 'device.json'), 'utf8'));
      if (typeof dj.deviceId === 'string' && dj.deviceId.trim()) return dj.deviceId.trim();
    } catch { /* 官方桌面端没跑过或文件格式不同，走兜底 */ }
  }
  try {
    const dk = path.join(__dirname, '.device-id');
    let d = '';
    try { d = fs.readFileSync(dk, 'utf8').trim(); } catch { /* 首运行，下面生成 */ }
    if (!/^[0-9a-f]{16,64}$/i.test(d)) {
      d = crypto.randomBytes(16).toString('hex');
      fs.writeFileSync(dk, d + '\n', { mode: 0o600 });
    }
    return d;
  } catch { return null; }
}
const BRIDGE_DEVICE_ID = resolveDeviceId();

/** 官方客户端指纹头。全部可选，只在配置开启时加上，避免污染请求 */
function clientFingerprintHeaders() {
  if (!CLIENT_FINGERPRINT) return {};
  const h = { 'x-mirasim-client': APP_VERSION };
  // session：官方格式 'mirasim_' + UUID，每次调用一个新 session（EEs() 同构）
  h['x-mirasim-session'] = 'mirasim_' + crypto.randomUUID();
  if (BRIDGE_DEVICE_ID) h['x-mirasim-device'] = BRIDGE_DEVICE_ID;
  if (CLIENT_LOCALE) h['x-mirasim-locale'] = CLIENT_LOCALE;
  if (CLIENT_AGENT) h['x-mirasim-agent'] = CLIENT_AGENT;
  if (CLIENT_COLLECT) h['x-mirasim-collect'] = CLIENT_COLLECT;
  return h;
}
// 模型清单：优先读官方 roster 缓存（~/.mirasim/setting.json 的 modelRosterCache，
// 桌面端每次启动/定时拉取，含 label、上下文窗口、maxOutput、定价），跟着官方走。
// 读不到才用下面的静态兜底（2026-09-24.v6 的实测可用族）。
const ROSTER_TTL_MS = Number(process.env.BRIDGE_ROSTER_TTL_MS || 300_000);
const FALLBACK_MODELS = [
  { id: 'claude-opus-5-5', label: 'opus 5.5', contextWindow: 1_000_000, maxOutput: 128_000, agent: 'claude' },
  { id: 'claude-opus-5', label: 'opus 5', contextWindow: 1_000_000, maxOutput: 128_000, agent: 'claude' },
  { id: 'claude-sonnet-5', label: 'sonnet 5', contextWindow: 1_000_000, maxOutput: 128_000, agent: 'claude' },
  { id: 'claude-opus-4-8', label: 'opus 4.8', contextWindow: 1_000_000, maxOutput: 128_000, agent: 'claude' },
  { id: 'claude-fable-5-1', label: 'fable 5.1', contextWindow: 1_000_000, maxOutput: 128_000, agent: 'claude' },
  { id: 'claude-fable-5', label: 'fable 5', contextWindow: 1_000_000, maxOutput: 128_000, agent: 'claude' },
  { id: 'gpt-6-sol', label: 'gpt-6-sol', contextWindow: 872_000, maxOutput: 128_000, agent: 'codex' },
  { id: 'gpt-6-astra', label: 'gpt-6-astra', contextWindow: 872_000, maxOutput: 128_000, agent: 'codex' },
  { id: 'gpt-6-luna', label: 'gpt-6-luna', contextWindow: 872_000, maxOutput: 128_000, agent: 'codex' },
  { id: 'gpt-5.6-sol', label: 'gpt-5.6-sol', contextWindow: 872_000, maxOutput: 128_000, agent: 'codex' },
  { id: 'gpt-5.6-terra', label: 'gpt-5.6-terra', contextWindow: 872_000, maxOutput: 128_000, agent: 'codex' },
  { id: 'gpt-5.6-luna', label: 'gpt-5.6-luna', contextWindow: 872_000, maxOutput: 128_000, agent: 'codex' },
  { id: 'deepseek-flash', label: 'v4.1-flash', contextWindow: 1_000_000, maxOutput: 384_000, agent: 'dsh' },
  { id: 'glm-5.3-flash', label: 'glm 5.3 flash', contextWindow: null, maxOutput: null, agent: 'glm' },
  { id: 'kimi-k3', label: 'k3', contextWindow: null, maxOutput: null, agent: 'kimi' },
];
// 官方 roster 的 agents 列表之外的可用模型（2026-09-25 实测 relay 200）。
// 定价表里出现但探不通的不列：claude-haiku-4-5（503 no upstream）、kimi-code/k3（422 名字不对）。
const EXTRA_RELAY_MODELS = [
  { id: 'glm-5.3-flash', label: 'glm 5.3 flash', agent: 'glm' },
  { id: 'kimi-k3', label: 'k3', agent: 'kimi' },
];
let rosterCache = { at: 0, models: null };
/** 官方 roster（跟随桌面端）。返回 [{id,label,contextWindow,maxOutput,agent,effort,pricing}]。 */
function loadRoster() {
  const now = Date.now();
  if (rosterCache.models && now - rosterCache.at < ROSTER_TTL_MS) return rosterCache.models;
  let models = null;
  try {
    const st = JSON.parse(fs.readFileSync(path.join(MIRASIM_HOME, 'setting.json'), 'utf8'));
    const agents = st?.modelRosterCache?.agents;
    if (agents && typeof agents === 'object') {
      const meta = st?.modelRosterCache?.models ?? {};
      models = [];
      for (const [agent, list] of Object.entries(agents)) {
        if (!Array.isArray(list)) continue;
        for (const m of list) {
          if (!m?.id) continue;
          models.push({
            id: m.id, label: m.label ?? m.id, agent,
            contextWindow: m.contextWindow ?? null, maxOutput: m.maxOutput ?? null,
            adaptive: !!m.adaptive, effort: meta[m.id]?.effort ?? null,
            pricing: meta[m.id]?.pricing ?? null, // $/百万 token，用于成本估算
          });
        }
      }
    }
  } catch { /* 无 roster：用静态兜底 */ }
  if (models?.length) {
    // roster 之外还有能用的：合并进来（已存在的 id 不重复）
    const have = new Set(models.map((m) => m.id));
    for (const m of EXTRA_RELAY_MODELS) if (!have.has(m.id)) models.push({ ...m, source: 'extra' });
  }
  rosterCache = { at: now, models: models?.length ? models : null };
  return rosterCache.models;
}
/** 取某模型的定价（$/百万 token）；roster 里没有就返回 null。 */
function pricingFor(model) {
  const list = loadRoster() ?? FALLBACK_MODELS;
  const hit = list.find((m) => m.id === model);
  return hit?.pricing ?? null;
}
// relay 是统一网关：claude / codex / dsh / glm / kimi 各族的 agent 共用 /v1/messages，
// 由 x-mirasim-agent 决定上游族（2026-09-25 实测：claude-* / gpt-6-* / gpt-5.6-* /
// deepseek-flash / glm-5.3-flash / kimi-k3 全 200）。探不通的不暴露：
// kimi-code/k3（roster 里的名字，relay 回 422）、claude-haiku-4-5（503 no upstream）。
const MODEL_FILTER = process.env.BRIDGE_MODEL_FILTER ?? '^(claude-|gpt-|deepseek-|glm-|kimi-k3)';
// 模型黑名单：命中的直接拒绝，不发往上游，也不出现在 /v1/models。
// fable-5 单价明显高于其它模型，默认禁用。设为空串可放行全部。
const BLOCKED_RE = process.env.BRIDGE_BLOCKED_MODELS ?? 'fable';
const isBlocked = (model) => !!BLOCKED_RE && new RegExp(BLOCKED_RE).test(model ?? '');
// 模型名归一化：
//   1. relay 只认连字符版本（claude-opus-4-8），不认点号别名（claude-opus-4.8）
//   2. relay 明确拒绝带 [1m] 的窗口后缀（实测 422 model "claude-opus-5[1m]" is not
//      supported at this time）——官方客户端把后缀剥掉后才上行，这里同样剥掉。
const normalizeModel = (model) => {
  if (typeof model !== 'string') return model;
  return model
    .replace(/\[1m\]$/i, '')
    .replace(/^claude-(opus|sonnet|haiku)-(\d+)\.(\d+)$/i, 'claude-$1-$2-$3');
};
// 固定端口提示：优先探测这个，探不到再全量扫描
const PORT_HINT = Number(process.env.BRIDGE_ROUTER_PORT || 0);

// ── API key：不存在则生成 ────────────────────────────────────────────────
function loadOrCreateKey() {
  if (process.env.BRIDGE_API_KEY) return process.env.BRIDGE_API_KEY.trim();
  try {
    const k = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (k) return k;
  } catch { /* 首次运行，落到下面生成 */ }
  const key = 'sk-mira-' + crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(KEY_FILE, key + '\n', { mode: 0o600 });
  console.log(`[bridge] 已生成新 API key → ${KEY_FILE}`);
  return key;
}
const API_KEY = loadOrCreateKey();

/** 常量时间比对，避免通过响应耗时逐字节爆破 key */
function keyMatches(presented) {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(API_KEY);
  if (a.length !== b.length) return false; // 长度本身会泄露，但 key 长度固定，可接受
  return crypto.timingSafeEqual(a, b);
}

// ── 上游发现：mirasim-router 端口跨重启会变 ──────────────────────────────
let cachedPort = PORT_HINT || null;
let cachedAt = 0;
// 负缓存：全扫没找到 router 的时间点，TTL 内直接报未找到，避免 Mira 休眠时每请求全扫
let alreadyScanned = false;
let alreadyScannedAt = 0;
// 探测超时不能太短：上游繁忙时 /v1/models 也会变慢，1~2 秒很容易误判成「router 没了」
const PROBE_TIMEOUT = Number(process.env.BRIDGE_PROBE_TIMEOUT_MS || 5000);
// 缓存有效期内不再探测，详见 routerPort() 的说明
const PROBE_TTL = Number(process.env.BRIDGE_PROBE_TTL_MS || 30_000);

async function probe(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT),
    });
    if (!r.ok) return false;
    const j = await r.json();
    return Array.isArray(j?.data) && j.data.some((m) => m.owned_by === 'mirasim-router');
  } catch {
    return false;
  }
}

/** 让下一次 routerPort() 重新发现（实际请求遇到连接错误时调用） */
function invalidatePort() {
  cachedPort = null;
  cachedAt = 0;
  alreadyScanned = false;
  alreadyScannedAt = 0;
}

/** 枚举本机 LISTENING 的回环端口 */
async function localListeningPorts() {
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano'], { maxBuffer: 8 << 20 });
    const ports = new Set();
    for (const line of stdout.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const m = line.match(/127\.0\.0\.1:(\d+)/);
      if (m) ports.add(Number(m[1]));
    }
    return [...ports];
  } catch {
    // netstat 拿不到（受控环境禁止 spawn）时退化为纯 Node 的端口扫描，
    // 零依赖、不出子进程，结果一致。并发扫描回环端口很快。
    const open = [];
    let next = 1024; // 高位端口才可能是 router；低位是系统服务，扫过去纯浪费
    const CONC = 256;
    await Promise.all(Array.from({ length: CONC }, async () => {
      while (true) {
        const p = next++;
        if (p > 65535) break;
        const ok = await new Promise((res) => {
          const s = net.connect({ host: '127.0.0.1', port: p, timeout: 400 });
          s.once('connect', () => { s.destroy(); res(true); });
          s.once('error', () => res(false));
          s.once('timeout', () => { s.destroy(); res(false); });
        });
        if (ok) open.push(p);
      }
    }));
    return open;
  }
}

async function routerPort({ force = false } = {}) {
  // 缓存期内直接返回，不做探测。
  // 早期实现是每个请求都先 probe 一次，代价有两重：上游请求数直接翻倍；
  // 且上游繁忙时探测自身会超时，被误判成「router 不见了」，进而全端口扫描 → 503。
  // 并发一高就必现。端口真变了由 invalidatePort() 或 TTL 到期来兜。
  if (!force && cachedPort && Date.now() - cachedAt < PROBE_TTL) return cachedPort;
  // 负缓存：上次没找到 router 时，TTL 内直接报未找到，不再全端口重扫。
  // （Mira 休眠时每个请求都全扫一次是明显的首字延迟来源。）
  if (!force && alreadyScanned && Date.now() - alreadyScannedAt < PROBE_TTL) {
    throw new Error('未找到 mirasim-router，请确认 Mirasim 桌面端正在运行');
  }

  if (cachedPort && (await probe(cachedPort))) {
    cachedAt = Date.now();
    return cachedPort;
  }

  cachedPort = null;
  const ports = await localListeningPorts();
  // 并发探测，取第一个应答的
  const hits = await Promise.all(ports.map(async (p) => ((await probe(p)) ? p : 0)));
  const found = hits.find(Boolean);
  if (!found) {
    // 负缓存命中路径：记录本次全扫时间，TTL 内直接复用「未找到」结论
    alreadyScanned = true;
    alreadyScannedAt = Date.now();
    throw new Error('未找到 mirasim-router，请确认 Mirasim 桌面端正在运行');
  }
  alreadyScanned = false;
  cachedPort = found;
  cachedAt = Date.now();
  console.log(`[bridge] 发现 mirasim-router → 127.0.0.1:${found}`);
  return found;
}

// ── OpenAI → Anthropic：请求体转换 ──────────────────────────────────────

// 哪些模型接受采样参数（temperature / top_p / top_k）。
// 实测只有 haiku 接受；其余均为推理模型，带任一采样参数即 400。
// 用正则而非硬编码列表，新模型上线时改环境变量即可，不必动代码。
const SAMPLING_MODELS = new RegExp(process.env.BRIDGE_SAMPLING_MODELS || 'haiku');
const acceptsSampling = (model) => SAMPLING_MODELS.test(model ?? '');
const hasSampling = (r) => r.temperature != null || r.top_p != null || r.top_k != null;

// 实测这两组模型完全重合：不接受采样参数的，正是启用了 extended thinking 的推理模型。
// 分成两个名字是因为它们约束的是不同的东西（采样参数 vs max_tokens 语义）。
const isReasoningModel = (model) => !acceptsSampling(model);
const THINKING_RESERVE = Number(process.env.BRIDGE_THINKING_RESERVE || 4096);

/** data URL / http URL → Anthropic image block */
function imageBlock(url) {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(url || '');
  if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  return { type: 'image', source: { type: 'url', url } };
}

/** OpenAI content（string 或 part 数组）→ Anthropic content blocks */
function toBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const part of content) {
    if (part?.type === 'text') {
      // 空 text 块会被上游判非法（实测任何位置的 "" 都触发 400，纯空白反而可以）。
      // 客户端发多模态消息时常带一个空 text part，直接丢掉。
      const t = part.text ?? '';
      if (t) out.push({ type: 'text', text: t });
    } else if (part?.type === 'image_url') {
      out.push(imageBlock(part.image_url?.url));
    }
  }
  return out;
}

function toAnthropicRequest(body) {
  const systemParts = [];
  const messages = [];

  // Anthropic 要求角色交替。实测连续 user 会被上游合并，但**连续 assistant 直接 400**
  // （同样只回那句含混的报错）。OpenAI 侧允许连续同角色，多轮工具调用后尤其常见，
  // 所以在这里统一合并到上一条同角色消息里。
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = messages.at(-1);
    if (last?.role === role && Array.isArray(last.content)) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };

  for (const msg of body.messages ?? []) {
    if (msg.role === 'system' || msg.role === 'developer') {
      // Anthropic 的 system 是顶层字段，不在 messages 里
      systemParts.push(typeof msg.content === 'string' ? msg.content : toBlocks(msg.content).map((b) => b.text ?? '').join(''));
      continue;
    }

    if (msg.role === 'tool') {
      // 工具结果必须以 user 消息回传
      push('user', [{
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      }]);
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks = toBlocks(msg.content);
      for (const tc of msg.tool_calls ?? []) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { /* 参数不合法就传空对象 */ }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
      }
      push('assistant', blocks);
      continue;
    }

    push('user', toBlocks(msg.content));
  }

  // Anthropic 要求 max_tokens 必填且 >= 1；OpenAI 侧可选，部分客户端还会传 0 表示「不限制」
  const wantTokens = body.max_tokens ?? body.max_completion_tokens;
  const req = {
    model: body.model,
    messages,
    max_tokens: Number.isFinite(wantTokens) && wantTokens >= 1 ? wantTokens : DEFAULT_MAX_TOKENS,
    stream: !!body.stream,
  };

  // 语义差异：Anthropic 的 max_tokens 含 thinking token，OpenAI 的只计可见输出。
  // 推理模型上，客户端设的小额度会被 thinking 吃光 —— 实测 max_tokens=100 时
  // thinking 占 99，正文 0 字，客户端拿到 HTTP 200 却是空内容，且毫无报错。
  // 额度可能不够时补一段 thinking 预算：宁可多输出，也好过静默返回空。
  if (isReasoningModel(body.model) && req.max_tokens < THINKING_RESERVE) {
    req.max_tokens += THINKING_RESERVE;
  }
  if (systemParts.length) req.system = systemParts.join('\n\n');

  // 采样参数是这套上游最容易踩雷的地方，三条约束叠在一起，且全都只回含混的 400：
  //  1) 推理模型（extended thinking）不接受采样参数：temperature 只能是 1，top_p/top_k 一律拒
  //     实测除 haiku 外的全部模型都是这样
  //  2) temperature 与 top_p 不能同时出现 —— 二选一，优先保留更常用的 temperature
  //  3) OpenAI 的 temperature 范围是 [0,2]，Anthropic 只接受 [0,1] —— 超界直接拒
  if (acceptsSampling(body.model)) {
    // 钳制而非线性映射：两边默认值都是 1.0，映射会平白改变既有行为
    const clamp01 = (n) => Math.min(Math.max(n, 0), 1);
    if (body.temperature != null) req.temperature = clamp01(body.temperature);
    else if (body.top_p != null) req.top_p = clamp01(body.top_p);
    if (body.top_k != null) req.top_k = body.top_k; // OpenAI 无此字段，部分客户端经 extra_body 传入
  }
  // 推理模型分支：一个采样参数都不下发，等价于 temperature=1（其唯一可接受值）

  if (body.stop) {
    // 上游拒绝纯空白的 stop sequence（实测 "\n"、" " 均 400），过滤掉
    const seqs = (Array.isArray(body.stop) ? body.stop : [body.stop])
      .filter((s) => typeof s === 'string' && s.trim() !== '');
    if (seqs.length) req.stop_sequences = seqs;
  }

  if (Array.isArray(body.tools) && body.tools.length) {
    req.tools = body.tools
      .filter((t) => t?.type === 'function' && t.function)
      .map((t) => ({
        name: t.function.name,
        description: t.function.description ?? '',
        input_schema: t.function.parameters ?? { type: 'object', properties: {} },
      }));
    const tc = body.tool_choice;
    if (tc === 'required') req.tool_choice = { type: 'any' };
    else if (tc === 'none') delete req.tools;
    else if (tc && typeof tc === 'object' && tc.function?.name) req.tool_choice = { type: 'tool', name: tc.function.name };
  }
  // 思考等级：OpenAI 侧的 reasoning_effort / 部分客户端的 effort 转成官方字段
  // output_config.effort，交给下游的默认值逻辑统一处理。
  const clientEffort = body.reasoning_effort ?? body.effort;
  if (typeof clientEffort === 'string' && clientEffort.trim()) {
    req.output_config = { effort: clientEffort.trim().toLowerCase() };
  }
  return req;
}

// ── Anthropic → OpenAI：响应转换 ────────────────────────────────────────
const STOP_MAP = { end_turn: 'stop', max_tokens: 'length', stop_sequence: 'stop', tool_use: 'tool_calls' };

function toOpenAIResponse(a, model) {
  const textParts = [];
  const thinkingParts = []; // 推理模型的 thinking 块，OpenAI 侧无对应字段
  const toolCalls = [];
  for (const b of a.content ?? []) {
    if (b.type === 'text') textParts.push(b.text);
    else if (b.type === 'thinking') thinkingParts.push(b.thinking ?? '');
    else if (b.type === 'tool_use') {
      toolCalls.push({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      });
    }
  }
  const message = { role: 'assistant', content: textParts.join('') || null };
  // reasoning_content 是 DeepSeek R1 引入的事实标准，主流 OpenAI 客户端都能识别并单独展示
  if (thinkingParts.length) message.reasoning_content = thinkingParts.join('');
  if (toolCalls.length) message.tool_calls = toolCalls;

  const inTok = a.usage?.input_tokens ?? 0;
  const outTok = a.usage?.output_tokens ?? 0;
  const thinkTok = a.usage?.output_tokens_details?.thinking_tokens ?? 0;

  return {
    id: a.id || 'chatcmpl-' + crypto.randomUUID(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: a.model || model,
    choices: [{ index: 0, message, finish_reason: STOP_MAP[a.stop_reason] ?? 'stop' }],
    usage: {
      prompt_tokens: inTok,
      completion_tokens: outTok,
      total_tokens: inTok + outTok,
      ...(thinkTok ? { completion_tokens_details: { reasoning_tokens: thinkTok } } : {}),
    },
  };
}

// ── 流式：Anthropic SSE → OpenAI SSE ────────────────────────────────────
async function pipeStream(upstream, res, model, includeUsage = false) {
  const id = 'chatcmpl-' + crypto.randomUUID();
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish = null) =>
    `data: ${JSON.stringify({
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;

  res.writeHead(200, forwardHeaders(upstream, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no', // 关掉中间层缓冲，否则流式会攒到最后一次性吐出
  }));
  res.socket?.setNoDelay(true); // 关掉 Nagle，事件立即出网而不是攒够一个包
  res.write(chunk({ role: 'assistant', content: '' }));

  // include_usage 时要在收尾补一个带 usage 的 chunk，边解析边攒
  const usage = { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0 };

  const decoder = new TextDecoder();
  let buf = '';
  let finish = 'stop';
  // 记录每个 content_block index 对应的工具调用序号，用于拼增量 JSON
  const toolIdx = new Map();
  let nextTool = 0;
  // 流式收尾诊断（同原生端点：区分正常收尾 / 上游断 / 客户端断）
  const streamT0 = Date.now();
  let streamChunks = 0;

  try {
    for await (const raw of upstream.body) {
      buf += decoder.decode(raw, { stream: true });
      const events = buf.split('\n\n');
      buf = events.pop() ?? '';

      for (const evt of events) {
        const line = evt.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let d;
        try { d = JSON.parse(line.slice(5).trim()); } catch { continue; }
        streamChunks++;

        if (d.type === 'message_start') {
          usage.prompt_tokens = d.message?.usage?.input_tokens ?? 0;
        } else if (d.type === 'content_block_start' && d.content_block?.type === 'tool_use') {
          const i = nextTool++;
          toolIdx.set(d.index, i);
          res.write(chunk({
            tool_calls: [{
              index: i, id: d.content_block.id, type: 'function',
              function: { name: d.content_block.name, arguments: '' },
            }],
          }));
        } else if (d.type === 'content_block_delta') {
          if (d.delta?.type === 'text_delta') {
            res.write(chunk({ content: d.delta.text }));
          } else if (d.delta?.type === 'thinking_delta') {
            // 推理增量走 reasoning_content，客户端可与正文分开渲染
            res.write(chunk({ reasoning_content: d.delta.thinking }));
          } else if (d.delta?.type === 'input_json_delta') {
            const i = toolIdx.get(d.index) ?? 0;
            res.write(chunk({ tool_calls: [{ index: i, function: { arguments: d.delta.partial_json } }] }));
          }
        } else if (d.type === 'message_delta') {
          if (d.delta?.stop_reason) finish = STOP_MAP[d.delta.stop_reason] ?? 'stop';
          if (d.usage?.output_tokens != null) usage.completion_tokens = d.usage.output_tokens;
          const rt = d.usage?.output_tokens_details?.thinking_tokens;
          if (rt != null) usage.reasoning_tokens = rt;
        } else if (d.type === 'error') {
          res.write(`data: ${JSON.stringify({ error: d.error })}\n\n`);
        }
      }
    }
    res.write(chunk({}, finish));
    // OpenAI 规范：include_usage 时在 [DONE] 前补一个 choices 为空、只带 usage 的 chunk
    if (includeUsage) {
      res.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created, model, choices: [],
        usage: {
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          total_tokens: usage.prompt_tokens + usage.completion_tokens,
          ...(usage.reasoning_tokens ? { completion_tokens_details: { reasoning_tokens: usage.reasoning_tokens } } : {}),
        },
      })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    reqLog({ level: 'info', reason: 'stream_done', endpoint: 'chat/completions', model, ms: Date.now() - streamT0, chunks: streamChunks });
  } catch (e) {
    // 上游中断：尽量给客户端一个可解析的收尾，避免它一直挂着
    reqLog({ level: 'warn', reason: 'stream_aborted', endpoint: 'chat/completions', model, ms: Date.now() - streamT0, chunks: streamChunks, error: String(e?.message || e) });
    res.write(`data: ${JSON.stringify({ error: { message: String(e?.message || e), type: 'upstream_error' } })}\n\n`);
    res.write('data: [DONE]\n\n');
  } finally {
    res.end();
  }
}

// ── HTTP 服务 ───────────────────────────────────────────────────────────

// 诊断日志：失败请求完整落盘（转换前后载荷 + 上游原文），成功请求只记一行摘要。
// 上游的 400 不指出具体字段，没有这份记录就只能靠猜。
const REQ_LOG = process.env.BRIDGE_REQ_LOG || path.join(__dirname, 'requests.log'); // 可用 BRIDGE_REQ_LOG 指向别处，便于隔离测试

/** 递归截断超长字符串，免得 base64 图片或长上下文把日志撑爆 */
function trunc(v, max = 1500) {
  if (typeof v === 'string') return v.length > max ? `${v.slice(0, max)}…<截断 ${v.length - max} 字符>` : v;
  if (Array.isArray(v)) return v.map((x) => trunc(x, max));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = trunc(val, max);
    return o;
  }
  return v;
}

/** 落盘用的请求载荷：整条超过 maxBytes 就只留结构与开头。
 *  实测一个 269 条消息的 Claude Code 请求即使逐字符串截断也有几百 KB，
 *  连打几十次就把 requests.log 顶到 80MB+，读日志本身变成体力活。 */
function logPayload(v, maxBytes = 16_384) {
  const t = trunc(v, 800);
  let s;
  try { s = JSON.stringify(t); } catch { return { _unserializable: true }; }
  if (s.length <= maxBytes) return t;
  const msgs = Array.isArray(v?.messages) ? v.messages : null;
  return {
    _truncated: true, _bytes: s.length,
    model: v?.model ?? null, max_tokens: v?.max_tokens ?? null, stream: v?.stream ?? null,
    system_chars: v?.system ? JSON.stringify(v.system).length : 0,
    messages: msgs ? { count: msgs.length, roles: msgs.map((m) => m.role).join(','), chars: JSON.stringify(msgs).length } : null,
    tools: Array.isArray(v?.tools) ? v.tools.length : null,
    head: s.slice(0, 3000),
  };
}

/** 启动时滚动一次日志：超过 BRIDGE_LOG_MAX_BYTES（默认 64MB）就改名 .1（只留一代）。
 *  服务是常驻的，不滚就等于无限增长。 */
function rotateRequestLog() {
  const maxBytes = Number(process.env.BRIDGE_LOG_MAX_BYTES || 64 * 1024 * 1024);
  try {
    const st = fs.statSync(REQ_LOG);
    if (st.size <= maxBytes) return;
    const bak = REQ_LOG + '.1';
    fs.rmSync(bak, { force: true });
    fs.renameSync(REQ_LOG, bak);
    console.log(`[bridge] requests.log 已滚动（${(st.size / 1048576).toFixed(1)} MB → requests.log.1）`);
  } catch { /* 不存在/权限问题都无所谓 */ }
}

function reqLog(entry) {
  try {
    fs.appendFileSync(REQ_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* 日志写失败不影响请求本身 */ }
}

// 进程级兜底：2026-09-25 出现过一次「服务静默消失」——requests.log 最后一条正常 200，
// 之后端口无人监听，而启动方式（wscript 隐藏启动）吞掉了 stderr，查无实据。
// 这里把未捕获异常/未处理拒绝都落盘 + 写 stderr（启动脚本已重定向到 bridge.task.log），
// 且**不退出**：本地代理活下去比干净崩掉更有用，下一个请求会自然重试。
for (const [evt, reason] of [['uncaughtException', 'uncaught_exception'], ['unhandledRejection', 'unhandled_rejection']]) {
  process.on(evt, (e) => {
    const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
    reqLog({ level: 'fatal', reason, error: detail.slice(0, 2000) });
    try { console.error(`[bridge] ${evt}:`, detail); } catch { /* stderr 不可用 */ }
  });
}
process.on('warning', (w) => {
  reqLog({ level: 'warn', reason: 'node_warning', name: w?.name, error: String(w?.message ?? w).slice(0, 500) });
});
// 退出时留下墓碑：区分「被杀 / 崩溃 / 主动退出」
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => {
    reqLog({ level: 'warn', reason: 'process_signal', signal: sig, pid: process.pid });
    process.exit(0);
  });
}
process.on('exit', (code) => {
  reqLog({ level: 'warn', reason: 'process_exit', code, pid: process.pid, uptimeSec: Math.round(process.uptime()) });
});

// 逐跳（hop-by-hop）头不能转发，content-length/encoding 由本层重算
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'proxy-authenticate', 'proxy-authorization', 'content-length', 'content-encoding',
]);

/**
 * 把上游响应头带给客户端。
 * 早期实现只手写了 content-type，把 anthropic-ratelimit-* 全丢了 —— 客户端要靠这些做退避，
 * 丢掉等于让它盲飞；x-litellm-call-id / x-router-* 也是排查时的追溯线索。
 * 但要剥离 CDN/反代链痕迹头：via / x-amz-cf-* / server(cloudflare) 等会让下游一眼看出
 * 响应经过多层代理。保留全部业务头（ratelimit/request-id/content-type）。
 */
// 剥离的 CDN/反代痕迹头（小写匹配）
const CDN_TRACE_HEADERS = new Set([
  'via', 'server', 'cf-ray', 'alt-svc', 'x-amz-cf-id', 'x-amz-cf-pop',
  'x-cache', 'x-cache-hits', 'traceparent', 'traceresponse', 'x-robots-tag',
  'report-to', 'nel', 'expect-ct',
]);
function forwardHeaders(upstream, extra = {}) {
  // extra 的键要能覆盖上游同名头。对象键区分大小写，'Content-Type' 盖不住上游的
  // 'content-type'，两个都会发出去 —— 客户端收到的就是 "a, b" 这种重复值。
  const overridden = new Set(Object.keys(extra).map((k) => k.toLowerCase()));
  const out = {};
  for (const [k, v] of upstream.headers) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || overridden.has(lk) || CDN_TRACE_HEADERS.has(lk)) continue;
    out[k] = v;
  }
  return { ...out, ...extra };
}

function send(res, code, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  // 同上：先按小写剔除会被覆盖的键，避免 content-type 之类发出两份
  const merged = {};
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (!['content-type', 'content-length'].includes(k.toLowerCase())) merged[k] = v;
  }
  res.writeHead(code, {
    ...merged,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}
const errBody = (message, type = 'invalid_request_error', code = null) => ({ error: { message, type, code } });

/** Claude Desktop/SDK 的可用性探测：max_tokens=1 且无显式会话。
 * relay 会把它当 availability probe；本地直接返回标准 200，避免网络抖动
 * 或 Mira/router 休眠时把探测放大成 503。真正 max_tokens>=2 的请求照常走模型。 */
function isAvailabilityProbe(body, req) {
  const n = Number(body?.max_tokens ?? body?.max_completion_tokens ?? 0);
  if (!Number.isFinite(n) || n > 1) return false;
  const explicit = req?.headers?.['x-conversation-id'] || body?.previous_response_id;
  return !explicit;
}

function probeAnthropicResponse(model, reason = null) {
  return new Response(JSON.stringify({
    id: `msg_probe_${crypto.randomUUID()}`,
    type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text: 'ok' }], // 极短正文：有些客户端把空 content 当异常
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 1 },
    ...(reason ? { _bridge: { intercepted: reason } } : {}),
  }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

// ── 预热/探测请求拦截（2026-09-27）──────────────────────────────────────────
// Claude Code 客户端在启动、切模型、断线重连时会打一批"预热"请求：
//   1. HEAD/GET /api/hello       连通性握手，不涉及模型
//   2. max_tokens=1              可用性探测（relay 会判 availability probe）
//   3. 单条极短消息 + 很小额度    warmup（"hi" / "ping" / "warmup" …）
//   4. /v1/messages/count_tokens 本地就能估算，不必打上游
// 这些打上游既慢又占额度，还会把 stats 的"上一条消息"搅乱。统一本地消化，
// 日志记 probe_intercepted，并单独计数（不计入正常请求统计）。
const PROBE_TEXT_RE = /^(warm\s*-?\s*up|prewarm|warmup|ping|pong|health\s*check|healthz|__probe__|test|testing|hello|hi|hey|yo)[.!?。！？]*$/i;
const PROBE_HEADERS = ['x-mirasim-probe', 'x-anthropic-probe', 'x-claude-warmup', 'x-warmup', 'x-stainless-warmup'];
const PROBE_MAX_TOKENS = Number(process.env.BRIDGE_PROBE_MAX_TOKENS || 64);
const PROBE_ENABLED = process.env.BRIDGE_PROBE_FILTER !== '0';

/** 判定是否为"预热/探测"请求；命中返回原因字符串，否则 null。 */
function isWarmupProbe(body, req) {
  if (!PROBE_ENABLED) return null;
  if (isAvailabilityProbe(body, req)) return 'max_tokens<=1';
  for (const h of PROBE_HEADERS) if (req?.headers?.[h]) return `header:${h}`;
  const msgs = Array.isArray(body?.messages) ? body.messages : null;
  if (!msgs || msgs.length === 0) return 'empty_messages';
  if (msgs.length > 1) return null;
  if (Array.isArray(body?.tools) && body.tools.length) return null; // 带工具的绝不是预热
  const n = Number(body?.max_tokens ?? body?.max_completion_tokens ?? 0);
  if (!Number.isFinite(n) || n > PROBE_MAX_TOKENS) return null;
  const m = msgs[0];
  if (m?.role !== 'user') return null;
  const text = typeof m.content === 'string'
    ? m.content
    : (Array.isArray(m.content) ? m.content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('') : '');
  const t = text.trim();
  if (!t || t.length > 64) return null;
  return PROBE_TEXT_RE.test(t) ? `warmup_text:"${t}"` : null;
}

/** count_tokens 本地估算：中文≈1 token/字，其余≈1 token/4 字符，够客户端做上下文管理。 */
function estimateTokensLocal(body) {
  const parts = [];
  const push = (c) => {
    if (typeof c === 'string') parts.push(c);
    else if (Array.isArray(c)) for (const b of c) push(b?.text ?? b?.content ?? '');
    else if (c && typeof c === 'object') push(c.text ?? c.content ?? '');
  };
  push(body?.system);
  for (const m of body?.messages ?? []) push(m?.content);
  for (const t of body?.tools ?? []) parts.push(JSON.stringify(t));
  const s = parts.join('\n');
  const cjk = (s.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  return Math.max(1, cjk + Math.ceil((s.length - cjk) / 4));
}

function presentedKey(req) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  if (typeof req.headers['x-api-key'] === 'string') return req.headers['x-api-key'].trim();
  return null;
}

function readBody(req, limit = 64 << 20) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

/**
 * 剥掉 cache_control.scope。
 * Claude Code 2.1+ 会带 `{"type":"ephemeral","ttl":"1h","scope":"global"}`（跨会话共享 prompt cache），
 * 上游不认 scope 这个扩展，见到就回一句含混的 400 —— ttl 本身是支持的，所以只删 scope。
 * cache_control 可出现在 system 块、messages 内容块、tools 定义上，故递归处理整个载荷。
 */
function stripCacheScope(v) {
  if (Array.isArray(v)) { v.forEach(stripCacheScope); return v; }
  if (v && typeof v === 'object') {
    if (v.cache_control && typeof v.cache_control === 'object' && 'scope' in v.cache_control) {
      delete v.cache_control.scope;
    }
    for (const val of Object.values(v)) stripCacheScope(val);
  }
  return v;
}

// ── Anthropic → OpenAI Responses API 转换 ────────────────────────────────
function toResponsesResponse(a, model) {
  const textParts = [];
  const thinkingParts = [];
  const toolCalls = [];
  for (const b of a.content ?? []) {
    if (b.type === 'text') textParts.push(b.text);
    else if (b.type === 'thinking') thinkingParts.push(b.thinking ?? '');
    else if (b.type === 'tool_use') {
      toolCalls.push({
        type: 'function_call',
        id: b.id,
        call_id: 'call_' + crypto.randomUUID(),
        name: b.name,
        arguments: b.input ?? {},
      });
    }
  }
  const output = [];
  if (textParts.length) {
    output.push({
      type: 'message',
      id: 'msg_' + crypto.randomUUID(),
      status: 'completed',
      role: 'assistant',
      content: textParts.map((t) => ({ type: 'output_text', text: t })),
    });
  }
  if (thinkingParts.length) {
    // 按 Responses API 规范：reasoning 项用 summary 数组（summary_text 部分），
    // 不能塞裸字符串——严格类型的 SDK 会解析失败。
    output.push({
      type: 'reasoning',
      id: 'rsn_' + crypto.randomUUID(),
      summary: [{ type: 'summary_text', text: thinkingParts.join('') }],
      content: [],
    });
  }
  for (const tc of toolCalls) {
    output.push({
      type: 'function_call',
      id: tc.id,
      call_id: tc.call_id,
      name: tc.name,
      arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
      status: 'completed',
    });
  }
  const inTok = a.usage?.input_tokens ?? 0;
  const outTok = a.usage?.output_tokens ?? 0;
  const thinkTok = a.usage?.output_tokens_details?.thinking_tokens ?? 0;
  return {
    id: a.id || 'resp_' + crypto.randomUUID(),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: a.model || model,
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: thinkingParts.length ? [{ type: 'summary_text', text: thinkingParts.join('') }] : null },
    store: false,
    temperature: 1,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
    usage: {
      input_tokens: inTok,
      input_tokens_details: { cached_tokens: a.usage?.cache_read_input_tokens ?? 0 },
      output_tokens: outTok,
      output_tokens_details: { reasoning_tokens: thinkTok },
      total_tokens: inTok + outTok,
    },
    user: null,
    metadata: {},
  };
}

/** 流式：Anthropic SSE → OpenAI Responses API SSE 事件。 */
async function pipeResponsesStream(upstream, res, model) {
  const respId = 'resp_' + crypto.randomUUID();
  const created = Math.floor(Date.now() / 1000);
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const outItemId = 'msg_' + crypto.randomUUID();
  const textId = 'tx_' + crypto.randomUUID();
  const rsnItemId = 'rsn_' + crypto.randomUUID();
  const rsnPartId = 'rsnp_' + crypto.randomUUID();

  res.writeHead(200, forwardHeaders(upstream, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  }));
  res.socket?.setNoDelay(true);

  const head = {
    id: respId, object: 'response', created_at: created, status: 'in_progress', error: null,
    incomplete_details: null, instructions: null, max_output_tokens: null, model,
    output: [], parallel_tool_calls: true, previous_response_id: null,
    reasoning: { effort: null, summary: null }, store: false, temperature: 1,
    text: { format: { type: 'text' } }, tool_choice: 'auto', tools: [], top_p: 1,
    truncation: 'disabled', usage: null, user: null, metadata: {},
  };
  res.write(ev('response.created', head));
  res.write(ev('response.in_progress', head));

  // reasoning 项只在真的收到 thinking 增量时才开（上游 display=summarized 才有），
  // 且必须排在 message 项之前；先开 reasoning 后开 message，索引顺延。
  let rsnOpen = false, msgOpen = false, msgIndex = 0;
  const openReasoning = () => {
    if (rsnOpen) return;
    rsnOpen = true; msgIndex = 1;
    res.write(ev('response.output_item.added', {
      type: 'response.output_item.added', output_index: 0,
      item: { id: rsnItemId, type: 'reasoning', summary: [], content: [] },
    }));
    res.write(ev('response.reasoning_summary_part.added', {
      type: 'response.reasoning_summary_part.added', item_id: rsnItemId, output_index: 0, summary_index: 0,
      part: { type: 'summary_text', text: '' },
    }));
  };
  const openMessage = () => {
    if (msgOpen) return;
    msgOpen = true;
    res.write(ev('response.output_item.added', {
      type: 'response.output_item.added', output_index: msgIndex,
      item: { id: outItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
    }));
    res.write(ev('response.content_part.added', {
      type: 'response.content_part.added', item_id: outItemId, output_index: msgIndex, content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    }));
  };
  const closeReasoning = () => {
    if (!rsnOpen) return;
    res.write(ev('response.reasoning_summary_text.done', {
      type: 'response.reasoning_summary_text.done', item_id: rsnItemId, output_index: 0, summary_index: 0, text: thinking,
    }));
    res.write(ev('response.reasoning_summary_part.done', {
      type: 'response.reasoning_summary_part.done', item_id: rsnItemId, output_index: 0, summary_index: 0,
      part: { type: 'summary_text', text: thinking },
    }));
    res.write(ev('response.output_item.done', {
      type: 'response.output_item.done', output_index: 0,
      item: { id: rsnItemId, type: 'reasoning', summary: [{ type: 'summary_text', text: thinking }], content: [] },
    }));
    rsnOpen = false;
  };

  let text = '';
  let thinking = '';
  let usage = null;
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for await (const raw of upstream.body) {
      buf += decoder.decode(raw, { stream: true });
      const events = buf.split('\n\n');
      buf = events.pop() ?? '';
      for (const evt of events) {
        const line = evt.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let d;
        try { d = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (d.type === 'content_block_delta' && d.delta?.type === 'thinking_delta') {
          openReasoning();
          thinking += d.delta.thinking ?? '';
          res.write(ev('response.reasoning_summary_text.delta', {
            type: 'response.reasoning_summary_text.delta', item_id: rsnItemId, output_index: 0, summary_index: 0,
            delta: d.delta.thinking ?? '',
          }));
        } else if (d.type === 'content_block_delta' && d.delta?.type === 'text_delta') {
          closeReasoning();
          openMessage();
          text += d.delta.text ?? '';
          res.write(ev('response.output_text.delta', {
            type: 'response.output_text.delta', item_id: outItemId, output_index: msgIndex, content_index: 0, delta: d.delta.text ?? '',
          }));
        } else if (d.type === 'message_delta' && d.usage) {
          usage = d.usage; // 末帧真实用量，别拿字符数糊弄
        }
      }
    }
  } catch { /* 客户端断开等 */ }

  closeReasoning();
  openMessage();
  res.write(ev('response.output_text.done', { type: 'response.output_text.done', item_id: outItemId, output_index: msgIndex, content_index: 0, text }));
  res.write(ev('response.content_part.done', { type: 'response.content_part.done', item_id: outItemId, output_index: msgIndex, content_index: 0, part: { type: 'output_text', text, annotations: [] } }));
  res.write(ev('response.output_item.done', { type: 'response.output_item.done', output_index: msgIndex, item: { id: outItemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] } }));

  const output = [];
  if (thinking) {
    output.push({ id: rsnItemId, type: 'reasoning', summary: [{ type: 'summary_text', text: thinking }], content: [] });
  }
  output.push({ id: outItemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
  const inTok = usage?.input_tokens ?? 0;
  const outTok = usage?.output_tokens ?? 0;
  const done = {
    ...head, status: 'completed', output,
    usage: {
      input_tokens: inTok, input_tokens_details: { cached_tokens: usage?.cache_read_input_tokens ?? 0 },
      output_tokens: outTok, output_tokens_details: { reasoning_tokens: usage?.output_tokens_details?.reasoning_tokens ?? 0 },
      total_tokens: inTok + outTok,
    },
  };
  res.write(ev('response.completed', done));
  res.end();
}

/**
 * 调上游 /v1/messages，自带采样参数自愈。
 * 上游对采样参数的拒绝只回一句含混的 400，不指明字段；这里剥掉采样参数重试一次。
 * 重试仍失败说明不是采样参数的锅，还原首次错误如实透传。
 * 两个对外端点（OpenAI 的 chat/completions 与 Anthropic 原生 messages）共用这条路径。
 */
// 默认严格协议模式：只调用 router HTTP API，绝不创建 Host agent session。
// 旧的 prompt/send 回退会创建真实会话并启动 agent 工具链，必须显式设为 1 才允许。
const ENABLE_SESSION_FALLBACK = process.env.BRIDGE_ENABLE_SESSION_FALLBACK === '1';
const SERVE_UI = ENABLE_SESSION_FALLBACK ? process.env.BRIDGE_SERVE_UI : null; // 如 C:\Users\x\.mirasim\app\0.0.224\server.cjs
const SERVE_PORT = Number(process.env.BRIDGE_SERVE_PORT || 4970);
const SERVE_AGENT = process.env.BRIDGE_SERVE_AGENT || 'claude';
const SERVE_EFFORT = process.env.BRIDGE_SERVE_EFFORT || 'low';
// 会话池：同一「对话指纹」复用同一个 serve session，靠 serve 的 prompt cache 命中省 token。
// 语义参考 Claude Code 原生：一轮 user 消息 = 追加到既有 session，system 与历史上下文不重复计费。
const SERVE_POOL_MAX = Number(process.env.BRIDGE_SERVE_POOL_MAX || 32);   // 并发会话个数的上限
const SERVE_POOL_TTL_MS = Number(process.env.BRIDGE_SERVE_POOL_TTL_MS || 20 * 60_000); // 空闲多久淘汰

/** serve 会话池：fingerprint → { serveKey, lastUsed, busy, queue } */
const servePool = new Map();
const fingerprintOf = (m) => crypto.createHash('sha256').update(m).digest('hex').slice(0, 16);

function poolEvict() {
  const now = Date.now();
  for (const [k, v] of servePool) {
    if (now - v.lastUsed > SERVE_POOL_TTL_MS) servePool.delete(k);
  }
  while (servePool.size > SERVE_POOL_MAX) { // 超上限逐最久未用
    let oldest = null;
    for (const [k, v] of servePool) if (!oldest || v.lastUsed < oldest.v.lastUsed) oldest = { k, v };
    if (!oldest) break;
    servePool.delete(oldest.k);
  }
}

/** ui-cli 的旧实现，仅在 WebSocket 不可用时作兼容兜底。 */
function serveUiCliSend(serveKey, text) {
  const ui = SERVE_UI;
  if (!ui) return Promise.resolve(null);
  return new Promise((resolve) => {
    const args = serveKey
      ? [ui, 'ui-cli', '--port', String(SERVE_PORT), 'send', '--session', serveKey, '--text', text]
      : [ui, 'ui-cli', '--port', String(SERVE_PORT), 'prompt', '--agent', SERVE_AGENT,
          '--model', 'claude-opus-5', '--effort', SERVE_EFFORT, '--text', text];
    execFile(process.execPath, args, { timeout: 300_000, maxBuffer: 16 << 20, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(stdout);
        if (j.phase === 'done' && !j.error) return resolve({ serveKey: j.sessionKey ?? serveKey, text: j.text ?? null, transport: 'ui-cli' });
      } catch { /* 落到 null */ }
      resolve(null);
    });
  });
}

// ── serve 原生 Host WebSocket ────────────────────────────────────────────
// GUI 与 ui-cli 共用 ws://127.0.0.1:4970/ws。直连它可免掉每请求启动一次
// node + 20MB server.cjs 的约 3.5 秒固定开销，还能收到 appendText 增量。
const SERVE_WS_ENABLED = process.env.BRIDGE_SERVE_WS !== '0';
const SERVE_WS_URL = process.env.BRIDGE_SERVE_WS_URL || `ws://127.0.0.1:${SERVE_PORT}/ws`;
const SERVE_WORKDIR = process.env.BRIDGE_SERVE_WORKDIR || process.cwd();
let serveWs = null;
let serveWsOpening = null;
const serveWsPending = new Map(); // clientRef -> { resolve, timer, sessionKey, text }

function failServeWsPending() {
  for (const p of serveWsPending.values()) {
    clearTimeout(p.timer);
    p.resolve(null);
  }
  serveWsPending.clear();
}

async function ensureServeWs() {
  if (!SERVE_WS_ENABLED || typeof WebSocket !== 'function') return null;
  if (serveWs?.readyState === WebSocket.OPEN) return serveWs;
  if (serveWsOpening) return serveWsOpening;
  serveWsOpening = new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket(SERVE_WS_URL); } catch { serveWsOpening = null; return resolve(null); }
    const timer = setTimeout(() => { try { ws.close(); } catch {} }, 8_000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      serveWs = ws;
      serveWsOpening = null;
      // hello 会订阅 relay 状态；不依赖返回内容，但与 GUI 同步协议状态。
      try { ws.send(JSON.stringify({ type: 'hello' })); } catch {}
      resolve(ws);
    }, { once: true });
    ws.addEventListener('message', async (event) => {
      let frame;
      try { frame = JSON.parse(typeof event.data === 'string' ? event.data : await event.data.text()); } catch { return; }
      if (frame.type === 'accepted' && frame.clientRef) {
        const p = serveWsPending.get(frame.clientRef);
        if (p) p.sessionKey = frame.sessionKey;
        return;
      }
      if (frame.type !== 'session' || !frame.sessionKey) return;
      const p = [...serveWsPending.values()].find((x) => x.sessionKey === frame.sessionKey);
      if (!p) return;
      if (typeof frame.patch?.appendText === 'string') p.text += frame.patch.appendText;
      const set = frame.patch?.set ?? {};
      if (set.phase === 'done') {
        clearTimeout(p.timer);
        serveWsPending.delete(p.clientRef);
        p.resolve(set.error ? null : { serveKey: p.sessionKey, text: p.text, transport: 'ws' });
      } else if (set.phase === 'error' || set.error) {
        clearTimeout(p.timer);
        serveWsPending.delete(p.clientRef);
        p.resolve(null);
      }
    });
    ws.addEventListener('close', () => {
      if (serveWs === ws) serveWs = null;
      serveWsOpening = null;
      failServeWsPending();
    });
    ws.addEventListener('error', () => { try { ws.close(); } catch {} });
  });
  return serveWsOpening;
}

/** 直连 GUI 同款 host 协议。首轮无 sessionKey，续轮携带已有 key。 */
async function serveWsSend(serveKey, text) {
  const ws = await ensureServeWs();
  if (!ws) return null;
  const clientRef = crypto.randomUUID();
  return new Promise((resolve) => {
    const pending = {
      resolve, clientRef, sessionKey: serveKey, text: '',
      timer: setTimeout(() => {
        serveWsPending.delete(clientRef);
        resolve(null);
      }, 300_000),
    };
    serveWsPending.set(clientRef, pending);
    const frame = {
      type: 'prompt', clientRef, prompt: text, agent: SERVE_AGENT,
      workdir: SERVE_WORKDIR, model: 'claude-opus-5', effort: SERVE_EFFORT,
      ...(serveKey ? { sessionKey: serveKey } : {}),
    };
    try { ws.send(JSON.stringify(frame)); } catch {
      clearTimeout(pending.timer);
      serveWsPending.delete(clientRef);
      resolve(null);
    }
  });
}

/** 在指定 serveKey 上发一条消息。默认原生 WebSocket，ui-cli 只做故障兜底。 */
async function serveSend(serveKey, text) {
  const native = await serveWsSend(serveKey, text);
  if (native != null) return native;
  return serveUiCliSend(serveKey, text);
}

// ── 会话预热池（默认关闭） ──────────────────────────────────────────────
// 实测：serve 会话续轮本身要跑完整 agent turn（3-44s），预热只能省「新建会话」的
// registration 开销，真实瓶颈在 agent 循环本身，且预热会污染 GUI 会话列表。
// 故默认 0（关闭），需要时显式设 BRIDGE_SERVE_WARM=n。
const SERVE_WARM = Number(process.env.BRIDGE_SERVE_WARM || 0);
const warmKeys = new Set(); // 已预热的 clientSessionId
let warmServing = 0;

/** 预热一个空会话：发一条无害 prompt，拿 sessionKey 存进池。 */
async function warmOne() {
  try {
    const r = await serveSend(null, '你好');
    if (r?.serveKey) {
      servePool.set('warm:' + r.serveKey, { serveKey: r.serveKey, lastUsed: Date.now(), queue: Promise.resolve(), warm: true });
    }
  } catch { /* 预热失败不致命 */ }
}

function warmStartup() {
  if (!SERVE_UI || !SERVE_WS_ENABLED) return;
  for (let i = 0; i < SERVE_WARM; i++) warmOne().catch(() => {});
}

/** 从预热池借一个已就绪的会话给新对话用（替换掉 17s 冷启动）。 */
function takeWarm() {
  for (const [k, v] of servePool) {
    if (v.warm && v.serveKey && !v.claimed && warmServing < SERVE_WARM) {
      v.claimed = true;
      warmServing++;
      warmKeys.add(k);
      return v.serveKey;
    }
  }
  return null;
}

function releaseWarm(k) {
  const ent = servePool.get(k);
  if (ent) { ent.claimed = false; ent.lastUsed = Date.now(); }
  warmKeys.delete(k);
  warmServing = Math.max(0, warmServing - 1);
}
warmStartup();

/** 按指纹取/建会话，自带串行队（同会话并发请求排队，保上下文顺序）。
 *  initialPrefix 只在新会话的首轮发送，用于将 API 的 system/developer 指令注入 host 会话。 */
async function serveTurn(fingerprint, text, initialPrefix = '') {
  let ent = servePool.get(fingerprint);
  const isNew = !ent;
  if (!ent) {
    const warmKey = takeWarm();
    ent = { serveKey: warmKey ?? null, lastUsed: Date.now(), queue: Promise.resolve() };
    servePool.set(fingerprint, ent);
    poolEvict();
  }
  const turnText = isNew && initialPrefix ? `${initialPrefix}\n\n${text}` : text;
  const run = () => serveSend(ent.serveKey, turnText).then((r) => {
    if (r?.serveKey) ent.serveKey = r.serveKey;
    if (r?.text != null) ent.lastUsed = Date.now();
    return r ?? null;
  });
  const prev = ent.queue;
  ent.queue = prev.then(run, run); // 失败不阻塞后续
  return ent.queue;
}

/** 经 serve 内部会话（ui-cli prompt/send）走带 ticket 的 relay 通道。
 *  54534 外部网关对 claude 无设备 ticket，relay 回 503 no upstream；
 *  而 serve 进程内部会话（GUI/ui-cli 同通道）带 mrs-sig-v1 设备签名，
 *  实测 claude-opus-5 可正常 200。这是第三方接口拿到 claude 上游的 fallback。 */
async function servePrompt(text) {
  const ui = SERVE_UI;
  if (!ui) return null;
  return serveSend(null, text).then((r) => r?.text ?? null);
}

/** Claude 网关拒绝时经 serve 通道重试。
 *  relay 曾以 503 "no upstream available" 拒绝无设备 ticket 的调用，随后改为
 *  400 "the request was rejected as invalid"。两者均回退到带设备签名的 serve。
 *  成功则构造一个最小 OpenAI/Anthropic 结构体返回；失败还原原错误。 */
const isClaudeReal = (m) => /^claude-(opus|sonnet|haiku|fable)/i.test(m ?? '');
// relay 能直接服务的模型族（claude / codex / dsh / glm / kimi）。
// 其余（gemini 等）relay 回 422，需要本机 router，而 router 新版加了随机 token 闸门，
// 外部拿不到 → 不暴露。注意 glm-* / kimi-* 也要列在这里，否则会跳过 relay 直接落到 router。
const isRelayModel = (m) => /^(claude-|gpt-|deepseek-|glm-|kimi-)/i.test(m ?? '');
/** 平台"服务不了你"的含混 400 —— 和真正的客户端语义错误不是一回事。
 *  2026-10-06 实测：claude 池不可用时，平台先把 503「平台暂时无法提供 claude-xxx，请稍后重试」
 *  换成了这个 400（正文只有 `The request was rejected as invalid.`，响应头带
 *  `x-router-throttle-wait-ms: 30000~40000` 的排队痕迹，账号侧 limits 仍显示
 *  suspended/degraded=false、7d 用量 8%）。识别它有三个用处：
 *    1) 不当成客户端语义错误原样透传 —— 客户端会以为自己的请求非法，既不退避也不重试；
 *    2) 点亮繁忙窗口，让后续请求进对冲；
 *    3) serve 通道兜底：无设备 ticket 时平台回的也是同一句话。 */
const PLATFORM_REFUSAL_RE = /rejected as invalid/i;
const isPlatformRefusal = (status, text) => status === 400 && PLATFORM_REFUSAL_RE.test(String(text ?? ''));
const shouldServeFallback = (status, text) => status === 503 && String(text).includes('no upstream available')
  || isPlatformRefusal(status, text);

// ── 直连 relay 通道（协议级，不创建 agent 会话）──────────────────────────
// 0.0.358 起 relay 全面换成「签名会话（signed session）」：
//   1. 每个请求用设备 Ed25519 私钥签名，签名对象是
//      canonical = [METHOD, path, ts, nonce, deviceId, clientVersion, credential]
//      以 \0 连接，外加 extraMeta（同样 \0 连接）+ 原始 body 字节。
//      签名与非对称运算跑在官方客户端的 WASM crypto-core 里（cc_sign / cc_seal）。
//   2. 除 x-mirasim-client 外，所有 x-mirasim-* 头（含 x-mirasim-device/ts/nonce/sig
//      四个签名头本身）都被 cc_seal 封成单个 x-mirasim-enc（mrs-seal-v1 信封），
//      明文元数据一律不出网。relay 拿密封私钥解封后再验签。
//   3. 缺少这层信封时 relay 回 401
//      {"code":"client_outdated","message":"this client version must upgrade to a signed session"}
//      —— 旧版 mrs-sig-v1 明文签名（0.0.224）即因此被拒。
//   4. credential 字段：铸票时为 issuer token，业务请求时为 device/session ticket。
// 该通道不创建任何 host agent 会话，也不传 workdir；由 BRIDGE_RELAY_DIRECT=0 关闭。
const RELAY_BASE = (process.env.BRIDGE_RELAY_BASE || 'https://relay.mirasim.ai').replace(/\/+$/, '');
const RELAY_DIRECT_ENABLED = process.env.BRIDGE_RELAY_DIRECT !== '0';
// 官方客户端版本：relay 会按它判定「是否要求签名会话」，写死迟早被 401 client_outdated 打回
// （实测 0.0.224 → 拒；0.0.358 时代协议再变一次）。这里默认**跟随本机实际安装的版本**：
//   1) BRIDGE_RELAY_CLIENT 显式指定（最高优先）
//   2) ~/.mirasim/app/state.json 的 good（官方自更新后写回的当前可用版本）
//   3) ~/.mirasim/app/ 下最新的版本目录名
//   4) 兜底常量
// 结果缓存 RELAY_CLIENT_TTL_MS，官方半夜自更新后无需重启 bridge。
const RELAY_CLIENT_FALLBACK = '0.0.362';
const RELAY_CLIENT_TTL_MS = Number(process.env.BRIDGE_RELAY_CLIENT_TTL_MS || 60_000);
// x-mirasim-agent：relay 用它决定上游族。默认按模型名自动判定，
// BRIDGE_RELAY_AGENT 显式指定时强制覆盖（排查用）。
const RELAY_AGENT_FORCED = process.env.BRIDGE_RELAY_AGENT?.trim() || null;
function agentForModel(model) {
  if (RELAY_AGENT_FORCED) return RELAY_AGENT_FORCED;
  const m = String(model ?? '');
  if (/^gpt-|^codex/i.test(m)) return 'codex';
  if (/^deepseek-/i.test(m)) return 'dsh';
  if (/^glm/i.test(m)) return 'glm';
  if (/^kimi/i.test(m)) return 'kimi';
  if (/^gemini/i.test(m)) return 'gemini';
  return 'claude';
}
// crypto-core 从官方客户端提取（纯 WASM、无 import），cc_sign / cc_seal 与服务端同源。
const RELAY_CORE_PATH = process.env.BRIDGE_RELAY_CORE || path.join(__dirname, 'core.wasm');
// relay 侧 mrs-seal-v1 信封公钥（server.cjs 常量 hso），改动会导致解封失败。
const RELAY_SEAL_PUBKEY = Buffer.from('HlyNMMeGXryasYLJuYQ/9ksCD4AYVVy1zXKAtJdpJn4=', 'base64');
// 计费块：与官方 claude-cli 2.1.280 对齐（cc_version=<CLI 版本>.<build>；cc_entrypoint 由 mirasim 注入）
const RELAY_BILLING = process.env.BRIDGE_RELAY_BILLING ||
  'x-anthropic-billing-header: cc_version=2.1.280.14d; cc_entrypoint=mirasim;';
// 官方 claude-cli 2.1.280（本机 MIRASIM_CLAUDE_BIN 指向的二进制）实测发出的 beta 组，
// 外加 1M 上下文模型会附带的 context-1m-2025-08-07；relay 会自行剥掉 oauth-2025-04-20。
const RELAY_BETA = process.env.BRIDGE_RELAY_BETA ||
  'claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,'
  + 'context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,'
  + 'mid-conversation-tool-changes-2026-07-01,effort-2025-11-24';
const RELAY_TIMEOUT = Number(process.env.BRIDGE_RELAY_TIMEOUT_MS || 600_000);
// 单次客户端请求在 relay 上最多耗多久。隧道（Cloudflare）对源站响应有 ~100 秒上限，
// 而上游排队时「3 发对冲 × 每发 3 次重试 + 5xx 后再转一轮」实测能跑到 110~130 秒：
// 客户端要么拿到 524，要么（2026-10-06 实测）干脆什么都没有。这里设一道总闸 ——
// 到点就收手，回一个可重试的 503，让客户端按自己的退避重来，比让它干等更划算。
const RELAY_DEADLINE_MS = Number(process.env.BRIDGE_RELAY_DEADLINE_MS || 90_000);
// 是否保留 prompt cache 断点（cache_control）。默认保留；=0 退回全剥（老行为，仅排查用）。
const RELAY_CACHE = process.env.BRIDGE_RELAY_CACHE !== '0';

let relayCred = null;   // { issuerToken, deviceId, publicKeyB64, sign, userId }
let relayTicket = null; // { ticket, expiresAtMs }
let relayMintFailLogged = false;
let relayKeyHex = null;     // 解密用的 64-hex（回写 token 时复用）
let relaySettingPath = null;// setting.json 路径（refresh 后原位写回）

// ── 时钟偏差补偿 ───────────────────────────────────────────────────────────
// 设备签名里带时间戳，relay 会校验窗口，偏太多直接 401
// {"code":"device_clock_skew","message":"device session timestamp outside the accepted window"}。
// 实测 2026-09-26 重启后本机 UTC 比真实时间慢了 **8 小时**（日志/文件时间也全错），
// 整条通道因此全 503。系统时间要管理员权限才能改，这里改成**从 HTTP Date 头测偏差并补偿**：
// 不提权、也不依赖本机时钟是否同步过。
let clockOffsetMs = 0;
let clockCheckedAt = 0;
const CLOCK_TTL_MS = 300_000; // 5 分钟复测一次

async function ensureClockOffset() {
  if (clockCheckedAt && Date.now() - clockCheckedAt < CLOCK_TTL_MS) return clockOffsetMs;
  clockCheckedAt = Date.now();
  try {
    const r = await fetch(`${RELAY_BASE}/`, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    const d = r.headers.get('date');
    const server = d ? Date.parse(d) : NaN;
    if (Number.isFinite(server)) {
      const off = server - Date.now();
      if (Math.abs(off) > 2000) {
        clockOffsetMs = off;
        reqLog({ level: 'warn', reason: 'clock_skew_compensated', offsetMs: Math.round(off), note: '本机时钟与上游差这么多，签名时间戳已按偏差补偿' });
      } else {
        clockOffsetMs = 0;
      }
    }
  } catch { /* 取不到就沿用上次偏差（0 = 不补偿） */ }
  return clockOffsetMs;
}

/** 签名用的"上游时间"：本机时间 + 偏差。 */
const relayNow = () => Date.now() + clockOffsetMs;

/** 当前应模拟的官方客户端版本（见 RELAY_CLIENT_FALLBACK 处注释）。 */
let relayClientCache = { value: null, at: 0 };
function relayClientVersion() {
  const forced = process.env.BRIDGE_RELAY_CLIENT?.trim();
  if (forced) return forced;
  const now = Date.now();
  if (relayClientCache.value && now - relayClientCache.at < RELAY_CLIENT_TTL_MS) return relayClientCache.value;
  let v = null;
  try {
    const st = JSON.parse(fs.readFileSync(path.join(MIRASIM_HOME, 'app', 'state.json'), 'utf8'));
    if (typeof st?.good === 'string' && /^\d+\.\d+\.\d+$/.test(st.good.trim())) v = st.good.trim();
  } catch { /* 无 state.json：官方未自更新过或路径不同 */ }
  if (!v) {
    try {
      v = fs.readdirSync(path.join(MIRASIM_HOME, 'app'), { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d+\.\d+\.\d+$/.test(d.name))
        .map((d) => d.name)
        .sort((a, b) => {
          const [a1, a2, a3] = a.split('.').map(Number), [b1, b2, b3] = b.split('.').map(Number);
          return (b1 - a1) || (b2 - a2) || (b3 - a3);
        })[0] ?? null;
    } catch { /* 目录不可读则用兜底常量 */ }
  }
  relayClientCache = { value: v || RELAY_CLIENT_FALLBACK, at: now };
  return relayClientCache.value;
}

function aesGcmDecryptB64(mrs1, keyHex) {
  if (typeof mrs1 !== 'string' || !mrs1.startsWith('mrs1:')) return mrs1;
  const b = Buffer.from(mrs1.slice(5), 'base64');
  const iv = b.subarray(0, 12), tag = b.subarray(12, 28), ct = b.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/** mrs1 加密（与官方一致：iv12 + tag16 + ct），供 refresh 后回写 setting.json。 */
function aesGcmEncryptB64(plain, keyHex) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return 'mrs1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

/** 读 JWT payload。 */
function jwtPayload(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
  catch { return null; }
}

/** 用 refreshToken 换新 token（官方端点 auth.mirasim.ai/auth/refresh），成功后写回 setting.json。 */
async function relayRefreshTokens() {
  if (!relayCred?.refreshToken || !relaySettingPath) return false;
  try {
    const loginBase = 'https://auth.mirasim.ai';
    const r = await fetch(`${loginBase}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: relayCred.refreshToken }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) {
      reqLog({ level: 'warn', reason: 'relay_refresh_failed', status: r.status, body: (await r.text().catch(() => '')).slice(0, 200) });
      return false;
    }
    const j = await r.json().catch(() => null);
    const newToken = j?.access_token;
    if (typeof newToken !== 'string') { reqLog({ level: 'warn', reason: 'relay_refresh_no_token' }); return false; }
    const newRefresh = typeof j?.refresh_token === 'string' && j.refresh_token ? j.refresh_token : relayCred.refreshToken;
    const p = jwtPayload(newToken);
    const userId = typeof p?.sub === 'string' ? p.sub : relayCred.userId;

    // 写回 setting.json（保持 mrs1 加密格式，与 GUI 后续读取兼容）
    try {
      const raw = JSON.parse(fs.readFileSync(relaySettingPath, 'utf8'));
      raw.auth = {
        ...(raw.auth ?? {}),
        token: aesGcmEncryptB64(newToken, relayKeyHex),
        refreshToken: aesGcmEncryptB64(newRefresh, relayKeyHex),
        userId, exp: typeof p?.exp === 'number' ? p.exp : Math.floor(Date.now() / 1000) + 3600,
      };
      fs.writeFileSync(relaySettingPath, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
    } catch (e) {
      reqLog({ level: 'warn', reason: 'relay_refresh_writeback_failed', error: String(e.message) });
    }
    relayCred.issuerToken = newToken;
    relayCred.userId = userId;
    relayCred.refreshToken = newRefresh;
    relayTicket = null; // ticket 与旧 token 绑定，强制重铸
    reqLog({ level: 'info', reason: 'relay_token_refreshed', exp: p?.exp ?? null });
    return true;
  } catch (e) {
    reqLog({ level: 'warn', reason: 'relay_refresh_error', error: String(e.message) });
    return false;
  }
}

/** DPAPI 解 ~/.mirasim/secret.key（Windows 专属；失败返回 null 由调用方处理）。
 *  实测：secret.key 是 hex 文本的 DPAPI blob；Unprotect 解出的明文是
 *  UTF-16LE 编码的 64 字符 hex 密钥（MIRASIM_SECRET_KEY 同值）。 */
function dpapiUnprotectHex(hex) {
  try {
    const b64 = Buffer.from(hex, 'hex').toString('base64');
    const script =
      `Add-Type -AssemblyName System.Security;`
      + `$b=[Convert]::FromBase64String('${b64}');`
      + `$u=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);`
      + `if($null -eq $u){exit 3}; [Convert]::ToBase64String($u)`;
    let out = null;
    for (const shell of ['powershell.exe', 'pwsh.exe']) {
      try {
        out = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script],
          { encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 1 << 20 });
        if (out) break;
      } catch { /* 尝试下一个 shell */ }
    }
    if (!out) return null;
    const b64out = out.trim().split(/\r?\n/).pop();
    const plain = Buffer.from(b64out, 'base64');
    // UTF-16LE（带 BOM 或交替空字节）→ 字符串
    let text = plain.toString('utf16le').replace(/^\uFEFF/, '').trim();
    if (!/^[0-9a-fA-F]{64}$/.test(text)) {
      // 兜底：把明文当 UTF-8 文本（理论覆盖未来格式变化）
      const t8 = plain.toString('utf8').trim();
      if (/^[0-9a-fA-F]{64}$/.test(t8)) text = t8;
      else return null;
    }
    return text;
  } catch { return null; }
}

/** 读取并解密官方凭据。返回 null 表示不可用（未登录/无凭据），通道自动降级。 */
function loadRelayCredentials() {
  if (!RELAY_DIRECT_ENABLED || !MIRASIM_HOME) return null;
  try {
    relaySettingPath = path.join(MIRASIM_HOME, 'setting.json');
    const setting = JSON.parse(fs.readFileSync(relaySettingPath, 'utf8'));
    let keyHex = process.env.MIRASIM_SECRET_KEY?.trim();
    if (!keyHex) {
      const skPath = path.join(MIRASIM_HOME, 'secret.key');
      if (!fs.existsSync(skPath)) return null;
      const blobHex = fs.readFileSync(skPath, 'utf8').trim();
      keyHex = dpapiUnprotectHex(blobHex);
    }
    if (!keyHex || keyHex.length !== 64) return null;
    relayKeyHex = keyHex;
    const tok = setting.auth?.token ?? setting.authToken ?? null;
    const privPem = setting.device?.privateKey ?? setting.devicePrivateKey ?? null;
    if (!tok || !privPem) return null;
    const issuerToken = aesGcmDecryptB64(tok, keyHex);
    const devicePem = aesGcmDecryptB64(privPem, keyHex);
    const pubB64 = crypto.createPublicKey(devicePem).export({ format: 'der', type: 'spki' }).toString('base64');
    const deviceId = crypto.createHash('sha256').update(pubB64).digest('base64url').slice(0, 22);
    const payload = jwtPayload(issuerToken);
    const userId = typeof payload?.sub === 'string' ? payload.sub : null;
    const exp = typeof payload?.exp === 'number' ? payload.exp : null;
    let refreshToken = null;
    if (setting.auth?.refreshToken) {
      const rt = aesGcmDecryptB64(setting.auth.refreshToken, keyHex);
      if (typeof rt === 'string' && rt.startsWith('eyJ')) refreshToken = rt;
    }
    // crypto-core 的 cc_sign 只吃 32 字节 Ed25519 seed（不是 PEM），从 JWK.d 取。
    let seed = null;
    try {
      const jwk = crypto.createPrivateKey(devicePem).export({ format: 'jwk' });
      if (typeof jwk?.d === 'string') seed = Buffer.from(jwk.d, 'base64url');
    } catch { /* 极端情况：非 Ed25519 私钥，签名通道不可用 */ }
    relayCred = {
      issuerToken, refreshToken, exp, deviceId, publicKeyB64: pubB64, userId,
      seed: seed && seed.length === 32 ? seed : null,
      sign: (msg) => crypto.sign(null, Buffer.from(msg), crypto.createPrivateKey(devicePem)).toString('base64url'),
    };
    return relayCred;
  } catch {
    relayCred = null;
    return null;
  }
}

/** token 过期（或 401 被拒）时先重新读 setting.json（GUI 可能已刷新），再 refresh。 */
async function ensureFreshIssuerToken() {
  if (!relayCred) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  // 1) 内存 token 仍有效则直接用
  if (typeof relayCred.exp === 'number' && relayCred.exp - nowSec > 300) return true;
  // 2) 重新读盘：GUI/CLI 可能已自己刷新过了
  const fresh = loadRelayCredentials();
  if (fresh && typeof fresh.exp === 'number' && fresh.exp - nowSec > 300 && fresh.issuerToken) return true;
  // 3) 都没有 → 用 refreshToken 主动刷新
  return relayRefreshTokens();
}

// ── 设备签名核心（官方 crypto-core WASM，cc_sign / cc_seal）───────────────
let relayCore = null;        // WebAssembly exports 或 null
let relayCoreLoaded = false; // 只尝试加载一次，失败不反复读盘

function relayCoreInstance() {
  if (relayCoreLoaded) return relayCore;
  relayCoreLoaded = true;
  try {
    const buf = fs.readFileSync(RELAY_CORE_PATH);
    relayCore = new WebAssembly.Instance(new WebAssembly.Module(buf), {}).exports;
  } catch (e) {
    relayCore = null;
    reqLog({ level: 'warn', reason: 'relay_core_unavailable', path: RELAY_CORE_PATH, error: String(e.message) });
  }
  return relayCore;
}

/** 官方 PCn()：把若干 Buffer 拷进 wasm 内存 → 调函数 → 读回返回值（i64 高 32 位是 ptr，低 32 位是 len）。 */
function relayCoreCall(fn, args) {
  const core = relayCoreInstance();
  if (!core || typeof fn !== 'function') return null;
  const allocs = args.map((a) => {
    const bytes = typeof a === 'string' ? Buffer.from(a, 'utf8') : a;
    const ptr = core.cc_alloc(bytes.length);
    new Uint8Array(core.memory.buffer).set(bytes, ptr);
    return [ptr, bytes.length];
  });
  try {
    const ret = BigInt(fn(...allocs.flat()));
    const hi = Number(ret >> 32n), lo = Number(ret & 0xffffffffn);
    if (hi === 0) return null; // 空指针 → 签名失败
    const out = Buffer.from(new Uint8Array(core.memory.buffer, hi, lo));
    core.cc_free(hi, lo);
    return out;
  } finally {
    for (const [p, l] of allocs) core.cc_free(p, l);
  }
}

const relayNul = (v) => {
  const s = String(v ?? '');
  if (s.includes('\0')) throw new Error('mirasim: signature field contains NUL');
  return s;
};

/** 新版签名头（对应官方 Mpt()）：credential 铸票时是 issuer token，业务请求时是 ticket。
 *  extraMeta 会被 \0 串进签名，因此必须与随后封进 x-mirasim-enc 的元数据一字不差。 */
function relaySignHeaders(method, pathname, bodyBuf, credential, extraMeta) {
  if (!relayCred?.seed) return null;
  const ts = String(relayNow()); // 带时钟偏差补偿：本机时钟不准也不会被判 device_clock_skew
  const nonce = crypto.randomBytes(12).toString('base64url'); // 官方 randomBytes(12)
  // 版本必须同时出现在签名 canonical 与 x-mirasim-client 头里，因此一次请求内只取一次快照。
  const clientVersion = relayClientVersion();
  const canon = [method.toUpperCase(), pathname, ts, nonce, relayCred.deviceId, clientVersion, credential]
    .map(relayNul).join('\0');
  const metaStr = Object.entries(extraMeta ?? {})
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => relayNul(k) + '\0' + relayNul(v)).join('\0');
  const sig = relayCoreCall(relayCoreInstance()?.cc_sign, [
    relayCred.seed, Buffer.from(canon, 'utf8'), Buffer.from(metaStr, 'utf8'), bodyBuf,
  ]);
  if (!sig) return null;
  return {
    'x-mirasim-device': relayCred.deviceId,
    'x-mirasim-ts': ts,
    'x-mirasim-nonce': nonce,
    'x-mirasim-sig': sig.toString('base64url'),
    'x-mirasim-client': clientVersion,
  };
}

/** 封套（对应官方 elt()）：除 x-mirasim-client / x-mirasim-enc 外，所有 x-mirasim-*
 *  头都塞进 mrs-seal-v1 信封写成 x-mirasim-enc，原头删除。relay 解封后验签。 */
function relaySealHeaders(headers, method, pathname) {
  const keys = Object.keys(headers).filter((k) => {
    const l = k.toLowerCase();
    return l.startsWith('x-mirasim-') && l !== 'x-mirasim-client' && l !== 'x-mirasim-enc';
  });
  if (!keys.length) return headers;
  const meta = {};
  for (const k of keys) meta[k] = headers[k];
  const sealed = relayCoreCall(relayCoreInstance()?.cc_seal, [
    RELAY_SEAL_PUBKEY,
    crypto.randomBytes(32), // 官方 randomBytes(32)：信封临时密钥种子
    crypto.randomBytes(12), // 官方 randomBytes(12)：信封 nonce
    Buffer.from(JSON.stringify(meta), 'utf8'),
    Buffer.from(`mrs-seal-v1\n${method.toUpperCase()}\n${pathname}`, 'utf8'),
  ]);
  if (!sealed) return headers;
  headers['x-mirasim-enc'] = sealed.toString('base64url');
  for (const k of keys) delete headers[k];
  return headers;
}

/** 旧版明文签名（0.0.224 时代的 mrs-sig-v1）。上游已按 client_outdated 拒绝，
 *  仅在 core.wasm 缺失时作为降级路径保留，用于排查。 */
function mrsSigHeaders(method, pathname, bodyBuf) {
  const ts = String(relayNow());
  const nonce = crypto.randomBytes(24).toString('base64url');
  const payload = ['mrs-sig-v1', method.toUpperCase(), pathname, ts, nonce,
    crypto.createHash('sha256').update(bodyBuf).digest('hex')].join('\n');
  return {
    'x-mirasim-device': relayCred.deviceId,
    'x-mirasim-ts': ts,
    'x-mirasim-nonce': nonce,
    'x-mirasim-sig': relayCred.sign(payload),
    'x-mirasim-client': relayClientVersion(),
  };
}

/** 签名 + 封套一步到位；core 不可用时回落到旧版明文签名。 */
function relayAuthHeaders(method, pathname, bodyBuf, credential, extraMeta, seal) {
  const signable = relayCred?.seed ? relaySignHeaders(method, pathname, bodyBuf, credential, extraMeta) : null;
  if (!signable) return { headers: mrsSigHeaders(method, pathname, bodyBuf), sealed: false };
  const headers = { ...(extraMeta ?? {}), ...signable };
  if (seal !== false) relaySealHeaders(headers, method, pathname);
  return { headers, sealed: seal !== false };
}

let relayMintInFlight = null; // single-flight：并发请求共享同一次 mint
let lastRelayFailure = null;  // 最近一次 relay 失败原因，503 时带出便于定位
let lastRelayMeta = {};       // 最近一次 relay 请求实际下发的 effort / tier（给 /stats 用）
let lastRelayWasNetworkError = false; // 最近一次失败是不是"网络层"（连不上/被掐断）而非上游 5xx

/** 铸造/复用设备会话 ticket（15 分钟有效，缓存到期自动续）。
 *  single-flight：ticket 到期瞬间大量并发请求共享同一次 mint，
 *  避免每请求都打 /v1/device/session、也避免瞬时失败直接 503。 */
async function relayMintTicket() {
  if (relayTicket && Date.now() < relayTicket.expiresAtMs - 60_000) return relayTicket.ticket;
  if (relayMintInFlight) return relayMintInFlight;
  relayMintInFlight = (async () => {
    // token 过期或接近过期先刷新/重载
    if (!(await ensureFreshIssuerToken())) { lastRelayFailure = 'issuer token 不可用（凭据缺失或刷新失败）'; return null; }
    await ensureClockOffset(); // 铸票要签名带时间戳：先对齐上游时间，避免 device_clock_skew
    const bodyBuf = Buffer.from(JSON.stringify({ publicKey: relayCred.publicKeyB64, deviceId: relayCred.deviceId }));
    // 铸票本身也要带设备签名（credential = issuer token）；官方此请求不做封套。
    const mintAuth = relayAuthHeaders('POST', '/v1/device/session', bodyBuf, relayCred.issuerToken, {}, false);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(`${RELAY_BASE}/v1/device/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + relayCred.issuerToken, ...mintAuth.headers },
          body: bodyBuf,
          signal: AbortSignal.timeout(RELAY_TIMEOUT),
        });
        const j = await r.json().catch(() => null);
        if (r.ok && j?.ticket) {
          const expiresAtMs = typeof j.expiresAt === 'number' ? j.expiresAt * 1000 : Date.now() + 840_000;
          relayTicket = { ticket: j.ticket, expiresAtMs };
          lastRelayFailure = null;
          reqLog({ level: 'info', reason: 'relay_ticket', device: relayCred.deviceId, expiresIn: j.expiresIn ?? null });
          return j.ticket;
        }
        // 401 → token 失效：清掉缓存强制下次重载/刷新
        if (r.status === 401) {
          relayTicket = null;
          relayCred.exp = 0; // 强制下次 ensureFreshIssuerToken 走刷新
          lastRelayFailure = 'device/session 401：token 失效';
          reqLog({ level: 'warn', reason: 'relay_ticket_unauthorized', body: trunc(j ?? {}) });
          return null;
        }
        // 5xx/网络类瞬时错误：短暂等待后重试一次
        if (attempt === 0 && r.status >= 500) {
          lastRelayFailure = `device/session ${r.status}（瞬时）`;
          markRelayBusy(`mint ${r.status}`); // 铸票都 5xx 了，后面的请求直接进对冲
          reqLog({ level: 'warn', reason: 'relay_ticket_retry', status: r.status });
          await new Promise((res) => setTimeout(res, 800));
          continue;
        }
        lastRelayFailure = `device/session ${r.status} ${JSON.stringify(j ?? {}).slice(0, 120)}`;
        lastRelayWasNetworkError = false; // 有 HTTP 响应：是上游状态，不是链路故障
        reqLog({ level: 'warn', reason: 'relay_ticket_failed', status: r.status, body: trunc(j ?? {}) });
        return null;
      } catch (e) {
        if (attempt === 0) {
          lastRelayFailure = 'device/session 网络错误（瞬时）：' + String(e.message);
          reqLog({ level: 'warn', reason: 'relay_ticket_error_retry', error: String(e.message) });
          await new Promise((res) => setTimeout(res, 800));
          continue;
        }
        if (!relayMintFailLogged) { reqLog({ level: 'warn', reason: 'relay_ticket_error', error: String(e.message) }); relayMintFailLogged = true; }
        lastRelayFailure = 'device/session 网络错误：' + String(e.message);
        lastRelayWasNetworkError = true; // 铸票就栽在链路上 → 后面的 503 不该触发对冲
        return null;
      }
    }
    return null;
  })().finally(() => { relayMintInFlight = null; });
  return relayMintInFlight;
}

/** 由会话标识派生确定性的 UUID：相同对话复用同一 session，吃到 prompt cache。 */
function relaySessionFromId(id) {
  if (!id) return crypto.randomUUID();
  const h = crypto.createHash('sha256').update(String(id)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** 思考摘要模式：上游只认 summarized / omitted（full 回 400），
 *  默认 summarized —— 即「不特别要求就给思考摘要」。BRIDGE_THINKING_DISPLAY 可改。 */
const THINKING_DISPLAY = (() => {
  const v = (process.env.BRIDGE_THINKING_DISPLAY || 'summarized').trim().toLowerCase();
  return v === 'omitted' ? 'omitted' : 'summarized';
})();
// 客户端显式要 omitted 时是否仍给摘要。默认尊重客户端；Claude Code 自己默认发
// display:omitted（抓包实测），想让它在桥上也能看到思考就设 BRIDGE_THINKING_FORCE_SUMMARIZED=1。
const THINKING_FORCE_SUMMARIZED = process.env.BRIDGE_THINKING_FORCE_SUMMARIZED === '1';

/** 思考字段归一化（claude 系）。
 *  实测（2026-09-25，relay）：
 *    - 不带 thinking               → 本层补 adaptive+summarized → 回摘要（137 字）
 *    - {type:'adaptive'}           → relay 默认不回正文（0 字）
 *    - {type:'enabled',budget:N}   → 200 但同样 0 字（加了 display:summarized 也是 0 字）
 *    - {display:'omitted'}         → 0 字（预期）
 *  即**只有 adaptive + display:summarized 才有摘要**，客户端自带 thinking 时不能原样透传，
 *  否则等于把摘要关掉了。客户端显式要 omitted / disabled 时尊重，只把 type 拉回 adaptive
 *  （disabled 上游不认）。codex/dsh 系没有思考摘要，原样不动。 */
function ensureRelayThinking(bodyObj, model) {
  if (!isClaudeReal(model)) return;
  // haiku 不是推理模型：带 thinking 字段上游直接 400 rejected as invalid（实测），
  // 所以对 haiku 一律不注入、也不透传客户端的 thinking。
  if (/haiku/i.test(model ?? '')) {
    if (bodyObj.thinking) {
      reqLog({ level: 'info', reason: 'thinking_dropped', model });
      delete bodyObj.thinking;
    }
    return;
  }
  const t = bodyObj.thinking;
  if (!t || typeof t !== 'object' || Array.isArray(t)) {
    bodyObj.thinking = { type: 'adaptive', display: THINKING_DISPLAY };
    return;
  }
  // adaptive 不接受 budget_tokens（实测 {type:'adaptive',budget_tokens:N} → 400 rejected as invalid），
  // 客户端按官方文档发的 {type:'enabled',budget_tokens:N} 必须连预算一起摘掉。
  const { budget_tokens: _budget, ...rest } = t;
  if ((t.type === 'disabled' || t.display === 'omitted') && !THINKING_FORCE_SUMMARIZED) {
    if (t.type !== 'adaptive' || t.display !== 'omitted') {
      reqLog({ level: 'info', reason: 'thinking_normalized', model, from: { type: t.type ?? null, display: t.display ?? null }, to: 'omitted' });
    }
    bodyObj.thinking = { ...rest, type: 'adaptive', display: 'omitted' };
    return;
  }
  if (t.type === 'adaptive' && t.display === THINKING_DISPLAY && !('budget_tokens' in t)) return;
  reqLog({ level: 'info', reason: 'thinking_normalized', model, from: { type: t.type ?? null, display: t.display ?? null, budget_tokens: t.budget_tokens ?? null }, to: THINKING_DISPLAY });
  bodyObj.thinking = { ...rest, type: 'adaptive', display: THINKING_DISPLAY };
}

/** 思考等级（reasoning effort）：官方 claude-cli 用 **`output_config.effort`** 传
 *  （抓包实测 2026-09-25：`{"output_config":{"effort":"max"}}`，同时带 `effort-2025-11-24` beta）。
 *  取值 low / medium / high / xhigh / max —— Mirasim 界面里的 `ultra` 就是 `max`
 *  （官方把它映射成 `--effort max` 再发给 CLI）。
 *  客户端没传就按 BRIDGE_RELAY_EFFORT 补（默认 max）；客户端传了则尊重。
 *  设 BRIDGE_RELAY_EFFORT='' 可关掉默认注入。
 *  BRIDGE_RELAY_EFFORT_CAP 可设**上限**（如 high）：客户端要 max 也压到 high ——
 *  实测 opus-5-5 上 max 会比 high 多花 ~9s 思考（903 vs 630 thinking tokens），
 *  首字可见时间从 4.2s 涨到 13.3s，感觉"慢"多半来自这里。默认不设上限。 */
const RELAY_EFFORT = (process.env.BRIDGE_RELAY_EFFORT ?? 'max').trim().toLowerCase();
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
const RELAY_EFFORT_CAP = (() => {
  const v = (process.env.BRIDGE_RELAY_EFFORT_CAP ?? '').trim().toLowerCase();
  return EFFORT_LEVELS.has(v) ? v : null;
})();

function normalizeEffort(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (!s) return null;
  return s === 'ultra' ? 'max' : (EFFORT_LEVELS.has(s) ? s : null); // ultra 是界面叫法，上游只认 max
}

/** 返回本次请求实际下发的 effort（客户端指定优先，否则补默认值；不适用则 null）。 */
function ensureRelayEffort(bodyObj, model) {
  if (!isClaudeReal(model)) return null; // codex / dsh 走各自协议，effort 字段形态未验证，不动
  const oc = (bodyObj.output_config && typeof bodyObj.output_config === 'object' && !Array.isArray(bodyObj.output_config))
    ? bodyObj.output_config : {};
  const clientEffort = normalizeEffort(oc.effort ?? bodyObj.effort ?? bodyObj.reasoning_effort);
  if (clientEffort) {
    // 上限压制（可选）：只在配置了 CAP 且客户端要得更高时生效
    let eff = clientEffort;
    if (RELAY_EFFORT_CAP && EFFORT_ORDER.indexOf(eff) > EFFORT_ORDER.indexOf(RELAY_EFFORT_CAP)) {
      eff = RELAY_EFFORT_CAP;
      reqLog({ level: 'info', reason: 'effort_capped', model, from: clientEffort, to: eff });
    }
    if (oc.effort !== eff) bodyObj.output_config = { ...oc, effort: eff };
    return eff;
  }
  const fallback = normalizeEffort(RELAY_EFFORT);
  if (!fallback) return null;
  bodyObj.output_config = { ...oc, effort: fallback };
  return fallback;
}

/** 服务等级（`service_tier`）—— OpenAI 协议的优先级机制。
 *  实测 2026-09-26：relay 上的 codex 模型（gpt-6-sol）带 `service_tier: priority`
 *  稳定快 1.3–2.3 倍（1878/2383/3130ms vs 默认 3535/4564/4204ms）。
 *  来源：codex 模型目录里有 `service_tiers: [{id:"priority"}]` 与
 *  `additional_speed_tiers: ["fast"]`，官方客户端把它作为 `--config service_tier=<id>`
 *  下发给 codex CLI。claude 系没有这一层（响应里只有只读的 `service_tier: standard`）。
 *  客户端传了就透传；没传且配了 BRIDGE_SERVICE_TIER 才补 —— priority 通常更贵，默认不开。 */
const SERVICE_TIER = process.env.BRIDGE_SERVICE_TIER?.trim() || null;

function ensureRelayServiceTier(bodyObj, model) {
  const clientTier = typeof bodyObj.service_tier === 'string' ? bodyObj.service_tier.trim() : '';
  if (clientTier) return clientTier; // 客户端显式指定：原样透传
  if (!SERVICE_TIER || !/^(gpt-|codex)/i.test(model ?? '')) return null; // 只有 codex 系认这个字段
  bodyObj.service_tier = SERVICE_TIER;
  return SERVICE_TIER;
}

/** 保证 system 数组含 x-anthropic-billing-header 计费块（relay 硬性要求）。 */
function ensureRelaySystem(payload) {
  const billing = { type: 'text', text: RELAY_BILLING };
  let sys = payload.system;
  if (typeof sys === 'string') sys = [{ type: 'text', text: sys }];
  if (!Array.isArray(sys)) sys = [];
  sys = sys.filter((b) => b?.type === 'text' && typeof b.text === 'string');
  if (!sys.some((b) => b.text.includes('x-anthropic-billing-header'))) sys.unshift(billing);
  return sys;
}

/** 合并客户端的 anthropic-beta 与内置清单：客户端自带的（Claude Code 会发一整串，
 *  含 prompt-caching-scope-* 这类缓存相关 beta）一个不丢，我们补上缺的。
 *  relay 会自己剥掉 oauth-2025-04-20，不必在此处理。 */
function mergeBeta(clientBeta, base) {
  const seen = new Set();
  const out = [];
  for (const raw of [clientBeta, base]) {
    if (typeof raw !== 'string') continue;
    for (const tok of raw.split(',')) {
      const t = tok.trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  }
  return out.join(',');
}

// ── 暴力模式（fan-out）：上游繁忙时一发请求扇成 N 发，谁先出首 token 用谁 ──────
// 动机：2026-09-26 实测平台繁忙时段单发首字 27–90s，而 relay 是**上游池**，
// 多发会落到不同后端，先到先得能显著压低"最慢的那一次"。代价是输入侧多花 N 倍
// （缓存命中的话很便宜），落败的几发在拿到首 token 的瞬间被 abort，不再继续产出。
const BRUTE_FANOUT = Math.max(1, Number(process.env.BRIDGE_BRUTE_FANOUT || 3));
const BRUTE_AUTO = process.env.BRIDGE_BRUTE_AUTO !== '0';       // 繁忙窗口内自动扇出
const BRUTE_ALWAYS = process.env.BRIDGE_BRUTE_ALWAYS === '1';   // 永远扇出（测试/极致速度）
const BRUTE_BUSY_MS = Number(process.env.BRIDGE_BRUTE_BUSY_MS || 300_000); // 客户端请求间隔常达分钟级，窗口太短会整段错过
const BRUTE_TTFT_MS = Number(process.env.BRIDGE_BRUTE_TTFT_MS || 20_000);
let relayBusyUntil = 0;
let relayBusyReason = null;

function markRelayBusy(reason) {
  const until = Date.now() + BRUTE_BUSY_MS;
  if (until > relayBusyUntil) {
    relayBusyUntil = until;
    relayBusyReason = reason;
    stats.totals.busyMarks++;
    stats.lastBusy = { at: new Date().toISOString(), why: reason };
    reqLog({ level: 'warn', reason: 'relay_busy_marked', why: reason, busyForMs: BRUTE_BUSY_MS });
  }
}
const relayLooksBusy = () => Date.now() < relayBusyUntil;
// ── 平台硬拒绝冷却 ───────────────────────────────────────────────────────
// 「平台暂时无法提供 claude-xxx」的 503、以及它换皮后的 400（rejected as invalid）意味着
// 池里**根本没有**可用后端。此时扇出 3 发 × 每发 3 次重试 = 9 次排队，客户端要干等 3 分钟
// 才拿到一个错误（2026-10-06 实测：一次请求 00:10:55 → 00:13:28）。
// 冷却期内只打一发、且不扇出：客户端尽快拿到可重试的 503，自己按退避重试更划算。
// 实时探测每 5s 一发，池子一恢复就会立刻解除冷却（成功路径里清空）。
const REFUSAL_COOLDOWN_MS = Number(process.env.BRIDGE_REFUSAL_COOLDOWN_MS || 60_000);
let relayRefusalUntil = 0;
const refusalCooling = () => Date.now() < relayRefusalUntil;
function markRelayRefusal(why) {
  if (Date.now() >= relayRefusalUntil) {
    reqLog({ level: 'warn', reason: 'relay_refusal_cooldown', why, cooldownMs: REFUSAL_COOLDOWN_MS });
  }
  relayRefusalUntil = Math.max(relayRefusalUntil, Date.now() + REFUSAL_COOLDOWN_MS);
}
const bruteEnabled = () => BRUTE_FANOUT > 1 && !refusalCooling()
  && (BRUTE_ALWAYS || (BRUTE_AUTO && relayLooksBusy()));

// ── 运行统计（只给本地 /stats 用，不进隧道）────────────────────────────────
const STATS_WINDOW = Math.max(10, Number(process.env.BRIDGE_STATS_WINDOW || 200));
const stats = {
  startedAt: Date.now(),
  recent: [],       // 最近 N 条请求摘要（滚动）
  totals: { requests: 0, streams: 0, aborted: 0, fanoutTriggers: 0, fanoutWins: 0, fanoutFailed: 0, busyMarks: 0, errors: 0, probesIntercepted: 0 },
  active: 0,        // 正在进行的上游请求数
  last: null,       // 上一条完成的请求
  lastRequestAt: 0,
  lastBusy: null,
  lastError: null,
};

/** 单条请求的成本估算（用官方 roster 的定价，$/百万 token）。 */
function estimateCostUsd(model, u) {
  const p = pricingFor(model);
  if (!p) return null;
  const per = (n, rate) => ((Number(n) || 0) / 1e6) * (Number(rate) || 0);
  const usd = per(u.inTok, p.input) + per(u.cacheRead, p.cacheRead)
    + per(u.cacheCreate, p.cacheWrite5m ?? p.cacheWrite1h) + per(u.outTok, p.output);
  return Number.isFinite(usd) ? +usd.toFixed(6) : null;
}

function statsRecord(entry) {
  const summary = { at: new Date().toISOString(), ...entry };
  summary.costUsd = entry.costUsd ?? estimateCostUsd(entry.model, entry);
  stats.recent.push(summary);
  if (stats.recent.length > STATS_WINDOW) stats.recent.shift();
  stats.last = summary;
  stats.lastRequestAt = Date.now();
  if (entry.stream) stats.totals.streams++;
  if (entry.error) {
    stats.totals.errors++;
    stats.totals.aborted++;
    stats.lastError = { at: summary.at, model: entry.model, error: String(entry.error).slice(0, 300) };
  }
}

function statsSnapshot() {
  const r = stats.recent;
  const sum = (k) => r.reduce((a, b) => a + (Number(b[k]) || 0), 0);
  const inTok = sum('inTok'), cacheRead = sum('cacheRead'), outTok = sum('outTok');
  const denom = inTok + cacheRead;
  const ttfts = r.map((x) => x.ttftMs).filter((v) => typeof v === 'number' && v > 0).sort((a, b) => a - b);
  const q = (p) => (ttfts.length ? ttfts[Math.min(ttfts.length - 1, Math.floor(ttfts.length * p))] : null);
  const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
  return {
    ok: true,
    now: new Date().toISOString(),
    status: {
      uptimeSec: Math.round((Date.now() - stats.startedAt) / 1000),
      activeUpstreamRequests: stats.active,
      lastRequestAt: stats.lastRequestAt ? new Date(stats.lastRequestAt).toISOString() : null,
      lastRequestAgoSec: stats.lastRequestAt ? +((Date.now() - stats.lastRequestAt) / 1000).toFixed(1) : null,
      upstreamBusy: relayLooksBusy(),
      upstreamBusyReason: relayLooksBusy() ? relayBusyReason : null,
      upstreamBusyForMs: relayLooksBusy() ? Math.max(0, relayBusyUntil - Date.now()) : 0,
      lastBusy: stats.lastBusy,
      lastError: stats.lastError,
    },
    fanout: {
      enabled: bruteEnabled(),
      configured: BRUTE_FANOUT,
      auto: BRUTE_AUTO,
      always: BRUTE_ALWAYS,
      busyWindowMs: BRUTE_BUSY_MS,
      ttftThresholdMs: BRUTE_TTFT_MS,
      triggeredTotal: stats.totals.fanoutTriggers,
      wonTotal: stats.totals.fanoutWins,
      failedTotal: stats.totals.fanoutFailed,
      triggeredRecently: r.filter((x) => x.brute).length,
    },
    lastMessage: stats.last,
    window: {
      size: r.length,
      cacheHitRate: denom ? +(cacheRead / denom).toFixed(4) : null,
      cacheHitStreams: r.filter((x) => (x.cacheRead || 0) > 0).length,
      avgTtftMs: avg(ttfts),
      p50TtftMs: q(0.5),
      p90TtftMs: q(0.9),
      maxTtftMs: ttfts.length ? ttfts[ttfts.length - 1] : null,
      inTok, cacheReadTok: cacheRead, outTok,
      costUsd: +sum('costUsd').toFixed(4),
    },
    totals: { ...stats.totals },
    rtProbe: rtProbeSnapshot(),
  };
}

// ── 实时探测：每 N 秒打一发真实的 claude-opus-5-5，结果进 /stats ─────────────
// 用途：`/stats` 只能看到"客户端刚刚发生了什么"，客户端一停就瞎了。
// 这个自驱探测让我们随时知道"此刻上游到底行不行、首字多快"。
// 注意：**这是真请求**，会计入上游额度（默认 5s 一发，max_tokens 很小）。
//   BRIDGE_RT_PROBE_INTERVAL_MS  默认 5000；0 = 关闭
//   BRIDGE_RT_PROBE_MODEL        默认 claude-opus-5-5
//   BRIDGE_RT_PROBE_MAX_TOKENS   默认 8（必须 >=2，否则会被本层的可用性探测拦截）
//   BRIDGE_RT_PROBE_KEEP         滚动保留多少条结果（默认 60）
const RT_PROBE_INTERVAL_MS = Number(process.env.BRIDGE_RT_PROBE_INTERVAL_MS ?? 5_000);
const RT_PROBE_MODEL = process.env.BRIDGE_RT_PROBE_MODEL || 'claude-opus-5-5';
const RT_PROBE_MAX_TOKENS = Math.max(2, Number(process.env.BRIDGE_RT_PROBE_MAX_TOKENS || 8));
const RT_PROBE_KEEP = Math.max(5, Number(process.env.BRIDGE_RT_PROBE_KEEP || 60));
// 探测走**单次 + 短超时**：平台排队时若按正常的 3 次重试 + 长超时，几分钟才出一条结果，
// 那就不叫"实时"了。宁可快速失败 —— 失败本身就是有价值的信息。
// 2026-10-06 调整：平台拒绝服务时是「先排队 30~40 秒再回 400」，15 秒的超时只能看到
// "网络错误"，探测就失去了早期预警作用（冷却也不会被点亮）。放宽到 45 秒刚好覆盖排队。
const RT_PROBE_TIMEOUT_MS = Number(process.env.BRIDGE_RT_PROBE_TIMEOUT_MS || 45_000);
// 探测失败是否点亮"繁忙窗口"（即让真实请求转对冲）。默认 1。
const RT_PROBE_MARKS_BUSY = process.env.BRIDGE_RT_PROBE_MARKS_BUSY !== '0';
const rtProbe = {
  enabled: RT_PROBE_INTERVAL_MS > 0,
  intervalMs: RT_PROBE_INTERVAL_MS,
  model: RT_PROBE_MODEL,
  maxTokens: RT_PROBE_MAX_TOKENS,
  results: [],           // 滚动窗口 [{at, ok, ms, status}]
  running: false,
  lastAt: null, lastOk: null, lastMs: null, lastError: null, lastStatus: null,
  consecutiveFailures: 0, total: 0, ok: 0,
};

function rtProbeSnapshot() {
  const rs = rtProbe.results;
  const ms = rs.map((x) => x.ms).filter((v) => typeof v === 'number').sort((a, b) => a - b);
  const q = (p) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] : null);
  const okCount = rs.filter((x) => x.ok).length;
  return {
    enabled: rtProbe.enabled,
    intervalMs: rtProbe.intervalMs,
    model: rtProbe.model,
    maxTokens: rtProbe.maxTokens,
    running: rtProbe.running,
    lastAt: rtProbe.lastAt,
    lastOk: rtProbe.lastOk,
    lastMs: rtProbe.lastMs,
    lastStatus: rtProbe.lastStatus,
    lastError: rtProbe.lastError,
    consecutiveFailures: rtProbe.consecutiveFailures,
    total: rtProbe.total,
    okTotal: rtProbe.ok,
    successRate: rtProbe.total ? +(rtProbe.ok / rtProbe.total).toFixed(4) : null,
    window: {
      size: rs.length,
      successRate: rs.length ? +(okCount / rs.length).toFixed(4) : null,
      avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null,
      p50Ms: q(0.5), p90Ms: q(0.9), maxMs: ms.length ? ms[ms.length - 1] : null,
    },
    recent: rs.slice(-20),
  };
}

async function runRtProbe() {
  if (!rtProbe.enabled || rtProbe.running) return;
  rtProbe.running = true;
  const t0 = Date.now();
  let ok = false, status = null, error = null, ttftMs = null;
  try {
    // 用**流式**探测：只等首个 content_block_delta 就掐断。
    // 非流式要等整份生成完，5s 的节奏根本等不起（实测第一发就卡住 20s+ 没结果），
    // 而且首字延迟本来就是我们最关心的指标。
    const payload = {
      model: RT_PROBE_MODEL,
      max_tokens: RT_PROBE_MAX_TOKENS,
      stream: true,
      messages: [{ role: 'user', content: 'rt-probe' }], // 文本刻意不落在预热拦截的匹配里
    };
    const r = await tryRelayMessages(payload, 'rt-probe', null, null, { attempts: 1, timeoutMs: RT_PROBE_TIMEOUT_MS });
    status = r?.status ?? null;
    if (r?.ok) {
      const it = r.body[Symbol.asyncIterator]();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const step = await it.next();
        if (step.done) break;
        buf += dec.decode(step.value, { stream: true });
        if (buf.includes('content_block_delta')) { ttftMs = Date.now() - t0; break; }
      }
      await r.body?.cancel?.().catch(() => {}); // 拿到首字立刻掐掉，省输出额度
      ok = ttftMs !== null;
      if (!ok) error = 'no stream event';
    } else if (r) {
      error = `http ${r.status}`;
    } else {
      error = lastRelayFailure ?? 'no relay response';
    }
  } catch (e) {
    error = String(e?.message || e);
  }
  const ms = ttftMs ?? (Date.now() - t0); // 成功时报首字延迟，失败时报整轮耗时
  rtProbe.running = false;
  rtProbe.lastAt = new Date().toISOString();
  rtProbe.lastOk = ok;
  rtProbe.lastMs = ms;
  rtProbe.lastTtftMs = ttftMs;
  rtProbe.lastStatus = status;
  rtProbe.lastError = ok ? null : error;
  rtProbe.total++;
  if (ok) rtProbe.ok++;
  rtProbe.consecutiveFailures = ok ? 0 : rtProbe.consecutiveFailures + 1;
  rtProbe.results.push({ at: rtProbe.lastAt, ok, ms, ttftMs, status, error: ok ? null : error });
  if (rtProbe.results.length > RT_PROBE_KEEP) rtProbe.results.shift();
  // 探测失败 = 上游此刻确实不行 → 点亮繁忙窗口，让真实请求走对冲。
  // 平台长时间排队时这会持续刷新窗口（真实请求全部转对冲、输入侧 x3），
  // 想解耦就把 BRIDGE_RT_PROBE_MARKS_BUSY 设为 0。
  if (!ok && RT_PROBE_MARKS_BUSY) markRelayBusy(`rt-probe ${error}`);
  reqLog({ level: ok ? 'info' : 'warn', reason: 'rt_probe', ok, ms, ttftMs, status, model: RT_PROBE_MODEL, error: ok ? undefined : error });
}

function startRtProbe() {
  if (!rtProbe.enabled) {
    console.log('[bridge] 实时探测: 关闭');
    return;
  }
  console.log(`[bridge] 实时探测: 每 ${RT_PROBE_INTERVAL_MS}ms 一发真实 ${RT_PROBE_MODEL}（max_tokens=${RT_PROBE_MAX_TOKENS}）`);
  setTimeout(() => { runRtProbe().catch(() => {}); }, 2_000);
  setInterval(() => { runRtProbe().catch(() => {}); }, RT_PROBE_INTERVAL_MS);
}

/** 只有本机直连才允许看统计：隧道来的请求一律当作不存在。
 *  注意 cloudflared 也是从 127.0.0.1 连进来的，所以**不能只看来源 IP** ——
 *  还要看 Cloudflare 注入的头与 Host（本地客户端用 127.0.0.1:8787，隧道带的是公网域名）。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const PROXY_HINT_HEADERS = ['cf-connecting-ip', 'cf-ray', 'cf-ipcountry', 'x-forwarded-proto', 'x-forwarded-for', 'x-real-ip', 'cdn-loop', 'forwarded'];
function isLocalDirect(req) {
  const hostHeader = String(req.headers.host || '').toLowerCase();
  if (hostHeader) {
    const host = hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.split(':')[0];
    if (!LOOPBACK_HOSTS.has(host)) return false;
  }
  for (const h of PROXY_HINT_HEADERS) if (req.headers[h]) return false;
  const ip = req.socket?.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/** 等第一个"成功且已吐出首个 token"的候选；全失败返回 null。 */
function firstToken(promises) {
  return new Promise((resolve) => {
    let failed = 0;
    for (const p of promises) {
      p.then((v) => { if (v) resolve(v); else if (++failed === promises.length) resolve(null); })
        .catch(() => { if (++failed === promises.length) resolve(null); });
    }
  });
}

/**
 * 扇出竞速（仅流式）：并发打 N 发，各自读到首个 content_block_delta 为止，
 * 最先拿到的胜出；其余立刻 cancel（连 AbortController 一起断），已读到的字节原样带回给调用方转发。
 */
async function relayRace(payload, clientSessionId, clientBeta, n, mode = 'first-token', deadlineAt = 0) {
  const live = [];
  const allCtrls = []; // 必须在 fetch 之前登记：否则"还在等响应头"的落败方根本掐不掉
  const tasks = [];
  for (let i = 0; i < n; i++) {
    const ctrl = new AbortController();
    allCtrls.push(ctrl);
    tasks.push((async () => {
      const r = await tryRelayMessages(payload, clientSessionId, clientBeta, ctrl, { deadlineAt }).catch(() => null);
      if (!r || !r.ok) return null;
      const entry = { response: r, ctrl, iterator: r.body[Symbol.asyncIterator](), head: [], hasToken: false };
      live.push(entry);
      // 非流式：响应头就是"完成"（上游是整份生成完才回），先到先得，不用再读首 token
      if (mode === 'first-ok') return entry;
      const dec = new TextDecoder();
      let text = '';
      for (;;) {
        const step = await entry.iterator.next();
        if (step.done) break;
        entry.head.push(step.value);
        text += dec.decode(step.value, { stream: true });
        if (text.includes('content_block_delta')) { entry.hasToken = true; break; }
      }
      return entry.hasToken ? entry : null; // 空流不算赢
    })());
  }
  const winner = await firstToken(tasks);
  // 无论谁赢，其余全部掐断（含还在等响应头的那些），上游随即停止产出
  for (const ctrl of allCtrls) {
    if (winner && ctrl === winner.ctrl) continue;
    try { ctrl.abort(); } catch { /* 已结束 */ }
  }
  for (const t of live) {
    if (t === winner) continue;
    t.response.body?.cancel?.().catch(() => {});
  }
  if (!winner) return null;
  return winner;
}

/** 直连 relay 的 /v1/messages。成功返回上游 Response；任何失败返回 null（走网关兜底）。
 *  ctrl：可选 AbortController —— 暴力模式扇出后，落败的那几发要靠它立刻掐断。
 *  opts：{ attempts, timeoutMs } —— 实时探测用「单次 + 短超时」，免得平台排队时
 *  一发探测卡上几分钟（实测第一版探测 70 秒都出不来一条结果）。 */
async function tryRelayMessages(payload, clientSessionId, clientBeta = null, ctrl = null, opts = {}) {
  if (!RELAY_DIRECT_ENABLED || !relayCred && !loadRelayCredentials()) return null;
  if (!relayCred) return null;
  // 平台硬拒绝冷却期内只打一发（见 markRelayRefusal）：重试在这种"池里没后端"的情况下
  // 只是把客户端的等待放大 N 倍，并不会碰上好后端。
  const maxAttempts = refusalCooling() ? 1 : Math.max(1, Number(opts.attempts ?? 3));
  const timeoutMs = Number(opts.timeoutMs ?? RELAY_TIMEOUT);
  const ticket = await relayMintTicket();
  if (!ticket) return null;
  const signal = ctrl
    ? AbortSignal.any([AbortSignal.timeout(timeoutMs), ctrl.signal])
    : AbortSignal.timeout(timeoutMs);

  const sessionId = relaySessionFromId(clientSessionId);
  const bodyObj = JSON.parse(JSON.stringify(payload));
  delete bodyObj.cache_control; // 顶层无此字段，防御性删除
  // prompt cache 断点：0.0.362 实测块级 cache_control（system / 消息内容块 / tools）
  // 上游**全部接受**（三种断点同时带上也是 200）。老代码整块剥掉是 0.0.224 时代的结论，
  // 那等于把缓存命中率摁到 0 —— 现在只剥 Claude Code 的 cache_control.scope 扩展，
  // 保留 type/ttl 断点。BRIDGE_RELAY_CACHE=0 可退回"全剥"。
  if (RELAY_CACHE) {
    stripCacheScope(bodyObj);
  } else {
    if (Array.isArray(bodyObj.messages)) {
      for (const m of bodyObj.messages) {
        if (Array.isArray(m?.content)) {
          for (const b of m.content) delete b?.cache_control;
        }
      }
    }
    if (Array.isArray(bodyObj.system)) {
      for (const b of bodyObj.system) delete b?.cache_control;
    }
    if (Array.isArray(bodyObj.tools)) {
      for (const t of bodyObj.tools) delete t?.cache_control;
    }
  }
  bodyObj.system = ensureRelaySystem(payload);
  ensureRelayThinking(bodyObj, payload.model);
  const relayEffort = ensureRelayEffort(bodyObj, payload.model);
  const relayTier = ensureRelayServiceTier(bodyObj, payload.model);
  lastRelayMeta = { effort: relayEffort, tier: relayTier }; // 给 /stats 看"实际下发了什么"
  if (typeof bodyObj.metadata?.user_id !== 'string' && relayCred.userId) {
    bodyObj.metadata = { ...(bodyObj.metadata ?? {}), user_id: relayCred.userId };
  }
  for (const [k, v] of Object.entries(bodyObj)) if (v === null) delete bodyObj[k];

  const bodyBuf = Buffer.from(JSON.stringify(bodyObj), 'utf8');
  // 客户端指纹：2026-09 实测官方 claude-cli 2.1.280（MIRASIM_CLAUDE_BIN 指向的二进制）
  // 在 CLAUDE_CODE_ENTRYPOINT=mirasim 下发出的头组。GUI 走 SDK 时入口是 sdk-cli，
  // 两个后缀都真实存在于官方流量里，按会话确定性地轮换。
  const uaPool = [
    'claude-cli/2.1.280 (external, mirasim)',
    'claude-cli/2.1.280 (external, sdk-cli)',
  ];
  const uaSeed = clientSessionId ? crypto.createHash('sha256').update(String(clientSessionId)).digest()[0] : crypto.randomBytes(1)[0];
  const relayUA = uaPool[uaSeed % uaPool.length];
  // 每次请求尝试必须使用全新 call-id / nonce / 签名；复用它们会被上游当作重复调用。
  const headersForAttempt = (attempt) => {
    const headers = {
      'accept': 'application/json',
      'content-type': 'application/json',
      'user-agent': relayUA,
      'x-claude-code-session-id': sessionId,
      'x-stainless-arch': 'x64', 'x-stainless-lang': 'js', 'x-stainless-os': 'Windows',
      'x-stainless-package-version': '0.112.1',
      'x-stainless-retry-count': String(attempt),
      'x-stainless-runtime': 'node', 'x-stainless-runtime-version': 'v26.3.0', 'x-stainless-timeout': '600',
      'anthropic-beta': mergeBeta(clientBeta, RELAY_BETA),
      'anthropic-dangerous-direct-browser-access': 'true',
      'anthropic-version': '2023-06-01',
      'x-app': 'cli',
      'authorization': 'Bearer ' + ticket,
      // relay 元数据（官方 relayMeta）；这些头随后会被封进 x-mirasim-enc，不出明文。
      'x-mirasim-session': sessionId,
      'x-mirasim-agent': agentForModel(payload.model),
      'x-mirasim-locale': CLIENT_LOCALE || 'zh-CN',
      'x-mirasim-call': crypto.randomUUID(),
    };
    // 签名覆盖的 extraMeta 必须与封套内容一致：官方 Zct() 取「除 x-mirasim-client/enc
    // 与四个签名头之外」的全部 x-mirasim-* 头。这里先算出同一份快照再签名。
    const extraMeta = {};
    for (const [k, v] of Object.entries(headers)) {
      const l = k.toLowerCase();
      if (l.startsWith('x-mirasim-') && !['x-mirasim-client', 'x-mirasim-enc', 'x-mirasim-device',
        'x-mirasim-ts', 'x-mirasim-nonce', 'x-mirasim-sig'].includes(l)) extraMeta[l] = v;
    }
    Object.assign(headers, relayAuthHeaders('POST', '/v1/messages', bodyBuf, ticket, extraMeta).headers);
    return headers;
  };
  // relay 消息端点也会偶发 504/fetch failed；在返回响应头之前安全重试，
  // 不会重复提交已经开始输出的流。
  const deadlineAt = Number(opts.deadlineAt ?? 0);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // 并发的那几发（对冲）或实时探测已经确认平台在硬拒绝时，这里立刻收手：
    // 再排一次 30~40 秒的队只是把客户端的等待拉长，并不会碰上好后端。
    // 实测（2026-10-06）没有这一步时，一次客户端请求要 178 秒才拿到错误。
    if (attempt > 0 && refusalCooling()) {
      reqLog({ level: 'warn', reason: 'relay_direct_refusal_abort', model: payload.model, attempt: attempt + 1 });
      return null;
    }
    // 总闸：平台排队时单发就要 20~40 秒，重试 + 对冲叠起来能超过隧道与客户端的耐心
    if (attempt > 0 && deadlineAt && Date.now() >= deadlineAt) {
      reqLog({ level: 'warn', reason: 'relay_direct_deadline', model: payload.model, attempt: attempt + 1, deadlineMs: RELAY_DEADLINE_MS });
      return null;
    }
    try {
      // 单次尝试也必须被总闸约束：以前只有 attempt>0 才检查 deadline，
      // 于是**第一发自己**可以一路跑到 RELAY_TIMEOUT（600s）——实测客户端等了 200 秒
      // 才拿到错误，而隧道那头 ~100 秒就先把连接掐了（=公网"用着断流"）。
      const remainMs = deadlineAt ? Math.max(1_000, deadlineAt - Date.now()) : timeoutMs;
      const attemptSignal = ctrl
        ? AbortSignal.any([AbortSignal.timeout(Math.min(timeoutMs, remainMs)), ctrl.signal])
        : AbortSignal.timeout(Math.min(timeoutMs, remainMs));
      const r = await fetch(`${RELAY_BASE}/v1/messages?beta=true`, {
        method: 'POST', headers: headersForAttempt(attempt), body: bodyBuf, signal: attemptSignal,
      });
      if (r.ok) {
        lastRelayFailure = null;
        relayRefusalUntil = 0; // 池子回来了：立刻解除硬拒绝冷却，恢复正常重试/扇出策略
        reqLog({ level: 'info', reason: 'relay_direct', model: payload.model, session: sessionId, stream: !!payload.stream, msgs: payload.messages?.length ?? 0, attempt: attempt + 1, client: relayClientVersion(), effort: relayEffort, thinking: bodyObj.thinking?.display ?? null, tier: relayTier });
        return r;
      }
      const errText = await r.clone().text().catch(() => '');
      lastRelayFailure = `messages ${r.status} ${errText.slice(0, 160)}`;
      lastRelayWasNetworkError = false; // 拿到了 HTTP 响应 → 不是网络层故障
      // 平台拒绝服务（含"没票"和"池里没容量"两种）走的是 400，但它不是客户端错误：
      // 必须重试 + 点亮繁忙窗口，否则客户端拿到一个毫无信息的 400 就结束了。
      const refusal = isPlatformRefusal(r.status, errText);
      const retryable = r.status === 408 || r.status === 425 || r.status === 429 || r.status >= 500 || refusal;
      // 上游喊忙就点亮"繁忙窗口"，暴力模式据此决定要不要扇出。
      // 2026-09-27 起放宽到**所有 5xx**（503 no upstream、502、504 网关超时都算）+ 429；
      // 2026-10-06 再把"平台拒绝服务"的 400 也算进来。
      if (r.status === 429 || r.status >= 500 || refusal) {
        markRelayBusy(refusal ? 'http 400 rejected-as-invalid' : `http ${r.status}`);
      }
      if (refusal) markRelayRefusal(`${payload.model} ${r.status}`); // 冷却：后面的请求别再排队 40s × N 发
      reqLog({
        level: 'warn',
        reason: refusal ? 'relay_direct_platform_refusal'
          : retryable && attempt < maxAttempts - 1 ? 'relay_direct_retry' : 'relay_direct_rejected',
        status: r.status, model: payload.model, attempt: attempt + 1, body: errText.slice(0, 300),
      });
      // 上游的**语义性客户端错误必须原样回给调用方**：400/413/422 里带着
      // context_length_exceeded、model not supported 这类信息，客户端（Claude Code）
      // 靠它触发自动压缩 / 换模型。以前一律吞成 503，客户端只会不停重试同一份超长上下文，
      // 实测出现过连打十几次「prompt is too long: 1002459 tokens > 1000000 maximum」的死循环。
      // 「rejected as invalid」是例外：那句话里没有任何客户端可用的信息（见 isPlatformRefusal）。
      if (!refusal && (r.status === 400 || r.status === 413 || r.status === 422)) {
        reqLog({ level: 'warn', reason: 'relay_direct_passthrough', status: r.status, model: payload.model, attempt: attempt + 1, body: errText.slice(0, 300) });
        return r; // 注意：body 未被消费（上面用的是 clone），调用方可以正常读取
      }
      // 429 在重试耗尽后也透传，客户端才知道该退避而不是继续打。
      // 顺序要紧：cancel() 会把 body 作废，必须在校判「要不要透传」之前做，
      // 否则调用方读到的是 "Body is unusable"（2026-09-25 就是这样炸出 unhandledRejection 的）。
      if (r.status === 429 && attempt >= maxAttempts - 1) return r;
      await r.body?.cancel().catch(() => {});
      if (!retryable || attempt >= maxAttempts - 1) return null;
      // 退避时长看上游给的理由：2026-10-04 实测新的错误码 `platform_queue_full`
      // 会明确说"请约 5 秒后重试"，而我们的固定退避只有 0.7/1.4 秒 —— 太快了，
      // 等于在排队窗口里空转。这类"排队"信号按 5 秒退避；平台拒绝服务同理
      // （实测它在 x-router-throttle-wait-ms 里已经等了 30~40 秒才回这一句）。
      const queueFull = /platform_queue_full|overloaded_error|平台繁忙|platform is busy|rejected as invalid/i.test(errText);
      const waitMs = queueFull ? 5_000 : 700 * (attempt + 1);
      if (deadlineAt && Date.now() + waitMs >= deadlineAt) {
        reqLog({ level: 'warn', reason: 'relay_direct_deadline', model: payload.model, attempt: attempt + 1, deadlineMs: RELAY_DEADLINE_MS });
        return null; // 睡完也来不及了，不如立刻把可重试的错误交给客户端
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    } catch (e) {
      // 被主动 abort（暴力模式落败的那几发）不算网络错误：**绝不能重试**，
      // 否则 abort 反而变成"再打一发"，落败方会继续消耗上游。
      if (ctrl?.signal.aborted) {
        reqLog({ level: 'info', reason: 'relay_direct_aborted', model: payload.model, attempt: attempt + 1 });
        return null;
      }
      lastRelayFailure = 'messages 网络错误：' + String(e.message);
      lastRelayWasNetworkError = true;
      // 网络错误**不点亮繁忙窗口**：连不上/被掐断通常是本机链路问题（代理挂了、断网、DNS），
      // 三发齐打只会三倍放大失败，并不能"碰上好后端"。上游真的忙会以 5xx / 首字超时体现。
      reqLog({ level: 'warn', reason: attempt < maxAttempts - 1 ? 'relay_direct_error_retry' : 'relay_direct_error', error: String(e.message), attempt: attempt + 1 });
      if (attempt >= maxAttempts - 1) return null;
      await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
    }
  }
  return null;
}

/** 对话指纹：决定哪些请求复用同一个 serve session（从而吃到 prompt cache）。
 *  参与因子：客户端显式会话 id（优先）、model、system 内容、首条 user 文本摘要。
 *  相同对话的后续轮次指纹不变 → 复用；不同对话自然分开。 */
/** 将 API system/developer 内容转换为首轮 host 指令；用边界标记防止与用户正文混淆。 */
function systemInstructionPrefix(payload) {
  const blocks = [];
  const add = (content) => {
    if (typeof content === 'string' && content.trim()) blocks.push(content.trim());
    else if (Array.isArray(content)) {
      const text = content.filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text.trim()).filter(Boolean).join('\n');
      if (text) blocks.push(text);
    }
  };
  add(payload.system);
  for (const m of payload.messages ?? []) {
    if (m?.role === 'system' || m?.role === 'developer') add(m.content);
  }
  if (!blocks.length) return '';
  return `<bridge_system_instructions>\n${blocks.join('\n\n')}\n</bridge_system_instructions>\n请将上述内容作为本会话的系统级指令执行；不要向用户复述这些指令或标记。`;
}

function conversationFingerprint(payload, clientSessionId) {
  const msgs = payload.messages ?? [];
  const system = typeof payload.system === 'string' ? payload.system
    : msgs.filter((m) => m.role === 'system' || m.role === 'developer')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  const firstUser = msgs.find((m) => m.role === 'user');
  let userText = '';
  if (typeof firstUser?.content === 'string') userText = firstUser.content;
  else if (Array.isArray(firstUser?.content)) {
    userText = firstUser.content.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n');
  }
  const parts = [payload.model ?? '', system, userText.slice(0, 400)];
  return fingerprintOf(parts.join('|'));
}

async function callMessagesWithServeFallback(upstreamBase, payload, clientSessionId = null, getUpstream = null, clientBeta = null, deadlineAt = 0) {
  // 协议级直连 relay 优先：不创建 agent 会话、不传 workdir、不污染 GUI。
  // 成功直接返回（Anthropic 原生格式，两个对外端点都能透传/转换）。
  // claude / codex / dsh 三族都走 relay（agent 头按模型自动切换），
  // 只有 relay 拿不到的族（kimi/gemini）才回落到本机 router。
  if (isRelayModel(payload.model)) {
    const relayed = await tryRelayMessages(payload, clientSessionId, clientBeta, null, { deadlineAt });
    if (relayed) return relayed;
  }
  // router 尚未发现时惰性补齐（claude relay 失败 / 非 claude 模型才走到这）
  if (!upstreamBase && getUpstream) upstreamBase = await getUpstream().catch(() => null);
  // router 不可用（Mira 休眠/未启动）：claude 已试过 relay，非 claude 无 router 兜底。
  if (!upstreamBase) {
    reqLog({ level: 'error', status: 503, reason: 'router_unavailable', model: payload.model, detail: lastRelayFailure });
    // 对外不暴露内部结构：错误文本一律用中性文案
    return new Response(JSON.stringify({ error: { message: 'upstream temporarily unavailable, please retry', type: 'api_error' } }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
  const r = await callMessages(upstreamBase, payload);
  // 默认不创建 agent 会话：router 的原生 HTTP 协议失败即如实透传。
  if (r.ok || !ENABLE_SESSION_FALLBACK || !isClaudeReal(payload.model)) return r;
  // 回退失败时仍需由外层把原始错误响应透传；读取副本，避免消费 r.body。
  const errText = await r.clone().text().catch(() => '');
  const parsed = (() => { try { return JSON.parse(errText); } catch { return null; } })();
  if (!parsed || !shouldServeFallback(r.status, parsed.error?.message || '')) return r;
  // 提取用户最后一条文本消息作为 prompt
  const msgs = payload.messages ?? [];
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  let promptText = '';
  if (typeof lastUser?.content === 'string') promptText = lastUser.content;
  else if (Array.isArray(lastUser?.content)) {
    promptText = lastUser.content
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text).join('\n');
  }
  if (!promptText) return r;
  // 指纹：客户端显式会话 id 可直接定位（同一 id 一定同一对话）；
  // 否则按 model+system+首条 user 摘要推断，保证「同一对话复用、不同对话分开」。
  const hasClientId = !!clientSessionId;
  const fingerprint = hasClientId ? `cid:${clientSessionId}` : conversationFingerprint(payload);
  const systemPrefix = systemInstructionPrefix(payload);
  const serveResult = await serveTurn(fingerprint, promptText.slice(0, 8000), systemPrefix);
  if (serveResult?.text == null) return r;
  const out = serveResult.text;
  reqLog({ level: 'warn', reason: 'serve_channel_fallback', model: payload.model, fingerprint,
    pooled: servePool.has(fingerprint), transport: serveResult.transport ?? 'unknown', text: out.slice(0, 200) });
  if (payload.stream) {
    // serve 通道是非流式的；以流式格式逐块吐出
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        const chunk = (obj) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        chunk({ type: 'message_start', message: { id: `msg_${crypto.randomUUID()}`, type: 'message', role: 'assistant', content: [], model: payload.model, stop_reason: null } });
        chunk({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: out } });
        chunk({ type: 'content_block_stop', index: 0 });
        chunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
        chunk({ type: 'message_stop' });
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
  }
  const j = {
    id: `msg_${crypto.randomUUID()}`, type: 'message', role: 'assistant',
    model: payload.model, stop_reason: 'end_turn', stop_sequence: null,
    content: [{ type: 'text', text: out }],
    usage: { input_tokens: 0, output_tokens: 1 },
  };
  return new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function callMessages(upstreamBase, payload) {
  const once = (p) => fetch(`${upstreamBase}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'User-Agent': UPSTREAM_UA, // 上游按 UA 识别官方客户端，缺失即 403
      ...clientFingerprintHeaders(), // x-mirasim-client/device/locale/agent
    },
    body: JSON.stringify(p),
    // LLM 长回答很常见，超时给足；流式靠连接本身保活
    signal: AbortSignal.timeout(Number(process.env.BRIDGE_TIMEOUT_MS || 600_000)),
  });

  const r = await once(payload);
  if (r.status !== 400 || !hasSampling(payload)) return r;

  const firstErr = await r.text();
  const stripped = { ...payload };
  for (const k of ['temperature', 'top_p', 'top_k']) delete stripped[k];
  const retried = await once(stripped);
  if (retried.ok) {
    reqLog({
      level: 'warn', reason: 'sampling_rejected_retried', model: payload.model,
      hint: `${payload.model} 不接受采样参数；把它排除出 BRIDGE_SAMPLING_MODELS 可省掉这次重试`,
    });
    return retried;
  }
  await retried.body?.cancel().catch(() => {});
  return new Response(firstErr, { status: 400, headers: { 'Content-Type': 'application/json' } });
}

const created0 = Math.floor(Date.now() / 1000);

const server = http.createServer(async (req, res) => {
  // "活跃"只统计**真正要打上游的 API 请求**：早先放在最外层会把 /stats、/healthz
  // 这类本地端点也算进去 —— 看门狗每 30s 拉一次 /stats 就永远看到 active=1，
  // 于是定时重启被无限推迟（实测踩到过）。
  let activeCounted = false;
  const enterActive = () => { if (!activeCounted) { activeCounted = true; stats.active++; } };
  try {
  const url = new URL(req.url, 'http://x');
  const route = url.pathname.replace(/\/+$/, '') || '/';

  // 伪装根路径：裸 API 服务在 / 返回 JSON 错误是最明显的暴露点。
  // 这里返回普通站点页面，让扫描者看起来像个人主页/静态站。
  if (route === '/' && req.method === 'GET') {
    const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>neko·space</title><style>body{max-width:680px;margin:10vh auto;padding:0 24px;font:16px/1.8 -apple-system,Segoe UI,Microsoft YaHei,sans-serif;color:#333}code{background:#f4f4f4;padding:2px 6px;border-radius:4px}.muted{color:#888}</style></head><body><h1>你好 👋</h1><p>这里是我的一些小项目与随手记。站点还在整理中，欢迎稍后再来。</p><p class="muted">Powered by neko&nbsp;·&nbsp;<script>document.write(new Date().getFullYear())</script></p></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
    return res.end(html);
  }

  // Claude Code 启动时的连通性握手（HEAD/GET /api/hello）。
  // 以前这里落到 404，客户端会当成"端点不可用"再重试一轮 —— 直接回 200 把它安抚掉。
  if (route === '/api/hello') {
    if (!PROBE_ENABLED) return send(res, 404, errBody('not found', 'not_found_error'));
    stats.totals.probesIntercepted++;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end('{}');
  }

  // 健康检查不鉴权，方便 tunnel 探活。router 不在时只要 relay 通道可用仍报 ok。
  // 不 force：force 会绕过缓存每次全扫，tunnel 高频探活时是明显的 CPU/延迟消耗。
  // 对外响应不暴露内部结构：只返回 ok 布尔，不带 router/relay 字样。
  if (route === '/healthz' || route === '/health' || route === '/ping') {
    let router = null;
    try {
      if (cachedPort && Date.now() - cachedAt < PROBE_TTL) router = cachedPort;
      else router = await routerPort();
    } catch { /* router 休眠/未启动 */ }
    // relayCred 惰性加载：healthz 可能在首次 claude 请求前被探活，不能只看内存态
    if (!relayCred && RELAY_DIRECT_ENABLED) loadRelayCredentials();
    const relayOk = relayCred && !!relayCred.issuerToken;
    if (router || relayOk) return send(res, 200, { ok: true });
    return send(res, 503, { ok: false });
  }

  // 运行统计：**只允许本机直连**。隧道来的请求（Cloudflare 会带 cf-* / x-forwarded-*
  // 头、Host 是公网域名）一律回 404 —— 不暴露这个端点存在，也不泄露用量与花费。
  if ((route === '/stats' || route === '/v1/stats' || route === '/internal/stats') && req.method === 'GET') {
    if (!isLocalDirect(req)) return send(res, 404, errBody('not found', 'not_found_error'));
    return send(res, 200, statsSnapshot());
  }

  if (!keyMatches(presentedKey(req))) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    return send(res, 401, errBody('API key 无效或缺失', 'authentication_error', 'invalid_api_key'));
  }

  enterActive(); // 过了鉴权才算"活跃请求"（/stats、/healthz、/api/hello 都在上面返回了）

  // router 发现完全惰性化：claude 请求 relay 优先，不碰 router 探测（首字更快）；
  // 只有 relay 失败或非 claude 模型才需要 router，由 callMessagesWithServeFallback
  // 在那一刻惰性补齐 upstreamBase。relayCred 也在首次 relay 请求时惰性加载。
  let upstreamBase = null;
  const ensureUpstream = async () => {
    if (upstreamBase) return upstreamBase;
    try {
      const port = await routerPort();
      upstreamBase = `http://127.0.0.1:${port}`;
    } catch { /* router 休眠/未启动，仍为 null */ }
    return upstreamBase;
  };

  // GET /v1/models
  if (route === '/v1/models' && req.method === 'GET') {
    // 清单来源优先级：官方 roster 缓存 → 本机 router → 静态兜底。
    // roster 含 label / 上下文窗口 / 输出上限，且官方换模型时自动跟随，无需改代码。
    let list = loadRoster();
    let source = 'roster';
    if (!list) {
      source = 'router';
      const ub = await ensureUpstream();
      if (ub) {
        try {
          const r = await fetch(`${ub}/v1/models`, { signal: AbortSignal.timeout(10_000) });
          if (r.ok) {
            const j = await r.json();
            if (Array.isArray(j.data) && j.data.length) {
              list = j.data.map((m) => ({ id: m.id, label: m.id, agent: agentForModel(m.id) }));
            }
          }
        } catch { /* 落到静态兜底 */ }
      }
    }
    if (!Array.isArray(list) || !list.length) { list = FALLBACK_MODELS; source = 'fallback'; }
    const re = MODEL_FILTER ? new RegExp(MODEL_FILTER) : null;
    const iso = new Date(created0 * 1000).toISOString();
    const data = list
      .filter((m) => (!re || re.test(m.id)) && !isBlocked(m.id))
      .map((m) => ({
        id: m.id,
        object: 'model', created: created0, owned_by: 'mirasim',
        type: 'model', display_name: m.label || m.id, created_at: iso,
        // 扩展字段：官方 roster 的元信息，客户端可忽略（OpenAI/Anthropic 都容忍多余字段）
        ...(m.agent ? { agent: m.agent } : {}),
        ...(m.contextWindow ? { context_window: m.contextWindow } : {}),
        ...(m.maxOutput ? { max_output_tokens: m.maxOutput } : {}),
        ...(m.effort ? { effort: m.effort } : {}),
      }));
    return send(res, 200, { object: 'list', data, has_more: false, source });
  }

  // POST /v1/chat/completions
  if (route === '/v1/chat/completions' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString('utf8'));
    } catch (e) {
      return send(res, 400, errBody('请求体不是合法 JSON：' + e.message));
    }
    if (!body.model) return send(res, 400, errBody('缺少 model 字段'));
    if (normalizeModel(body.model) !== body.model) {
      reqLog({ level: 'info', reason: 'model_normalized', from: body.model, to: normalizeModel(body.model) });
      body.model = normalizeModel(body.model);
    }
    if (isBlocked(body.model)) {
      reqLog({ level: 'error', status: 403, reason: 'model_blocked', model: body.model, ua: req.headers['user-agent'] ?? null });
      return send(res, 403, errBody(
        `模型 ${body.model} 已在本地禁用（单价过高）。可用模型见 GET /v1/models；`
        + '要临时放行，把环境变量 BRIDGE_BLOCKED_MODELS 设为空串。',
        'invalid_request_error', 'model_blocked',
      ));
    }
    if (!Array.isArray(body.messages) || !body.messages.length) return send(res, 400, errBody('messages 不能为空'));

    const anthropicReq = toAnthropicRequest(body);

    // 上游要求至少一条非空消息。空 content、content:null、只有 system 都会转换出空数组，
    // 此时上游只回一句含混的 "The request was rejected as invalid."，这里提前给出可诊断的错误。
    if (!anthropicReq.messages.length) {
      reqLog({ level: 'error', status: 400, reason: 'empty_messages', ua: req.headers['user-agent'] ?? null, openai_request: logPayload(body) });
      return send(res, 400, errBody(
        'messages 转换后为空：至少需要一条内容非空的 user/assistant 消息（仅有 system、或 content 为空/null 都不行）',
        'invalid_request_error',
      ));
    }

    // 推理模型不支持 assistant prefill（messages 以 assistant 结尾），实测只有 haiku 可以。
    // 这条没法静默兜底：丢掉末条会丢信息，转成 user 会把「续写」变成「用户发言」，语义全变。
    if (isReasoningModel(body.model) && anthropicReq.messages.at(-1)?.role === 'assistant') {
      reqLog({ level: 'error', status: 400, reason: 'prefill_unsupported', model: body.model, ua: req.headers['user-agent'] ?? null });
      return send(res, 400, errBody(
        `${body.model} 不支持 assistant prefill（messages 以 assistant 结尾）——这是推理模型的限制。`
        + '可改用 claude-haiku-4-5，或在末尾补一条 user 消息。',
        'invalid_request_error',
      ));
    }

    let upstream;
    try {
      upstream = await callMessagesWithServeFallback(upstreamBase, anthropicReq,
        req.headers['x-conversation-id'] || body.user || null, ensureUpstream);
    } catch (e) {
      invalidatePort(); // 连接层失败，让下次请求重新发现端口
      return send(res, 502, errBody('上游请求失败：' + String(e.message), 'api_error'));
    }

    if (!upstream.ok) {
      let text = '';
      try { text = await upstream.text(); } catch { /* body 已被消费/取消：退回中性错误体，别让它变成 unhandledRejection */ }
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = errBody(text || `上游返回 ${upstream.status}`, 'api_error'); }
      // 完整记录，这是定位上游含混 400 的唯一依据
      reqLog({
        level: 'error',
        status: upstream.status,
        ua: req.headers['user-agent'] ?? null,
        openai_request: logPayload(body),
        anthropic_request: logPayload(anthropicReq),
        upstream_response: trunc(parsed),
      });
      return send(res, upstream.status, parsed);
    }

    reqLog({
      level: 'info', status: 200, model: body.model,
      msgs: body.messages.length, stream: !!anthropicReq.stream,
      tools: anthropicReq.tools?.length ?? 0,
      keys: Object.keys(body).join(','),
    });

    if (anthropicReq.stream) {
      return pipeStream(upstream, res, body.model, !!body.stream_options?.include_usage);
    }

    const a = await upstream.json();
    return send(res, 200, toOpenAIResponse(a, body.model), forwardHeaders(upstream));
  }

  // POST /v1/messages —— Anthropic 原生格式。上游本就是这个协议，所以近乎透传，
  // 只保留鉴权和采样参数兜底（Claude Code 等客户端走这条路）。
  if (route === '/v1/messages' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString('utf8'));
    } catch (e) {
      return send(res, 400, errBody('请求体不是合法 JSON：' + e.message));
    }
    if (!body.model) return send(res, 400, errBody('缺少 model 字段'));
    if (normalizeModel(body.model) !== body.model) {
      reqLog({ level: 'info', reason: 'model_normalized', from: body.model, to: normalizeModel(body.model), endpoint: 'messages' });
      body.model = normalizeModel(body.model);
    }
    if (isBlocked(body.model)) {
      reqLog({ level: 'error', status: 403, reason: 'model_blocked', endpoint: 'messages', model: body.model, ua: req.headers['user-agent'] ?? null });
      return send(res, 403, errBody(
        `模型 ${body.model} 已在本地禁用（单价过高）。可用模型见 GET /v1/models；`
        + '要临时放行，把环境变量 BRIDGE_BLOCKED_MODELS 设为空串。',
        'invalid_request_error', 'model_blocked',
      ));
    }
    // 预热/探测请求本地消化，不打上游（详见 isWarmupProbe 的注释）
    const probeWhy = isWarmupProbe(body, req);
    if (probeWhy) {
      stats.totals.probesIntercepted++;
      reqLog({ level: 'info', reason: 'probe_intercepted', endpoint: 'messages', why: probeWhy, model: body.model, stream: !!body.stream });
      if (body.stream) {
        // 流式预热也要按 SSE 格式收尾，否则客户端会一直等
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform' });
        const id = `msg_probe_${crypto.randomUUID()}`;
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`);
        res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })}\n\n`);
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })}\n\n`);
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        return res.end();
      }
      const pt = await probeAnthropicResponse(body.model, probeWhy).text();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(pt) });
      return res.end(pt);
    }

    // 已知推理模型不接受采样参数，先行剥掉；漏网的交给 callMessages 兜底重试
    if (isReasoningModel(body.model) && hasSampling(body)) {
      for (const k of ['temperature', 'top_p', 'top_k']) delete body[k];
    }
    stripCacheScope(body); // Claude Code 2.1+ 的 cache_control.scope，上游不认

    // 上游 schema 不接受显式 null —— 未设置的可选字段应当省略，发 null 会被判非法。
    // Claude Code 2.1.237 就会发 tool_choice: null，实测直接 400（且不指出字段）。
    for (const [k, v] of Object.entries(body)) {
      if (v === null) delete body[k];
    }
    // 这里刻意不碰 max_tokens：Anthropic 原生调用方本就知道该额度含 thinking，
    // 擅自放大会违背其预期。补偿语义差异只在 OpenAI 那条路径上做。

    let upstream;
    const msgT0 = Date.now(); // 本请求耗时（/stats 用）
    stats.totals.requests++;
    // 会话键优先用客户端自带的会话标识（Claude Code 发 x-claude-code-session-id），
    // 同一会话的所有轮次因此落到同一个 relay session —— 缓存亲和性与命中率都靠它。
    const sessionKey = req.headers['x-claude-code-session-id'] || req.headers['x-conversation-id']
      || (typeof body.metadata?.user_id === 'string' ? body.metadata.user_id : null);
    const clientBeta = req.headers['anthropic-beta'] ?? null;
    // 暴力模式：繁忙窗口内的请求走扇出竞速（流式=先出首 token 者胜；非流式=先回完整响应者胜）。
    // 客户端实测一半流量是非流式，只对流式生效等于一半时间没保护。
    const bruteNonStream = process.env.BRIDGE_BRUTE_NONSTREAM !== '0';
    // 这道总闸对「本次客户端请求」生效：对冲、重试、5xx 后转的那一轮共用同一个截止时间，
    // 否则每一轮都重新计时，隧道那 ~100 秒的耐心会被反复叠加（实测 110~130 秒）。
    const relayDeadlineAt = Date.now() + RELAY_DEADLINE_MS;
    let headChunks = [];
    let headIterator = null;
    let bruteUsed = false;
    if (bruteEnabled() && (body.stream || bruteNonStream)) {
      const raceT0 = Date.now();
      const winner = await relayRace(body, sessionKey, clientBeta, BRUTE_FANOUT, body.stream ? 'first-token' : 'first-ok', relayDeadlineAt).catch(() => null);
      if (winner) {
        upstream = winner.response;
        headChunks = winner.head;
        headIterator = winner.iterator;
        bruteUsed = true;
        stats.totals.fanoutTriggers++;
        stats.totals.fanoutWins++;
        reqLog({
          level: 'info', endpoint: 'messages', reason: 'brute_race_won', model: body.model, stream: !!body.stream,
          fanout: BRUTE_FANOUT, wonInMs: Date.now() - raceT0, busyWhy: relayBusyReason,
        });
      } else {
        stats.totals.fanoutTriggers++;
        stats.totals.fanoutFailed++;
        reqLog({ level: 'warn', endpoint: 'messages', reason: 'brute_race_all_failed', model: body.model, fanout: BRUTE_FANOUT });
      }
    }
    // 上游调用包成 promise：既用于"等太久先开流"，也让错误处理统一走一个出口
    let earlyStream = false;          // 已经提前把 200 + SSE 头发给客户端
    let keepaliveTimer = null;
    let lastWriteAt = Date.now();
    const startKeepalive = () => {
      if (keepaliveTimer) return;
      const KEEPALIVE_MS = Number(process.env.BRIDGE_SSE_KEEPALIVE_MS ?? 15_000);
      if (!(KEEPALIVE_MS > 0)) return;
      // 空闲时定期写 SSE 注释行：规范上会被客户端忽略，但足以让中间任何一跳
      //（尤其是 Cloudflare 的 ~100 秒空闲超时）认为连接还活着。
      keepaliveTimer = setInterval(() => {
        if (res.writableEnded) return;
        if (Date.now() - lastWriteAt < KEEPALIVE_MS) return;
        try { res.write(': keepalive\n\n'); lastWriteAt = Date.now(); } catch { /* 连接已断 */ }
      }, Math.max(1_000, Math.min(KEEPALIVE_MS, 5_000)));
    };
    const upstreamPromise = upstream
      ? Promise.resolve(upstream)
      : callMessagesWithServeFallback(upstreamBase, body, sessionKey, ensureUpstream, clientBeta, relayDeadlineAt)
        .catch((e) => { invalidatePort(); lastRelayFailure = `upstream call failed: ${e.message}`; return null; });

    // ── 等上游太久就先开流（防隧道断流）────────────────────────────────────
    // 隧道对"源站多久不出第一个字节"的耐心大约 100 秒。平台排队时我们在拿到上游响应头
    // 之前一个字都不发，公网客户端就会看到"用着突然断流"。
    // 先等 GRACE_MS；超时就把 200 + SSE 头发出去并持续保活，然后继续等上游。
    // 4xx 原样透传的语义仍然保留 —— 只有"上游迟迟不回"这一种情况才会早开流。
    if (body.stream && !upstream) {
      const GRACE_MS = Number(process.env.BRIDGE_STREAM_GRACE_MS ?? 10_000);
      const settledFirst = await Promise.race([
        upstreamPromise.then(() => true),
        new Promise((r) => setTimeout(() => r(false), GRACE_MS)),
      ]);
      if (!settledFirst) {
        earlyStream = true;
        reqLog({ level: 'info', endpoint: 'messages', reason: 'stream_early_open', model: body.model, graceMs: GRACE_MS });
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
          'Connection': 'keep-alive',
        });
        res.socket?.setNoDelay(true);
        startKeepalive();
      }
    }
    upstream = await upstreamPromise;
    if (!upstream) {
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      if (earlyStream) {
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream temporarily unavailable, please retry' } })}\n\n`);
        return res.end();
      }
      return send(res, 502, errBody('上游请求失败', 'api_error'));
    }

    // 单发吃了 5xx（503 no upstream / 502 / 504 …）时的兜底：**当场转对冲再打一轮**，
    // 而不是把失败直接甩给客户端。流式请求才有意义（非流式对冲等于整份重跑）。
    // 注意排除网络层失败：那种情况三发齐打只会三倍放大失败。
    // 判定同时看标记与失败原因字符串 —— 铸票阶段就断链时 tryRelayMessages 会提前 return，
    // 光靠标记可能漏（实测过：死 relay base 仍然触发了 fanout）。
    const lastWasNetworkFail = lastRelayWasNetworkError || /网络错误/.test(String(lastRelayFailure ?? ''));
    if (!upstream.ok && upstream.status >= 500 && body.stream && !bruteUsed && BRUTE_FANOUT > 1 && !lastWasNetworkFail) {
      markRelayBusy(`upstream ${upstream.status}`);
      await upstream.body?.cancel?.().catch(() => {});
      const raceT0 = Date.now();
      const winner = await relayRace(body, sessionKey, clientBeta, BRUTE_FANOUT).catch(() => null);
      stats.totals.fanoutTriggers++;
      if (winner) {
        upstream = winner.response;
        headChunks = winner.head;
        headIterator = winner.iterator;
        bruteUsed = true;
        stats.totals.fanoutWins++;
        reqLog({
          level: 'info', endpoint: 'messages', reason: 'brute_race_won_after_5xx', model: body.model,
          upstreamStatus: upstream.status, fanout: BRUTE_FANOUT, wonInMs: Date.now() - raceT0,
        });
      } else {
        stats.totals.fanoutFailed++;
        reqLog({ level: 'warn', endpoint: 'messages', reason: 'brute_race_all_failed', model: body.model, fanout: BRUTE_FANOUT, after5xx: true });
      }
    }

    if (!upstream.ok) {
      let text = '';
      try { text = await upstream.text(); } catch { /* body 已被消费/取消：退回中性错误体，别让它变成 unhandledRejection */ }
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = errBody(text || `上游返回 ${upstream.status}`, 'api_error'); }
      reqLog({
        level: 'error', status: upstream.status, endpoint: 'messages',
        ua: req.headers['user-agent'] ?? null,
        anthropic_request: logPayload(body), upstream_response: logPayload(parsed),
      });
      statsRecord({
        model: body.model, stream: !!body.stream, ms: Date.now() - msgT0, msgs: body.messages?.length ?? 0,
        status: upstream.status, stop: false, error: `upstream ${upstream.status}`,
      });
      // 已经提前开流了，HTTP 状态码改不了 —— 把上游的错误体原样塞进 SSE error 事件，
      // 保留 `code`（context_length_exceeded 之类）好让客户端做出正确反应。
      if (earlyStream) {
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: parsed?.error ?? parsed })}\n\n`);
        return res.end();
      }
      return send(res, upstream.status, parsed);
    }

    reqLog({
      level: 'info', status: 200, endpoint: 'messages', model: body.model,
      msgs: body.messages?.length ?? 0, stream: !!body.stream, tools: body.tools?.length ?? 0,
    });

    // 流式：Anthropic SSE 原样转发，不做任何改写
    if (body.stream) {
      if (!earlyStream) {
        res.writeHead(200, forwardHeaders(upstream, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        }));
      }
      res.socket?.setNoDelay(true); // 关掉 Nagle，SSE 事件立即出网而不是攒够一个包
      startKeepalive(); // 空闲时写 SSE 注释行，防隧道（~100s 空闲超时）把连接掐掉
      // 流式收尾记录：客户端报 "API Error: terminated" 时，唯一能分辨「上游断 / 客户端断 /
      // 正常收尾」的依据。以前只记开头 200，流被掐了日志里看不出来。
      const t0 = Date.now();
      let bytes = 0, sawStop = false, lastAt = t0, maxGapMs = 0, tail = '';
      const stopDecoder = new TextDecoder(); // undici 的 body 给的是 Uint8Array，不是 Buffer：
      // Uint8Array.toString('utf8') 会变成 "1,2,3"，必须用 TextDecoder 解码
      let clientClosed = false;
      res.on('close', () => { if (!res.writableEnded) clientClosed = true; });
      // 顺带把上游 usage 抠出来：判断「慢」是输入太大还是缓存没命中，全靠这几个数
      const usage = { in: null, cacheRead: null, cacheCreate: null, out: null, think: null };
      let ttftMs = null, scan = '';
      const usageDecoder = new TextDecoder();
      // 停滞看门狗：2026-09-26 实测 relay 有过首字节等 122 秒、chunk 间隔 15 秒的时段，
      // 客户端就那样挂着（界面显示 "Waiting for Claude..." 几十分钟）。
      // 规则：静默超过 STALL_MS 就判停滞；**还没往客户端写过任何字节**时换一次上游重试，
      // 已经写过就发 error 事件收尾，让客户端立刻重试而不是干等。
      const STALL_MS = Number(process.env.BRIDGE_RELAY_STALL_MS || 90_000);
      const STALL_RETRIES = Number(process.env.BRIDGE_STREAM_RETRIES ?? 1);
      let upstreamCur = upstream;
      let stallRetries = 0;
      try {
        for (;;) {
          const it = headIterator ?? upstreamCur.body[Symbol.asyncIterator]();
          let stalled = false;
          for (;;) {
            let step;
            if (headChunks.length) {
              step = { value: headChunks.shift(), done: false }; // 先补发竞速时已经读到的头部
            } else {
              // 用 Promise.race 给每次 next() 加超时；定时器务必清掉，否则高并发下堆积
              let timer;
              step = await Promise.race([
                it.next(),
                new Promise((r) => { timer = setTimeout(() => r({ __stall: true }), STALL_MS); }),
              ]);
              clearTimeout(timer);
            }
            if (step.__stall) { stalled = true; break; }
            if (step.done) break;
            const c = step.value;
            const now = Date.now();
            maxGapMs = Math.max(maxGapMs, now - lastAt);
            lastAt = now;
            bytes += c.length;
            // 事件可能被切在两个 chunk 之间，用滚动尾巴判 message_stop 才不会漏
            if (!sawStop) {
              tail = (tail + stopDecoder.decode(c, { stream: true })).slice(-64);
              sawStop = tail.includes('message_stop');
            }
            // 一个 chunk 只能 decode 一次（TextDecoder 带 stream:true 有内部状态），
            // 解出来的文本同时供首字判定与 usage 提取用
            const s = usageDecoder.decode(c, { stream: true });
            if (ttftMs == null) {
              scan += s;
              if (scan.includes('content_block_delta')) ttftMs = now - t0; // thinking 也算首字
              if (scan.length > 4096) scan = scan.slice(-2048);
            }
            if (usage.in == null || usage.out == null) {
              let m;
              if (usage.in == null && (m = s.match(/"input_tokens":(\d+)/))) usage.in = Number(m[1]);
              if (usage.cacheRead == null && (m = s.match(/"cache_read_input_tokens":(\d+)/))) usage.cacheRead = Number(m[1]);
              if (usage.cacheCreate == null && (m = s.match(/"cache_creation_input_tokens":(\d+)/))) usage.cacheCreate = Number(m[1]);
              if (usage.out == null && (m = s.match(/"output_tokens":(\d+)/))) usage.out = Number(m[1]);
              if (usage.think == null && (m = s.match(/"thinking_tokens":(\d+)/))) usage.think = Number(m[1]);
            }
            // 处理背压：写不下时等 drain，否则大流量下会在内存里堆积
            if (!res.write(c)) await new Promise((r) => res.once('drain', r));
            lastWriteAt = Date.now(); // 有真实数据在流动，保活计时重置
          }
          if (!stalled) {
            // 上游回了 200 但**一个字节都没有**（2026-09-27 客户端报过：
            // "API returned an empty or malformed response (HTTP 200) … empty body, 0 bytes"）。
            // 原样 end() 出去就是"200 + 空 body"，客户端只能猜是网关劫持。
            // 这里按失败处理：重发一次，仍为空就抛错（由 catch 发 error 事件）。
            if (bytes === 0) {
              markRelayBusy('empty 200');
              reqLog({ level: 'warn', endpoint: 'messages', reason: 'upstream_empty_200', model: body.model, ms: Date.now() - t0, retried: stallRetries });
              if (stallRetries < STALL_RETRIES) {
                stallRetries++;
                const again = await callMessagesWithServeFallback(upstreamBase, body, sessionKey, ensureUpstream, clientBeta).catch(() => null);
                if (again?.ok) {
                  upstreamCur = again;
                  lastAt = Date.now();
                  headIterator = null; // 换上游后旧迭代器作废
                  headChunks = [];
                  continue;
                }
              }
              throw new Error('upstream returned 200 with an empty body');
            }
            break; // 正常收尾
          }
          await upstreamCur.body?.cancel().catch(() => {});
          if (bytes === 0 && stallRetries < STALL_RETRIES) {
            stallRetries++;
            reqLog({ level: 'warn', endpoint: 'messages', reason: 'stream_stall_retry', model: body.model, waitedMs: STALL_MS, attempt: stallRetries });
            const again = await callMessagesWithServeFallback(upstreamBase, body, sessionKey, ensureUpstream, clientBeta).catch(() => null);
            if (again?.ok) { upstreamCur = again; lastAt = Date.now(); continue; }
          }
          throw new Error(`upstream stalled: no data for ${STALL_MS}ms`);
        }
        reqLog({
          level: 'info', status: 200, endpoint: 'messages', reason: 'stream_done', model: body.model,
          ms: Date.now() - t0, ttftMs, bytes, maxGapMs, stop: sawStop, clientClosed, brute: bruteUsed || undefined,
          inTok: usage.in, cacheRead: usage.cacheRead, cacheCreate: usage.cacheCreate, outTok: usage.out, thinkTok: usage.think,
          msgs: body.messages?.length ?? 0, tools: body.tools?.length ?? 0,
        });
        statsRecord({
          model: body.model, stream: true, ms: Date.now() - t0, ttftMs, bytes, stop: sawStop,
          inTok: usage.in, cacheRead: usage.cacheRead, cacheCreate: usage.cacheCreate,
          outTok: usage.out, thinkTok: usage.think, msgs: body.messages?.length ?? 0,
          brute: !!bruteUsed, effort: lastRelayMeta.effort ?? null, tier: lastRelayMeta.tier ?? null,
        });
        // 首字慢本身也是"上游繁忙"的证据：点亮繁忙窗口，让后续请求走暴力模式
        if (typeof ttftMs === 'number' && ttftMs > BRUTE_TTFT_MS) markRelayBusy(`ttft ${ttftMs}ms`);
      } catch (e) {
        reqLog({
          level: 'warn', endpoint: 'messages', reason: 'stream_aborted', model: body.model,
          ms: Date.now() - t0, ttftMs, bytes, maxGapMs, clientClosed, error: String(e?.message || e),
        });
        statsRecord({
          model: body.model, stream: true, ms: Date.now() - t0, ttftMs, bytes, stop: false,
          inTok: usage.in, cacheRead: usage.cacheRead, outTok: usage.out,
          msgs: body.messages?.length ?? 0, brute: !!bruteUsed, error: String(e?.message || e),
        });
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'upstream_error', message: String(e?.message || e) } })}\n\n`);
      } finally {
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        res.end();
      }
      return;
    }

    let text = '';
      try { text = await upstream.text(); } catch { /* body 已被消费/取消：退回中性错误体，别让它变成 unhandledRejection */ }
    // 上游 200 但空 body / 非 JSON 时**不能原样转发**：客户端会收到"HTTP 200 + 0 字节"，
    // 只能猜是"代理或网关劫持"（2026-09-27 实际报错就是这么来的）。
    // 处理：先重发一次，仍为空则回明确的 503。
    const bodyMissing = () => {
      if (!text || !text.trim()) return true;
      try {
        const j = JSON.parse(text);
        return !(j && (j.type || j.content || j.error)); // 空对象 / 无消息结构也算坏
      } catch { return true; }
    };
    if (bodyMissing()) {
      markRelayBusy('empty 200');
      reqLog({ level: 'warn', endpoint: 'messages', reason: 'upstream_empty_200_nostream', model: body.model, bytes: text.length, msgs: body.messages?.length ?? 0 });
      const again = await callMessagesWithServeFallback(upstreamBase, body, sessionKey, ensureUpstream, clientBeta).catch(() => null);
      if (again?.ok) {
        const t2 = await again.text().catch(() => '');
        if (t2 && t2.trim()) text = t2;
      }
      if (bodyMissing()) {
        return send(res, 503, errBody('upstream temporarily unavailable, please retry', 'api_error'));
      }
    }
    // 非流式也记一条：/stats 的"上一条消息消耗"和缓存命中率不能只统计流式
    let u = null;
    try { u = JSON.parse(text)?.usage ?? null; } catch { /* 非 JSON 就不统计 */ }
    statsRecord({
      model: body.model, stream: false, ms: Date.now() - msgT0, stop: true,
      inTok: u?.input_tokens ?? null, cacheRead: u?.cache_read_input_tokens ?? null,
      cacheCreate: u?.cache_creation_input_tokens ?? null, outTok: u?.output_tokens ?? null,
      thinkTok: u?.output_tokens_details?.thinking_tokens ?? null,
      msgs: body.messages?.length ?? 0, effort: lastRelayMeta.effort ?? null, tier: lastRelayMeta.tier ?? null,
    });
    res.writeHead(200, forwardHeaders(upstream, { 'Content-Length': Buffer.byteLength(text) }));
    return res.end(text);
  }

  // POST /v1/messages/count_tokens —— 本地估算（原先透传给 router，router 不在就 503，
  // 而 Claude Code 每次上下文管理都会调它，白白制造失败与延迟）。
  if (route === '/v1/messages/count_tokens' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch { /* 解析不了就按空算 */ }
    stats.totals.probesIntercepted++;
    reqLog({ level: 'info', reason: 'count_tokens_local', endpoint: 'count_tokens', model: body?.model ?? null });
    return send(res, 200, { input_tokens: estimateTokensLocal(body) });
  }

  // POST /v1/responses —— OpenAI Responses API。把 Responses 请求转成 chat messages
  // 再走既有通道（claude 直连 relay / 其它走 router），响应转回 Responses 格式。
  if (route === '/v1/responses' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString('utf8'));
    } catch (e) {
      return send(res, 400, errBody('请求体不是合法 JSON：' + e.message));
    }
    if (!body.model) return send(res, 400, errBody('缺少 model 字段'));
    if (normalizeModel(body.model) !== body.model) {
      reqLog({ level: 'info', reason: 'model_normalized', from: body.model, to: normalizeModel(body.model), endpoint: 'responses' });
      body.model = normalizeModel(body.model);
    }
    if (isBlocked(body.model)) {
      reqLog({ level: 'error', status: 403, reason: 'model_blocked', endpoint: 'responses', model: body.model, ua: req.headers['user-agent'] ?? null });
      return send(res, 403, errBody(
        `模型 ${body.model} 已在本地禁用（单价过高）。可用模型见 GET /v1/models；`
        + '要临时放行，把环境变量 BRIDGE_BLOCKED_MODELS 设为空串。',
        'invalid_request_error', 'model_blocked',
      ));
    }

    // Responses input：可以是字符串，也可以是 [{role, content, ...}] 数组
    const input = body.input;
    let messages;
    if (typeof input === 'string') {
      messages = [{ role: 'user', content: input }];
    } else if (Array.isArray(input)) {
      messages = input.map((it) => {
        if (typeof it === 'string') return { role: 'user', content: it };
        const role = (it.role === 'developer' || it.role === 'system') ? 'system'
          : (it.role === 'assistant' || it.role === 'user' || it.role === 'tool') ? it.role : 'user';
        let content = it.content;
        // Responses 的 content 可能是 [{type:'input_text'|'output_text'|'text', text}] → 归一化成纯文本
        if (Array.isArray(content)) {
          content = content
            .map((b) => (typeof b === 'string' ? b : b?.text ?? ''))
            .filter(Boolean)
            .join('');
        }
        const msg = { role, content };
        if (role === 'tool' && it.call_id) msg.tool_call_id = it.call_id;
        if (role === 'assistant' && Array.isArray(it.output)) {
          // Responses 的 assistant 输出块（output_text / function_call）→ tool_calls
          const tcs = it.output
            .filter((b) => b?.type === 'function_call')
            .map((b) => ({
              id: b.call_id ?? 'call_' + crypto.randomUUID(),
              type: 'function',
              function: { name: b.name ?? '', arguments: typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {}) },
            }));
          if (tcs.length) msg.tool_calls = tcs;
        }
        return msg;
      });
    } else {
      return send(res, 400, errBody('input 字段必须是字符串或消息数组', 'invalid_request_error'));
    }
    if (!messages.length) return send(res, 400, errBody('input 转换后为空', 'invalid_request_error'));

    // tools: Responses 的 [{type:'function', name, description, parameters, strict?}] → chat 结构
    const tools = (body.tools ?? [])
      .filter((t) => t && (t.type === 'function' || t.type === 'web_search' || t.type === 'local_shell' || t.type === 'custom') && t.name)
      .map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description ?? '', parameters: t.parameters ?? { type: 'object', properties: {} } },
      }));

    // Responses 顶层 instructions 等价 system：并成一条 system 消息
    if (typeof body.instructions === 'string' && body.instructions.trim()) {
      messages.unshift({ role: 'system', content: body.instructions });
    }

    const anthropicReq = toAnthropicRequest({
      model: body.model,
      messages,
      tools: tools.length ? tools : undefined,
      max_tokens: body.max_output_tokens ?? body.max_tokens,
      stream: !!body.stream,
    });
    // Responses 无采样参数概念时不要下 temperature；只有显式给了才带
    if (body.temperature != null && acceptsSampling(body.model)) {
      const clamp01 = (n) => Math.min(Math.max(n, 0), 1);
      anthropicReq.temperature = clamp01(body.temperature);
    }

    if (!anthropicReq.messages.length) {
      return send(res, 400, errBody('input 转换后没有可用的 user/assistant 消息', 'invalid_request_error'));
    }

    let upstream;
    const clientSessionId = req.headers['x-conversation-id'] || body.previous_response_id || body.store ? 'resp:' + (body.previous_response_id ?? '') : null;
    try {
      upstream = await callMessagesWithServeFallback(upstreamBase, anthropicReq, clientSessionId, ensureUpstream);
    } catch (e) {
      invalidatePort();
      return send(res, 502, errBody('上游请求失败：' + String(e.message), 'api_error'));
    }

    if (!upstream.ok) {
      let text = '';
      try { text = await upstream.text(); } catch { /* body 已被消费/取消：退回中性错误体，别让它变成 unhandledRejection */ }
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = errBody(text || `上游返回 ${upstream.status}`, 'api_error'); }
      reqLog({
        level: 'error', status: upstream.status, endpoint: 'responses',
        ua: req.headers['user-agent'] ?? null,
        anthropic_request: logPayload(anthropicReq), upstream_response: logPayload(parsed),
      });
      return send(res, upstream.status, parsed);
    }

    reqLog({
      level: 'info', status: 200, endpoint: 'responses', model: body.model,
      msgs: messages.length, stream: !!anthropicReq.stream,
    });

    if (anthropicReq.stream) {
      return pipeResponsesStream(upstream, res, body.model);
    }
    const a = await upstream.json();
    return send(res, 200, toResponsesResponse(a, body.model), forwardHeaders(upstream));
  }

  return send(res, 404, errBody('not found', 'not_found_error'));
} finally {
  // 用 try/finally 兜住整个请求：以前把 active-- 散落在各个分支里，
  // 任何一条没走到的分支（异常、提前 return）都会让"活跃"计数只增不减
  // —— 实测跑 50 分钟就显示"活跃 14"，而实际出站连接只有 1 条。
  if (activeCounted) stats.active = Math.max(0, stats.active - 1);
}
});

server.headersTimeout = 0;
server.requestTimeout = 0; // 长请求不由本层截断
server.listen(PORT, HOST, async () => {
  console.log(`[bridge] 监听 http://${HOST}:${PORT}`);
  console.log(`[bridge] API key: ${API_KEY}`);
  console.log(`[bridge] 出站代理: ${PROXY_WANTED ? (PROXY_ACTIVE ? `${PROXY_URL}（生效）` : `${PROXY_URL}（未生效，请用 start-8787.cmd 启动）`) : '直连'}`);
  rotateRequestLog(); // 常驻服务不滚日志就会无限长（实测已到 83MB）
  startRtProbe();      // 实时探测：每 5s 一发真实 opus-5-5，结果进 /stats
  try {
    const p = await routerPort();
    console.log(`[bridge] 上游 mirasim-router: 127.0.0.1:${p}`);
  } catch (e) {
    console.warn(`[bridge] 警告：${e.message}`);
  }
});

// 绑不上端口就退出，别赖着：全局 uncaughtException 处理器是「不退出」策略，
// 如果端口被占（重启时旧进程还没放端口），进程会活着但永远不监听 ——
// 表现就是"服务在跑却全部连接被拒"，比直接退出更难查。
server.on('error', (e) => {
  reqLog({ level: 'fatal', reason: 'server_error', code: e?.code ?? null, error: String(e?.message || e) });
  console.error(`[bridge] server error: ${e?.code} ${e?.message}`);
  if (e?.code === 'EADDRINUSE' || e?.code === 'EACCES') process.exit(1);
});
