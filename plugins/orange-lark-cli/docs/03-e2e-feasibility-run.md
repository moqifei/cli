# 步骤三：端到端可行性验证（隔离实例 + 测试桩）

**目标**：在**不接触生产 Orange、不需要真实飞书应用**的前提下，把「事件进 → agent 跑 → 回复出」整条链路跑通，并验证边界行为（去重、特殊字符、进程自愈）。

**产出**：`scripts/prepare-test-home.sh` + `scripts/e2e.sh`，可重复执行，失败即退出。

---

## 1. 为什么不直接用真实飞书应用

- 需要企业管理员开 scope、发布版本、配置长连接订阅，周期不可控；
- 同一 appId 双接入会随机分流事件（详见风险 B1），验证期不能把生产 bot 接两遍；
- 结论只需要证明「插件 ↔ CLI 契约」和「宿主 ↔ 插件契约」，与飞书租户无关。

所以用两个测试桩把外部依赖替换掉，**保留真实的 Orange 进程、真实的插件进程、真实的 agent 与 LLM 调用链**。

## 2. 隔离实例设计

```
TEST_HOME=/tmp/orange-lark-test
├── config.yaml                    # 测试配置（端口 3999，不碰 3000）
├── .orange/config.yaml -> ../config.yaml   # 关键：shim 只认 $HOME/.orange/config.yaml
├── lib -> ~/.orange/lib           # bridge-harness.js + node_modules（yaml）
├── plugins/orange-lark-cli/       # 实体复制的插件（不能用 symlink）
├── data/lark-cli/test/            # LARKSUITE_CLI_CONFIG_DIR（bus.sock、token、UAT）
├── workspace/main/                # agent workspace
└── fixtures/{events.jsonl,sent.jsonl}
```

启动方式：

```bash
HOME=/tmp/orange-lark-test ORANGE_HOME=/tmp/orange-lark-test \
  orange gateway run --port 3999
```

`HOME` 与 `ORANGE_HOME` 必须都指向测试树（原因见步骤一坑 1）。生产实例（:3000）全程未被触碰，仅共用 `~/.orange/lib`。

## 3. 两个测试桩

### `test/fake-lark-cli.mjs`

模拟两个子命令，**严格复刻可观测契约**：

| 行为 | 真实 CLI | 测试桩 |
|---|---|---|
| 就绪 | stderr `[event] ready event_key=...` | 相同 |
| 事件 | stdout NDJSON | 相同（从 `FAKE_LARK_EVENTS` 读） |
| 停止 | stdin EOF 优雅退出 | 相同 |
| 出站 | stdout `{ok:true,data:{message_id}}` | 相同，并落盘 `FAKE_LARK_SEND_LOG`（含完整 argv 与正文，供断言） |

桩的价值在于**能断言 argv**：证明我们真的用了 `--user-id` / `--text -` / `--format json` / `--idempotency-key`，而不是碰巧成功。

### `test/mock-llm.mjs`

本地 OpenAI 兼容端点（`/v1/chat/completions`，支持 SSE 与非流式），回复 `MOCK_REPLY: <用户文本>`，用于断言「回复确实经过 agent」。

## 4. 执行与实测结果

```bash
cd orange-lark-cli && ./scripts/e2e.sh
```

```
PASS: channel ready (lark-cli consumer spawned)
PASS: inbound event reached the agent
PASS: agent reply delivered through lark-cli outbound
```

关键日志（真实抓取）：

```
[orange-lark-cli:test] lark-cli version: lark-cli version fake-0.1.0
[orange-lark-cli:test] spawned consumer pid=17779 event=im.message.receive_v1
[orange-lark-cli:test] consumer ready: [event] ready event_key=im.message.receive_v1
[orange-lark-cli:test] channel ready (account=test event=im.message.receive_v1 pid=17779)
[orange-lark-cli:test] inbound chat=oc_p0_test_chat sender=ou_p0_test_user chars=24
[orange.dispatch] Created session bd067eb9… (key=main:feishu:test:direct:ou_p0_test_user)
[orange.agent_run] conv_key="feishu:test:direct:ou_p0_test_user" channel="feishu" agent_id="main"
[mock-llm] POST /v1/chat/completions stream=false model=mock-chat user="你好，这是一条 lark-cli 可行性验证消息"
[orange-lark-cli:test] spawn … im +messages-send --as bot --user-id ou_p0_test_user --text - --format json --idempotency-key om_msg_p0_0001-final-0
[orange-lark-cli:test] sent to user:ou_p0_test_user message_id=om_fake_mvua3mje chars=52
[orange-lark-cli:test] inbound done in 224ms message=om_msg_p0_0001
```

