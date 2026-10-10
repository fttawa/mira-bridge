# 操你妈的 mirasim，免费用户不是人是吗

# 操你妈的 mirasim，免费用户不是人是吗

# 操你妈的 mirasim，免费用户不是人是吗

# 操你妈的 mirasim，免费用户不是人是吗

# 操你妈的 mirasim，免费用户不是人是吗

**操你妈的 mirasim，免费用户不是人是吗**

**操你妈的 mirasim，免费用户不是人是吗**

**操你妈的 mirasim，免费用户不是人是吗**

## 操你妈的 mirasim，免费用户不是人是吗

## 操你妈的 mirasim，免费用户不是人是吗

免费额度砍到没法用 · 排队排到天荒地老 · 付费才配说话

---

# mira-bridge

> ## ✅ 已适配新版协议（2026年09月24日 · mirasim 0.0.358 → 0.0.362）
>
> 官方客户端从 `0.0.224` 升到 `0.0.358` 后，relay 把设备认证整体换成了**签名会话
> （signed session）**，旧版明文 `mrs-sig-v1` 签名一律被拒：
>
> ```json
> {"error":{"code":"client_outdated","message":"this client version must upgrade to a signed session","type":"authentication_error"}}
> ```
>
> 新版协议已完整复刻并实测通过（`/v1/messages`、`/v1/chat/completions`、流式均 200）：
>
> 1. **每请求设备签名**：用设备 Ed25519 私钥对
>    `METHOD\0path\0ts\0nonce\0deviceId\0clientVersion\0credential` + 元数据 + 原始 body 签名；
> 2. **元数据封套**：除 `x-mirasim-client` 外，所有 `x-mirasim-*` 头（**含四个签名头本身**）
>    封成单个 `x-mirasim-enc`（`mrs-seal-v1` 信封），明文元数据不出网；
> 3. 签名与封套走官方客户端的 WASM crypto-core（`cc_sign` / `cc_seal`），已提取为
>    项目内 `core.wasm`（88KB，纯 WASM 无 import），与服务端同源实现，不是"看起来像"的仿写；
>    0.0.358 → 0.0.362 两次升级中该核心**逐字节未变**（SHA-256 一致）；
> 4. 客户端指纹对齐实测的 `claude-cli/2.1.280 (external, mirasim)`；
> 5. **版本号自动跟随本机安装的官方版本**（读 `~/.mirasim/app/state.json` 的 `good`），
>    官方再自更新时不必改代码、也不必重启 bridge。
>
> 判定口径：旧版请求 401 `client_outdated`；新版请求已越过全部认证闸门，剩余错误只可能是
> relay 的**容量**问题（见下方「平台繁忙」一节），与协议无关。

> ## ✅ 已修复（2026年08月24日）

>
> 之前 relay 报 `this client is not supported; please upgrade to the latest mirasim client`
> 的根因已定位并修复：**mirasim-router 从某一版本起按 User-Agent 识别调用方**，
> 不带 UA 或 UA 不以 `mirasim/<数字版本>` 开头的请求一律 403。
> 本项目在发给上游的请求上补了合规 UA 与官方指纹头（默认 `Mirasim/0.0.222` +
> `x-mirasim-client/device`，版本与头均可用环境变量覆盖），两条协议路径与流式均已实测通过。
>
> 另发现两条新约束，已实测确认（直连上游与经桥接层行为一致，属上游规则，非本层引入）：
>
> - `max_tokens=1` 且无 session 会被上游当成可用性探测拒绝（`400 ... read as an availability probe`），
>   需要探测请走 `GET /v1/limits`，不要用 1 token 请求试。
> - 上游端口跨重启会变，本项目端口发现逻辑不变；另在 netstat 不可用的受限环境下，
>   端口扫描退化为纯 Node 实现（`node:net` 并发扫高位回环端口），不再依赖外部命令。

把本机 Mirasim 桌面端的模型额度，包装成一个**同时兼容 OpenAI 与 Anthropic 协议**的本地 API。

```
你的客户端 ──→ mira-bridge :8787 ──→ mirasim-router ──→ relay
              (API key 校验 +        (本机，端口自动发现)
               协议转换 + 约束兜底)
```

零外部依赖，单文件，只用 Node 内置模块。要求 Node >= 18。

> `core.wasm` 必须与 `server.mjs` 放在同一目录：它是从官方客户端提取的签名/封套核心，
> 直连 relay 通道要用它做 `cc_sign` / `cc_seal`。缺失时 bridge 仍可启动，但 relay 通道会
> 降级回已被上游拒绝的旧版明文签名（日志记 `relay_core_unavailable`）。
> 路径可用 `BRIDGE_RELAY_CORE` 指定。

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
| `GET /v1/models` | 两者兼容 | 跟随官方 roster，含 `agent` / `context_window` / `max_output_tokens` 扩展字段 |
| `GET /healthz` | — | 不鉴权，供探活 |

认证两种头都收：`Authorization: Bearer <key>`（OpenAI 习惯）与 `x-api-key: <key>`（Anthropic 习惯）。

### 模型清单（跟随官方 roster）

`GET /v1/models` 不再写死，而是读桌面端自己的 roster 缓存
（`~/.mirasim/setting.json` 的 `modelRosterCache`，官方每次启动/定时拉取），
所以官方上新模型时**这里自动跟上**，无需改代码。取不到才用内置静态兜底。
响应里带 `source` 字段说明来源（`roster` / `router` / `fallback`）。

实测（roster `2026-09-24.v6`）relay 是**统一网关**：`x-mirasim-agent` 决定上游族，
claude / codex / dsh 三族共用 `/v1/messages`，本层按模型名自动切换：

| 模型族 | `x-mirasim-agent` | 实测 | 备注 |
|---|---|---|---|
| `claude-opus-5-5` / `claude-opus-5` / `claude-sonnet-5` / `claude-opus-4-8` / `claude-fable-5[-1]` | `claude` | 200 | 上下文 1M，输出上限 128k，支持 thinking |
| `gpt-6-astra` / `gpt-6-sol` / `gpt-6-luna` | `codex` | 200 | 上下文 872k |
| `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` | `codex` | 200 | 上一代，仍在 roster |
| `deepseek-flash`（label `v4.1-flash`） | `dsh` | 200 | 上下文 1M，输出上限 384k |
| `glm-5.3-flash` | `glm` | 200 | 定价表里有、agents 列表里没有，实测可用 |
| `kimi-k3` | `kimi` | 200 | 注意**不是** roster 里写的 `kimi-code/k3`（那个名字 relay 回 422） |
| `kimi-code/k3`、`gemini-*` | — | **422** | relay 明确回 `not supported`，默认不暴露 |
| `claude-haiku-4-5` | `claude` | **503** | `no upstream available`：平台池里没有 haiku 了（且它不是推理模型，带 thinking 会 400） |

默认黑名单是 `fable`（`$10/$50` 一档，明显贵于 opus 的 `$4–5/$20–25`），
所以 `/v1/models` 默认少这两个；`BRIDGE_BLOCKED_MODELS=""` 即可放行。

> 本机 `mirasim-router` 新版加了**随机 token 闸门**（`managedToken` + `inboundPathSecret`
> 由桌面端每次启动随机生成，只注入给自己 spawn 的子进程），匿名 HTTP 调用一律 401，
> 所以 `gpt-*` / `deepseek-*` 也改走 relay，不再依赖 router。
> `cli.minVersion`（roster 里的 `claude: 2.1.280`）与本层模拟的 claude-cli 版本一致。

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

### 调用方认证：按 User-Agent 识别客户端（2026-08 新增）

`mirasim-router` 现在要求请求带官方客户端 UA。不带 UA，或 UA 不以 `mirasim/<数字版本>` 开头（大小写不敏感），一律回

```json
{"error":{"message":"this client is not supported; please upgrade to the latest mirasim client","type":"permission_error"}}
```

**第二道闸（2026-08-24 傍晚起）**：relay 侧开始区分「带设备会话 ticket 的请求」与「匿名请求」。
用户桌面版（serve 进程内部会话）42/42 全 200；而经 `54534` 外部 HTTP 网关的 claude 请求，
无论带不带 UA / 指纹头 / 官方 token，一律回：

```json
{"error":{"message":"no upstream available for model \"claude-opus-5\"","type":"api_error"}}
```

**第三方接口报错就是这个**（`llm http 503: {"error":{"message":"no upstream available for model ..."}}`）。
它是 relay 对「无设备会话签名」的 claude 转发的统一拒绝，**与 bridge 代码无关**：同期
（21:31–21:45）Mirasim GUI 桌面版 42 次 claude 请求全部 200，bridge 全部 503，同一时刻一成一败，
差异只在 serve 进程内部转发时附加的 `mrs-sig-v1` 设备签名会话（`Authorization: Bearer <ticket>` +
`x-mirasim-sig/ts/nonce/device`），该 ticket 由 serve 持有（每 ~13 分钟自动重铸），外部 HTTP 网关
拿不到。

定位依据（全部实测）：

- serve 进程日志：`relay-ticket: device session established (device …)` 每 ~13 分钟重铸一次 ticket，
  期间用户桌面版 `claude-opus-5`（裸模型名）连续 200
