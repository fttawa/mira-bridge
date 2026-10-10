#!/usr/bin/env node
/**
 * speed-test — 吞吐测量：TTFT / 总时长 / 输出 tokens / tokens-per-second
 *
 * 用法：
 *   node tools/speed-test.mjs                                  # 本地，claude-opus-5-5，3 轮
 *   node tools/speed-test.mjs https://mira.neko.xn--fiqs8s claude-opus-5-5 3
 *   node tools/speed-test.mjs http://127.0.0.1:8787 claude-opus-5-5 3 high
 *
 * 说明：token 数取上游 usage（message_delta 里的 output_tokens），不是按字符估算；
 * tok/s 给两个口径 —— 含思考的端到端，以及「首个 token 之后」的纯生成速度。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const MODEL = process.argv[3] || 'claude-opus-5-5';
const RUNS = Number(process.argv[4] || 3);
const EFFORT = process.argv[5] || null;
const KEY = process.env.BRIDGE_API_KEY
  || fs.readFileSync(path.join(__dirname, '..', '.api-key'), 'utf8').trim();
const PROMPT = process.env.SPEED_PROMPT
  || 'Write a dense technical explanation of how BGP route selection works, about 1200 words. Start immediately, no preamble.';

async function one(i) {
  const body = {
    model: MODEL, max_tokens: 4000, stream: true,
    messages: [{ role: 'user', content: PROMPT }],
  };
  if (EFFORT) body.output_config = { effort: EFFORT };
  const t0 = Date.now();
  let ttft = null, ttftText = null, tokens = 0, thinking = 0, textChars = 0, stop = false;
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.log(`run ${i}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const p of parts) {
      if (p.includes('message_stop')) stop = true;
      const line = p.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let d;
      try { d = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (d.type === 'content_block_delta' && d.delta?.type === 'thinking_delta') {
        if (ttft == null) ttft = Date.now() - t0;
      } else if (d.type === 'content_block_delta' && d.delta?.type === 'text_delta') {
        if (ttft == null) ttft = Date.now() - t0;
        if (ttftText == null) ttftText = Date.now() - t0;
        textChars += (d.delta.text ?? '').length;
      } else if (d.type === 'message_delta') {
        if (d.usage?.output_tokens) tokens = d.usage.output_tokens;
        if (d.usage?.output_tokens_details?.thinking_tokens) thinking = d.usage.output_tokens_details.thinking_tokens;
      }
    }
  }
  const total = Date.now() - t0;
  const genMs = Math.max(1, total - (ttft ?? 0));
  const tps = tokens ? (tokens / (total / 1000)) : 0;
  const tpsGen = tokens ? (tokens / (genMs / 1000)) : 0;
  console.log(`run ${i}: ttft=${ttft}ms 首文本=${ttftText}ms 总=${total}ms tokens=${tokens}(think=${thinking}) chars=${textChars} stop=${stop}`);
  console.log(`        tok/s 端到端=${tps.toFixed(1)}  首 token 后=${tpsGen.toFixed(1)}`);
  return { ttft, total, tokens, tps, tpsGen, stop };
}

console.log(`target=${BASE} model=${MODEL} effort=${EFFORT ?? '(默认=上游注入 max)'} runs=${RUNS}`);
const out = [];
for (let i = 1; i <= RUNS; i++) {
  try {
    const r = await one(i);
    if (r) out.push(r);
  } catch (e) {
    console.log(`run ${i}: ERR ${e.message}`);
  }
}
if (out.length) {
  const avg = (k) => (out.reduce((a, b) => a + b[k], 0) / out.length);
  console.log(`\n平均: ttft=${avg('ttft').toFixed(0)}ms 总=${avg('total').toFixed(0)}ms tokens=${avg('tokens').toFixed(0)}`);
  console.log(`平均 tok/s: 端到端=${avg('tps').toFixed(1)}  首 token 后=${avg('tpsGen').toFixed(1)}`);
}
