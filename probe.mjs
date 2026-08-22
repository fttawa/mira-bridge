// 诊断脚本：逐一测试常见客户端请求形态，定位哪种会被上游拒绝
import fs from 'node:fs';
import { routerUrl } from './_upstream.mjs';

const KEY = fs.readFileSync(new URL('./.api-key', import.meta.url), 'utf8').trim();
const BRIDGE = process.env.PROBE_TARGET || 'http://127.0.0.1:8787';
// 直连上游，用于区分「桥接层的锅」还是「上游的锅」。端口会变，向 bridge 问
const ROUTER = await routerUrl();
const M = 'claude-haiku-4-5';

const cases = {
  '基础单轮': { model: M, messages: [{ role: 'user', content: 'hi' }], max_tokens: 20 },
  '带 system': { model: M, messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' }], max_tokens: 20 },
  '连续两条 user': { model: M, messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }], max_tokens: 20 },
  'assistant 结尾(prefill)': { model: M, messages: [{ role: 'user', content: 'count' }, { role: 'assistant', content: '1,' }], max_tokens: 20 },
  '空 content 的 user': { model: M, messages: [{ role: 'user', content: '' }], max_tokens: 20 },
  '只有 system': { model: M, messages: [{ role: 'system', content: 'hi' }], max_tokens: 20 },
  'content=null': { model: M, messages: [{ role: 'user', content: null }], max_tokens: 20 },
  '多轮正常': { model: M, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }], max_tokens: 20 },
  '超大 max_tokens': { model: M, messages: [{ role: 'user', content: 'hi' }], max_tokens: 200000 },
  '不传 max_tokens': { model: M, messages: [{ role: 'user', content: 'hi' }] },
  'temperature=0': { model: M, messages: [{ role: 'user', content: 'hi' }], max_tokens: 20, temperature: 0 },
  'temp+top_p 同时': { model: M, messages: [{ role: 'user', content: 'hi' }], max_tokens: 20, temperature: 0.7, top_p: 0.9 },
  'stop 字符串': { model: M, messages: [{ role: 'user', content: 'hi' }], max_tokens: 20, stop: '\n' },
  'OpenAI 多模态文本块': { model: M, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], max_tokens: 20 },
  '带 n=1': { model: M, messages: [{ role: 'user', content: 'hi' }], max_tokens: 20, n: 1 },
  '带 presence/frequency_penalty': { model: M, messages: [{ role: 'user', content: 'hi' }], max_tokens: 20, presence_penalty: 0, frequency_penalty: 0 },
  '带 user 字段': { model: M, messages: [{ role: 'user', content: 'hi' }], max_tokens: 20, user: 'u1' },
  '带 response_format': { model: M, messages: [{ role: 'user', content: 'hi' }], max_tokens: 20, response_format: { type: 'text' } },
};

const post = async (url, path, body, headers = {}) => {
  try {
    const r = await fetch(url + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const t = await r.text();
    return { status: r.status, text: t };
  } catch (e) {
    return { status: 0, text: String(e.message) };
  }
};

const brief = (t) => {
  try {
    const j = JSON.parse(t);
    if (j.error) return j.error.message?.slice(0, 90);
    return 'OK';
  } catch { return t.slice(0, 90); }
};

console.log(`目标: ${BRIDGE}\n`);
const failures = [];
for (const [name, body] of Object.entries(cases)) {
  const r = await post(BRIDGE, '/v1/chat/completions', body, { Authorization: `Bearer ${KEY}` });
  const ok = r.status === 200;
  console.log(`${ok ? '  ok ' : ' FAIL'}  ${String(r.status).padEnd(4)} ${name.padEnd(26)} ${ok ? '' : brief(r.text)}`);
  if (!ok) failures.push([name, body, r]);
}

// 对失败用例，把桥接层转换后的 Anthropic 请求直接打到上游，区分责任方
if (failures.length) {
  console.log('\n── 失败用例直连上游对照 ──');
  for (const [name, body] of failures) {
    // 复刻 server.mjs 的极简转换，只为对照
    const msgs = [];
    let system;
    for (const m of body.messages ?? []) {
      if (m.role === 'system') { system = m.content; continue; }
      const c = typeof m.content === 'string' ? m.content : (m.content?.map?.(p => p.text).join('') ?? '');
      if (c) msgs.push({ role: m.role, content: [{ type: 'text', text: c }] });
    }
    const a = { model: M, messages: msgs, max_tokens: body.max_tokens ?? 8192 };
    if (system) a.system = system;
    const r = await post(ROUTER, '/v1/messages', a, { 'anthropic-version': '2023-06-01' });
    console.log(`  ${String(r.status).padEnd(4)} ${name.padEnd(26)} messages=${JSON.stringify(msgs).slice(0, 60)} → ${brief(r.text)}`);
  }
}
