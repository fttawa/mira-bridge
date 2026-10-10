#!/usr/bin/env node
/**
 * relay-probe — 直连 relay 的协议体检（不依赖 bridge 进程、不创建任何 agent 会话）
 *
 * 用途：官方客户端升级后，先跑这个确认「新版模拟 + 协议适配」是否仍然成立。
 *
 *   node tools/relay-probe.mjs                     # 默认测一组 claude 模型
 *   node tools/relay-probe.mjs claude-opus-5       # 指定模型
 *   node tools/relay-probe.mjs --client 0.0.358    # 指定 x-mirasim-client
 *
 * 输出解读：
 *   401 client_outdated                     → x-mirasim-client 版本落后，需跟随官方升级
 *   401 device_signature (missing_headers)  → 元数据没封进 x-mirasim-enc，或 core.wasm 不对
 *   401 device_signature (replay/skew)      → 时钟偏差或 nonce 复用
 *   422 model ... not supported             → 模型名不被接受（注意别带 [1m] 后缀）
 *   503 no upstream available for model X   → 协议已通过，是平台池容量问题，与适配无关
 *   200                                     → 全链路可用
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const VALUE_FLAGS = new Set(['--base', '--client', '--core', '--agent', '--path', '--display', '--service-tier']);
const MODELS = [];
for (let i = 0; i < argv.length; i++) {
  if (VALUE_FLAGS.has(argv[i])) { i++; continue; } // 跳过开关的值，别把端口/路径当模型名
  if (argv[i].startsWith('--')) continue;
  MODELS.push(argv[i]);
}
const MIRASIM_HOME = process.env.MIRASIM_HOME || path.join(process.env.USERPROFILE || '', '.mirasim');
const RELAY_BASE = flag('--base', process.env.BRIDGE_RELAY_BASE || 'https://relay.mirasim.ai').replace(/\/+$/, '');
// 默认跟随本机安装的官方版本（state.json 的 good），与 server.mjs 同一套判定
function detectClientVersion() {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(MIRASIM_HOME, 'app', 'state.json'), 'utf8'));
    if (typeof st?.good === 'string' && /^\d+\.\d+\.\d+$/.test(st.good.trim())) return st.good.trim();
  } catch { /* fall through */ }
  try {
    const v = fs.readdirSync(path.join(MIRASIM_HOME, 'app'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+\.\d+\.\d+$/.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => {
        const [a1, a2, a3] = a.split('.').map(Number), [b1, b2, b3] = b.split('.').map(Number);
        return (b1 - a1) || (b2 - a2) || (b3 - a3);
      })[0];
    if (v) return v;
  } catch { /* fall through */ }
  return '0.0.362';
}
const CLIENT_VERSION = flag('--client', process.env.BRIDGE_RELAY_CLIENT || detectClientVersion());
const AGENT = flag('--agent', process.env.BRIDGE_RELAY_AGENT || 'claude');
const MSG_PATH = flag('--path', '/v1/messages');
// 思考内容回传形态：summarized（官方默认）/ omitted（不回传）/ full（上游是否支持待验证）
const THINKING_DISPLAY = flag('--display', 'summarized');
const CACHE = argv.includes('--cache');
const NO_THINKING = argv.includes('--no-thinking'); // 有些模型（haiku）不吃 thinking 字段
// 服务等级：OpenAI 侧的 service_tier（auto/default/flex/priority），codex 模型才有
const SERVICE_TIER = flag('--service-tier', null);
const CORE = flag('--core', process.env.BRIDGE_RELAY_CORE || path.join(__dirname, '..', 'core.wasm'));
const SEAL_PUBKEY = Buffer.from('HlyNMMeGXryasYLJuYQ/9ksCD4AYVVy1zXKAtJdpJn4=', 'base64');
const BILLING = process.env.BRIDGE_RELAY_BILLING
  || 'x-anthropic-billing-header: cc_version=2.1.280.14d; cc_entrypoint=mirasim;';