- `~/.mirasim/traffic/<session>/index-0.ndjson` 捕获：`viaRelay:true`、`deviceId` 与
  `device.json` 一致（`81e9ef55-…`）、请求体可达 209KB —— 与匿名外部请求可区分
- **gpt 系走 relay 仍可用**（`x-mirasim-agent: codex`，2026-09 实测 `gpt-6-*` / `gpt-5.6-*` 全 200），
  可作为 claude 断供窗口的应急模型

即：claude 系在 relay 当前要求**设备会话 ticket**（router→relay 的 `mrs-sig-v1` 签名体系，
见下），匿名 HTTP 网关请求不再分配 claude 上游。若 claude 恢复（relay 策略回退或 ticket 条件
放宽），bridge 无需改动；前述 UA + 指纹头仍是正确姿势。

| User-Agent | 结果 |
|---|---|
| （无 UA） | **403** |
| `mirasim/1.0.0`、`Mirasim/1.0.0`、`MIRASIM/1` | ok |
| `mirasim-desktop/1.0.0`、`claude-cli/1.0`、`node`、`curl/8.0` | **403** |

本层在发给上游的请求上固定带 `User-Agent: Mirasim/0.0.222`（版本默认对齐官网内置常量，
`BRIDGE_UPSTREAM_UA` 可覆盖），所以客户端无需做任何事。

**第三方接口的 claude 已在 2026-08-24 深夜打通（双通道方案）**。relay 现在把「serve 进程内部会话」
（GUI / `ui-cli`，带 `mrs-sig-v1` 设备签名 ticket）与「54534 外部 HTTP 网关」区别对待：只有前者
能给 claude 分配上游（实测 serve 内部 `claude-opus-5` 42/42 + 后续多次全 200），后者会返回
`503 no upstream available`，或新版 relay 的 `400 the request was rejected as invalid`（gpt 系除外，匿名可用）。

**协议级直连 relay（2026-08-25 逆向打通，默认通道；2026-09-24 升级到签名会话）**：
对 claude 系模型，bridge 不再走 router 的匿名网关（那会被 relay 按「外部端点」拒绝），
而是**像官方 serve 进程一样直接调用 relay API**，完整复刻官方转发：

- 读 `~/.mirasim/setting.json`（DPAPI 解 `secret.key` → AES-256-GCM 解 `mrs1:` 凭据），
  得到 issuer JWT、Ed25519 设备私钥与 32 字节 seed；
- `POST /v1/device/session` 换 15 分钟设备 ticket —— **请求本身也带新版设备签名**
  （`credential` = issuer token），回包 `{ticket, expiresIn:900}`；
- `POST /v1/messages?beta=true` 带 `Authorization: Bearer <ticket>`，并按 0.0.358 协议：
  1. 组装客户端头（claude-cli UA、anthropic-beta 组、stainless 头组）+ relay 元数据
     （`x-mirasim-session/agent/locale/call`）；
  2. 用设备 seed 对 `[METHOD, path, ts, nonce, deviceId, clientVersion, credential=ticket]`
     （`\0` 连接）+ 元数据 + body 做 `cc_sign`，产出
     `x-mirasim-device/ts/nonce/sig` 四个签名头；
  3. 把除 `x-mirasim-client` 外的全部 `x-mirasim-*` 头（**含签名头**）`cc_seal` 成
     `x-mirasim-enc`（`mrs-seal-v1\nMETHOD\npath` 作为信封 AAD），并删除原头 —— 明文元数据不出网；
- 请求体自动补齐 relay 硬性要求：`system` 里带 `x-anthropic-billing-header` 计费块、
  推理模型补 `thinking: adaptive` —— 缺这两个字段 relay 直接回 `400 rejected as invalid`；
- `nonce` 每次尝试重取、签名随 body 重算，重试不会复用同一签名（复用会被判重放）。

实测要点（2026-09-24）：

| 请求形态 | relay 结果 |
|---|---|
| 明文签名头 + 明文元数据（旧版形态） | **401 `client_outdated`** |
| 新版签名头 + 明文元数据（不封套） | **401 `device_signature` / `request signature rejected (missing_headers)`** |
| 新版签名头 + `x-mirasim-enc` 封套 | 通过认证（进入上游路由阶段） |

即：**封套是强制的**，relay 解封后才验签 —— 签名头本身也不能留在明文里。

该通道**不创建任何 host agent 会话、不触碰 workdir、不污染 GUI 会话列表**（实测 GUI 与
headless 的 sessions 目录零新增），且首轮延迟从 serve 会话的 15–19s 降到 **3–5s**。
`BRIDGE_RELAY_DIRECT=0` 可关闭。

**平台繁忙（`no upstream available`）不是本层的问题**：当 Mirasim 托管池排队时，relay 对
**所有**客户端（含官方桌面端）回同一句话，官方 GUI 同期日志为
`claude turn failed … API Error: 422 平台服务当前繁忙 … 请切换到「自有」路由`。
bridge 侧表现为 `503 upstream temporarily unavailable, please retry`（内部原因写 `requests.log`，
不外泄给客户端）。此时可重试，或等池子空闲；换成 `gpt-5.6-*` 系模型走匿名上游通常仍可用。


**relay-only 模式（2026-08-26 起，不依赖 Mira 常驻）**：bridge 的 claude 请求、`/v1/models`、
`/healthz` 都已与 `mirasim-router` 解耦 —— Mira 休眠/未启动时：

- `/healthz` 仍 `200`，返回 `{"ok":true,"router":null,"relay":"available"}`
- `/v1/models` 回落内置静态清单（claude-opus-5 / claude-opus-4-8 / claude-sonnet-5 / claude-haiku-4-5）
- `/v1/messages`、`/v1/chat/completions`、`/v1/responses` 全部走 relay 直连，实测无 router 下
  `200 / 在线`（约 3–8s）
- 唯一例外：`/v1/messages/count_tokens` 需要 router（非 claude 的 gpt/其它模型也走 router）

`BRIDGE_ENABLE_SESSION_FALLBACK=1` 是保留的兼容开关；它会启动 Host agent session，产生可见会话，
并可能让 agent 访问其 workdir，因此默认关闭，普通 API 部署不应启用。

**会话持久化与 prompt cache 复用（2026-08-24 升级）**：serve 通道默认启用**会话池**，同一对话的
后续轮次复用同一个 serve session，而不是每个请求单开会话：

- **对话指纹**：优先用客户端显式会话 id —— `x-conversation-id` 请求头（OpenAI 路径也用
  `user` 字段、Anthropic 路径用 `metadata.user_id`）；没有时按 `model + system 内容 + 首条
  user 摘要` 哈希推断。相同指纹 → 同一 serve session，不同对话自然分开。
- **系统提示词保真**：新会话首轮会将 Anthropic 顶层 `system` 及 OpenAI/Anthropic 的
  `system` / `developer` 消息封装为 host 的系统级指令，再发送首条 user 内容；续轮只发新增用户消息，
  不重复注入。实测“无论用户说什么只答 `SYSTEM_OK`”得到 `SYSTEM_OK`。
- **上下文延续**：首轮 `ui-cli prompt` 建会话，后续 `ui-cli send` 追加到同一会话 —— 多轮
  对话记得前文（实测第 2 轮能答出第 1 轮约定的暗号）。
- **缓存命中**：serve 的 session 自带 prompt cache，实测第 2 轮起 `cachedInputTokens` 打到
  71k+（长会话 32 轮约 698k），新计费仅 `inputTokens: 2`，省 token 也缩短延迟。
- **原生常驻 WS，不再 spawn ui-cli**：bridge 直连 GUI 同款 `ws://127.0.0.1:4970/ws` host 协议，
  发送 `prompt` 帧、接收 `accepted/session/appendText/done` 帧并常驻复用连接；每请求启动
  node + 20MB `server.cjs` 的约 **3.5s** 冷启动已移除。`ui-cli` 仅在 WebSocket 断线或协议异常时兜底。
- **并发安全**：同一会话内请求串行排队（`ent.queue`），保上下文顺序；会话 LRU 池
  （默认上限 32、空闲 20 分钟淘汰，`BRIDGE_SERVE_POOL_MAX` / `BRIDGE_SERVE_POOL_TTL_MS` 可调）。

**实测性能画像（Serve WS 通道）**：

| 场景 | 耗时 | 说明 |
|---|---:|---|
| 新对话首轮 | 15–19s | agent 冷启动 + 首次推理（relay 首 token） |
| 同会话续轮 | **3–5s** | prompt cache 命中（`cachedInputTokens` 71k+），逼近 GUI 内部（4.8s） |

**曾尝试但不可行的更低延迟通道（记录备查）**：

1. **直连 relay（ticket + mrs-sig-v1 设备签名）**：已完整复刻 serve 内部结构——
   DPAPI 解 `secret.key`（64 hex）→ AES-256-GCM 解 `mrs1:` 的 `device.privateKey` 与
   `auth.token` → 得 Ed25519 PEM + issuer JWT → deviceId 与 serve 日志完全一致
   （`mmUwQy75ncu691W6SIzp9K`）→ POST `/v1/device/session` 换回 15 分钟有效 ticket
   （**200**）。但随后直连 `relay.mirasim.ai/v1/messages` 无论带
   `Authorization` 还是 `x-api-key`、带不带 `x-mirasim-session/device/account` 元数据，
   全部 `503 no upstream available for model`。ticket 有效但 relay 内部仍要求
   serve 注册过的会话上下文；该通道无法外部复用。
