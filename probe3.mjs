// 第二轮诊断：覆盖上一轮没测的面 —— 各模型、tools、图片、system 变体、长上下文
import fs from 'node:fs';
const KEY = fs.readFileSync(new URL('./.api-key', import.meta.url), 'utf8').trim();
const B = process.env.PROBE_TARGET || 'http://127.0.0.1:8787';

const TOOL = {
  type: 'function',
  function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
};
// 1x1 透明 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const u = (t) => [{ role: 'user', content: t }];

const cases = {
  // 各模型基线
  'model: claude-haiku-4-5': { model: 'claude-haiku-4-5', messages: u('hi'), max_tokens: 20 },
  'model: claude-sonnet-5': { model: 'claude-sonnet-5', messages: u('hi'), max_tokens: 20 },
  'model: claude-opus-5': { model: 'claude-opus-5', messages: u('hi'), max_tokens: 20 },
  'model: claude-opus-4-8': { model: 'claude-opus-4-8', messages: u('hi'), max_tokens: 20 },
  'model: claude-opus-4-7': { model: 'claude-opus-4-7', messages: u('hi'), max_tokens: 20 },
  'model: claude-fable-5': { model: 'claude-fable-5', messages: u('hi'), max_tokens: 20 },
  // 带 [1M] 后缀（mirasim 的 context 变体写法）
  'model: claude-opus-5[1M]': { model: 'claude-opus-5[1M]', messages: u('hi'), max_tokens: 20 },
  // tools
  'tools 基础': { model: 'claude-haiku-4-5', messages: u('weather in Paris?'), tools: [TOOL], max_tokens: 100 },
  'tool_choice auto': { model: 'claude-haiku-4-5', messages: u('weather in Paris?'), tools: [TOOL], tool_choice: 'auto', max_tokens: 100 },
  'tool_choice required': { model: 'claude-haiku-4-5', messages: u('weather in Paris?'), tools: [TOOL], tool_choice: 'required', max_tokens: 100 },
  'tool_choice none': { model: 'claude-haiku-4-5', messages: u('hi'), tools: [TOOL], tool_choice: 'none', max_tokens: 50 },
  'tools 空数组': { model: 'claude-haiku-4-5', messages: u('hi'), tools: [], max_tokens: 20 },
  'parameters 无 properties': {
    model: 'claude-haiku-4-5', messages: u('ping'), max_tokens: 50,
    tools: [{ type: 'function', function: { name: 'noop', description: 'x', parameters: { type: 'object' } } }],
  },
  'function 无 description': {
    model: 'claude-haiku-4-5', messages: u('ping'), max_tokens: 50,
    tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {} } } }],
  },
  // 工具结果回传（完整往返）
  'tool 结果回传': {
    model: 'claude-haiku-4-5', max_tokens: 100, tools: [TOOL],
    messages: [
      { role: 'user', content: 'weather in Paris?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"temp":18}' },
    ],
  },
  // 图片
  '图片 data URL': { model: 'claude-haiku-4-5', max_tokens: 30, messages: [{ role: 'user', content: [{ type: 'text', text: 'what color?' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }] }] },
  // system 变体
  'system 为数组': { model: 'claude-haiku-4-5', max_tokens: 20, messages: [{ role: 'system', content: [{ type: 'text', text: 'be terse' }] }, { role: 'user', content: 'hi' }] },
  'developer 角色': { model: 'claude-haiku-4-5', max_tokens: 20, messages: [{ role: 'developer', content: 'be terse' }, { role: 'user', content: 'hi' }] },
  '多条 system': { model: 'claude-haiku-4-5', max_tokens: 20, messages: [{ role: 'system', content: 'a' }, { role: 'system', content: 'b' }, { role: 'user', content: 'hi' }] },
  'system 在中间': { model: 'claude-haiku-4-5', max_tokens: 20, messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: 'be terse' }] },
  // 其它
  'stream + tools': { model: 'claude-haiku-4-5', messages: u('weather in Paris?'), tools: [TOOL], max_tokens: 100, stream: true },
  'max_tokens=1': { model: 'claude-haiku-4-5', messages: u('hi'), max_tokens: 1 },
  'max_tokens=0': { model: 'claude-haiku-4-5', messages: u('hi'), max_tokens: 0 },
  'temperature=2': { model: 'claude-haiku-4-5', messages: u('hi'), max_tokens: 20, temperature: 2 },
  'seed 字段': { model: 'claude-haiku-4-5', messages: u('hi'), max_tokens: 20, seed: 42 },
  'logprobs': { model: 'claude-haiku-4-5', messages: u('hi'), max_tokens: 20, logprobs: true },
  '长上下文 ~40k 字符': { model: 'claude-haiku-4-5', messages: u('x'.repeat(40000) + '\n说 ok'), max_tokens: 20 },
};

let fail = 0;
for (const [name, body] of Object.entries(cases)) {
  try {
    const r = await fetch(B + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const t = await r.text();
    let msg = '';
    if (r.status !== 200) { fail++; try { msg = JSON.parse(t).error.message.slice(0, 70); } catch { msg = t.slice(0, 70); } }
    console.log(`${r.status === 200 ? '  ok ' : ' FAIL'} ${String(r.status).padEnd(4)} ${name.padEnd(26)} ${msg}`);
  } catch (e) {
    fail++;
    console.log(` ERR       ${name.padEnd(26)} ${e.message.slice(0, 70)}`);
  }
}
console.log(`\n共 ${Object.keys(cases).length} 项，失败 ${fail} 项`);
