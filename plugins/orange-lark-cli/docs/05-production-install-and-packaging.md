# 步骤五：打包、生产安装与切流（本机已执行）

**目标**：把插件（**含 lark-cli 二进制**）打包成可分发包 + 安装到 `~/.orange/plugins`，用已有飞书应用凭证接通，替换 `openclaw-lark`。

**执行时间**：2026-10-30 09:33–09:36（本机 macOS arm64，生产 gateway 端口 3000）

---

## 1. 打包：一个脚本产出「插件 + CLI」

```bash
cd /Users/moqifei/openimsdk/orange-lark-cli
./scripts/package.sh                 # 只打包
./scripts/package.sh --install       # 打包 + 安装到 ~/.orange/plugins
```

实际输出：

```
==> building plugin
built 6 module(s) -> .../dist
==> staging .../dist-pkg/orange-lark-cli
==> verifying bundled binary
lark-cli version 7933333c
==> archiving
package : .../dist-pkg/orange-lark-cli-0.1.0-darwin-arm64.tar.gz
size    : 14M            # 解压后 45M（CLI 二进制占绝大部分）
sha256  : 6a8bc370086d4e857766490f18ac7255bb1c4ab8bc0bc7aa399e67c040f08365
```

> 每次重新打包 sha256 都会变（内含构建时间戳/新脚本），以 `*.sha256` 文件为准。

### 包内结构

```
orange-lark-cli/
├── openclaw.plugin.json     # channel: feishu
├── package.json             # openclaw.extensions -> ./dist/index.mjs
├── dist/*.mjs               # 插件代码（零第三方依赖）
├── bin/lark-cli             # ★ 随包分发的官方 CLI（可执行位已保留）
└── scripts/{install.sh,setup-account.sh}
```

### 脚本做了什么（可复用要点）

| 步骤 | 细节 | 为什么 |
|---|---|---|
| 构建插件 | `node build.mjs` 复制 `src/*.mjs` → `dist/` | 插件只用 node 内置模块，不需要 bundler/tsx；Orange 用 `node` 直接跑 `.mjs` |
| 找 CLI | `CLI_SRC` 指定，否则用 `../cli/lark-cli`，不存在则 `make build` | 同一份脚本既能用预编译二进制，也能从源码构建 |
| 装机兼容 | `GOOS=linux GOARCH=amd64 ./scripts/package.sh` | 目标机与开发机架构不同时交叉编译 |
| 校验 | 打包前跑 `bin/lark-cli --version` | 防止把不可执行/缺动态库的二进制发出去 |
| 归档 | `tar -czf` + `shasum -a 256` | 保留可执行位；便于传输后校验 |
| 安装 | `install.sh` 用 `cp -R` 实体复制 | **不能用 symlink**：Orange 会拒绝逃逸搜索根的插件目录 |

> 踩坑：`tar` 默认保留权限，但 `cp` 在某些 umask 下会丢执行位 —— 安装脚本里显式 `chmod +x bin/lark-cli`，并且插件启动时会先 `--version` 探活，失败立刻在日志里报 `lark-cli not runnable`。

## 2. 凭证：用已有飞书应用，不新增配置项

已有的 `channels.feishu.accounts.work`（appId/appSecret）继续保留不动，但 **CLI 用自己的凭证存储**，凭证不进入插件配置：

```bash
# 一次性：把已有 app 的凭证写入 CLI 的账号目录（0600）
printf '%s' "$APP_SECRET" | \
  LARKSUITE_CLI_CONFIG_DIR=~/.orange/data/lark-cli/work \
  ~/.orange/plugins/orange-lark-cli/bin/lark-cli config init \
    --app-id cli_a97af778eaf99bdb --app-secret-stdin --brand feishu
# => OK: Configuration saved to /Users/moqifei/.orange/data/lark-cli/work/config.json
```

等价的自动化入口（包内自带，secret 走 stdin 不进 `ps`）：

```bash
APP_SECRET=xxx ./scripts/setup-account.sh work cli_a97af778eaf99bdb feishu
```