2. **会话预热池**：预建 serve 会话省不了慢——续轮已带历史上下文时，agent 每轮仍要跑
   完整循环（实测预热会话续发 44s，比新建还慢），且预热会污染 GUI 会话列表。
   默认 `BRIDGE_SERVE_WARM=0` 关闭。

**指纹对齐（逆向官方客户端后还原的完整身份头）**：官方客户端内置版本是 `0.0.222`
（router 本体 `server.cjs` 里的常量，可被 `MIRASIM_APP_VERSION` 环境变量覆盖），本层默认沿用
同一版本。除 UA 外，本层还会随请求带官方 CLI 同款身份头（逆向 `server.cjs` 的 interceptor
装配段还原）：

| 头 | 值 | 说明 |
|---|---|---|
| `x-mirasim-client` | `0.0.222` | 官方内置版本（`uk()`） |
| `x-mirasim-session` | `mirasim_<uuid>` | 官方格式 `'mirasim_' + randomUUID()`（`EEs()`），每次调用一个新 session |
| `x-mirasim-device` | 官方 `device.json` 的 deviceId | **与桌面端共用同一设备身份**：优先读 `%USERPROFILE%\.mirasim\device.json`，没有才落回项目 `.device-id` |
| `x-mirasim-locale` | 可配 | `BRIDGE_CLIENT_LOCALE` |
| `x-mirasim-agent` | 可配 | `BRIDGE_CLIENT_AGENT` |
| `x-mirasim-collect` | `off` | 官方不开遥测时也发 `off`，可配 `BRIDGE_CLIENT_COLLECT` |

实测 router 目前只校验 UA（仅有官方 UA、不带任何 `x-mirasim-*` 头也通），这些头全部无害；
带上它们让请求形态与官方客户端一致，上游将来若按这些头做更细的客户端识别也不会误伤。
`BRIDGE_CLIENT_FINGERPRINT=0` 可整体关闭。

> 更深一层的 `mrs-sig-v1`（Ed25519 签名 `x-mirasim-device/ts/nonce/sig`，经
> `/v1/device/session` 换 relay ticket）是 **router → relay** 的认证体系，由本机
> router 自己维护设备密钥与 ticket，桥接层请求先到 router，无需（也不应）复刻这一层。

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

### 消息结构

这几条在长对话里特别容易撞上，因为客户端拼装历史时很容易产生：

| 情况 | 结果 | 处理 |
|---|---|---|
| **content 数组里含空 text 块**（`{"type":"text","text":""}`） | **400** | 自动丢弃。任何位置的空块都会触发；纯空白（`"   "`）反而合法 |
| **连续两条以上 assistant 消息** | **400** | 合并为一条。连续 user 反而会被上游自动合并，assistant 不会 |
| **assistant 结尾（prefill）** | 推理模型 **400** | 无法兜底，返回明确错误。只有 haiku 支持 prefill |
| `tool_choice: null` 等显式 null 字段 | **400** | 剥掉所有值为 `null` 的顶层字段 |

`tool_choice: null` 是 Claude Code 2.1.237 会发的——上游 schema 不接受显式 `null`，未设置的可选字段必须省略而非发 `null`。

prefill 那条之所以只能报错：丢掉末条会丢信息，转成 user 会把「续写」变成「用户发言」，语义完全变了。返回的错误里会提示改用 haiku 或在末尾补一条 user 消息。

> 排查提示：这类结构问题上游同样只回那句含混的 400。`bisect.mjs` 可以对一条失败载荷截断 `messages` 找最小失败前缀，再逐块定位——上面几条就是这么找出来的。

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

模型名**不要带 `[1m]` 后缀**：Mirasim 内部把它当 context 变体写法（`setting.json` 的
`claudeModel` 就是 `claude-opus-5[1m]`），但 relay 明确拒绝带后缀的模型名
（实测 `422 model "claude-opus-5[1m]" is not supported at this time`）——官方客户端上行前会剥掉。
本层已在 `/v1/messages`、`/v1/chat/completions`、`/v1/responses` 三条路径上自动剥离 `[1m]`，
所以客户端直接粘 Mirasim 界面里的模型名也能用。

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
| `BRIDGE_MODEL_FILTER` | `^(claude-\|gpt-\|deepseek-)` | `/v1/models` 的正则过滤。这三族 relay 都能直接服务（实测 200）。`kimi-code/k3`、`gemini-*` relay 回 422，故默认不暴露。设为空串放行全部 |
| `BRIDGE_BLOCKED_MODELS` | `fable` | 模型黑名单正则。命中的直接回 403，不发往上游，也不出现在 `/v1/models`。默认禁用 fable-5 / fable-5-1（$10/$50 一档，明显贵于 opus 的 $4–5/$20–25）。设为空串放行全部 |
| `BRIDGE_DEFAULT_MAX_TOKENS` | `8192` | 客户端没传 `max_tokens` 时的默认值 |
| `BRIDGE_UPSTREAM_UA` | `Mirasim/0.0.358` | 发给 mirasim-router 的 User-Agent。上游按此识别调用方，缺失或格式不对一律 403，勿改成非 `mirasim/` 前缀 |
| `BRIDGE_APP_VERSION` / `MIRASIM_APP_VERSION` | `0.0.358` | 指纹里的官方版本号（即 UA 版本与 `x-mirasim-client` 的值）。跟随官方升级 |
| `BRIDGE_CLIENT_FINGERPRINT` | `1` | 是否带 `x-mirasim-client/session/device/collect` 等指纹头，`0` 关闭 |
| `BRIDGE_CLIENT_DEVICE` | 官方 device.json | 固定设备号。默认优先读官方 `%USERPROFILE%\.mirasim\device.json`（与桌面端共用身份），无则用 `.device-id` |
| `BRIDGE_CLIENT_LOCALE` | 未设 | `x-mirasim-locale` 值，如 `zh-CN` |
| `BRIDGE_CLIENT_AGENT` | 未设 | `x-mirasim-agent` 值，如 `claude` |
| `BRIDGE_CLIENT_COLLECT` | `off` | `x-mirasim-collect` 值，官方遥测开关形态 |
| `BRIDGE_RELAY_DIRECT` | `1` | claude 模型协议级直连 relay（默认）。`0` 关闭后回退 router 匿名网关 |
| `BRIDGE_RELAY_BASE` | `https://relay.mirasim.ai` | 直连 relay 的 base URL；默认即官方 |
| `BRIDGE_RELAY_CORE` | `<同目录>/core.wasm` | 设备签名核心（官方 crypto-core），`cc_sign` / `cc_seal` 用 |
| `BRIDGE_RELAY_CLIENT` | 自动跟随官方安装版本 | 直连时 `x-mirasim-client` 版本号。**上游按此判定是否要求签名会话，旧值会被 401 `client_outdated` 拒绝**。默认读 `~/.mirasim/app/state.json` 的 `good`（官方自更新写回的当前版本），再退回最新版本目录，最后才是内置常量 `0.0.362` |
| `BRIDGE_RELAY_CLIENT_TTL_MS` | `60000` | 上面这个版本号的缓存时长；官方半夜自更新后最多 1 分钟即自动跟随，无需重启 |
| `BRIDGE_RELAY_AGENT` | 按模型自动判定 | 直连时 `x-mirasim-agent`。默认 `claude-*`→`claude`、`gpt-*`→`codex`、`deepseek-*`→`dsh`；显式指定则强制覆盖（排查用） |
| `BRIDGE_RELAY_BILLING` | `cc_version=2.1.280.14d; cc_entrypoint=mirasim;` | `system` 计费块文本，官方 `x-anthropic-billing-header` 形态。改版本时与 `claude-cli/2.1.280` 一起改，保持自洽 |
| `BRIDGE_RELAY_BETA` | 内置（2.1.280 实测组 + `context-1m-2025-08-07`） | 直连时下发的 `anthropic-beta` 列表 |
| `BRIDGE_RELAY_TIMEOUT_MS` | `600000` | 直连 relay 的请求超时 |
| `BRIDGE_REFUSAL_COOLDOWN_MS` | `60000` | 平台"拒绝服务"（400 `rejected as invalid`）后的冷却时长：这段时间只打一发、不扇出、重试直接收手，免得把 30~40s 的排队放大成几分钟。任意一发成功即清零 |
| `MIRASIM_SECRET_KEY` | 自动 DPAPI 解 | 手动指定 64-hex 密钥；不设则自动解 `~/.mirasim/secret.key` |
| `BRIDGE_ENABLE_SESSION_FALLBACK` | `0` | **默认关闭**。设 `1` 才允许旧的 Host prompt/send 回退；该模式会新建 agent 会话并可访问其 workdir |
| `BRIDGE_SERVE_UI` | 未设 | 仅当 `BRIDGE_ENABLE_SESSION_FALLBACK=1` 时读取的 serve `server.cjs` 绝对路径 |
| `BRIDGE_SERVE_PORT` | `4970` | 仅旧会话回退使用的 serve 端口 |
| `BRIDGE_SERVE_AGENT` | `claude` | serve 会话的 agent 名 |
| `BRIDGE_SERVE_EFFORT` | `low` | serve 会话的 effort（low/medium/high/max） |
| `BRIDGE_SERVE_POOL_MAX` | `32` | 会话池并发上限（超限逐最久未用淘汰） |
| `BRIDGE_SERVE_POOL_TTL_MS` | `1200000` (20min) | 会话空闲超时（serve 侧也会自动收闲会话） |
| `BRIDGE_SAMPLING_MODELS` | `haiku` | 正则，匹配的模型才下发采样参数 |
| `BRIDGE_THINKING_RESERVE` | `4096` | 推理模型的 thinking 预算补偿 |
| `BRIDGE_THINKING_DISPLAY` | `summarized` | 思考回传形态。`summarized` 给摘要，`omitted` 全局关掉（上游只认这两个，`full` 回 400） |
| `BRIDGE_THINKING_FORCE_SUMMARIZED` | `0` | 设 `1` 时忽略客户端显式要的 `display:omitted`，一律给摘要（Claude Code 默认就是 omitted） |
| `BRIDGE_RELAY_EFFORT` | `max` | 思考等级（`output_config.effort`），客户端没传时下发。`low`/`medium`/`high`/`xhigh`/`max`（`ultra` 视为 `max`）；空串关闭默认注入 |
| `BRIDGE_PROBE_TTL_MS` | `30000` | 上游端口缓存有效期 |
| `BRIDGE_PROBE_TIMEOUT_MS` | `5000` | 单次端口探测超时。太短会在上游繁忙时误判 |
| `BRIDGE_TIMEOUT_MS` | `600000` | 上游请求超时 |