// 客户端指纹：上游 2026-10 起会对「UA / 计费块 / 查询串」三者的一致性做校验，
// 排查时用 PROBE_UA / PROBE_QUERY 逐个变量替换，别一次全改（否则分不清是哪个起作用）。
const UA = process.env.PROBE_UA || 'claude-cli/2.1.280 (external, mirasim)';
// PROBE_QUERY='-' 表示不带查询串（Windows 下空字符串会被当成"未设置"，只能这么表达）
const QUERY = process.env.PROBE_QUERY === '-' ? '' : (process.env.PROBE_QUERY ?? '?beta=true');
const SIG_KEYS = ['x-mirasim-client', 'x-mirasim-enc', 'x-mirasim-device', 'x-mirasim-ts', 'x-mirasim-nonce', 'x-mirasim-sig'];

// ── 凭据（与 server.mjs 同源逻辑）────────────────────────────────────────
function aesGcmDecryptB64(mrs1, keyHex) {
  const b = Buffer.from(mrs1.slice(5), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
function dpapiUnprotectHex(hex) {
  const b64 = Buffer.from(hex, 'hex').toString('base64');
  const script = `Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String('${b64}');`
    + '$u=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'
    + '[System.Security.Cryptography.DataProtectionScope]::CurrentUser);if($null -eq $u){exit 3};'
    + '[Convert]::ToBase64String($u)';
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    try {
      const out = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 1 << 20 });
      if (out) {
        return Buffer.from(out.trim().split(/\r?\n/).pop(), 'base64')
          .toString('utf16le').replace(/^\uFEFF/, '').trim();
      }
    } catch { /* 试下一个 shell */ }
  }
  return null;
}
const setting = JSON.parse(fs.readFileSync(path.join(MIRASIM_HOME, 'setting.json'), 'utf8'));
const keyHex = process.env.MIRASIM_SECRET_KEY?.trim()
  || dpapiUnprotectHex(fs.readFileSync(path.join(MIRASIM_HOME, 'secret.key'), 'utf8').trim());
const issuerToken = aesGcmDecryptB64(setting.auth.token, keyHex);
const devicePem = aesGcmDecryptB64(setting.device.privateKey, keyHex);
const pubB64 = crypto.createPublicKey(devicePem).export({ format: 'der', type: 'spki' }).toString('base64');
const deviceId = crypto.createHash('sha256').update(pubB64).digest('base64url').slice(0, 22);
const seed = Buffer.from(crypto.createPrivateKey(devicePem).export({ format: 'jwk' }).d, 'base64url');
const userId = JSON.parse(Buffer.from(issuerToken.split('.')[1], 'base64url').toString('utf8')).sub;

// ── 官方 crypto-core ─────────────────────────────────────────────────────
const core = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(CORE)), {}).exports;
function coreCall(fn, args) {
  const allocs = args.map((a) => {
    const bytes = typeof a === 'string' ? Buffer.from(a, 'utf8') : a;
    const ptr = core.cc_alloc(bytes.length);
    new Uint8Array(core.memory.buffer).set(bytes, ptr);
    return [ptr, bytes.length];
  });
  try {
    const ret = BigInt(fn(...allocs.flat()));
    const hi = Number(ret >> 32n), lo = Number(ret & 0xffffffffn);
    if (hi === 0) return null;
    const out = Buffer.from(new Uint8Array(core.memory.buffer, hi, lo));
    core.cc_free(hi, lo);
    return out;
  } finally { for (const [p, l] of allocs) core.cc_free(p, l); }
}
const nul = (v) => { const s = String(v ?? ''); if (s.includes('\0')) throw new Error('NUL'); return s; };

