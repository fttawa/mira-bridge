// 对一条失败载荷做深度二分：先截断 messages 找最小失败集，再逐字段/逐块定位
import fs from 'node:fs';
import { routerUrl } from './_upstream.mjs';

const R = await routerUrl();
const recs = fs.readFileSync(new URL('./requests.log', import.meta.url), 'utf8')
  .split('\n').filter((l) => l.includes('"level":"error"'))
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r?.anthropic_request?.messages?.length >= 20);

const A = recs.at(Number(process.argv[2] ?? -1)).anthropic_request;
console.log(`载荷: messages=${A.messages.length}  tools=${A.tools?.length ?? 0}  system=${(A.system ?? '').length} 字符\n`);

const call = async (body) => {
  try {
    const r = await fetch(`${R}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (r.status === 200) { await r.text(); return true; }
    await r.text();
    return false;
  } catch { return false; }
};
const base = (msgs, extra = {}) => ({ model: A.model, messages: msgs, max_tokens: 200, ...extra });

// 1. 先确认原样失败、去掉 tools/system 是否还失败
console.log('── 粗筛 ──');
console.log(`  原样(仅 messages)        ${await call(base(A.messages)) ? 'ok' : 'FAIL'}`);
console.log(`  + system                ${await call(base(A.messages, { system: A.system })) ? 'ok' : 'FAIL'}`);
console.log(`  + tools                 ${await call(base(A.messages, { tools: A.tools })) ? 'ok' : 'FAIL'}`);

// 2. 截断 messages，找最小失败前缀
console.log('\n── 截断 messages 找最小失败前缀 ──');
let firstBad = -1;
for (let n = 1; n <= A.messages.length; n++) {
  const slice = A.messages.slice(0, n);
  if (slice.at(-1).role === 'assistant') continue; // 避开 prefill 干扰
  const ok = await call(base(slice));
  if (!ok) { firstBad = n; console.log(`  前 ${n} 条 → FAIL  (最小失败前缀)`); break; }
}
if (firstBad < 0) { console.log('  所有前缀都通过 —— 问题不在单条消息，可能是整体规模'); }

// 3. 定位到具体消息后，逐块检查
if (firstBad > 0) {
  const bad = A.messages[firstBad - 1];
  console.log(`\n── 第 ${firstBad - 1} 条消息 (role=${bad.role}, blocks=${bad.content.length}) ──`);
  bad.content.forEach((b, i) => {
    const body = b.text ?? '';
    console.log(`  [${i}] type=${b.type} keys=${Object.keys(b).join('/')} len=${body.length}`
      + (b.type === 'image' ? ` source.type=${b.source?.type} media=${b.source?.media_type} data=${(b.source?.data ?? '').length}字符` : '')
      + (body ? ` "${body.slice(0, 40).replace(/\n/g, '\\n')}"` : ''));
  });
  // 逐块二分：只保留单个块
  console.log('  逐块单独测试：');
  for (const [i, b] of bad.content.entries()) {
    const msgs = [...A.messages.slice(0, firstBad - 1), { role: bad.role, content: [b] }];
    if (msgs.at(-1).role === 'assistant') msgs.push({ role: 'user', content: [{ type: 'text', text: 'ok' }] });
    console.log(`    [${i}] ${b.type} → ${await call(base(msgs)) ? 'ok' : 'FAIL'}`);
  }
}
