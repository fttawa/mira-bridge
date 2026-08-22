# mira-bridge

把本机 Mirasim 桌面端的模型额度，包装成一个**同时兼容 OpenAI 与 Anthropic 协议**的本地 API。

```
你的客户端 ──→ mira-bridge :8787 ──→ mirasim-router ──→ relay
              (API key 校验 +        (本机，端口自动发现)
               协议转换 + 约束兜底)
```

零外部依赖，单文件，只用 Node 内置模块。要求 Node >= 18。

## 为什么需要这一层

Mirasim 桌面端在本机跑着一个 `mirasim-router`，但直接用它有三个问题：

1. **它不校验任何凭据。** 只听 `127.0.0.1`，任何本机进程都能白嫖你的额度。本层负责加 API key。
2. **它只接受 Anthropic Messages API。** `/v1/chat/completions` 在上游是不通的，claude 系模型会明确报错。本层负责 OpenAI ⇄ Anthropic 双向转换。
3. **它的端口跨重启会变。** 写死必挂。本层启动时自动发现，失效时重新探测。

此外上游还有一批**不写在任何文档里的约束**，踩中一律回同一句含混的 `400 The request was rejected as invalid.`，不指出是哪个字段。本层逐条兜底，详见下方「上游的隐藏约束」——那一节是这个项目最有价值的部分。

## 快速开始

```bash
node server.mjs
```

首次运行自动生成 API key 到 `.api-key`，并打印在启动日志里：

```
[bridge] 监听 http://127.0.0.1:8787
[bridge] API key: sk-mira-xxxxxxxx
[bridge] 发现 mirasim-router → 127.0.0.1:51840
```

自检：

```bash
curl http://127.0.0.1:8787/healthz          # 不鉴权，返回上游端口
curl http://127.0.0.1:8787/v1/models -H "Authorization: Bearer $(cat .api-key)"
```

## 两套协议，同一个地址

| 端点 | 协议 | 说明 |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI | 完整转换 |
| `POST /v1/messages` | Anthropic 原生 | 近乎透传——上游本就是这个协议 |
| `POST /v1/messages/count_tokens` | Anthropic 原生 | 纯透传 |
| `GET /v1/models` | 两者兼容 | 同一响应铺了两套字段 |
| `GET /healthz` | — | 不鉴权，供探活 |

认证两种头都收：`Authorization: Bearer <key>`（OpenAI 习惯）与 `x-api-key: <key>`（Anthropic 习惯）。

OpenAI 客户端：

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="sk-mira-...")
print(client.chat.completions.create(
    model="claude-opus-5",
    messages=[{"role": "user", "content": "hi"}],
).choices[0].message.content)
```

Claude Code / Anthropic SDK：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_AUTH_TOKEN=sk-mira-...
```

原生端点上流式 SSE **原样转发**，仍是 `message_start` / `content_block_delta` / `message_stop` 这套事件，不会被改写成 OpenAI chunk。

两条路径只有一处差别：**原生端点不动 `max_tokens`**。Anthropic 调用方本就知道该额度含 thinking，擅自放大会违背其预期；补偿只在 OpenAI 那条路上做。采样参数的剥离与自愈重试则两边都有。

## 上游的隐藏约束

以下全部为实测结论。踩中任意一条，上游都只回 `400 The request was rejected as invalid.`，**不告诉你是哪个字段**。

### 采样参数：只有 haiku 接受

除 `claude-haiku-4-5` 外，其余模型都是推理模型（extended thinking 默认开启），带任何采样参数即 400：

| 模型 | 无参数 | `temp=0.8` | `temp=1` | `top_p` | `top_k` |
|---|---|---|---|---|---|
| `claude-haiku-4-5` | ok | ok | ok | ok | ok |
| 其余全部 | ok | **400** | ok | **400** | **400** |

`temperature` 只接受 `1`（thinking 模式下的唯一合法值），`top_p` / `top_k` 一律拒绝。

按 `BRIDGE_SAMPLING_MODELS`（默认 `haiku`）判断：匹配的模型才下发采样参数，其余一律剥掉，等价于 `temperature=1`。另有一层自愈：若仍因采样参数吃了 400，自动剥掉重试一次并在日志记 `sampling_rejected_retried`，所以模型清单变了也不会挂。