function signHeaders(method, pathname, bodyBuf, credential, extraMeta) {
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(12).toString('base64url');
  const canon = [method.toUpperCase(), pathname, ts, nonce, deviceId, CLIENT_VERSION, credential].map(nul).join('\0');
  const meta = Object.entries(extraMeta ?? {}).filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => nul(k) + '\0' + nul(v)).join('\0');
  const sig = coreCall(core.cc_sign.bind(core), [seed, Buffer.from(canon, 'utf8'), Buffer.from(meta, 'utf8'), bodyBuf]);
  if (!sig) throw new Error('cc_sign failed');
  return {
    'x-mirasim-device': deviceId, 'x-mirasim-ts': ts, 'x-mirasim-nonce': nonce,
    'x-mirasim-sig': sig.toString('base64url'), 'x-mirasim-client': CLIENT_VERSION,
  };
}
function sealHeaders(headers, method, pathname) {
  const keys = Object.keys(headers).filter((k) => {
    const l = k.toLowerCase();
    return l.startsWith('x-mirasim-') && l !== 'x-mirasim-client' && l !== 'x-mirasim-enc';
  });
  if (!keys.length) return headers;
  const meta = {};
  for (const k of keys) meta[k] = headers[k];
  const sealed = coreCall(core.cc_seal.bind(core), [
    SEAL_PUBKEY, crypto.randomBytes(32), crypto.randomBytes(12),
    Buffer.from(JSON.stringify(meta), 'utf8'),
    Buffer.from(`mrs-seal-v1\n${method.toUpperCase()}\n${pathname}`, 'utf8'),
  ]);
  if (!sealed) throw new Error('cc_seal failed');
  headers['x-mirasim-enc'] = sealed.toString('base64url');
  for (const k of keys) delete headers[k];
  return headers;
}

console.log(`relay=${RELAY_BASE} client=${CLIENT_VERSION} device=${deviceId} core=${path.basename(CORE)}`);

// ── 1. 铸票 ──────────────────────────────────────────────────────────────
const mintPath = '/v1/device/session';
const mintBody = Buffer.from(JSON.stringify({ publicKey: pubB64, deviceId }), 'utf8');
const mintRes = await fetch(RELAY_BASE + mintPath, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: 'Bearer ' + issuerToken,
    ...signHeaders('POST', mintPath, mintBody, issuerToken, {}),
  },
  body: mintBody,
  signal: AbortSignal.timeout(30_000),
});
const mintJson = await mintRes.json().catch(() => ({}));
console.log(`mint ${mintRes.status} ${mintRes.ok ? `expiresIn=${mintJson.expiresIn}` : JSON.stringify(mintJson).slice(0, 200)}`);
if (!mintJson.ticket) process.exit(1);
const ticket = mintJson.ticket;

// ── 1b. 额度/账号状态：claude 通道被拒时，先看平台怎么描述这个账号 ──────────
// （suspended / degraded / paid / windows 里的 used-budget 是判断"平台侧还是适配侧"的第一手依据）
if (argv.includes('--limits')) {
  const limitsPath = '/v1/limits';
  const emptyBody = Buffer.alloc(0);
  const h = {
    accept: 'application/json',
    authorization: 'Bearer ' + ticket,
    'x-mirasim-session': crypto.randomUUID(),
    'x-mirasim-agent': AGENT,
  };
  Object.assign(h, signHeaders('GET', limitsPath, emptyBody, ticket, { 'x-mirasim-agent': AGENT }));
  sealHeaders(h, 'GET', limitsPath);
  const r = await fetch(RELAY_BASE + limitsPath, { method: 'GET', headers: h, signal: AbortSignal.timeout(30_000) });
  console.log(`limits ${r.status}`);
  console.log('  ' + (await r.text()).replace(/\s+/g, ' ').slice(0, 900));
}