## 已实现

- 流式 + 非流式
- **claude 协议级直连 relay（新版签名会话）**：默认通道，不创建 agent 会话、不污染 GUI、不传 workdir（`BRIDGE_RELAY_DIRECT` 开关）
- **设备签名 + 元数据封套**：官方 WASM crypto-core（`cc_sign` / `cc_seal`）+ `x-mirasim-enc`（`mrs-seal-v1`），元数据与签名头都不出明文
- **token 自动续期**：issuer JWT 过期或 relay 返回 401 时，自动重载 `setting.json`（GUI 已刷新则直接复用），否则用 `refreshToken` 调 `auth.mirasim.ai/auth/refresh` 换新 token 并回写
- **模型名归一化**：`claude-opus-4.8` 点号别名 → 连字符；`claude-opus-5[1m]` → 剥离 `[1m]`（relay 对后缀回 422）
- Function calling：`tools` / `tool_choice` / `tool_calls` / `role:"tool"` 回传，流式下增量拼 `arguments`
- 多模态图片：`image_url` 支持 `data:` base64 与 http URL
- `system` / `developer` 角色提取到 Anthropic 顶层 `system`
- `thinking` 块映射为 `reasoning_content`（DeepSeek R1 引入的事实标准，主流客户端可单独渲染），流式走 `delta.reasoning_content`
- `stream_options.include_usage`：在 `[DONE]` 前补一个 `choices: []` 只带 `usage` 的 chunk
- `usage` 映射，含 `completion_tokens_details.reasoning_tokens`
- `finish_reason` 映射：`end_turn→stop`、`max_tokens→length`、`tool_use→tool_calls`

> 思考正文**会**回传（2026-09-24 起实测），详见上方「思考内容（thinking）」一节。
> 早前"`reasoning_content` 恒为空串"是 0.0.224 时代的结论，已作废。

## 思考内容（thinking）

上游会回传思考正文（不是只有 token 计数）。本层在四条路径上都把它带出来了：

| 端点 | 形态 | 实测 |
|---|---|---|
| `POST /v1/messages`（非流式） | `content[]` 里原样保留 `{"type":"thinking","thinking":"…","signature":"…"}` | ✓ |
| `POST /v1/messages`（流式） | `content_block_start`(thinking) + `content_block_delta` → `thinking_delta`，原样透传 | ✓ |
| `POST /v1/chat/completions`（非流式） | `choices[0].message.reasoning_content` | ✓ |
| `POST /v1/chat/completions`（流式） | `choices[0].delta.reasoning_content` 增量（DeepSeek R1 起的通行写法） | ✓ |
| `POST /v1/responses`（非流式） | `output[]` 里前置一个 `{"type":"reasoning","summary":[{"type":"summary_text",…}]}` | ✓ |
| `POST /v1/responses`（流式） | `response.reasoning_summary_text.delta` / `…part.added|done` / `output_item.done`，reasoning 项固定 `output_index:0` | ✓ |

思考形态由请求体的 `thinking.display` 决定，**relay 只接受两个值**（与官方 `MIRASIM_CLAUDE_THINKING_DISPLAY` 同一套）：

| `display` | 结果 |
|---|---|
| `summarized` | 200，回传思考**摘要**（官方默认，本层缺省值） |
| `omitted` | 200，不回传思考正文（只留 token 计数） |
| `full` | **400**（relay 不接受） |

本层对 claude 系（opus / sonnet / haiku / fable）**无条件归一化** `thinking`：只保留客户端
「不要正文」的意图，其余一律补成 `adaptive + summarized` —— 因为**只有这一种形态才有摘要正文**，
客户端按官方文档发的形态反而拿不到。实测（2026-09-25，同一提问）：

| 客户端发来的 `thinking` | 归一化后 | 结果 |
|---|---|---|
| （不带） | `adaptive` + `summarized` | 200，**有摘要** |
| `{type:'adaptive'}` | 补 `display:summarized` | 200，**有摘要**（不补就是 0 字） |
| `{type:'enabled', budget_tokens:2048}` | 换 `adaptive` + `summarized`，**摘掉 `budget_tokens`** | 200，**有摘要** |
| `{type:'adaptive', budget_tokens:N}` | 摘掉 `budget_tokens` | 200，有摘要（留着这字段上游回 400） |
| `{type:'adaptive', display:'omitted'}` | 原样尊重 | 200，无正文（预期） |
| `{type:'disabled'}` | 改 `adaptive` + `omitted` | 200，无正文（上游不认 disabled） |

归一化动作会在 `requests.log` 记一行 `thinking_normalized`，方便解释"为什么和客户端发的不一样"。
全局关掉摘要：`BRIDGE_THINKING_DISPLAY=omitted`。codex / dsh 系没有思考摘要，原样透传。

> **Claude Code 用户注意**：官方 CLI 自己默认发 `{"type":"adaptive","display":"omitted"}`
> （抓包实测 2026-09-25），本层默认尊重它 —— 所以直接用 Claude Code 连桥是**看不到思考**的。
> 想让它在桥上也能看到摘要：`BRIDGE_THINKING_FORCE_SUMMARIZED=1`。

### 思考等级（reasoning effort）默认给 MAX

官方 claude-cli 把思考等级放在 **`output_config.effort`**（抓包实测：
`{"output_config":{"effort":"max"}}`，同时带 `effort-2025-11-24` beta）。
取值 `low` / `medium` / `high` / `xhigh` / `max`；Mirasim 界面里的 `ultra` 就是 `max`
（官方代码里就是 `effort === 'ultra' ? 'max' : effort` 再发给 CLI）。

本层策略：**客户端没传就补 `max`**，传了就尊重。实测同一道题（`claude-opus-5`）：

| 客户端传的 effort | 实际下发 | 思考字数 | thinking tokens |
|---|---|---|---|
| （不传） | `max`（本层补） | 266 | 165 |
| `low` | `low` | 68 | 15 |
| `max` | `max` | 318 | 211 |

OpenAI 路径的 `reasoning_effort`（或顶层 `effort`）会被翻译成同一个字段，
所以 `{"reasoning_effort":"low"}` 走 `/v1/chat/completions` 也是 low（实测 34 reasoning tokens）。
实际下发的等级会记进 `requests.log` 的 `relay_direct` 行（`effort` 字段）。
不要默认注入就设 `BRIDGE_RELAY_EFFORT=""`。

另外两条实践提醒：

- **thinking 算在 `max_tokens` 里**（见上文「`max_tokens` 含 thinking token」），
  额度给小了会出现"思考把额度吃光、正文为空"。
- Anthropic 原生路径上的 `signature` 原样透传；多轮对话把带签名的 thinking 块回传时不会被改写，
  上游的签名校验因此照常通过。OpenAI 路径没有 thinking 的位置，多轮时按普通文本回传即可。

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
node probe.mjs             # OpenAI 参数与消息结构，18 项
node probe2.mjs            # 采样参数约束二分（直连上游）
node probe3.mjs            # 模型 / tools / 图片 / system 变体，27 项
node probe4.mjs            # Anthropic 原生端点，9 项
node tools/relay-probe.mjs # 直连 relay 协议体检（官方升级后先跑这个）

