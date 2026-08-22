// 用日志里的真实 Claude Code 载荷逐字段删除，定位触发 400 的字段
import fs from 'node:fs';
import { routerUrl } from './_upstream.mjs';
const ROUTER = await routerUrl();

const rec = JSON.parse(
  fs.readFileSync(new URL('./requests.log', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('"level":"error"')).at(-1)
);
const A = rec.anthropic_request;
console.log(`载荷: ${rec.ts}  ua=${rec.ua}`);
console.log(`  字段: ${Object.keys(A).join(', ')}\n`);

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
    if (r.status !== 200) { try { m = JSON.parse(t).error.message.slice(0, 50); } catch { m = t.slice(0, 50); } }
    console.log(`  ${r.status === 200 ? 'ok  ' : 'FAIL'} ${String(r.status).padEnd(4)} ${label.padEnd(30)} ${m}`);
    return r.status === 200;
  } catch (e) {
    console.log(`  ERR       ${label.padEnd(30)} ${e.message.slice(0, 50)}`);
    return false;
  }
};

// 关掉 stream，响应更好判读
const full = { ...A, stream: false };
await call('原样重放（含全部字段）', full);

// 逐个删除可选字段，看谁是元凶
for (const k of ['thinking', 'tools', 'system', 'metadata', 'max_tokens']) {
  if (!(k in full)) continue;
  const b = { ...full };
  delete b[k];
  if (k === 'max_tokens') b.max_tokens = 4096; // 必填，换个小值
  await call(`去掉 ${k}`, b);
}

// 只保留最小集，再逐个加回
console.log('');
const min = { model: A.model, messages: A.messages, max_tokens: 4096 };
await call('最小集 (model+messages)', min);
for (const k of ['thinking', 'tools', 'system', 'metadata']) {
  if (!(k in A)) continue;
  await call(`最小集 + ${k}`, { ...min, [k]: A[k] });
}

// max_tokens 单独看：Claude Code 传的是 64000
console.log('');
for (const mt of [4096, 32000, 64000]) {
  await call(`最小集 max_tokens=${mt}`, { ...min, max_tokens: mt });
}
if (A.thinking) {
  for (const mt of [4096, 32000, 64000]) {
    await call(`min+thinking max_tokens=${mt}`, { ...min, thinking: A.thinking, max_tokens: mt });
  }
}