**踩坑（重要）**：只设 `LARKSUITE_CLI_APP_ID/APP_SECRET` 环境变量**不够**。env 凭证源只接受显式 TAT（`LARKSUITE_CLI_TENANT_ACCESS_TOKEN`），不会用 app_id+secret 去换 TAT：

```
preconditions: [{ name: credentials_available, status: blocked,
                  detail: resolve tenant access token: no tat available from credential source "env" }]
```

所以必须走 `config init`（凭证存储）或显式注入 TAT。

## 3. 切换前的预检（不建连接，安全）

```bash
export LARKSUITE_CLI_CONFIG_DIR=~/.orange/data/lark-cli/work
CLI=~/.orange/plugins/orange-lark-cli/bin/lark-cli

$CLI event consume im.message.receive_v1 --as bot --dry-run
# status: "ready"；preconditions: credentials_available / console_event_published / scopes_granted 全 ok

$CLI event consume card.action.trigger --as bot --dry-run     # 同样 ready（P0 暂不消费）

$CLI api GET /open-apis/bot/v3/info --as bot
# app_name=百大明分身  open_id=ou_4c6c18ed997840ac8c01a4d6f13c12a7

printf 'probe' | $CLI im +messages-send --as bot --user-id ou_000... --text - --format json
# => ok:false api code 99992351 (invalid open_id) —— 证明 TAT/scope/参数/STDIN 全部正确，
#    请求确实打到了飞书，只是接收者是我编的 id
```

结论：现网应用**已具备** `im:message.p2p_msg:readonly` 与 `im:message:readonly`，控制台长连接订阅也已开启，不需要额外发布版本。

## 4. 配置改动（已写入 `~/.orange/config.yaml`）

备份：`~/.orange/config.yaml.bak.20261030-093526`

```yaml
plugins:
  entries:
    openclaw-lark:
      enabled: false            # ← 由 true 改为 false（config 块原样保留，便于回滚）
      config: { ...原样... }
    orange-lark-cli:            # ← 新增
      enabled: true
      config:
        bot_open_id: ou_4c6c18ed997840ac8c01a4d6f13c12a7
        accounts:
          work:
            config_dir: /Users/moqifei/.orange/data/lark-cli/work
            identity: bot
```

未改动、也不需要改动：

- `channels.feishu.*`（`requireMention` / `request_profile` / `accounts.work` / `dmPolicy`）——宿主照常读；
- `bindings`（`channel: feishu, account_id: work`）——channel id 仍是 `feishu`；
- 其它插件（`openclaw-channel` / `openclaw-http-channel` / `weather` …）全部未动。

`cli_path` 故意省略：插件默认使用**自己包内**的 `bin/lark-cli`（`ORANGE_PLUGIN_DIR/bin/lark-cli`），这样升级插件即升级 CLI，也不会受 PATH 影响。

## 5. 重启与上线结果

```bash
kill <old pid>
cd ~ && nohup /usr/local/bin/orange gateway run --port 3000 --bind lan --force \
  > ~/.orange/logs/gateway.stdout.log 2>&1 &
```

实测日志（`~/.orange/logs/gateway.log`）：

```
[orange-lark-cli:work] starting account (cli=~/.orange/plugins/orange-lark-cli/bin/lark-cli config_dir=~/.orange/data/lark-cli/work)
[orange-lark-cli:work] lark-cli version: lark-cli version 7933333c
[orange-lark-cli:work] spawned consumer pid=32966 event=im.message.receive_v1
[event] consuming as cli_a97af778eaf99bdb (cli_a97af778eaf99bdb)
[event] local bus not found; checking remote connections...
[event] remote connection check: online_instance_cnt=0        ← 没有第二个实例抢事件
[event] started bus daemon pid=32978
[event] listening for events (key=im.message.receive_v1)
consumer ready: [event] ready event_key=im.message.receive_v1
channel ready (account=work event=im.message.receive_v1 pid=32966)
[source] feishu-websocket: connected                          ← 长连接已建立
```

进程拓扑核对：