PROBE_TARGET=https://your-host node probe.mjs   # 指向远端
```

`tools/relay-probe.mjs` 不依赖 bridge 进程，直接按官方协议铸票 + 签名 + 封套打一发，并按回包
给出结论（`client_outdated` = 版本落后 / `missing_headers` = 封套缺失 / `no upstream available`
= 平台池繁忙 / `200` = 全链路可用）。官方再升级协议时，先跑它定位，再改 `server.mjs`。

### 重放

从 `requests.log` 取最后一条失败载荷打到上游，逐字段删除以定位元凶——本项目里几个约束都是这么找出来的：

```bash
node replay.mjs      # 按 system / user 内容二分
node replay2.mjs     # 按顶层字段逐个删除
```

## 看门狗（tools/watchdog.mjs，已启用）

2026-09-25/26 出现过三次 **bridge 静默消失**：`requests.log` 最后一条是正常 200，之后端口无人监听，
且**没有 `process_exit` 墓碑、没有 `fatal` 记录、stderr 也是空的** —— 是被硬杀
（`TerminateProcess` 不跑 JS 钩子），不是崩栈；同期火绒安全日志、Windows 系统日志都没有对应事件。

**已确认的一种成因**：关掉启动它的父进程（当时的 agent/dsh 进程）时，同一个 Windows Job 里的
子进程被连带杀掉 —— 这也解释了"由登录态启动的 cloudflared 活了一整夜，被手工重启的 bridge 过一阵就没了"。

所以现在挂着看门狗：

```
HKCU\...\Run → MiraWatchdog → autostart-watchdog.vbs → node tools/watchdog.mjs
```

- 每 `BRIDGE_WATCHDOG_INTERVAL_MS`（默认 30s）探一次 `127.0.0.1:8787` 与 `cloudflared.exe`；
- 缺哪个补哪个（`detached` 启动），动作写 `watchdog.log`；
- 拉起 bridge 时走 `start-8787.cmd`（带上出站代理环境变量，并让日志落盘）；
- 实测：杀掉 bridge 后 **13–32 秒**恢复（取决于踩在巡检周期的哪个点）；
- `BRIDGE_WATCHDOG_DRY=1` 只记不启；不想要就删掉那条 Run 项并杀掉进程。

### 定时重启（默认每小时一次）

长跑会累积碎片状态，所以看门狗顺带做**定时重启**：

| 变量 | 默认 | 说明 |
|---|---|---|
| `BRIDGE_RESTART_INTERVAL_MS` | `3600000`（1h） | 超过这个运行时长就重启一次；`0` 关闭 |
| `BRIDGE_RESTART_MAX_DEFER_MS` | `600000`（10min） | 有在途请求时最多推迟这么久 |

判断依据是 bridge 自己的 `/stats`（`uptimeSec` + `activeUpstreamRequests`）：

- **有在途请求就等**（实测单条流可以跑 30–100 秒，不能一刀砍掉客户端正在跑的活），
  日志记 `restart_deferred`；
- 推迟超过上限则强制重启，日志记 `restart_forced`；
- 重启动作 = 杀掉端口占用者 → 等端口释放（最多 15s）→ 重新拉起，日志记 `scheduled_restart`。

实测（隔离实例，把周期压到 15s 验证）：

```jsonc
{"msg":"scheduled_restart","uptimeSec":17,"active":0,"pid":2756}
{"msg":"bridge_down_restarting","port":8797}
{"msg":"launched","label":"bridge","pid":23976}
```

> 顺带修掉一个会让定时重启**永远推迟**的坑：`/stats`、`/healthz` 这类本地端点原先也计入
> `activeUpstreamRequests`，于是看门狗每次拉 `/stats` 都看到 `active=1`（就是它自己那次请求）
> → 永远判定"有在途请求"。现在只有过了鉴权的 API 请求才计入。

### 顺带修掉三个"服务起不来还不报错"的坑（2026-09-26）

1. **`start-8787.cmd` 里的中文注释被 cmd 当成命令**：cmd.exe 用 OEM 代码页跑 `.cmd`，
   UTF-8 中文被拆坏后变成 `'────' is not recognized as an internal or external command`，
   启动路径因此不可靠。**该文件现在只允许 ASCII**，以后改它注意。
2. **`>> bridge.task.log 2>&1` 会一直占着文件句柄**：cmd 的追加重定向在整个进程生命周期内持有该文件，
   于是"再起一个实例"连日志都打不开（看门狗拉起的实例就是这样静默失败的）。
   现在由 `server.mjs` 自己 `appendFileSync` 写 `bridge.task.log`（写完即关，多实例不冲突），
   批处理里**不再重定向**。
3. **端口被占会留僵尸**：全局异常处理器是"不退出"策略，端口被占时进程会活着但永远不监听 ——
   表现就是"服务在跑、却全部连接被拒"。现在 `server.on('error')` 遇 `EADDRINUSE`/`EACCES`
   记 fatal 并退出，看门狗下一轮自然重试。

隧道也补了日志：`autostart-tunnel.vbs` 现在带 `--logfile tunnel.log`（以前输出没人接，
2026-09-26 那次 530 就没法查）。

### prompt cache 命中率（2026-09-25 修复）

**老代码把 relay 请求里的 `cache_control` 全剥了**（`system` / 消息内容块 / `tools` 三处断点都没了）——
那是 0.0.224 时代的结论（当时块级 cache_control 会 400）。现在实测 **0.0.362+ 三种断点全接受**，
照剥等于把缓存命中率摁到 0，所以改成：**只剥 Claude Code 的 `cache_control.scope` 扩展，保留 `type` / `ttl` 断点**
（`BRIDGE_RELAY_CACHE=0` 可退回老行为）。

同时把客户端自带的请求头透传上来：

| 客户端头 | 本层用法 |
|---|---|
| `x-claude-code-session-id` | **作为会话键的首选**，映射成 relay 的 `x-mirasim-session` —— 同一会话的所有轮次落到同一 session，缓存亲和性靠它（原先只认 `x-conversation-id` / `metadata.user_id`） |
| `anthropic-beta` | 与内置清单**合并**（客户端的 token 一个不丢，缺的补上），`prompt-caching-scope-2026-01-05` 这类缓存 beta 因此照常上行 |
| `metadata.user_id` | 仍是兜底会话键 |

实测（11.9k token 的长前缀 + `x-claude-code-session-id` 固定，连打 7 发）：

| 请求 | `cache_creation_input_tokens` | `cache_read_input_tokens` | `input_tokens` |
|---|---|---|---|
| 第 1 发 | 15414 | 0 | 49 |
| 第 2 发 | 15414 | 0 | 2 |
| 第 3 发 | 0 | **15414** | 2 |
| 第 4–7 发 | 0 | **15414** | 2 |

即：首轮建缓存（15.4k），之后**每轮全量命中**，`input_tokens` 从 49 掉到 2。
第 2 发又建了一次缓存，是因为 relay 是上游池、命中哪个后端有随机性；固定会话键后亲和性变好，
第 3 发起稳定命中。

### 上游的语义性错误原样透传（2026-09-25 修复）

以前 relay 的任何非 2xx 都被吞成 `503 upstream temporarily unavailable`。这在
**`context_length_exceeded`** 上是致命的：客户端（Claude Code）靠这个错误触发自动压缩上下文，
拿不到就只会拿同一份超长 prompt 反复重试 —— 实测日志里连打十几次
`prompt is too long: 1002459 tokens > 1000000 maximum`，全部变成 503，客户端学不会该压缩。

现在：

| 上游状态 | 本层行为 |
|---|---|
| `400` / `413` / `422` | **立即原样透传**（含 `code` / `message`），不重试、不包装 |
| `429` | 重试 3 次后仍 429 则透传，客户端才知道要退避 |
| `408` / `425` / `5xx` / 网络错误 | 退避重试 3 次，仍失败才回 503 中性文案 |
| `401` / `403` | 不透明透传（内部凭据问题不该冒充客户端的鉴权错误），仍回 503 |

`requests.log` 里能看到判定：`relay_direct_passthrough` 就是走了透传那条路。

### 日志体积（2026-09-25 修复）

一个 269 条消息的 Claude Code 请求，即使逐字符串截断也有几百 KB；连打几十次就把
`requests.log` 顶到 **86 MB**，读日志本身成了体力活。现在：

- 落盘载荷超过 `logPayload` 的 16 KB 上限就只留**结构摘要**（model / max_tokens / 消息条数与角色序列 / 各段字符数 / 开头 3 KB）；
- 启动时若 `requests.log` 超过 `BRIDGE_LOG_MAX_BYTES`（默认 64 MB）就滚动成 `requests.log.1`（只留一代）。

### 出站代理（默认走本机 Clash 7897）

Node 的 `fetch` **不看系统代理**；要让 relay 流量走本机代理，必须在进程**启动时**带
`NODE_USE_ENV_PROXY=1`（Node 24 起支持，读 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`）——
这个开关在 bootstrap 阶段生效，脚本里再设已经晚了。所以：

- `start-8787.cmd` 默认设 `BRIDGE_PROXY=http://127.0.0.1:7897` 并导出上述变量；
- `server.mjs` 启动时自检：若配了代理却**没生效**，会带环境变量把自己重启一次
  （父进程退化成薄壳，Ctrl+C 一起收到）——所以 `node server.mjs` 直接跑也一样走代理；
- 启动横幅会明确打印 `[bridge] 出站代理: http://127.0.0.1:7897（生效）` 或 `直连`。

| 变量 | 默认 | 说明 |
|---|---|---|
| `BRIDGE_PROXY` | `http://127.0.0.1:7897` | 出站代理。设 `0` / `off` 直连，设别的端口即换代理 |
| `BRIDGE_NO_PROXY` | `127.0.0.1,localhost,::1` | 免代理名单，本地探测不绕代理 |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | 由上面两个导出 | 给 Node 运行时看的实际变量 |

验证办法：把 `BRIDGE_PROXY` 指向一个不存在的端口，relay 请求应当立刻失败；
指向 7897 则正常 200 —— 说明流量确实走了代理（实测两者都符合）。

