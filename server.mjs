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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 配置 ────────────────────────────────────────────────────────────────
const PORT = Number(process.env.BRIDGE_PORT || 8787);
const HOST = process.env.BRIDGE_HOST || '127.0.0.1'; // 只听本地，公网暴露交给 tunnel
const KEY_FILE = path.join(__dirname, '.api-key');
const DEFAULT_MAX_TOKENS = Number(process.env.BRIDGE_DEFAULT_MAX_TOKENS || 8192);
// mirasim-router 里 gpt-*/kimi-* 实测不可路由，默认只暴露 claude 系
const MODEL_FILTER = process.env.BRIDGE_MODEL_FILTER ?? '^claude-';
// 模型黑名单：命中的直接拒绝，不发往上游，也不出现在 /v1/models。
// fable-5 单价明显高于其它模型，默认禁用。设为空串可放行全部。
const BLOCKED_RE = process.env.BRIDGE_BLOCKED_MODELS ?? 'fable';
const isBlocked = (model) => !!BLOCKED_RE && new RegExp(BLOCKED_RE).test(model ?? '');
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
    return [];
  }
}

async function routerPort({ force = false } = {}) {
  // 缓存期内直接返回，不做探测。
  // 早期实现是每个请求都先 probe 一次，代价有两重：上游请求数直接翻倍；
  // 且上游繁忙时探测自身会超时，被误判成「router 不见了」，进而全端口扫描 → 503。
  // 并发一高就必现。端口真变了由 invalidatePort() 或 TTL 到期来兜。
  if (!force && cachedPort && Date.now() - cachedAt < PROBE_TTL) return cachedPort;

  if (cachedPort && (await probe(cachedPort))) {
    cachedAt = Date.now();
    return cachedPort;
  }

  cachedPort = null;
  const ports = await localListeningPorts();
  // 并发探测，取第一个应答的
  const hits = await Promise.all(ports.map(async (p) => ((await probe(p)) ? p : 0)));
  const found = hits.find(Boolean);
  if (!found) throw new Error('未找到 mirasim-router，请确认 Mirasim 桌面端正在运行');
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
  } catch (e) {
    // 上游中断：尽量给客户端一个可解析的收尾，避免它一直挂着
    res.write(`data: ${JSON.stringify({ error: { message: String(e?.message || e), type: 'upstream_error' } })}\n\n`);
    res.write('data: [DONE]\n\n');
  } finally {
    res.end();
  }
}

// ── HTTP 服务 ───────────────────────────────────────────────────────────

// 诊断日志：失败请求完整落盘（转换前后载荷 + 上游原文），成功请求只记一行摘要。
// 上游的 400 不指出具体字段，没有这份记录就只能靠猜。
const REQ_LOG = path.join(__dirname, 'requests.log');

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

function reqLog(entry) {
  try {
    fs.appendFileSync(REQ_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* 日志写失败不影响请求本身 */ }
}

// 逐跳（hop-by-hop）头不能转发，content-length/encoding 由本层重算
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'proxy-authenticate', 'proxy-authorization', 'content-length', 'content-encoding',
]);

/**
 * 把上游响应头带给客户端。
 * 早期实现只手写了 content-type，把 anthropic-ratelimit-* 全丢了 —— 客户端要靠这些做退避，
 * 丢掉等于让它盲飞；x-litellm-call-id / x-router-* 也是排查时的追溯线索。
 */
function forwardHeaders(upstream, extra = {}) {
  // extra 的键要能覆盖上游同名头。对象键区分大小写，'Content-Type' 盖不住上游的
  // 'content-type'，两个都会发出去 —— 客户端收到的就是 "a, b" 这种重复值。
  const overridden = new Set(Object.keys(extra).map((k) => k.toLowerCase()));
  const out = {};
  for (const [k, v] of upstream.headers) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || overridden.has(lk)) continue;
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

/**
 * 调上游 /v1/messages，自带采样参数自愈。
 * 上游对采样参数的拒绝只回一句含混的 400，不指明字段；这里剥掉采样参数重试一次。
 * 重试仍失败说明不是采样参数的锅，还原首次错误如实透传。
 * 两个对外端点（OpenAI 的 chat/completions 与 Anthropic 原生 messages）共用这条路径。
 */
