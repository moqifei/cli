# 步骤四：验证手册与真实飞书接入

---

## 1. 三分钟验证（不需要任何凭证）

```bash
cd /Users/moqifei/openimsdk/orange-lark-cli
./scripts/e2e.sh
```

期望输出：

```
PASS: channel ready (lark-cli consumer spawned)
PASS: inbound event reached the agent
PASS: agent reply delivered through lark-cli outbound
```

三条 PASS 分别证明：CLI 消费者被拉起并就绪 / 事件穿过宿主路由到达 agent / agent 回复经 CLI 出站送达。

看细节：

```bash
KEEP=1 ./scripts/e2e.sh          # 跑完不杀进程
tail -f /tmp/orange-lark-test/logs/gateway.log | grep orange-lark-cli
cat /tmp/orange-lark-test/fixtures/sent.jsonl | python3 -m json.tool
```

一条完整链路应看到这 6 行（顺序固定）：

```
lark-cli version: …
spawned consumer pid=… event=im.message.receive_v1
consumer ready: [event] ready event_key=im.message.receive_v1
channel ready (account=test …)
inbound chat=oc_… sender=ou_… chars=…
sent to user:ou_… message_id=om_… chars=…
inbound done in ~200ms message=om_…
```

## 2. 手工验证（不用脚本）

```bash
./scripts/prepare-test-home.sh
(MOCK_LLM_PORT=18080 node test/mock-llm.mjs &)
(cd /tmp/orange-lark-test && HOME=/tmp/orange-lark-test ORANGE_HOME=/tmp/orange-lark-test \
   /Users/moqifei/openimsdk/orange/target/release/orange gateway run --port 3999 &)
# 想换消息：编辑 /tmp/orange-lark-test/fixtures/events.jsonl 后重启 gateway
```

断言点：

| 断言 | 方法 |
|---|---|
| 插件被加载 | 日志出现 `Activated plugin: orange-lark-cli` 且 `data/plugins/status.json` 中 state=active |
| 配置生效 | `resolved accounts: test(cli=<你配的路径>)`（若显示 `default(cli=lark-cli)` 说明配置没读到） |
| 通道就绪 | `channel ready (account=… event=… pid=…)` |
| 入站路由 | `Created session … (key=main:feishu:test:direct:ou_…)` + `agent_id="main"` |
| 出站 | `sent to user:ou_… message_id=…` |
| 去重 | 同 `message_id` 第二次出现时 `duplicate message dropped` |
| 自愈 | `pkill -f "event consume"` 后 1s 内出现 `restarting consumer` 与新的 `channel ready` |

## 3. 接真实飞书（P0 上线路径）

### 3.1 前置条件（go/no-go 闸门）

| 检查 | 命令 | 通过标准 |
|---|---|---|
| CLI 可用 | `lark-cli --version` | 有版本号；建议固定版本并禁用自动升级 |
| 应用凭证 | `echo -n "$SECRET" \| LARKSUITE_CLI_CONFIG_DIR=~/.orange/data/lark-cli/work lark-cli config init --app-id cli_xxx --app-secret-stdin --brand feishu` | 成功写入 |
| 身份可用 | `lark-cli doctor` | 无致命错误 |
| **scope** | `lark-cli event consume im.message.receive_v1 --dry-run --as bot` | 不报 missing scope（需 `im:message.p2p_msg:readonly`） |
| **回调 scope** | `lark-cli event consume card.action.trigger --dry-run --as bot` | 不报 missing scope（需 `im:message:readonly`），且开发者后台已配置长连接订阅 |
| 真事件 | `lark-cli event consume im.message.receive_v1 --as bot --max-events 1 --timeout 60` | 60s 内收到 1 条 |
| 出站 | `lark-cli im +messages-send --chat-id oc_xxx --text 'ping' --as bot` | 返回 `message_id` |

> scope 是**新的硬性门槛**：`event consume` 失败会直接退出，不是"收不到但不报错"。缺 scope 时插件日志会显示
> `channel NOT ready: … cli_error=[permission/...]`，并且每 1/2/5/10/30s 重试。

### 3.2 切换配置

```yaml
plugins:
  entries:
    openclaw-lark:
      enabled: false            # 必须关，同一 channel id 不能双跑
    orange-lark-cli:
      enabled: true
      config:
        cli_path: /usr/local/bin/lark-cli
        accounts:
          work:
            config_dir: /Users/moqifei/.orange/data/lark-cli/work
            identity: bot
```

