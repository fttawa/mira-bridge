// 从 requests.log 取失败载荷重放到上游，二分定位是哪部分内容触发拒绝
import fs from 'node:fs';

import { routerUrl } from './_upstream.mjs';
const ROUTER = await routerUrl();
const lines = fs.readFileSync(new URL('./requests.log', import.meta.url), 'utf8')
  .split('\n').filter((l) => l.includes('"level":"error"'));
const idx = Number(process.argv[2] ?? -1);
const rec = JSON.parse(lines.at(idx));
const A = rec.anthropic_request;

console.log(`重放 ${rec.ts}  model=${A.model}`);
console.log(`  system len=${A.system?.length ?? 0}  user len=${A.messages?.[0]?.content?.[0]?.text?.length ?? 0}\n`);

const call = async (label, body) => {
  try {
    const r = await fetch(ROUTER + '/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const t = await r.text();
    let m = '';
    if (r.status !== 200) { try { m = JSON.parse(t).error.message.slice(0, 55); } catch { m = t.slice(0, 55); } }
    console.log(`  ${r.status === 200 ? 'ok  ' : 'FAIL'} ${String(r.status).padEnd(4)} ${label.padEnd(34)} ${m}`);
    return r.status === 200;
  } catch (e) {
    console.log(`  ERR       ${label.padEnd(34)} ${e.message.slice(0, 55)}`);
    return false;
  }
};

const sys = A.system ?? '';
const usr = A.messages?.[0]?.content?.[0]?.text ?? '';
const mk = (s, u, extra = {}) => {
  const b = { model: A.model, messages: [{ role: 'user', content: [{ type: 'text', text: u }] }], max_tokens: A.max_tokens, ...extra };
  if (s) b.system = s;
  return b;
};

// 1) 原样重放（内容已被日志截断，但足以判断触发点是否落在前 1500 字符内）
await call('原样重放', { ...A });

// 2) 拆开：分别只留 system / 只留 user
await call('去掉 system（仅 user）', mk('', usr));
await call('去掉 user（system + 占位）', mk(sys, 'hi'));

// 3) 去掉采样参数
await call('原样但去掉 temperature', mk(sys, usr));

// 4) 对 system / user 各自二分，定位触发段落
for (const [name, full, other] of [['system', sys, 'u'], ['user', usr, 's']]) {
  if (!full) continue;
  console.log(`\n  ── 二分 ${name}（共 ${full.length} 字符）──`);
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    const cut = full.slice(0, Math.floor(full.length * frac));
    const body = other === 'u' ? mk('', cut || 'hi') : mk(cut, 'hi');
    await call(`前 ${Math.round(frac * 100)}% (${cut.length} 字符)`, body);
  }
}
