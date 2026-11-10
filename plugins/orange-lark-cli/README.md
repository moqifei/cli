# orange-lark-cli

Orange 的飞书渠道插件，通道层改用飞书官方 [`larksuite/cli`](https://github.com/larksuite/cli) 二进制，不再依赖 `@larksuiteoapi/node-sdk` 的 WSClient / OpenAPI 客户端。

插件本身零第三方依赖，只用 `node:` 内置模块；通道能力全部通过 `lark-cli` 子进程实现（事件消费、发消息、CardKit、OAuth）。

## 为什么放在 cli 仓库里

本插件托管在 lark-cli 的 fork 内（`plugins/orange-lark-cli`），只用维护一套代码：

| 关注点 | 处理方式 |
|---|---|
| 官方 CLI 更新 | `git fetch upstream && git merge upstream/main`；插件位于 `plugins/`，上游不涉及该目录，几乎不会冲突 |
| 插件内技能 | 构建时从仓库根 `skills/lark-*` 生成，**不落库**（`.gitignore` 忽略 `plugins/orange-lark-cli/skills/`），不存在两份技能 |
| 打包二进制 | `scripts/package.sh` 默认从同一工作区 `make build`，CLI 源码变更不会被漏掉 |
| 本地适配补丁 | 直接改 CLI 源码，与插件一起提交、一起打包 |

## 目录

```
openclaw.plugin.json   插件清单（Orange 与 OpenClaw 共同约定）
package.json           openclaw.extensions -> ./dist/index.mjs
src/*.mjs              源码（零第三方依赖，只用 node: 内置模块）
build.mjs              构建：src -> dist，并从 ../../skills 生成 skills/
dist/                  构建产物（不入库）
skills/                由 ../../skills/lark-* 生成（不入库）
test/                  测试桩：假 lark-cli / 本地 mock LLM
scripts/*.sh           隔离实例准备、打包、安装、端到端脚本
docs/                  分步骤实施记录（含踩坑）
```

## 快速开始（本地端到端）

```bash
./scripts/e2e.sh          # 全自动：准备隔离 home → 起 mock LLM → 起 Orange → 断言收发
KEEP=1 ./scripts/e2e.sh   # 保留进程，便于看日志
```

## 打包（含 lark-cli 二进制）

```bash
./scripts/package.sh                  # 重新 make build CLI + 生成技能 → dist-pkg/*.tar.gz
./scripts/package.sh --install        # 打包并安装到 ~/.orange/plugins
./scripts/package.sh --no-cli-build   # 跳过 CLI 编译，复用仓库根的 lark-cli（迭代插件时更快）
CLI_SRC=/path/to/lark-cli ./scripts/package.sh  # 用指定二进制
GOOS=linux GOARCH=amd64 ./scripts/package.sh    # 交叉编译 CLI
```

包内结构：`dist/*.mjs` + `skills/` + `bin/lark-cli` + 清单 + `scripts/{install.sh,setup-account.sh}`。
插件默认使用**包内**的 `bin/lark-cli`，因此升级插件即升级 CLI，无需依赖 PATH。

> 旧版脚本只在 `cli/lark-cli` 不存在时才编译，CLI 源码改了也不会重新打包；现在默认每次 `make build`，必须显式加 `--no-cli-build` 才会复用旧二进制。

> 注意：**不要**用符号链接安装。Orange 的插件发现会拒绝逃逸搜索根的符号链接
> （`plugin candidate escapes search root`），必须实体复制。

## 改完东西跑哪条命令

| 你改了什么 | 跑什么 | 为什么 |
|---|---|---|
| `src/*.mjs`（插件逻辑） | `./scripts/package.sh --no-cli-build --install` | 不涉及 Go，跳过 CLI 编译 |
| `cli/skills/lark-*/SKILL.md`（技能） | `./scripts/sync-skills.sh --sandboxes` | 技能是生成产物，需重建并同步到运行时 |
| `cli/` 下的 Go 代码（lark-cli） | `./scripts/package.sh --install` | 必须重编 `bin/lark-cli` |
| `orange/` 的 Rust 代码 | 在 `orange/` 里 `cargo build --release`，替换 `/usr/local/bin/orange` 后 `orange gateway restart` | 与插件无关 |

### 为什么技能会被"覆盖"

`plugins/orange-lark-cli/skills/` **不是源文件**，是 `build.mjs` 从 `cli/skills/lark-*`
生成出来的（`fs.cpSync(from, to, { force: true })`）。直接改它"看起来生效"，
下次 `package.sh` 一跑就被源文件覆盖回去 —— 典型症状是"我明明改了，重装后又变回旧版"。

**改技能请改 `cli/skills/<技能名>/SKILL.md`**，然后：

```bash
./scripts/sync-skills.sh                # 重建 skills/ → 插件目录 → ~/.orange/workspace/*/skills
./scripts/sync-skills.sh --sandboxes    # 顺带覆盖已有 sandbox 副本（运行中的会话立刻生效）
./scripts/sync-skills.sh --no-build     # 不重建，只同步当前 skills/
```

同步链路的由来：Orange 运行时读的是 **sandbox 副本**，源头是
`~/.orange/workspace/<agent>/skills`（会话启动时 `write-if-missing` 同步，已存在则不覆盖）。
所以"改了源 + 重装插件"只更新了插件目录，运行中的会话仍读旧副本 —— 这就是
`sync-skills.sh` 要把三层一次写到位的原因。

`package.sh --install` 收尾已自动跑 `sync-skills.sh --no-build --sandboxes`
（安装目录是 `<orange_home>/plugins` 时），打包安装一条命令即覆盖到运行中的会话。

## 接入真实飞书

```bash
# 每个账号一次性写凭证（secret 走 stdin，不进 ps）
APP_SECRET=xxx ./scripts/setup-account.sh work cli_xxx feishu
```

凭证落在 `~/.orange/data/lark-cli/<account>/config.json`（0600），插件配置里只写 `config_dir`。
详见 `docs/05-production-install-and-packaging.md`。

`~/.orange/config.yaml`：

```yaml
plugins:
  entries:
    openclaw-lark:
      enabled: false          # 同一 channel id 不能双跑
    orange-lark-cli:
      enabled: true
      config:
        # cli_path 可省略：默认用包内 bin/lark-cli；仅在需要覆盖时才写
        accounts:
          work:
            config_dir: ~/.orange/data/lark-cli/work
            identity: bot
```

## 配置项

| key | 默认 | 说明 |
|---|---|---|
| `cli_path` | 包内 `bin/lark-cli` | 找不到包内二进制时才回退到 PATH 里的 `lark-cli` |
| `accounts` | 由 `channels.feishu.accounts` 推导 | 显式配置时以插件配置为准 |
| `accounts.<id>.config_dir` | `$ORANGE_HOME/data/lark-cli/<id>` | 传给 `LARKSUITE_CLI_CONFIG_DIR`，每账号隔离 token/bus/UAT |
| `accounts.<id>.identity` | `bot` | `--as` 取值 |
| `accounts.<id>.enabled` | `true` | 置 false 可保留配置但不起进程 |
| `ready_timeout_ms` | `30000` | 等待 `[event] ready` 的超时 |
| `send_timeout_ms` | `60000` | 单次出站超时 |
| `max_concurrent` | `4` | 调度并发上限 |
| `bot_open_id` | 启动时自动探测 | 机器人自己的 open_id，只用于群聊 `@` 判定。这是**应用维度**的标识，换个飞书应用（测试/生产、不同租户）就会变，抄配置到别的环境一定对不上；启动时用 `bot/v3/info` 校准，写错会用探测值纠正并告警。一般不用配。探测也失败时退化成「有 mentions 即视为被 @」。 |
| `message_types` | `["text"]` | P0 仅文本 |
| `accounts.<id>.auth_domains` | 由技能声明推导 | 固定用户授权申请的域集（如 `[im, calendar, task, approval]`），覆盖推导结果 |
| `proxy` | 继承进程环境 | 企业网络代理；`url` / `no_proxy` / `ca_path` / `enabled` / `mode`，账号级可覆盖 |
| `env` | - | 透传给 CLI 子进程的额外环境变量（测试桩等；代理请用 `proxy`） |
| `render_mode` | `text` | `card` 启用 CardKit 流式卡片 |
| `streaming` | `false` | 与 `render_mode: card` 一起开启流式 |
| `reasoning.enabled` / `.expanded` | `true` / `false` | 思考面板是否展示、默认是否展开 |
| `card.show_tool_use` | `true` | 工具执行折叠面板 |
| `card.loading_icon_img_key` | - | 生成中的转圈图标（租户自传的 `img_v3_...`；默认不发） |
| `footer.status` / `.elapsed` | `false` | 终帧 footer（与旧插件一致，默认全关；`model` 同理） |
| `reply_in_thread` | `false` | 回复是否进话题线程 |

## 卡片渲染（与旧插件对齐）

`render_mode: card` 时一轮一张卡，生命周期与 `openclaw-lark/src/card` 一致：

1. **首帧**：dispatch 一开始就建卡发出去 —— 只有一个空的流式锚点，不渲染任何占位面板。模型迟迟不吐字时用户也立刻有反馈；一轮什么都没产出时也不会一条消息都不弹。
2. **中间帧**：工具调用变成可折叠面板（`🛠️ 工具执行 · N 步 (1.2s)`，每步带图标与 Running/Succeeded 状态色）；**没有工具步骤时完全不渲染工具面板**（旧插件那块「等待工具执行」空壳已去掉）。思考面板 `💭 思考中...` 一旦出现就一直保留，回答开始输出后也不撤回。
3. **终帧**：工具面板折叠，思考标题变成 `💭 思考了 3.2s` 并保持可见；正文经 markdown 适配（H1→H4、表格/代码块留白、剥离非 `img_` 图片）；可选 footer（`已完成 · 耗时 4.1s`）；关掉 streaming 动画。

卡片是**回复用户那条消息**（`im +messages-reply`），所以会渲染引用块「回复 某某：…」并挂进同一会话线程；`reply_in_thread: true` 时改为话题内回复。

> 与旧插件的已知差异：工具步骤只有「名称 + 状态」，没有参数/结果代码块——Orange 只把 `tool_start` 透给插件，拿不到入参与返回值。footer 的 tokens/cache/context 同理（没有 session 统计），因此即使打开也不显示。

### 主动简报：信封渲染与投递幂等

proactive 技能（`lark-daily-brief`）的最终回复是一段 **delta 信封** JSON，那是给调度器判重和水位用的机器契约，不是给人看的。`src/render.mjs` 在投递前把它渲染成文本，覆盖 `status: "delta" | "summary" | "alert"` 三种：

- 之前只认 `delta`，而「今天没事」的空态用的是 `status: "summary"`，于是整段 JSON 被原样贴进飞书。
- 两条投递路径都要渲染：会话内手动跑走 `deliver`，cron 的 `channel/send` 走 `outbound.sendText`。后者不做渲染的话，Rust 侧的 `render.rs` 不生效时会漏出去。

**重复投递**：Orange 的 `outbound recovery` 会在 `channel/send` 还没返回时扫描 pending 队列重投；卡片投递要 1s+，同一条简报就会发两次。`outbound.mjs` 加了一层 10 秒内容窗口（目标 + 内容指纹）：第二次请求直接 `await` 第一次的 promise，拿到同样的 `messageId`，核心据此把队列项标成已完成。`sendText` / `sendCard` / `sendPost` 三处都覆盖；重复内容只在窗口内合并，超时后照常发送（用户要求重发不会丢）。

## 企业网络代理

飞书流量全部在 `lark-cli` 子进程里（REST + WebSocket），所以代理只需变成子进程环境变量，
不需要 `https-proxy-agent` 之类的依赖：

```yaml
plugins:
  entries:
    orange-lark-cli:
      config:
        proxy:
          url: http://127.0.0.1:7890      # 或 proxy: http://127.0.0.1:7890
          no_proxy: [".corp.internal"]
          ca_path: /etc/ssl/certs/corp-root-ca.pem   # TLS 中间人代理
          # mode: cli-plugin              # 固定 loopback 代理 + CA（默认 env）
          # enabled: false                # 强制直连
```

- 不配 `proxy:` 时行为与改造前完全一致（继承 `HTTP(S)_PROXY`，没有就直连）。
- `enabled: false` → 子进程拿到 `LARK_CLI_NO_PROXY=1`，强制直连。
- loopback（gateway / token service）永远不走代理；启动日志会打一行 `network proxy: …`（凭据脱敏）。

完整说明、验证方法与常见问题见 [`docs/06-network-proxy.md`](docs/06-network-proxy.md)。

## 授权模型（一次授权、最小权限）

授权分两层，**只有第一层需要管理员**：

| 层 | 谁来做 | 频率 | 说明 |
|---|---|---|---|
| 应用级 scope | 应用管理员（开放平台 → 权限管理） | 一次性 | 应用没开通的 scope，用户点任何卡片都授不出来 |
| 用户级授权 | 用户本人点卡片 | 一次性 | Device Flow，卡片由插件在缺权限时自动发出 |

关键设计：**按技能声明申请，而不是按命令申请**。

技能在 frontmatter 里声明自己会碰的域：

```yaml
metadata:
  requires:
    bins: ["lark-cli"]
    domains: ["im", "calendar", "task", "approval"]
```

某个命令缺权限时，插件取「声明了该域的技能」的**完整域集**，一次性发起 device flow。
所以用户只会看到一张卡片、点一次，不会出现"授权完 `im` 又缺 `calendar`、再授权一次"的来回；
同时申请范围仍限于**已安装技能声明的域**，不会要一份飞书的全部权限。

没声明 `domains` 的技能退化为「按当前命令的域」申请；也可用 `auth_domains` 在账号级钉死。

### 通用授权门（不依赖具体工具）

缺权限时的「弹卡片 → 用户点授权 → 回到**当前会话**继续任务」不再由每个工具各自实现，而是收敛成 `src/auth-gate.mjs` 两层：

| 层 | 入口 | 谁在用 |
|---|---|---|
| 预检（精确） | `ensureUserAuthorized({ account, argv, toolCtx })` | `lark_cli`、`feishu_*`——知道具体子命令，能算准要申请的 scope |
| 兜底（通用） | `after_tool_call` 钩子 `feishu-auth-gate` | **任何**工具：本插件的、内置的、其它插件的（http 注入器也走这条） |

发卡片的实现只有一份。别的 hook（如 `http-token-injector`）遇到授权错误时**不自己发卡**，只 `block` 调用并回一个 `FEISHU_AUTH_REQUIRED subtype=… code=… missing_scopes=a,b` 标记，由这个通用门接管。

兜底层做三件事，都必须在 120ms 的钩子预算内完成（Orange `HOOK_SYNC_TIMEOUT_MS`）：

1. 只认**结构化**的飞书错误签名：JSON 错误信封里的 `"code": 9999167x` / `"subtype"` / `"missing_scopes": [...]`，或注入器打的 `FEISHU_AUTH_REQUIRED` 标记。`99991677/99991663/99991668` → token 失效；`99991679/99991672` / `missing_scopes` → 缺 scope；`99991664` → 应用级权限（不发卡片，提示管理员开通）。
   `Skill` / `read_file` 返回的是 SKILL.md、reference 文档，里面写满了 `missing_scopes`、`99991679`、`permission denied` 这类排错说明——**那是文档不是错误**。这类工具直接跳过，长文本 / markdown 表格也一律不算；否则技能每加载一次就弹一张授权卡，授权完 resume 又要求「重新加载该技能」，形成死循环。
2. 用渠道记录的会话反查（session key → sender → 最近私聊）把卡片发到**当前会话**；同时抑制本轮的模型输出，避免「半份结果 + 待授权」被当成最终答案。
3. `fire-and-forget` 起 device flow 轮询；完成后把工具结果改写成 `AUTH_REQUIRED`，并用合成消息在**同一 session** 续跑（带用户原话）。

**不会重复要权限**（对齐旧插件 `oauth.ts` 的「用户已授权，scope 已覆盖」）：发 flow 前先拿 `--verify` 过的 token 比对，若已覆盖全部申请 scope 就不开新 flow；钩子侧还存一份同步快照，授权成功后 10 分钟内同类「无明确缺口」的报错改写成 `NOT_AUTHORIZATION_ERROR`，不再发卡、不再 resume。这样飞书同意页不会一直停在「请重新授权 / 此前已授予的权限」。

**卡片生命周期 10 分钟**：到期时把**同一张 CardKit 卡片**原地翻成「⏱ 授权链接已过期」，撤掉「去授权」按钮、清掉 pending flow、停止轮询；不再补发一条重复的文本提醒。用户想继续时发一句话即可重新发起。

**一次授权完，但只授「这个技能要用的」**（默认 `auth_scope_mode: skill`）：飞书 OAuth 是增量的，只申请「本次缺口」就会每跑一条新命令冒出一个新权限（09:02 补 10 个、09:31 补 `wiki:node:read`、09:36 补 `im:chat:read`）。现在的范围是 **技能声明的 `domains` ∪ 本次失败命令的 domain**，取 `lark-cli auth scopes --json` 里这些域的权限子集一次申请——日程技能不会把邮箱、通讯录、多维表格一起要过来，但同一批域内的权限一次给全。卡片只显示域和总数，不逐条贴。

域 → scope 前缀的映射见 `DOMAIN_SCOPE_PREFIXES`；`SENSITIVE_SCOPES`（代发消息、删除类）默认跳过，除非本次错误明确点名。授权完成后写 `.auth-grant-<accountId>.json` 记号（模式 + 域集合 + 条数），同样的组合点过一次就不再发卡；技能扩了新域、应用新开了权限才重发。

  - `auth_scope_mode: all` → 应用已开通的全部用户级权限，等价旧插件的 `/feishu_auth` 批量授权（`commands/auth.ts` → `triggerOnboarding`）。
  - `auth_scope_mode: declared` → 只申请 SKILL.md 声明的 scope（最小集）。
  - `auth_scopes: [...]` → 显式钉死清单，优先级最高。
  - 各模式都会累积本进程见过的缺口；`startDeviceFlow` 复用判断按 **scope 集合**而非 domain。

**合成入站 id 不能当 reply target**：授权后续跑注入的消息 id 是 `auth-…:auth-complete`，不是真实 `om_` 消息。`outbound` 会把非 `om_` 的 reply target 降级为普通发送，否则飞书报 `invalid message ID`，最终答复整条发不出去。

因为挂在钩子上，**新加工具不需要再接线**：失败时把飞书原始错误透出来即可。

## 工具：feishu_ask_user_question

从 `openclaw-lark` 移植的交互式确认卡片，供 `oa-workflow` 等技能在写操作前收集确认。

| | |
|---|---|
| 参数 | `questions: [{ question, header, options, multiSelect, required }]`，`options: []` 渲染输入框 |
| 返回 | 发卡后**立即** `{status:"pending"}`，本轮结束，不要轮询或重复调用 |
| 回答 | `card.action.trigger` → 解析 `form_value` → 注入 synthetic 消息 → 同一 session 新的一轮继续 |

- 插件**额外起一个** `event consume card.action.trigger --as bot`，与 `im.message.receive_v1` 共用同一个 bus daemon / WebSocket，不需要第二个长连接。
- lark-cli SDK 会在 3s 内自动 ACK 回调；卡片状态由 CardKit `PUT` 就地翻成「已提交 / 已收到回答 / 已过期」。
- 5 分钟未回答自动过期；`event_id` 去重；只有被提问的用户能提交；注入失败会回滚卡片让用户重试。
- 前置条件：开放平台已启用 `card.action.trigger` 回调，应用有 `im:message:readonly`。

## 工具：feishu_search_user / feishu_get_user

同样是 `openclaw-lark` 的通讯录工具，`oa-workflow` 用它把「经办人姓名」换成邮箱。

| 工具 | 底层命令 | 说明 |
|---|---|---|
| `feishu_search_user` | `contact +search-user --query/--user-ids --as user` | 姓名 / 邮箱 / 手机号 → open_id + 邮箱 + 部门 |
| `feishu_get_user` | 先 `+search-user --user-ids`，回落 `+get-user` | 不传 id 取自己；传 id 取他人（字段更全的路径优先） |

- 一律走 **user 身份**：本租户 app token 查他人会 `41050 no user authority`，且企业邮箱等字段只有 user 身份才全。
- 返回 `email` 做了兜底：`enterprise_email || email`，OA 技能直接拿去拼 `jbrdx1` 不会拿到空串。
- 缺 `contact:user:search` 等 scope 时走与 `lark_cli` **同一套授权闸门**，会弹卡而不是抛 `missing_scope`。

## 已知限制

- 每条入站消息一次 CLI 进程（约 30–80ms 开销），流式/高频场景需升级为常驻 bridge。
- 工具集：`lark_cli`、`feishu_ask_user_question`、`feishu_search_user`、`feishu_get_user`；`http_post`（OA 网关）尚未移植。
- 消费者重启会丢失事件窗口：CLI bus daemon 空闲 30s 退出，hub 无订阅者时事件被丢弃；
  需要结合 CLI 的 per-consumer `Seq` 做 gap 检测与补偿（P1）。
