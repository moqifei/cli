# 步骤二：插件实现（channel 契约 + CLI 适配层）

**目标**：用最小代码量打通「CLI 事件 → Orange 入站上下文 → agent → CLI 出站」，同时把飞书相关的实现面收敛到一个可替换的门面里。

**产出**：`orange-lark-cli` 插件（零第三方依赖，8 个模块，约 900 行）。

---

## 1. 模块划分

| 文件 | 职责 | 关键设计 |
|---|---|---|
| `src/index.mjs` | 插件入口 + channel 契约 | 账号**惰性解析**；per-chat 串行队列 + 全局并发上限；消费者崩溃指数退避重启 |
| `src/cli.mjs` | 进程适配 | argv 执行、stdin 写入、超时、宽松信封解析、错误归类（`CliError` 带 type/subtype/hint） |
| `src/consumer.mjs` | `event consume` 生命周期 | stderr 就绪检测、stdout NDJSON 分发、stdin EOF 优雅停止、崩溃上报 |
| `src/mapper.mjs` | 事件 → 入站上下文 | 字段名对齐 OpenClaw 拼写；过滤 bot/非文本/空；`message_id` 去重 |
| `src/outbound.mjs` | 出站 | `chat:`/`user:`/`oc_`/`ou_` 目标解析；12k 分片；`--text -` 走 stdin |
| `src/card.mjs` | 卡片体（CardKit 2.0） | 思考中 / 流式 / 终帧三态；工具折叠面板、思考面板、footer、summary、双语 |
| `src/card-markdown.mjs` | markdown 适配 | 标题降级、表格/代码块留白、剥离非 `img_` 图片引用 |
| `src/tool-display.mjs` | 工具步骤展示 | 工具名 → 图标 + 标题；Running/Succeeded 状态色 |
| `src/streaming.mjs` | 流式卡片生命周期 | 首帧立刻建卡并**回复**用户消息；节流 + 串行更新；终帧收尾 |
| `src/auth-gate.mjs` | 授权门 + `after_tool_call` 钩子 | 缺权限 → 当前会话发卡片 → 授权后同 session 续跑；与具体工具解耦 |
| `src/proxy.mjs` | 企业网络代理 | 解析 `proxy:` 配置 → lark-cli 子进程 env（含 TLS 中间人 CA）；loopback 永久直连 |
| `src/log.mjs` | 日志 | 统一前缀 + 凭证脱敏 |
| `build.mjs` | 构建 | 仅复制 `src/*.mjs` 到 `dist/` |
| `test/*` | 测试桩 | 见步骤三 |

## 2. 三个契约对齐点（决定成败）

### 2.1 channel 注册形态

shim 同时支持 `gateway.startAccount` 形态与简易 `start()` 形态，实测走前者：

```js
api.registerChannel({
  plugin: {
    id: "feishu",
    setup: { resolveAccounts() { /* 返回账号数组 */ } },
    config: { listAccountIds(), resolveAccount(cfg, id) },
    gateway: { async startAccount(ctx) { /* 起 CLI 消费者 */ } },
    outbound: { async sendText({ to, text, accountId }) { /* 调 CLI */ } },
  },
});
```

- `setup.resolveAccounts` 优先于 `config.listAccountIds`，返回的对象会作为 `ctx.account` 传给 `startAccount`；
- `gateway.startAccount` **不被 await**（`bridge-harness.ts:350-358` 立即返回），所以启动失败只能在插件内打日志 + 自愈，不能靠抛错让 `channel/connect` 失败；
- `outbound.sendText` 同时被入站回复和宿主主动推送（cron）复用。

### 2.2 入站上下文字段

宿主用一套「宽松推断」函数从 ctx 里取字段（`openclaw-host-runtime.ts`），因此按 OpenClaw 拼写填即可：

| 宿主用途 | 取的字段 | 本插件填法 |
|---|---|---|
| channel id | `Surface` → `Provider` | `feishu` |
| chat / peer | `ChatId` → `ChatType` → `From` | `chat_id` / `direct\|group` |
| 出站目标 | `OriginatingTo` → `To` | `chat:oc_x` 或 `user:ou_x` |
| 正文 | `BodyForAgent` → `Body` → `RawBody` | CLI 的渲染文本 |
| 去重/追踪 | `MessageSid` | `message_id` |
| 线程 | `MessageThreadId` | `thread_id` |
| 群 @ 门禁 | `WasMentioned` | `mentions` 推导（p2p 不校验） |
| 路由 | `AgentId` / `SessionKey` | `runtime.channel.routing.resolveAgentRoute()` |

