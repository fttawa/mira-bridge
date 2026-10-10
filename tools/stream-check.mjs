#!/usr/bin/env node
/**
 * stream-check — 流式健康检查：区分「完整收尾 / 上游掐断 / 客户端提前断」
 *
 * 用法：
 *   node tools/stream-check.mjs                                   # 打本地 8787，claude-opus-5
 *   node tools/stream-check.mjs https://mira.neko.xn--fiqs8s      # 打公网（顺带验隧道）
 *   node tools/stream-check.mjs http://127.0.0.1:8787 claude-sonnet-5
 *   BRIDGE_API_KEY=sk-mira-... node tools/stream-check.mjs        # 非默认 key
 *
 * 判读：
 *   ✅ 流完整收尾          收到 message_stop，链路健康
 *   ⚠️ 没收到 message_stop  SSE 被提前终止（客户端侧就是 "API Error: terminated"）
 *   maxGapBetweenChunks    相邻 chunk 的最大间隔；逼近 100s 要怀疑 Cloudflare 空闲超时
 * 同时对照 bridge 的 requests.log：`stream_done` / `stream_aborted` 两行会给出
 * ms / bytes / maxGapMs / stop / clientClosed，一眼能看出是上游断还是客户端断。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const model = process.argv[3] || 'claude-opus-5';
const KEY = process.env.BRIDGE_API_KEY
  || fs.readFileSync(path.join(__dirname, '..', '.api-key'), 'utf8').trim();
const prompt = process.env.STREAM_PROMPT
  || 'Write a detailed 900-word explanation of how TCP congestion control works. Do not stop early.';

const t0 = Date.now();
let res;
try {
  res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': KEY, 'content-type': 'application/json',
      'anthropic-version': '2023-06-01', accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model, max_tokens: 4000, stream: true,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
} catch (e) {
  console.log('连接失败:', e.message);
  process.exit(1);
}
console.log(`target=${BASE} model=${model} status=${res.status} 首字节 ${Date.now() - t0}ms`);
if (!res.ok) {
  console.log('上游错误:', (await res.text()).slice(0, 300));
  process.exit(1);
}

const decoder = new TextDecoder();
let buf = '';
let events = 0, chars = 0, lastAt = Date.now(), maxGap = 0;
let stop = false, err = null;
try {
  for await (const chunk of res.body) {
    const now = Date.now();
    maxGap = Math.max(maxGap, now - lastAt);
    lastAt = now;
    buf += decoder.decode(chunk, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const p of parts) {
      events++;
      if (p.includes('message_stop')) stop = true;
      if (p.includes('"type":"error"')) err = p.slice(0, 200);
      const m = p.match(/"text":"((?:[^"\\]|\\.)*)"/g);
      if (m) chars += m.join('').length;
    }
  }
} catch (e) {
  err = '读取中断: ' + e.message;
}
console.log(`events=${events} textChars≈${chars} maxGap=${maxGap}ms total=${Date.now() - t0}ms`);
if (err) console.log('error 事件:', err);
console.log(stop ? '✅ 流完整收尾（收到 message_stop）' : '⚠️ 流被提前终止（没收到 message_stop）');