async function callMessages(upstreamBase, payload) {
  const once = (p) => fetch(`${upstreamBase}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
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
  const url = new URL(req.url, 'http://x');
  const route = url.pathname.replace(/\/+$/, '') || '/';

  // 健康检查不鉴权，方便 tunnel 探活。强制探测：它的职责就是反映真实状态，不能读缓存
  if (route === '/healthz') {
    try {
      const p = await routerPort({ force: true });
      return send(res, 200, { ok: true, router: `127.0.0.1:${p}` });
    } catch (e) {
      return send(res, 503, { ok: false, error: String(e.message) });
    }
  }

  if (!keyMatches(presentedKey(req))) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    return send(res, 401, errBody('API key 无效或缺失', 'authentication_error', 'invalid_api_key'));
  }

  let port;
  try {
    port = await routerPort();
  } catch (e) {
    return send(res, 503, errBody(String(e.message), 'api_error'));
  }
  const upstreamBase = `http://127.0.0.1:${port}`;

  // GET /v1/models
  if (route === '/v1/models' && req.method === 'GET') {
    try {
      const r = await fetch(`${upstreamBase}/v1/models`, { signal: AbortSignal.timeout(10_000) });
      const j = await r.json();
      const re = MODEL_FILTER ? new RegExp(MODEL_FILTER) : null;
      // 同一份数据同时铺上 OpenAI 与 Anthropic 两套字段：
      // OpenAI 认 object/created/owned_by，Anthropic 认 type/display_name/created_at。
      // 两边字段不冲突，一个响应喂两种客户端。
      const iso = new Date(created0 * 1000).toISOString();
      const data = (j.data ?? [])
        .filter((m) => (!re || re.test(m.id)) && !isBlocked(m.id))
        .map((m) => ({
          id: m.id,
          object: 'model', created: created0, owned_by: m.owned_by || 'mirasim',
          type: 'model', display_name: m.id, created_at: iso,
        }));
      return send(res, 200, { object: 'list', data, has_more: false });
    } catch (e) {
      return send(res, 502, errBody(String(e.message), 'api_error'));
    }
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
      reqLog({ level: 'error', status: 400, reason: 'empty_messages', ua: req.headers['user-agent'] ?? null, openai_request: trunc(body) });
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
      upstream = await callMessages(upstreamBase, anthropicReq);
    } catch (e) {
      invalidatePort(); // 连接层失败，让下次请求重新发现端口
      return send(res, 502, errBody('上游请求失败：' + String(e.message), 'api_error'));
    }

    if (!upstream.ok) {
      const text = await upstream.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = errBody(text || `上游返回 ${upstream.status}`, 'api_error'); }
      // 完整记录，这是定位上游含混 400 的唯一依据
      reqLog({
        level: 'error',
        status: upstream.status,
        ua: req.headers['user-agent'] ?? null,
        openai_request: trunc(body),
        anthropic_request: trunc(anthropicReq),
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
    if (isBlocked(body.model)) {
      reqLog({ level: 'error', status: 403, reason: 'model_blocked', endpoint: 'messages', model: body.model, ua: req.headers['user-agent'] ?? null });
      return send(res, 403, errBody(
        `模型 ${body.model} 已在本地禁用（单价过高）。可用模型见 GET /v1/models；`
        + '要临时放行，把环境变量 BRIDGE_BLOCKED_MODELS 设为空串。',
        'invalid_request_error', 'model_blocked',
      ));
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
    try {
      upstream = await callMessages(upstreamBase, body);
    } catch (e) {
      invalidatePort(); // 连接层失败，让下次请求重新发现端口
      return send(res, 502, errBody('上游请求失败：' + String(e.message), 'api_error'));
    }

    if (!upstream.ok) {
      const text = await upstream.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = errBody(text || `上游返回 ${upstream.status}`, 'api_error'); }
      reqLog({
        level: 'error', status: upstream.status, endpoint: 'messages',
        ua: req.headers['user-agent'] ?? null,
        anthropic_request: trunc(body), upstream_response: trunc(parsed),
      });
      return send(res, upstream.status, parsed);
    }

    reqLog({
      level: 'info', status: 200, endpoint: 'messages', model: body.model,
      msgs: body.messages?.length ?? 0, stream: !!body.stream, tools: body.tools?.length ?? 0,
    });

    // 流式：Anthropic SSE 原样转发，不做任何改写
    if (body.stream) {
      res.writeHead(200, forwardHeaders(upstream, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      }));
      res.socket?.setNoDelay(true); // 关掉 Nagle，SSE 事件立即出网而不是攒够一个包
      try {
        for await (const c of upstream.body) {
          // 处理背压：写不下时等 drain，否则大流量下会在内存里堆积
          if (!res.write(c)) await new Promise((r) => res.once('drain', r));
        }
      } catch (e) {
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'upstream_error', message: String(e?.message || e) } })}\n\n`);
      } finally {
        res.end();
      }
      return;
    }

    const text = await upstream.text();
    res.writeHead(200, forwardHeaders(upstream, { 'Content-Length': Buffer.byteLength(text) }));
    return res.end(text);
  }

  // POST /v1/messages/count_tokens —— 纯透传
  if (route === '/v1/messages/count_tokens' && req.method === 'POST') {
    try {
      const r = await fetch(`${upstreamBase}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: (await readBody(req)).toString('utf8'),
        signal: AbortSignal.timeout(30_000),
      });
      const t = await r.text();
      res.writeHead(r.status, forwardHeaders(r, { 'Content-Length': Buffer.byteLength(t) }));
      return res.end(t);
    } catch (e) {
      return send(res, 502, errBody(String(e.message), 'api_error'));
    }
  }

  return send(res, 404, errBody(`未实现的端点：${req.method} ${route}`, 'not_found_error'));
});

server.headersTimeout = 0;
server.requestTimeout = 0; // 长请求不由本层截断
server.listen(PORT, HOST, async () => {
  console.log(`[bridge] 监听 http://${HOST}:${PORT}`);
  console.log(`[bridge] API key: ${API_KEY}`);
  try {
    const p = await routerPort();
    console.log(`[bridge] 上游 mirasim-router: 127.0.0.1:${p}`);
  } catch (e) {
    console.warn(`[bridge] 警告：${e.message}`);
  }
});