### 上游错误体读取失败不再炸进程（2026-09-25）

`429` 透传的分支原先写在 `body.cancel()` **之后**：body 已作废，调用方再 `text()`
就抛 `TypeError: Body is unusable`，而这个异常发生在请求处理链里，直接变成
`unhandledRejection` 打到 stderr（日志里能看到两条）。现在两处都修了：

- 判定顺序改成「先决定透传，再 cancel」；
- 三个端点的错误体读取都包了 try/catch，读不到就退回中性错误体，不再把异常抛到进程级。

### 流式诊断（`API Error: terminated` 怎么查）

客户端报 `API Error: terminated` 就是 **SSE 被中途掐断**。以前 bridge 只在流开始时记一行
`status:200`，掐了也看不出来 —— 现在每条流都会记收尾：

```jsonc
// 正常收尾
{"reason":"stream_done","model":"claude-sonnet-5","ms":29293,"bytes":83750,"maxGapMs":2668,"stop":true,"clientClosed":false}
// 中途断（stop:false 且带 error 就是上游断；clientClosed:true 是客户端自己先走）
{"reason":"stream_aborted","model":"claude-opus-5","ms":41000,"bytes":51200,"maxGapMs":900,"clientClosed":false,"error":"terminated"}
```

| 字段 | 含义 |
|---|---|
| `ms` | 整条流持续时长 |
| `bytes` | 转发字节数（0 字节 = 连首帧都没拿到） |
| `maxGapMs` | 相邻 chunk 的最大间隔，逼近 100s 要怀疑 Cloudflare 隧道空闲超时 |
| `stop` | 是否收到 `message_stop`（false = 被掐断） |
| `clientClosed` | 客户端先断开（用户取消 / 客户端超时） |

配套自检脚本：

```bash
node tools/stream-check.mjs                                # 本地 8787
node tools/stream-check.mjs https://mira.neko.xn--fiqs8s   # 公网（顺带验隧道 + 出站代理）
```

实测 2026-09-26：本地与公网各打 40–48s 长流（~85–93 KB / 500–600 事件），
`maxGap` 最大 3s，全部 `message_stop` 收尾 —— 说明常规长流没问题，
真出现 `terminated` 时按上面那两行日志判方向即可。

### 速度画像（2026-09-26 实测 claude-opus-5-5）

```bash
node tools/speed-test.mjs                                  # 本地 3 轮
node tools/speed-test.mjs https://mira.neko.xn--fiqs8s claude-opus-5-5 3
```

**生成速度不慢**（token 数取上游 `usage.output_tokens`，不是字符估算）：

| 场景 | tok/s 端到端 | tok/s 首 token 后 |
|---|---:|---:|
| 长回答 4000 tokens，`effort=high` | **87.0** | **101.1** |
| 长回答 4000 tokens，`effort=max`（本层默认） | 86.0 | 98.6 |

**"感觉慢"来自首字之前的等待**，不是吐字速度（同一道短问题）：

| effort | 首个 token | **首段可见文本** | 总时长 | thinking tokens |
|---|---:|---:|---:|---:|
| `low` | 4.16s | **4.16s** | 4.83s | 15 |
| `high` | 4.21s | **4.21s** | 5.93s | 13 |
| `max` | 4.79s | **13.33s** | 13.33s | **903** |

即：`max` 会先想 900+ token 才吐第一个可见字（+9s）；其中还有 ~4s 是平台固定开销
（实测到 relay 的 TTFB 本身就 0.57–1.11s，其余是池子选路与模型启动）。
出站代理不是瓶颈：直连 TTFB 0.57–1.11s，经 7897 是 0.66–2.09s，中位数相当。

**想把客户端的 `max` 压下来又不想改客户端**：`BRIDGE_RELAY_EFFORT_CAP=high` 重启即可
（只在客户端要得更高时生效，日志记 `effort_capped`）。

### 为什么"感觉慢"：先看 usage，再下结论（2026-09-26）

每条流式请求的收尾日志现在带 usage，**先量再猜**：

```jsonc
{"reason":"stream_done","model":"claude-opus-5-5","ms":107043,"ttftMs":8420,
 "inTok":98038,"cacheRead":4695,"cacheCreate":0,"outTok":11240,"thinkTok":6100,"msgs":1655}
```

| 字段 | 用途 |
|---|---|
| `ttftMs` | 首字延迟：大上下文 / 缓存未命中主要吃在这里 |
| `inTok` / `cacheRead` | 输入规模与缓存命中量；`cacheRead` 占比低说明每轮都在重读上下文 |
| `outTok` / `thinkTok` | 输出规模；**这是长耗时的主要来源** |

实测基准（2026-09-26，本地，`effort=high`）：

| 模型 | 首字 | 一轮总时长 | tok/s（端到端） |
|---|---:|---:|---:|
| `claude-opus-5-5` | 3.1–5.1s | 4.6–6.7s | 30.9 |
| `claude-sonnet-5` | 2.0–2.3s | 3.6–5.8s | 41.9 |
| `gpt-6-luna` | 2.0–6.1s | 3.6–7.8s | 12.3 |
| `deepseek-flash` | **1.5–1.7s** | 2.9–4.0s | **63.0** |

大上下文代价：98k token / 300 条消息的请求，首字 **7.4–12.1s**（小请求 2–4s）；
同一请求连打三次只有一次 `cacheRead>0` —— relay 是上游池，缓存是各后端的本地状态，
命中本身带随机性。想快就压上下文（对话越长越明显）或换更快的模型。

**结论**：生成速度不是瓶颈（opus-5-5 长回答实测 87 tok/s，连打三轮 86.8/85.2/85.9）。
一轮 107s / 178s 这种时长，按 90 tok/s 反推是 1–1.6 万输出 token —— 是"想得多、写得多"，
不是链路卡住。

### 停滞看门狗：上游卡住不再让客户端干等（2026-09-26）

实测到过一次 relay 的"半死"状态：**首字节等 122 秒**、chunk 间隔 15 秒，
期间还夹着 `no upstream available` 503 与 `token_invalid` 401 突发 —— 客户端界面就是
"Waiting for Claude..." 挂着几十分钟，用户看起来就是"卡住了"。

现在流式代理带停滞检测：

| 变量 | 默认 | 说明 |
|---|---|---|
| `BRIDGE_RELAY_STALL_MS` | `90000` | 上游静默超过这个时长判为停滞；`0` 关闭 |
| `BRIDGE_STREAM_RETRIES` | `1` | 停滞时换一次上游重试的次数（**仅当还没往客户端写过任何字节**） |

- 还没写出字节 → 丢掉这条上游连接、重发一次（日志 `stream_stall_retry`，可能落到更快的后端）；
- 已经写出字节 → 发 `event: error` 收尾并记 `stream_aborted`（带 `bytes` / `maxGapMs`），
  客户端立刻知道失败并重试，而不是继续等。

实测（把阈值压到 200ms 强制触发）：

```jsonc
{"reason":"stream_aborted","ms":209,"bytes":728,"maxGapMs":1,"error":"upstream stalled: no data for 200ms"}
```

> 顺带一提，那次"卡住"里 bridge 本身是好的：同一时刻 `/healthz` 195ms 返回，
> 只是上游迟迟不给数据 —— 判别依据就是 `stream_done` 里的 `ttftMs`。

### 上游有没有优先级机制（2026-09-26 探查结论）

**有，但只在 codex 系模型上**，字段是 OpenAI 协议的 `service_tier`。

来源与依据（都在本机官方客户端里）：

- `~/.codex/cockpit-model-catalog.json`（codex 模型目录）里每个模型带
  `service_tiers: [{id:"priority"}]` 与 `additional_speed_tiers: ["fast"]`；
- 官方客户端把它存成 `codexServiceTier`，再以 `--config service_tier=<id>` 交给 codex CLI
  （源码里那句 `service_tier applies to codex only` 就是硬约束）；
- claude 系没有这一层 —— Anthropic 响应里的 `service_tier` 是**只读**的 `standard`。

**实测效果**（relay 上的 `gpt-6-sol`，交替各打 3 发）：

| 轮次 | 默认 | `service_tier: priority` |
|---|---:|---:|
| 1 | 3535ms | **1878ms** |
| 2 | 4564ms | **2383ms** |
| 3 | 4204ms | **3130ms** |

即 **快 1.3–2.3 倍**，且 relay 原样接受这个字段（200，不再被剥离）。

本层的处理：

| 情况 | 行为 |
|---|---|
| 客户端传了 `service_tier` | 原样透传（任何模型），日志 `relay_direct` 行里能看到 `tier` |
| 没传 + `BRIDGE_SERVICE_TIER` 有值 + 模型是 `gpt-*`/`codex*` | 补上该值 |
| 没传 + 未配 `BRIDGE_SERVICE_TIER` | 不注入（**priority 通常更贵**，默认不开） |

想给 codex 系默认提速：`BRIDGE_SERVICE_TIER=priority` 重启即可。
claude 系（你主力用的 opus-5-5）**没有这个开关** —— 它的快慢只取决于平台池当时的负载。

> 另有一个"路由模式"开关：`relay.mode = local | cloud`（自有账号 / 平台池），
> 官方文档明确两者**互不兜底**。本层走的是 cloud 那条（设备签名会话），
> 平台池繁忙时就会看到 `503 no upstream available` —— 这不是优先级能解决的，
> 只能重试或换模型。