```
gateway(32921) ─┬─ lark-cli event consume im.message.receive_v1 --as bot   (32966)
                └─ lark-cli event _bus --profile cli_a97…  (32978)      ← 共享 WS 的 bus daemon
node bridge-harness × 3  →  orange-lark-cli / openclaw-channel / orange-http-channel
```

**`openclaw-lark` 的进程已不存在**，确认完成替换。

> 备注：`~/.orange/data/plugins/status.json` 里 `openclaw-lark: active` 是**历史注册记录**（updated_at 停留在 10-28），不代表正在运行；以进程与日志为准。

## 6. 你怎么验证（3 步）

1. **私聊 bot 发一句**「你好，测试一下」→ 应收到一条纯文本回复（当前无卡片/流式）。
2. 看日志确认链路：
   ```bash
   tail -f ~/.orange/logs/gateway.log | grep -E "orange-lark-cli|feishu-trace"
   ```
   期望序列：`inbound chat=… sender=… chars=…` → `Created session … (key=main:feishu:work:direct:ou_…)` → `sent to user:ou_… message_id=om_…` → `inbound done in …ms`。
3. **群里 @bot** 发一句（`requireMention: true` 仍生效）→ 同样应有回复。

## 7. 回滚（1 分钟）

```yaml
plugins.entries.openclaw-lark.enabled: true
plugins.entries.orange-lark-cli.enabled: false
```

重启 gateway 即可；`channels.feishu` 与 `bindings` 从未改动，不需要额外调整。
也可以直接用备份覆盖：`cp ~/.orange/config.yaml.bak.20261030-093526 ~/.orange/config.yaml`。

## 8. 本次切换的功能差异（**务必知悉**）

| 能力 | 旧（openclaw-lark） | 现在（P0） | 影响 |
|---|---|---|---|
| 私聊/群 @ 文本收发 | ✅ | ✅ | 无 |
| **42 个 `feishu_*` 工具** | ✅ | ❌ 未迁移 | agent 无法再调用飞书工具；`feishu-daily-brief` 等 cron 技能会失败 |
| 卡片渲染 / 流式 | ✅ | ❌ | 回复是一条完整纯文本，无打字机效果 |
| 线程回复 | ✅ | ❌ | 回复落在会话主线程 |
| 图片/文件/语音 | ✅ | ❌ | 入站非文本消息会被跳过（日志 `unsupported message_type`） |
| 插件级 `http_token_injector` | ✅（原配置为占位 URL） | ❌ 未迁移 | 宿主级 `agent.defaults.http_token`（`127.0.0.1:5000`）仍然生效，未受影响 |
| 主动推送（cron/proactive） | ✅ | ⚠️ 仅文本 | 走 `channel/send` → 本插件出站，可用；但依赖 `feishu_*` 工具的技能会失败 |

> 建议验证顺序：先确认文本收发（本次目标），再决定是否把「工具集」作为下一步（P0.5），否则 17:50 的 `feishu-daily-brief` 定时任务会报工具不存在。

## 9. 排障对照

| 现象 | 查什么 | 处理 |
|---|---|---|
| 日志 `resolved accounts: default(cli=lark-cli)` | 插件配置没读到（`HOME` 与 `~/.orange` 不一致） | 确认运行用户 `$HOME/.orange/config.yaml` 是同一份 |
| `spawn lark-cli ENOENT` | 打包时漏了 `bin/`，或执行位丢失 | 重新 `package.sh --install`；`chmod +x` |
| `cli_error=[config/not_configured]` | `config_dir` 下没有 `config.json` | `setup-account.sh` |
| `channel ready` 但收不到消息 | 控制台订阅方式是否"长连接"；是否另有实例占用 | `event consume --dry-run` 看 `console_event_published`；`remote connection check: online_instance_cnt` |
| 能发不能收 | 企业代理只对 REST 生效 | 见方案文档 P1（WS dialer 代理） |
| 回复重复 | 两个插件同时启用（旧插件没停） | 确认 `bridge-harness` 进程 cwd 只有 3 个，且不含 `openclaw-lark` |