实测宿主生成的 session key：`main:feishu:test:direct:ou_p0_test_user`，说明 `account_id` + peer 都正确传入。

### 2.3 回复投递

```js
const { dispatcher, replyOptions } = runtime.channel.reply.createReplyDispatcherWithTyping({
  deliver: async (payload) => sendTextChunked({ ..., text: payload.text }),
  onError, onIdle, onReplyStart, onCleanup,
});
await runtime.channel.reply.dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyOptions });
dispatcher.markComplete?.();
await dispatcher.waitForIdle?.();   // 必须等，否则下一条消息可能先发
```

`dispatchReplyFromConfig` 返回时**发送链可能还没跑完**（`sendFinalReply` 是入队执行），所以 `markComplete()` + `waitForIdle()` 是保证同会话顺序的必要一步。

## 3. 步骤二踩到的坑

### 坑 1：`api.pluginConfig` 在 `register()` 时是空的（最费时的一个）

现象：

```
[bridge] plugin/init config={"accounts":{"test":{...}},"cli_path":"..."}   ← 配置确实送到了
[orange-lark-cli] registered channel feishu (accounts=default)             ← 但 register 时读不到
[orange-lark-cli] resolved accounts: default(cli=lark-cli)                 ← 于是用了默认账号
ERROR lark-cli not runnable (lark-cli): spawn lark-cli ENOENT
```

原因：harness 先调用 `register(api)`，之后才发 `plugin/init` / `channel/connect`。初始化时序决定了**不能在 register 期捕获配置**。

修复：把账号解析改成惰性求值，在 `resolveAccounts()` / `startAccount()` / `sendText()` 里首次读取并缓存：

```js
let cachedAccounts = null;
const getAccounts = () => (cachedAccounts ??= normalizeAccounts({...pluginConfig, ...api.pluginConfig}));
```

### 坑 2：Orange 会过滤插件进程的环境变量

`ipc/typescript.rs` 只透传白名单键（`PATH` / `HOME` / `LANG` / 代理相关等）。验证时用到的 `FAKE_LARK_EVENTS` 传不进去，CLI 子进程收不到。

修复：给插件加 `config.env`（字符串 map），由插件显式注入 CLI 子进程。这同时也是企业场景下注入 `HTTPS_PROXY` / `LARKSUITE_CLI_*` 的正规入口。

### 坑 3：`dist/` 里不能放 manifest

一开始把 `openclaw.plugin.json` + `package.json` 也复制进 `dist/`，结果：

```
WARN Skipping duplicate plugin id 'orange-lark-cli' from plugins/orange-lark-cli
```

Orange 把「任何含清单的目录」都当插件候选，`dist/` 也算一个。修复：`build.mjs` 只复制 `.mjs`。

### 坑 4：错误信封是多行 JSON，按行取尾部不可读

真实 CLI 的 `config/not_configured` 报错被打散成十几行，日志里完全没法看。修复：累积 stderr 全量（上限 64KB），优先解析出信封并压成一行：

```
cli_error=[config/not_configured] not configured hint: run `lark-cli config init --new` ...
```

### 坑 5：`startAccount` 抛错不会让 `channel/connect` 失败

因为是即发即忘，早期实现里「启动失败」只体现为一条 ERROR，很容易被忽略。修复：启动失败必须**显式打 `channel NOT ready`** 并进入退避重试；同时把「未就绪」与「崩溃」区分开，避免首次 ENOENT 刷两遍日志。

### 坑 6：同会话顺序

`dispatchReplyFromConfig` 提前返回 + 每条消息独立进程，导致并发时后一条回复可能先到。修复：per-chat Promise 链串行 + 全局信号量（`max_concurrent`），并在 dispatch 结束后 `waitForIdle()`。

## 4. 结论

- 插件侧真正需要的飞书知识只有「事件字段 → ctx 字段」和「ctx → 出站命令」两张映射表，其余都是宿主契约；
- 三个隐性约束（配置时机、环境过滤、启动失败不可观测）必须在文档里写清楚，否则后来者会重复踩。