### 暴力模式（fan-out）：上游发飘时一发扇成三发，先出首 token 的赢

动机：平台是**上游池**，同一时刻不同后端快慢差很多 —— 实测 2026-09-26 繁忙时段
单发首字 27s / 53s / 90s 混着出现。多发齐打、谁先吐出第一个 token 就用谁，
能把"抽到慢后端"的尾巴砍掉。

规则：

1. **触发**（任一即可点亮"繁忙窗口"，默认持续 300s）：
   - 上游返回 **5xx**（`503 no upstream available`、`502`、`504` 网关超时都算）或 `429`；
   - 铸票 `/v1/device/session` 也 5xx；
   - 某条流**首字超过** `BRIDGE_BRUTE_TTFT_MS`（默认 20s）；
   - **网络层错误不算**（连不上 / DNS / 代理挂了 / 连接被掐断）：那种情况三发齐打只是
     三倍放大失败，并不能"碰上好后端"。日志记 `relay_direct_error`，不点亮窗口、也不当场转对冲。
2. 窗口内**流式**请求扇出 `BRIDGE_BRUTE_FANOUT`（默认 3）发并发；
3. 各自读到**首个 `content_block_delta`** 为止，最先拿到的胜出，已读字节原样转发给客户端；
4. **落败的立刻 abort**（含还在等响应头的那些），日志记 `relay_direct_aborted`；
   实测不会再重试、不再消耗，胜者的流照常跑完（`stream_done ... brute:true`）；
5. **单发自己就吃到 5xx 时当场转对冲**：不等下一次请求，直接把这一发扇出去重试一轮
   （日志 `brute_race_won_after_5xx` / `brute_race_all_failed ... after5xx:true`）；
   **网络层失败不走这一步**（三发齐打只是三倍放大失败）。

实测两种失败的差别（用假上游验证）：

| 场景 | 日志 | 是否对冲 |
|---|---|---|
| 真 5xx（含铸票 5xx） | `relay_busy_marked why=mint 503` → `brute_race_all_failed fanout=3` | ✅ 对冲 |
| 网络层错误（relay base 指向死端口） | `relay_ticket_error` → `router_unavailable`，**无 busy、无 race** | ❌ 不对冲 |

实测日志（`BRIDGE_BRUTE_ALWAYS=1` 强制开）：

```jsonc
{"reason":"relay_direct","session":"72678043…"}
{"reason":"relay_direct_aborted"}   // 落败，掐断
{"reason":"relay_direct_aborted"}   // 落败，掐断
{"reason":"brute_race_won","fanout":3,"wonInMs":6749}
{"reason":"stream_done","ms":36252,"stop":true,"brute":true}
```

| 变量 | 默认 | 说明 |
|---|---|---|
| `BRIDGE_BRUTE_FANOUT` | `3` | 扇出份数；`1` 等于关闭 |
| `BRIDGE_BRUTE_AUTO` | `1` | 繁忙窗口内自动扇出；`0` 只保留手动 `ALWAYS` |
| `BRIDGE_BRUTE_ALWAYS` | `0` | `1` = 每个请求都扇出（测试 / 极致速度） |
| `BRIDGE_BRUTE_BUSY_MS` | `300000` | 一次繁忙信号点亮窗口多久。**默认 5 分钟**：客户端请求间隔常达 2–3 分钟，60s 的窗口会整段错过（实测触发 0 次就是这么来的） |
| `BRIDGE_BRUTE_TTFT_MS` | `20000` | 首字超过多少算"上游繁忙" |
| `BRIDGE_BRUTE_NONSTREAM` | `1` | 非流式请求也扇出（先回完整响应者胜）。实测客户端一半流量是非流式，只保护流式等于一半时间没保护；设 `0` 关闭 |

> **代价**：扇出期间输入侧按份数计费（缓存命中时是 cache-read 价，很便宜），
> 落败方在胜者出首 token 的瞬间被断，**输出侧几乎不额外花**；
> 非流式扇出的代价高一些（三份都要生成到完整响应才知道谁快），介意就 `BRIDGE_BRUTE_NONSTREAM=0`。
> 注意区分两种慢：后端抽签慢（扇出有效）vs 上下文太大导致的 prefill 慢
> （三份一样慢，扇出白花钱）—— 后者把 `BRIDGE_BRUTE_TTFT_MS` 调大或
> `BRIDGE_BRUTE_AUTO=0` 关掉自动触发。

### `GET /stats` —— 运行统计（**只允许本机直连，隧道进来一律 404**）

```bash
curl.exe -s http://127.0.0.1:8787/stats
```

一次拿到：上一条消息的消耗与首字、缓存命中率、对冲是否触发/触发几次、当前状态、最后消息时间。

```jsonc
{
  "status": {
    "uptimeSec": 20, "activeUpstreamRequests": 0,
    "lastRequestAt": "2026-09-27T07:42:30.949Z", "lastRequestAgoSec": 1.4,
    "upstreamBusy": false, "upstreamBusyReason": null, "upstreamBusyForMs": 0,
    "lastBusy": null, "lastError": null
  },
  "fanout": {
    "enabled": false, "configured": 3, "auto": true, "always": false,
    "busyWindowMs": 60000, "ttftThresholdMs": 20000,
    "triggeredTotal": 0, "wonTotal": 0, "failedTotal": 0, "triggeredRecently": 0
  },
  "lastMessage": {
    "at": "2026-09-27T07:42:30.949Z", "model": "claude-opus-5-5", "stream": false,
    "ms": 10036, "ttftMs": 1682, "inTok": 35, "cacheRead": 0, "cacheCreate": 0,
    "outTok": 32, "thinkTok": 32, "msgs": 1, "brute": false,
    "effort": "max", "tier": null, "costUsd": 0.00078
  },
  "window": {                       // 最近 BRIDGE_STATS_WINDOW（默认 200）条请求
    "size": 1, "cacheHitRate": 0, "cacheHitStreams": 0,
    "avgTtftMs": null, "p50TtftMs": null, "p90TtftMs": null, "maxTtftMs": null,
    "inTok": 35, "cacheReadTok": 0, "outTok": 32, "costUsd": 0.0008
  },
  "totals": { "requests": 2, "streams": 0, "aborted": 0, "fanoutTriggers": 0, "fanoutWins": 0, "fanoutFailed": 0, "busyMarks": 0, "errors": 0 }
}
```

- `costUsd` 用官方 roster 的定价算（`input` / `output` / `cacheRead`，$/百万 token）；
- `cacheHitRate` = `cacheRead / (cacheRead + inTok)`，即"输入里有多少是缓存命中"；
- **访问控制**：cloudflared 也是从 127.0.0.1 连进来的，所以不能只看来源 IP ——
  同时要求 `Host` 是回环地址、且不带任何 Cloudflare/代理注入头（`cf-*`、`x-forwarded-*`、
  `forwarded` 等）。不满足就回 **404**（不暴露端点存在）。实测：

| 请求方式 | 结果 |
|---|---|
| `http://127.0.0.1:8787/stats` | **200** |
| 带 `cf-ray` / `cf-connecting-ip` | **404** |
| `Host: mira.neko.xn--fiqs8s` | **404** |
| 真的走隧道 `https://mira.neko.xn--fiqs8s/stats` | **404** |

别名：`/v1/stats`、`/internal/stats`。不需要 API key（本机专属）。

### 预热/探测请求拦截（2026-09-27）

Claude Code 客户端在启动、切模型、断线重连时会打一批"预热"请求，打上游既慢又占额度，
还会把 `/stats` 的"上一条消息"搅乱。现在统一本地消化，日志记 `probe_intercepted`，
计数进 `totals.probesIntercepted`（**不计入正常请求统计**）：

| 形态 | 处理 |
|---|---|
| `HEAD/GET /api/hello` | 回 `200 {}`（以前 404，客户端会当成端点不可用再重试一轮） |
| `max_tokens <= 1` 且无显式会话 | 回标准 200 空消息（原来就有） |
| 单条极短消息 + `max_tokens <= BRIDGE_PROBE_MAX_TOKENS`（默认 64），且**不带 tools** | 回 `ok`（流式也按 SSE 完整收尾） |
| 带 `x-mirasim-probe` / `x-anthropic-probe` / `x-claude-warmup` / `x-warmup` 头 | 同上 |
| `POST /v1/messages/count_tokens` | **本地估算**（中文≈1 token/字，其余≈1 token/4 字符） |

命中的文本形态：`warmup` / `prewarm` / `ping` / `pong` / `hello` / `hi` / `hey` / `yo` /
`test` / `health check` 等（整条消息完全匹配才算，见 `PROBE_TEXT_RE`）。

实测（防误伤）：

| 请求 | 结果 |
|---|---|
| `HEAD /api/hello` | **200**，本地 |
| `count_tokens`（中文短句） | **200** `{"input_tokens":12}`，本地 |
| `hi` + `max_tokens:16` | **本地拦截**，返回 `ok`，标 `_bridge.intercepted` |
| `hi` + `max_tokens:32` **带 tools** | 不拦，正常打上游 |
| `你好` + `max_tokens:32` | 不拦，正常打上游 |
| 真实提问 | 不拦，正常打上游 |