从事件进到回复出 **约 200–224ms**（含一次本地 LLM 调用）。生产环境将主要受模型时延影响，CLI 侧开销 ≈ 一次进程启动（30–80ms）。

宿主侧 `bindings` 生效：`agent_id="main"`、`account_id=test` 正确匹配。

## 5. 边界行为验证

| 用例 | 做法 | 结果 |
|---|---|---|
| 重复事件 | fixtures 放两条相同 `message_id` | 第二条 `duplicate message dropped`，只回复一次 |
| 特殊字符 | 事件正文以 `@_all` 开头、含换行与 `--text=xxx` | 出站原文完整保留（`repr` 校验通过），未被当作 flag/@file |
| 消费者崩溃 | `pkill -f "fake-lark-cli.mjs event consume"` | <1s 检测到 SIGTERM 退出 → 1000ms 后重启 → 重新 ready |
| 重放事件 | 崩溃后桩从头回放 | 已被去重表拦截，未产生二次回复 |
| 真实 CLI 参数合法性 | 用真 `lark-cli` 调同一路径 | 退出码 3 + `[config/not_configured]`，说明 argv 正确、仅缺凭证 |
| 真实 CLI 启动失败 | 用真 CLI 起消费者 | `consumer exited before ready (code=3) cli_error=[config/not_configured] …`，错误可读 |

出站落盘验证（节选）：

```json
{"argv":["im","+messages-send","--as","bot","--user-id","ou_p0_test_user",
         "--text","-","--format","json","--idempotency-key","om_msg_p0_0002-final-0"],
 "text":"@_all 这是以 @ 开头的回复测试\n第二行包含 --text=xxx 与 --as user\n\n顺便认识一下，你叫什么名字？"}
```

## 6. 步骤三踩到的坑

1. **符号链接装插件被拒**（`plugin candidate escapes search root`）→ 全部改为 `cp -R`。
2. **只设 `ORANGE_HOME` 不生效** → 必须同时覆盖 `HOME`，否则 shim 读生产配置，插件拿到空配置。
3. **`bridge-harness` 需要 `~/.orange/lib` 里的 `node_modules/yaml`** → 测试树用 symlink 指过去即可（这一处 symlink 不在插件搜索根内，不会被安全策略拦）。
4. **测试桩必须严格复刻 stdin EOF 语义**，否则进程停不掉，只能靠 SIGKILL（真实 CLI 是读 stdin EOF 优雅退出）。
5. **`ready` 之后才上报崩溃**：早期实现在 `ENOENT` 时打两条 ERROR（启动失败 + 崩溃），加 `everReady` 去噪。
6. **内置 `aiwork` 通道端口冲突**（隔离实例的已知噪音），与本次验证无关。
7. **同一插件被搜索到两次**：Orange 的默认搜索路径同时包含 `$ORANGE_HOME/plugins` 和 CWD 下的 `plugins/`。若把 CWD 设成 Orange home，同一目录会被发现两次，日志出现 `Skipping duplicate plugin id 'orange-lark-cli'`（无害但误导）。脚本已改为从 `$TEST_HOME/workspace` 启动。

## 7. 本步骤暴露的架构限制（需写入方案）

1. **事件丢失窗口**：bus daemon 在最后一个消费者断开 30s 后退出；hub 对无订阅者的事件直接丢弃；消费者慢时 drop-oldest。验证中"崩溃→重启"之间的重放是靠测试桩伪造的，真实飞书不会重推。→ P1 必须加 `Seq` gap 检测 + 按 chat 补偿拉取。
2. **每消息一次进程**：200ms 中约 30–80ms 是进程开销，流式场景（每 chunk 一次）不可接受。→ P1 常驻 bridge。
3. **无 CardKit/媒体/线程/工具**：P0 范围外，但门面已预留（`outbound.mjs` / `cli.mjs` 可扩展 raw `api` 调用）。
