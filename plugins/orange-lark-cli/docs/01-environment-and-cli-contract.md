# 步骤一：环境勘察与 lark-cli 契约确认

**目标**：在不碰生产 Orange 的前提下，确认「Orange 插件体系能加载自研插件」+「lark-cli 具备渠道接入所需的收发原语」+「两者的输出契约可被稳定解析」。

**产出**：可用的 `lark-cli` 二进制、已核验的命令与输出契约、隔离测试环境的可行路径。

---

## 1. 环境基线

| 组件 | 实测 |
|---|---|
| Node | v22+（Orange 用 `node` 直接跑 `dist/index.mjs`，无需 tsx） |
| Go | 用于构建 `lark-cli` |
| Orange | `/Users/moqifei/openimsdk/orange/target/release/orange`，`orange gateway run --port <port>` |
| lark-cli | `cli/` 源码，`make build` → `cli/lark-cli` |
| 生产实例 | `orange gateway run --port 3000`（全程未触碰） |

构建命令与实测结果：

```bash
cd /Users/moqifei/openimsdk/cli && make build     # 产出 ./lark-cli
./lark-cli --version                              # 正常输出
```

## 2. 核验的四条契约

### 2.1 事件消费是推送式长连接，不是轮询

`lark-cli event consume <EventKey> --as bot`：

- 就绪信号走 **stderr**：`[event] ready event_key=<key>`
- 事件走 **stdout**：一行一个 JSON 对象（NDJSON），字段已扁平化
- 非 TTY 时 **stdin EOF = 优雅退出**（这是插件停止子进程的正确姿势，不用先 kill）
- 同一 appId 的多个消费者共享一个 bus daemon（UDS），daemon 在最后一个消费者断开后 **30s 自动退出**
- 启动前有 scope/订阅预检，失败直接**非零退出**（fail-fast，不会静默空转）

实测（无凭证）：

```
$ lark-cli event consume im.message.receive_v1 --as bot --dry-run
{"status":"error","error":{"type":"config","subtype":"not_configured", ...}}
exit=3
```

### 2.2 出站命令参数形态

```bash
lark-cli im +messages-send --as bot --chat-id oc_x --text - --format json
lark-cli im +messages-send --as bot --user-id ou_x --text - --format json
```

- `--text -` 表示**从 stdin 读正文**（`--text @file` 是读文件，`@` 开头会被误判，因此统一走 stdin）
- `--format` 默认就是 json，仍显式传入，防止未来默认值变化
- `--idempotency-key` 原生支持幂等

用真实 CLI 验证参数是否被接受（无凭证时应报 `config/not_configured`，而不是 unknown flag）：

```
MSG: lark-cli im +messages-send failed (exit=3) [config/not_configured] not configured hint: ...
```

### 2.3 输出信封

成功：`{"ok":true,"identity":"bot","data":{...}}`（`data.message_id` 可取消息 id）
失败：`{"ok":false,"error":{"type","subtype","message","hint"}}`，且退出码非 0

**关键坑**：错误信封是**多行 pretty JSON**，且可能同时出现在 stdout 与 stderr。所以：

- 不能按行解析，必须对整段 buffer 做「找第一个 `{` 到最后一个 `}`」的宽松解析
- 不能只看 stdout，必须同时看退出码

### 2.4 CardKit 有 raw 透传通道

`lark-cli api <METHOD> /open-apis/...` 是官方设计的 raw escape hatch，CardKit 的 `cards` / `cardElement.content` / `settings` 都能直接打，**P1 的流式卡片不需要改 cli 代码**。

## 3. Orange 侧契约（只读核验，未改宿主）

| 事实 | 位置 |
|---|---|
| 插件发现：`$ORANGE_HOME/plugins` + CWD `plugins/` + `plugins.load.paths` | `orange/src/plugins/manager.rs:193-260` |
| 清单：`openclaw.plugin.json` 或 `orange.plugin.yaml`，入口取 `package.json#openclaw.extensions[0]` | `manager.rs:141-259` |
| 运行时：`node bridge-harness.js --plugin ./dist/index.mjs`，**动态 import + cwd=插件目录** | `bridge-harness.ts:480-520` |
| channel 契约：`registerChannel({plugin:{id,setup,config,gateway.startAccount,outbound.sendText}})`，两块都支持 | `openclaw-shim.ts:1440-1600` |
| 宿主只认 `channel` / `account_id` / `delivery_to` / `was_mentioned`，不认识飞书 | `bridge.rs` `dispatch_request_from_payload` |
| session key 由宿主按 `channel:account:peer` 派生（插件不需要算） | `request_lifecycle.rs` `resolve_dispatch_scope` |

**结论**：宿主无需任何改动，插件只要满足 shim 的 channel 契约即可。

## 4. 步骤一踩到的坑

### 坑 1：`ORANGE_HOME` 不影响插件读配置（重要，影响生产部署）

shim 读 `plugins.entries.<id>.config` 时，路径是**硬编码**的：

```ts
// orange/src/plugins/typescript/openclaw-shim.ts:326-335
const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
const configPath = path.join(home, ".orange", "config.yaml");
```

即：即使设置了 `ORANGE_HOME`，Node 侧仍然读 `$HOME/.orange/config.yaml`。隔离测试时必须在 `HOME` 下也放一份 `.orange/config.yaml`，否则插件拿到的是**空配置**（表现为 `resolved accounts: default(cli=lark-cli)` 然后 `spawn lark-cli ENOENT`）。

> 生产含义：如果 Orange 以 systemd/service 用户运行，`$HOME` 与真实配置目录不一致时，插件配置会读不到。部署文档必须显式说明 `HOME` 与 `~/.orange` 的关系。

### 坑 2：插件目录不能用符号链接

```
WARN Skipping unsafe plugin candidate /tmp/.../plugins/orange-lark-cli:
     plugin candidate escapes search root: ... -> /Users/moqifei/openimsdk/orange-lark-cli
```

Orange 会校验候选目录 realpath 是否逃逸搜索根。开发期用 symlink 会直接被拒，必须实体复制（脚本里用 `cp -R`）。

### 坑 3：内置 `orange-aiwork` 在隔离实例里抢端口

隔离实例启动时 `[channel:aiwork] runner stopped: Address already in use (os error 48)`。这是内置桌面通道，与本次验证无关，日志噪音可忽略；生产同机双实例部署时需要注意端口冲突。

## 5. 结论

1. lark-cli 的收发原语满足渠道需求，且错误契约清晰可解析；
2. Orange 的插件契约足够通用，**零改动**即可承载新通道；
3. 有两条环境约束必须先解决：`HOME` 与 `~/.orange` 的关系、插件目录必须是实体目录。