### `max_tokens` 含 thinking token（最阴险，且不报错）

Anthropic 的 `max_tokens` 把 thinking 算在内，OpenAI 语义只计可见输出。推理模型上小额度会被 thinking 吃光，客户端拿到 **HTTP 200 + 空内容**，没有任何错误提示：

| max_tokens | thinking | 正文 | 结果 |
|---|---|---|---|
| 100 | 99 | 0 字 | **空响应** |
| 300 | 216 | 79 字 | 被截断 |
| 1000 | 177 | 151 字 | 正常 |

OpenAI 路径上，推理模型且额度低于 `BRIDGE_THINKING_RESERVE`（默认 4096）时自动补该额度。

### `cache_control.scope`（Claude Code 专属）

Claude Code 2.1+ 在 system 块上带的是 `{"type":"ephemeral","ttl":"1h","scope":"global"}`。`scope` 是它用来跨会话共享 prompt cache 的扩展，上游不认；`ttl` 则没问题：

| cache_control | 结果 |
|---|---|
| `{type:"ephemeral"}` | ok |
| `{type:"ephemeral", ttl:"5m"}` / `{ttl:"1h"}` | ok |
| `{type:"ephemeral", scope:"global"}` | **400** |

`/v1/messages` 上递归剥掉所有 `cache_control.scope`（system 块、messages 内容块、tools 定义都可能带），`ttl` 保留。

### `thinking` 参数与官方文档相反

上游只认 `{"type":"adaptive"}`（Claude Code 用的就是它）；官方文档写的 `{"type":"enabled","budget_tokens":N}` 和 `{"type":"disabled"}` 反而 400。**不要"修正"它**，原样透传即可工作。

### 其余

| 约束 | 处理 |
|---|---|
| `temperature` 上限 1.0（OpenAI 是 2.0） | 钳制到 `[0,1]`。不做线性映射——两边默认值都是 1.0，映射会平白改变既有行为 |
| `temperature` 与 `top_p` 不能同时出现 | 两个都传时只保留 `temperature` |
| `stop_sequences` 不能含纯空白项（`"\n"`、`" "`） | 自动过滤；全被滤掉则不下发该字段 |
| `max_tokens` 必须 >= 1 | `0` / 负数 / 缺失一律回落到默认值 |
| `messages` 不能为空 | 返回明确错误而非透传含混信息 |

模型名**不要带 `[1M]` 后缀**（如 `claude-opus-5[1M]` 会 404），那是 Mirasim 内部的 context 变体写法。用 `/v1/models` 返回的裸名字。

上游还有速率限制，压测时会打出 `429 rate limit exceeded`。本层原样透传 429，客户端可自行退避。

## 响应头透传

上游的响应头会带给客户端，**不能只手写 content-type 了事**——客户端要靠这些做退避和追溯：

```
anthropic-ratelimit-unified-5h-reset / -utilization
anthropic-ratelimit-unified-7d-reset / -utilization
x-litellm-call-id, x-router-input-tokens, x-router-output-tokens
```

逐跳头（`connection` / `transfer-encoding` / `keep-alive` 等）按 HTTP 规范剔除，`content-length` 由本层重算。

> 合并时要按**小写**比对键名。`{'Content-Type': ...}` 盖不住上游的 `{'content-type': ...}`，两个都会发出去，客户端收到 `content-type: text/event-stream, text/event-stream; charset=utf-8` 这种重复值。

流式另外做了两件事：`socket.setNoDelay(true)` 关掉 Nagle 让事件立即出网；`res.write()` 返回 false 时等 `drain`，避免大流量在内存里堆积。

## 端口发现

`mirasim-router` 的端口跨重启会变，所以不能写死。启动时扫描本机回环端口，对每个候选打 `/v1/models`，认 `owned_by: "mirasim-router"`。