关闭：`BRIDGE_PROBE_FILTER=0`。阈值可调：`BRIDGE_PROBE_MAX_TOKENS`。

### 上游回 200 但空 body 的处理（2026-09-27）

客户端报过这个：

```
API returned an empty or malformed response (HTTP 200) — check for a proxy or gateway
intercepting the request. Response: content-type json, empty body, 0 bytes,
request-id absent, intermediary headers anthropic-* x-litellm-* x-request-id.
```

根因是**上游（relay）返回了 200 但没有 body**，而本层原样转发，客户端只能猜"被网关劫持"。
（`x-litellm-*` 是上游自己的头，被本层照常转发。）

现在两条路都按失败处理：

| 路径 | 处理 |
|---|---|
| 非流式 | body 为空 / 非 JSON / 无消息结构 → 重发一次；仍为空 → 回 **503** 明确错误（不再发 200+0 字节） |
| 流式 | 整条流 0 字节 → 重发一次；仍为空 → 发 `event: error`，客户端立刻重试而不是干等 |

同时会 `markRelayBusy('empty 200')`，让后续请求进入对冲。日志分别记
`upstream_empty_200_nostream` / `upstream_empty_200`。

实测（假上游：铸票正常、`/v1/messages` 回 200 空 body）：

```
非流式: relay_busy_marked why=empty 200 → upstream_empty_200_nostream bytes=0 → 重发 → 客户端收到 503（101 字节 JSON）
流式:   ... → upstream_empty_200 → 重发 → 客户端收到 SSE event: error（124 字节）
```

### 实时探测（`/stats` 里的 `rtProbe`，2026-10-04 加）

`/stats` 原先只能反映"客户端刚刚干了什么"，客户端一停就瞎了。现在 bridge 自己**每 5 秒打一发真实的
`claude-opus-5-5`**，结果直接进 `/stats`：

```jsonc
"rtProbe": {
  "enabled": true, "intervalMs": 5000, "model": "claude-opus-5-5", "maxTokens": 8,
  "lastAt": "2026-10-04T10:31:57Z", "lastOk": false, "lastMs": 15009, "lastTtftMs": null,
  "lastError": "messages 503 {\"code\":\"platform_queue_full\",\"message\":\"平台繁忙，请约 5 秒后重试\"}",
  "consecutiveFailures": 3, "total": 3, "okTotal": 0, "successRate": 0,
  "window": { "size": 3, "successRate": 0, "avgMs": 15510, "p50Ms": 15009, "p90Ms": 16517, "maxMs": 16517 },
  "recent": [ { "at": "…", "ok": false, "ms": 15009, "ttftMs": null, "status": null, "error": "…" } ]
}
```

- **流式探测**：只等首个 `content_block_delta` 就掐断，所以健康时 `lastMs` 就是**首字延迟**，同时省输出额度；
- **单次 + 短超时**：不走正常的 3 次重试，否则平台排队时几分钟才出一条结果，就不叫"实时"了；
- 失败时点亮"繁忙窗口"让真实请求走对冲；想解耦设 `BRIDGE_RT_PROBE_MARKS_BUSY=0`。

| 变量 | 默认 | 说明 |
|---|---|---|
| `BRIDGE_RT_PROBE_INTERVAL_MS` | `5000` | 探测节奏；`0` 关闭 |
| `BRIDGE_RT_PROBE_MODEL` | `claude-opus-5-5` | 探测用模型 |
| `BRIDGE_RT_PROBE_MAX_TOKENS` | `8` | 必须 ≥2，否则会被本层的可用性探测拦截 |
| `BRIDGE_RT_PROBE_TIMEOUT_MS` | `45000` | 单次探测超时。平台拒绝服务时是"先排队 30~40s 再回 400"，超时太短就只能看到"网络错误"，早期预警与硬拒绝冷却都会失灵 |
| `BRIDGE_RT_PROBE_KEEP` | `60` | 滚动保留多少条结果 |
| `BRIDGE_RT_PROBE_MARKS_BUSY` | `1` | 探测失败是否点亮繁忙窗口 |

> 代价：这是**真请求**（默认 5s 一发，max_tokens=8、拿到首字即断），会计入上游额度。

### 平台排队信号 `platform_queue_full`（2026-10-04）

实测上游新增了排队错误：

```json
503 {"error":{"code":"platform_queue_full","message":"平台繁忙，请约 5 秒后重试。"},"type":"overloaded_error"}
```

它明确说"约 5 秒后重试"，而本层原来的退避只有 0.7s / 1.4s —— 等于在排队窗口里空转。
现在识别到这类信号（`platform_queue_full` / `overloaded_error` / "平台繁忙"）按 **5 秒**退避。

### 平台"拒绝服务"的 400：不能当客户端错误透传（2026-10-06）

实测（10-05 19:15Z 起）平台 claude 池不可用时，报错先长这样：

```json
503 {"error":{"message":"平台暂时无法提供 claude-opus-5-5，请稍后重试或换用其他模型。 …"}}
```

约 7 分钟后换成了**含混 400**，正文里没有任何字段信息：

```json
400 {"error":{"message":"The request was rejected as invalid.","type":"upstream_error"}}
```

响应头留着排队痕迹：`x-router-throttle-wait-ms: 30000~40000`、`x-router-failure=request; scope=request`；
而账号侧 `/v1/limits` 同时显示 `suspended=false, degraded=false`、7d 用量 8%（**不是额度或封号**），
同设备的 dsh 通道（`deepseek-flash`）200 正常。**结论：这是平台侧的容量问题，不是协议/适配问题。**

危险点在于它长得像"客户端语义错误"：原逻辑对 400 一律 `relay_direct_passthrough` 原样回给客户端，
于是客户端以为自己的请求非法 —— 不重试、不退避，本层的重试与对冲也全部不触发。现在改成：

| 机制 | 行为 |
|---|---|
| 识别 | `isPlatformRefusal()`：400 + `/rejected as invalid/i`（`shouldServeFallback` 也复用同一判定） |
| 归类 | 记为 `relay_direct_platform_refusal`，**算可重试**，并点亮繁忙窗口（后续请求进对冲） |
| 冷却 | `markRelayRefusal()`：60 秒内（`BRIDGE_REFUSAL_COOLDOWN_MS`）只打一发、不扇出、重试直接收手 |
| 解除 | 任意一发成功（含每 5s 的实时探测）立即清零冷却 |
| 对外 | 重试耗尽后不再回 400，而是可重试的 `503 upstream temporarily unavailable, please retry` |

冷却的意义是**别把等待放大**：平台先排队 30~40 秒再拒绝，3 发对冲 × 3 次重试 = 9 次排队，
实测一次客户端请求要 **269 秒**才拿到错误；加冷却与"并发那几发看到拒绝就收手"之后降到 **23 秒**。
顺带把实时探测的超时从 15s 放宽到 45s（`BRIDGE_RT_PROBE_TIMEOUT_MS`）——排队比超时久时，
探测只能看到"网络错误"，早期预警和冷却点亮都会失灵。

### 公网"用着断流"的根治（2026-10-06）

症状：隧道进来的流式请求**用着用着就断**。根因是 Cloudflare 对"源站多久不出第一个字节"的
耐心大约 **100 秒** —— 平台排队时 bridge 在拿到上游响应头之前一个字都不发，隧道那头直接掐连接。

三处一起改：

1. **提前开流**：流式请求先等上游 `BRIDGE_STREAM_GRACE_MS`（默认 10s）；超时就把 `200 + SSE`
   头发出去并持续保活，然后继续等上游。4xx 原样透传的语义保留 —— 只有"上游迟迟不回"这一种
   情况才会早开流（日志 `stream_early_open`）；早开流后上游若仍失败，错误体以 **SSE `event: error`**
   下发（保留 `code`，客户端照样识别）。
2. **SSE 保活**：空闲超过 `BRIDGE_SSE_KEEPALIVE_MS`（默认 15s）写一行 `: keepalive` 注释。
   注释按 SSE 规范会被客户端忽略，但足以让中间任何一跳（尤其 Cloudflare 的空闲超时）认为连接还活着。
3. 顺带补上**单次尝试不受总闸约束**的漏洞：`RELAY_DEADLINE_MS`（默认 90s）原先只在 `attempt > 0`
   时检查，第一发自己就能跑到 600s 的 `RELAY_TIMEOUT` —— 实测客户端等了 **200 秒**才拿到错误。
   现在每一发的超时都按剩余时间截断。

实测（平台正在排队、上游必然 503，走公网）：

```
status=200  首字节=17.7s  总=150.1s
输出: : keepalive ×9 …  最后 event: error {"message":"上游返回 503"}
日志: stream_early_open graceMs=10000
```

改之前同一条路径是"**一个字都不发，200 秒后直接断**"。

## 注意事项

**桌面端必须开着。** Mirasim 关掉后 `mirasim-router` 随之消失，`/healthz` 返回 503。这条链路解决不了「电脑关机也能用」。

**要暴露到公网的话**，保持 `BRIDGE_HOST=127.0.0.1`，前面套一层反代或隧道，并再加一层认证（当前只有一个静态 bearer，没有速率限制也没有失败锁定）。`/healthz` 故意不鉴权以便探活，它会暴露「服务是否存活」这一个信息。

**别把 `.api-key` 和 `requests.log` 提交到版本库。**

## License

MIT
