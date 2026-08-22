// 验证 Anthropic 原生端点 /v1/messages
import fs from 'node:fs';
const KEY = fs.readFileSync(new URL('./.api-key', import.meta.url), 'utf8').trim();
const B = process.env.PROBE_TARGET || 'http://127.0.0.1:8787';

const call = async (path, body, headers = {}) => {
  const r = await fetch(B + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  return { status: r.status, text: await r.text() };
};
const line = (ok, status, name, note = '') =>
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${String(status).padEnd(4)} ${name.padEnd(34)} ${note}`);

// 1. x-api-key 认证（Anthropic 客户端的标准头）
{
  const r = await call('/v1/messages', { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'say ok' }], max_tokens: 30 }, { 'x-api-key': KEY });
  let note = '';
  try { note = 'content=' + JSON.stringify(JSON.parse(r.text).content?.[0]?.text); } catch { note = r.text.slice(0, 50); }
  line(r.status === 200, r.status, 'x-api-key 认证 + 基础对话', note);
}
// 2. Bearer 认证
{
  const r = await call('/v1/messages', { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'say ok' }], max_tokens: 30 }, { Authorization: `Bearer ${KEY}` });
  line(r.status === 200, r.status, 'Bearer 认证');
}
// 3. 无认证
{
  const r = await call('/v1/messages', { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 20 });
  line(r.status === 401, r.status, '无认证（预期 401）');
}
// 4. 推理模型 + temperature（原生格式下也该被兜底）
{
  const r = await call('/v1/messages', { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'say ok' }], max_tokens: 2000, temperature: 0.8 }, { 'x-api-key': KEY });
  let note = '';
  try { note = 'content=' + JSON.stringify(JSON.parse(r.text).content?.find((b) => b.type === 'text')?.text?.slice(0, 20)); } catch { note = r.text.slice(0, 50); }
  line(r.status === 200, r.status, 'sonnet-5 + temperature 兜底', note);
}
// 5. system 顶层字段（Anthropic 原生写法）
{
  const r = await call('/v1/messages', { model: 'claude-haiku-4-5', system: '只回一个词', messages: [{ role: 'user', content: 'say ok' }], max_tokens: 30 }, { 'x-api-key': KEY });
  line(r.status === 200, r.status, 'system 顶层字段');
}
// 6. tools（Anthropic 原生 schema）
{
  const r = await call('/v1/messages', {
    model: 'claude-haiku-4-5', max_tokens: 200,
    tools: [{ name: 'get_weather', description: 'Get weather', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
    messages: [{ role: 'user', content: 'weather in Paris?' }],
  }, { 'x-api-key': KEY });
  let note = '';
  try { const j = JSON.parse(r.text); note = 'stop=' + j.stop_reason + ' blocks=' + j.content.map((b) => b.type).join('+'); } catch { note = r.text.slice(0, 50); }
  line(r.status === 200, r.status, 'tools（原生 input_schema）', note);
}
// 7. 流式 —— 必须是 Anthropic 事件格式，不能被改写成 OpenAI chunk
{
  const r = await fetch(B + '/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'count 1 to 5' }], max_tokens: 100, stream: true }),
    signal: AbortSignal.timeout(180_000),
  });
  const raw = await r.text();
  const events = [...raw.matchAll(/^event: (\w+)/gm)].map((m) => m[1]);
  const text = [...raw.matchAll(/"text_delta","text":"([^"]*)"/g)].map((m) => m[1]).join('');
  const isAnthropic = events.includes('message_start') && events.includes('message_stop');
  const notOpenAI = !raw.includes('chat.completion.chunk') && !raw.includes('[DONE]');
  line(r.status === 200 && isAnthropic && notOpenAI, r.status, '流式（原生 SSE 事件）',
    `events=${[...new Set(events)].join(',')} 文本="${text.slice(0, 24)}"`);
}
// 8. count_tokens
{
  const r = await call('/v1/messages/count_tokens', { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hello world' }] }, { 'x-api-key': KEY });
  line(r.status === 200, r.status, 'count_tokens', r.text.slice(0, 60));
}
// 9. /v1/models 双格式兼容
{
  const r = await fetch(B + '/v1/models', { headers: { 'x-api-key': KEY } });
  const j = await r.json();
  const m = j.data?.[0] ?? {};
  const openai = 'object' in m && 'owned_by' in m;
  const anthropic = 'type' in m && 'display_name' in m;
  line(r.status === 200 && openai && anthropic, r.status, '/v1/models 双格式字段',
    `OpenAI字段=${openai} Anthropic字段=${anthropic} 共${j.data?.length}个`);
}
