// 直连上游，二分定位 relay 对采样参数 / stop_sequences 的精确约束
import { routerUrl } from './_upstream.mjs';
const ROUTER = await routerUrl();
const base = { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], max_tokens: 20 };

const cases = {
  '仅 temperature':            { temperature: 0.7 },
  '仅 top_p':                  { top_p: 0.9 },
  'temperature + top_p':       { temperature: 0.7, top_p: 0.9 },
  'temperature=1 + top_p':     { temperature: 1, top_p: 0.9 },
  'stop_sequences ["END"]':    { stop_sequences: ['END'] },
  'stop_sequences ["\\n"]':    { stop_sequences: ['\n'] },
  'stop_sequences [" "]':      { stop_sequences: [' '] },
  'stop_sequences []':         { stop_sequences: [] },
  'top_k':                     { top_k: 40 },
};

for (const [name, extra] of Object.entries(cases)) {
  const body = { ...base, ...extra };
  try {
    const r = await fetch(ROUTER + '/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const t = await r.text();
    let msg = 'OK';
    if (r.status !== 200) { try { msg = JSON.parse(t).error.message.slice(0, 80); } catch { msg = t.slice(0, 80); } }
    console.log(`  ${r.status === 200 ? 'ok  ' : 'FAIL'} ${String(r.status).padEnd(4)} ${name.padEnd(26)} ${msg === 'OK' ? '' : msg}`);
  } catch (e) {
    console.log(`  ERR       ${name.padEnd(26)} ${e.message}`);
  }
}