// ── 2. 业务请求 ──────────────────────────────────────────────────────────
// --cache：带 cache_control（system / 消息内容块 / tools 三处断点），用来验证
// relay 是否还接受块级 cache_control（0.0.224 时代会 400）。
const models = MODELS.length ? MODELS : ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8'];
for (const model of models) {
  const sys = [{ type: 'text', text: BILLING }];
  const userContent = CACHE ? [{ type: 'text', text: 'say ok', cache_control: { type: 'ephemeral' } }] : 'say ok';
  if (CACHE) sys[0].cache_control = { type: 'ephemeral', ttl: '1h' };
  const body = Buffer.from(JSON.stringify({
    model, max_tokens: 24, stream: false,
    system: sys,
    ...(NO_THINKING ? {} : { thinking: { type: 'adaptive', display: THINKING_DISPLAY } }),
    ...(SERVICE_TIER ? { service_tier: SERVICE_TIER } : {}),
    metadata: { user_id: userId },
    messages: [{ role: 'user', content: userContent }],
    ...(CACHE ? {
      tools: [{
        name: 'get_time', description: 'returns the current time',
        input_schema: { type: 'object', properties: {} },
        cache_control: { type: 'ephemeral' },
      }],
    } : {}),
  }), 'utf8');
  const sessionId = crypto.randomUUID();
  const headers = {
    accept: 'application/json', 'content-type': 'application/json',
    'user-agent': UA,
    'x-claude-code-session-id': sessionId,
    'x-stainless-arch': 'x64', 'x-stainless-lang': 'js', 'x-stainless-os': 'Windows',
    'x-stainless-package-version': '0.112.1', 'x-stainless-retry-count': '0',
    'x-stainless-runtime': 'node', 'x-stainless-runtime-version': 'v26.3.0', 'x-stainless-timeout': '600',
    'anthropic-beta': 'claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,'
      + 'thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,'
      + 'mid-conversation-system-2026-04-07,mid-conversation-tool-changes-2026-07-01,effort-2025-11-24',
    'anthropic-dangerous-direct-browser-access': 'true', 'anthropic-version': '2023-06-01', 'x-app': 'cli',
    authorization: 'Bearer ' + ticket,
    'x-mirasim-session': sessionId, 'x-mirasim-agent': AGENT,
    'x-mirasim-locale': process.env.BRIDGE_CLIENT_LOCALE || 'zh-CN',
    'x-mirasim-call': crypto.randomUUID(),
  };
  // PROBE_EXTRA='{"x-mirasim-turn":"..."}'：临时补一个候选头，用来二分定位上游新要求
  if (process.env.PROBE_EXTRA) {
    try { Object.assign(headers, JSON.parse(process.env.PROBE_EXTRA)); }
    catch { console.log('PROBE_EXTRA 不是合法 JSON，已忽略'); }
  }
  const extra = {};
  for (const [k, v] of Object.entries(headers)) {
    const l = k.toLowerCase();
    if (l.startsWith('x-mirasim-') && !SIG_KEYS.includes(l)) extra[l] = v;
  }
  Object.assign(headers, signHeaders('POST', MSG_PATH, body, ticket, extra));
  sealHeaders(headers, 'POST', MSG_PATH);
  const t0 = Date.now();
  try {
    const r = await fetch(`${RELAY_BASE}${MSG_PATH}${QUERY}`, {
      method: 'POST', headers, body, signal: AbortSignal.timeout(180_000),
    });
    const text = await r.text();
    const ms = Date.now() - t0;
    let verdict = '';
    if (r.ok) verdict = '✅ 可用';
    else if (text.includes('client_outdated')) verdict = '⚠️ 版本落后：升 BRIDGE_RELAY_CLIENT';
    else if (text.includes('missing_headers')) verdict = '⚠️ 封套缺失：检查 core.wasm';
    else if (text.includes('no upstream available')) verdict = '⏳ 协议通过，平台池繁忙';
    else if (text.includes('not supported at this time')) verdict = '⚠️ 模型名不被接受';
    console.log(`${model.padEnd(20)} ${r.status} ${String(ms).padStart(6)}ms ${verdict}`);
    console.log(`  ${text.replace(/\s+/g, ' ').slice(0, 220)}`);
    if (!r.ok && process.env.PROBE_HEADERS === '1') {
      // 失败时把上游返回的追溯头也打出来：relay 常在头里给 route / region / 拒绝原因
      const keep = [...r.headers.entries()].filter(([k]) => /mirasim|litellm|router|anthropic-ratelimit|region|retry-after|x-request-id|cf-/i.test(k));
      console.log(`  headers: ${keep.map(([k, v]) => `${k}=${String(v).slice(0, 80)}`).join(' | ') || '(无相关头)'}`);
    }
  } catch (e) {
    console.log(`${model.padEnd(20)} ERR ${e.message}`);
  }
}