`channels.feishu` 与 `bindings` **不需要改**（`requireMention` / `request_profile` / `account_id` 继续由宿主读取）。

重启 gateway 后确认：

1. `resolved accounts: work(cli=/usr/local/bin/lark-cli)`
2. `channel ready (account=work …)`
3. 私聊 bot 发一句「你好」→ 收到回复
4. `ps` 中只有 **1 个** `lark-cli event consume`（加卡片回调时应为 2 个）

### 3.3 失败模式对照表

| 日志 | 原因 | 处理 |
|---|---|---|
| `resolved accounts: default(cli=lark-cli)` | 插件配置没读到（`HOME`/`~/.orange` 不一致） | 确认运行用户的 `$HOME/.orange/config.yaml` 是同一份 |
| `spawn lark-cli ENOENT` | `cli_path` 不可执行或不在 PATH | 配绝对路径 |
| `cli_error=[config/not_configured]` | 该 `config_dir` 没有凭证 | 执行 `config init` |
| `cli_error=[permission/...]` | 缺 scope / 未发布版本 | 后台开权限并发布 |
| `channel ready` 但收不到消息 | 控制台未配置长连接订阅 / 事件未订阅 | 开发者后台确认订阅方式为长连接 |
| 能发不能收 | 企业代理只对 REST 生效，WS 未走代理 | 见 `docs/04` §5 与方案文档 P1 |

### 3.4 回滚

```yaml
plugins.entries.openclaw-lark.enabled: true
plugins.entries.orange-lark-cli.enabled: false
```

重启 gateway 即可。因为 `channels.feishu` / `bindings` 从未改动，回滚不需要动业务配置。

## 4. 本阶段已交付 / 未交付

**已交付（P0 可行性）**

- 插件骨架与 Orange 契约打通（channel 注册、账号解析、入站 ctx、出站 sendText）
- `event consume` 子进程全生命周期（就绪检测、NDJSON 分发、stdin 优雅停止、崩溃自愈、指数退避）
- 文本收发闭环、per-chat 串行、去重、分片、凭证脱敏
- 隔离测试环境与可重复 e2e 脚本
- 与真实 CLI 的错误契约对齐（`type/subtype/hint` 可读化）

**未交付（P1 及以后）**

| 能力 | 现状 | 下一步 |
|---|---|---|
| 卡片 / CardKit 流式 | 未实现 | `lark-cli api` raw 调 CardKit + per-card 串行 sequence |
| 线程回复 | 未实现 | `im +messages-reply --reply-in-thread` |
| 媒体收发 | 未实现 | 入站解析 `[Image: key]` / `+messages-mget --download-resources`；出站 `--image/--file`（cwd 相对） |
| 群聊与 @ 门禁 | 只测了 p2p | 用 `mentions[]` 判定 `WasMentioned`，capabilities 打开 group |
| 事件连续性 | 仅内存去重 | 用 `Seq` 做 gap 检测 + 重启后按 chat 补偿 |
| 企业 hook（token 注入） | 未迁移 | 原样搬 `http-token-injector.ts` + 缓存依赖链对齐 |
| 出站代理 | 未验证 | REST 走 env/loopback；WS 需 `gorilla DefaultDialer.Proxy` |
| 42 个 `feishu_*` 工具 | 未迁移 | 按域分级迁移（P0 只需用户信息/发消息/读消息/媒体） |
| 每 chunk 一次进程 | 已实测 30–80ms | 常驻 bridge（P1，性能与流式） |

## 5. 已知限制（务必在评审中说明）

1. **事件丢失窗口**：消费者崩溃到重启之间、以及 bus daemon 空闲退出后的事件不会重推；P0 只能靠去重 + 人工补发。P1 用 `Seq` 对齐。
2. **流式不可用**：每条回复一次进程，且未实现 CardKit，长回答会是一整条文本。
3. **WS 代理未通**：企业出口只配 `HTTPS_PROXY` 时 REST 通、WS 不通，表现为"能发不能收"。P1 在 wrapper 里加 3 行 `DefaultDialer.Proxy`。
4. **scope 依赖发布流程**：不是改代码能解决的，必须提前和飞书管理员对齐。