**探测不是每请求都做。** 早期实现每个请求都先 probe 一次，代价有两重：上游请求数直接翻倍；且上游一忙探测就超时，被误判成「router 不见了」进而返回 503——并发一高必现。现在缓存 `BRIDGE_PROBE_TTL_MS`（默认 30 秒），探测超时放宽到 `BRIDGE_PROBE_TIMEOUT_MS`（默认 5 秒），只有连接层真的报错才立即失效重探。`/healthz` 例外，强制探测以反映真实状态。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `BRIDGE_PORT` | `8787` | 监听端口 |
| `BRIDGE_HOST` | `127.0.0.1` | 监听地址。要暴露到公网，建议保持回环再用反代/隧道，别直接改成 `0.0.0.0` |
| `BRIDGE_API_KEY` | — | 指定 key，覆盖 `.api-key` 文件 |
| `BRIDGE_ROUTER_PORT` | 自动发现 | 固定上游端口，跳过扫描 |
| `BRIDGE_MODEL_FILTER` | `^claude-` | `/v1/models` 的正则过滤。设为空串放行全部 |
| `BRIDGE_DEFAULT_MAX_TOKENS` | `8192` | 客户端没传 `max_tokens` 时的默认值 |
| `BRIDGE_SAMPLING_MODELS` | `haiku` | 正则，匹配的模型才下发采样参数 |
| `BRIDGE_THINKING_RESERVE` | `4096` | 推理模型的 thinking 预算补偿 |
| `BRIDGE_PROBE_TTL_MS` | `30000` | 上游端口缓存有效期 |
| `BRIDGE_PROBE_TIMEOUT_MS` | `5000` | 单次端口探测超时。太短会在上游繁忙时误判 |
| `BRIDGE_TIMEOUT_MS` | `600000` | 上游请求超时 |

## 已实现

- 流式 + 非流式
- Function calling：`tools` / `tool_choice` / `tool_calls` / `role:"tool"` 回传，流式下增量拼 `arguments`
- 多模态图片：`image_url` 支持 `data:` base64 与 http URL
- `system` / `developer` 角色提取到 Anthropic 顶层 `system`
- `thinking` 块映射为 `reasoning_content`（DeepSeek R1 引入的事实标准，主流客户端可单独渲染），流式走 `delta.reasoning_content`
- `stream_options.include_usage`：在 `[DONE]` 前补一个 `choices: []` 只带 `usage` 的 chunk
- `usage` 映射，含 `completion_tokens_details.reasoning_tokens`
- `finish_reason` 映射：`end_turn→stop`、`max_tokens→length`、`tool_use→tool_calls`

> 注：`reasoning_content` 目前恒为空串——实测上游只回传 thinking 的 token 计数，不回传正文。映射代码留着，上游哪天回传即可生效。

## 诊断

### 请求日志

`requests.log`（JSONL）。失败请求完整落盘，成功只记一行摘要：

```jsonc
{"ts":"…","level":"error","status":400,"ua":"…",
 "openai_request":{…},      // 客户端发来的原始载荷
 "anthropic_request":{…},   // 桥接层转换后、真正发给上游的
 "upstream_response":{…}}   // 上游原文
```

**转换前后两份载荷对照**是定位含混 400 的关键。超长字符串（base64 图片、长上下文）自动截断到 1500 字符。

> 日志含完整对话内容，已在 `.gitignore`，注意别外传。

### 测试脚本

```bash
node probe.mjs      # OpenAI 参数与消息结构，18 项
node probe2.mjs     # 采样参数约束二分（直连上游）
node probe3.mjs     # 模型 / tools / 图片 / system 变体，27 项
node probe4.mjs     # Anthropic 原生端点，9 项

PROBE_TARGET=https://your-host node probe.mjs   # 指向远端
```

### 重放

从 `requests.log` 取最后一条失败载荷打到上游，逐字段删除以定位元凶——本项目里几个约束都是这么找出来的：

```bash
node replay.mjs      # 按 system / user 内容二分
node replay2.mjs     # 按顶层字段逐个删除
```

## 注意事项

**桌面端必须开着。** Mirasim 关掉后 `mirasim-router` 随之消失，`/healthz` 返回 503。这条链路解决不了「电脑关机也能用」。

**要暴露到公网的话**，保持 `BRIDGE_HOST=127.0.0.1`，前面套一层反代或隧道，并再加一层认证（当前只有一个静态 bearer，没有速率限制也没有失败锁定）。`/healthz` 故意不鉴权以便探活，它会暴露「服务是否存活」这一个信息。

**别把 `.api-key` 和 `requests.log` 提交到版本库。**

## License

MIT
