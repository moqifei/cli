---
name: lark-daily-brief
version: 1.12.0
description: "飞书每日简报 / 主动提醒基准技能：聚合今天@我且等我回的消息（区分已读未回与未读）、逾期与临期待办、待你回复的会议邀请、今晚与明天的日程（含冲突与连轴预警）、昨天开过的会留下了哪些纪要/回放，以及我自己文档上别人新留的未解决评论；每条标注优先级并给出建议动作，按优先级压成一条消息推给用户。既可在会话里手动触发（“生成今天的飞书简报”），也可被定时任务在无人值守下按 mode=digest（每天一次汇总，每天必发）或 mode=alert（临近事件巡检）调度。"
metadata:
  requires:
    bins: []
    # 声明本技能会碰的权限域，而不是把飞书全部能力都要一遍。
    # 运行时会用这份清单**一次性**申请授权：用户点一次卡片即可，
    # 不会出现"授权完 im 又缺 calendar、再授权一次"的来回。
    domains: ["im", "calendar", "task", "vc", "drive"]
    # 精确到 scope：`--domain im` 会把「获取与上传图片或文件资源」一起带上，
    # 那是发图片/文件用的权限，日报根本不需要。按 scope 申请可以少要这一项。
    #
    # 这里只写**用户级**（设备码授权可授予）的 scope。`approval:task:read` 是
    # 应用级权限：用户授权页会标成「无法授予」并打红叉，整张卡看起来像失败了，
    # 而审批这一路照样读不到。所以它不写在这里，Step 2 的 C 段也随之停用，
    # 等管理员在开放平台开通后再一起恢复。
    #
    # `vc` / `drive` 是后加的能力：老用户手上没有这些 scope，E/F 段会先做预检、
    # 缺权限就整段跳过（见「降级分支」），保证简报每天照发。
    #
    # `im:message.reactions:read` 必须声明：A 段的 `im +messages-search` 在预检里
    # 无条件校验它（默认给每条消息附 reactions，连 `--no-reactions` 也绕不过预检）。
    # 漏掉这一项，用户点完授权卡后取数仍会一直报 missing_scope。
    scopes: ["im:message:readonly", "im:message.reactions:read", "search:message", "calendar:calendar.event:read", "task:task:read", "vc:meeting.search:read", "vc:record:readonly", "vc:meeting.meetingevent:read", "search:docs:read", "docs:document.comment:read"]
  cliHelp: "lark-cli im --help"
---

<!-- orange-lark-cli-adapter -->
> **Orange 运行时（务必先读）**：本技能中出现的 `lark-cli <子命令> ...`，请改用工具 `lark_cli` 执行：
> 把 `<子命令>` 及其参数按顺序放入 `argv` 数组，**不要**包含 `lark-cli` 前缀。
> 例：`lark-cli docs +create --title 测试文档` → `lark_cli({"argv":["docs","+create","--title","测试文档"]})`。
> 该工具已内置应用凭证（默认机器人身份）；`docs +create` 会自动使用**用户身份**，把文档建到用户自己的云空间。
> 若返回 `awaiting_authorization: true`（系统**已自动**向用户发出授权卡片，且已一次性申请了本技能声明的全部权限域），
> **本轮到此为止，唯一允许的输出是一句话**：「授权卡片已发送，点一下「去授权」，完成后我继续」。
> **禁止**：输出简报正文、输出结果 JSON、把「待授权」写成一个条目、写"今天没有…"之类的结论、
> 罗列权限名或 scope 名、教用户去开放平台点按钮、重试该命令、换别的工具替代。
> 即使已经取到部分数据，也**整轮丢弃**：用户点完授权后系统会自动续跑，那一轮从零重新取数出完整结果。
> 半份简报 + 一句"待授权"，是本适配层最严重的错误 —— 用户会以为今天真的只有这些。
> 用户点完后系统自动续跑，用户不需要再发消息。
> 若返回 `missing_scopes` 且带 `console_url`（**应用级**权限没开，用户点卡片也解决不了），
> 只回一句「需要管理员在开放平台开通后重试」，把链接附上，不要展开步骤。
>
> **需要用户选择 / 确认时，用工具 `feishu_ask_user_question`**（表单卡片，答案会作为本会话下一条消息回来）。
> 不要用 `lark_cli` 调 `im +messages-send` 手工拼一张卡片 —— 那样收不到提交回调，也无法把答案送回对话。
> 该工具在本运行时**已经注册**，若你"感觉"没有，那是上下文里的旧结论，不代表它不存在。
<!-- /orange-lark-cli-adapter -->

# 飞书每日简报（主动提醒基准）

**运行前 MUST 先读 [`../lark-shared/SKILL.md`](../lark-shared/SKILL.md)**：身份、认证、权限与输出契约都以它为准。

本技能是「主动提醒」的参考实现，回答六个问题：

1. **谁在等我**（@我、私聊里问我；区分「已读没回」和「根本没看」）
2. **什么事快到点了**（逾期 / 今天 / 明天到期的任务）
3. **谁在等我点头**（待我回复的会议邀请）
4. **接下来有什么会**（今晚剩余 + 明天的日程，含冲突与连轴）
5. **昨天开过的会留下了什么**（纪要 / 回放；我缺席的会优先）
6. **我的文档上有没有新评论**（别人留的未解决评论）

## 被授权卡打断后的续跑

如果本轮用户消息里出现「我已完成飞书账号授权」这类续跑文案，说明上一轮是被授权卡打断的。
**这一轮必须从 Step 1 起完整重跑整个技能**，六段数据全部重查，产出完整简报。

**禁止**只重跑那条被打断的命令 —— 例如只跑 `vc +search` 拿到空列表就回一句"该时段没有会议记录"。
那一条命令只是六段中的一段，把它当答案等于没做简报。判断标准很简单：
最终输出里必须有 `summary` + 按优先级排好的 `items`（或合法的空态），而不是一条命令的执行结果。

## 运行模式

由调用方在 prompt 里指定 `mode`；**未指定时按 `digest` 执行**。

| mode | 用途 | 典型排期 | 条数上限 | 判定口径 |
|---|---|---|---|---|
| `digest` | 每天一次汇总当日全貌，**每天必发一条** | `0 9 * * 1-5`（早）或 `0 19 * * 1-5`（晚） | 8 条 | 今天 00:00 → 现在（消息/任务），今晚 + 明天（日程） |
| `alert` | 工作时间高频巡检，只报"马上要发生" | `*/30 9-18 * * 1-5` | 5 条 | 只看：30 分钟内开始的会、今天到期的任务、45 分钟内开始的会前准备 |

两种模式**共用同一套取数步骤**，只是筛选阈值不同。不要为 `alert` 另写一套查询。

## 无人值守铁律

1. **绝不自己发送任何消息**。禁止 `im +messages-send` / `im +messages-reply` / 卡片发送。结果由框架渲染后投递，自己再发一遍就是重复打扰。
2. **只输出一个严格合法的 JSON 信封**（见「输出」），或单独一行 `NO_UPDATES`。不要前后缀、不要解释、不要用 Markdown 代码块围栏（三个反引号）、不要尾随逗号（数组或对象最后一项后不能留逗号）。
3. **不许编**：读不到就说读不到；时间、人名、条数全部来自命令返回，不猜。
4. **时间不许心算**：无人值守（cron）轮次由框架在消息末尾注入 `[本轮时间基准 · 框架注入]`，里面已给好时区偏移和四个时间值，直接取用，**不要调用 `shell` / `date`**（见 Step 0）。只有消息里没有这个块（会话内手动触发）时才用命令兜底；容器时区常为 UTC，兜底时必须显式 `TZ=Asia/Shanghai`，否则会整体偏 8 小时。
5. **输出顺序必须稳定**：按「优先级 → 时间升序 → ref 字典序」排。顺序抖动会让同一批内容被判成新内容而重复推送。
6. **正文里不要写相对时间**（"3 小时前""又多了 1 条"）：这类文字每次运行都变，会破坏指纹去重。用绝对时间（`今天 15:30`、`明天 10:00`）。
7. **先取数，再判空**。`NO_UPDATES` 只能由**真实命令返回**证明：可用的那几路必须真的跑过，且结果是空的（`total: 0` / `items: []` / `data: []`）。
   一次取数命令都没跑就写 `NO_UPDATES`，等于谎报「今天没事」——用户看到的是"授权了却什么都不来"。
   同理，"未授权"只能由命令返回的 `awaiting_authorization` / `missing_scope` 证明，**不能**凭记忆或印象判断。

## Step 0：确定时间窗（先做）

**首选：用框架注入的时间基准。** 无人值守轮次的消息末尾会有 `[本轮时间基准 · 框架注入]` 块，
含 `YESTERDAY_START` / `TODAY_START` / `NOW` / `TOMORROW_END` 和时区偏移，直接替换下文同名占位符。
**禁止再调 `shell` / `date`**：`shell` 在 `sandbox.mode=all` 下必须连 Docker 建容器，
Docker 没启动这条命令就失败，整份简报会连空态都产不出来。取时间不是取数，不该有这个故障点。

**仅当消息里没有注入块时**（会话内手动触发）才用命令兜底：

```bash
# 昨天 00:00 / 今天 00:00 / 现在 / 明天
TZ=Asia/Shanghai date -v-1d +"%Y-%m-%dT00:00:00+08:00"   # BSD date（macOS）
TZ=Asia/Shanghai date -d "yesterday" +"%Y-%m-%dT00:00:00+08:00"  # GNU date（Linux 容器）
TZ=Asia/Shanghai date +"%Y-%m-%dT00:00:00+08:00"
TZ=Asia/Shanghai date +"%Y-%m-%dT%H:%M:%S+08:00"
TZ=Asia/Shanghai date -v+1d +"%Y-%m-%d"   # BSD；Linux 用 date -d "+1 day"
```

兜底时时区以 `TZ=Asia/Shanghai date +%z` 的结果为准；不是 `+0800` 就换成用户实际时区，**不要**在没有依据时硬编码。

下文用 `<YESTERDAY_START>` = 昨天 00:00、`<TODAY_START>` = 今天 00:00、`<NOW>` = 现在、
`<TOMORROW_END>` = 明天 23:59:59 占位，执行时必须替换成真实值。

## Step 1：确认身份

```bash
lark-cli whoami
lark-cli auth status --json --verify
```

从 `identities.user` 取 `openId`（`ou_xxx`）和 `userName`；`identities.user.scope` 是**空格分隔的 scope 字符串**，
后面所有预检都读它。后续「@我」「发给我」全部用这个 `openId`，**不要**从历史消息里抄，也不要猜。

判定：

- `identities.user` 缺失、`verified=false` 或 `tokenStatus` 非正常 → 走「降级：未授权」。
- 只有 bot 身份可用 → 消息类数据源全部不可用（bot 看不到用户的群与私聊），按「降级：部分不可用」处理，只出日程/任务/审批。

## Step 1.5：权限对齐（必须在取数之前做完）

比对 `identities.user.scope` 与 frontmatter 声明的 scopes（见 `metadata.requires.scopes`），
**缺任何一个就在这一步把卡撞出来**，不要等取到一半再弹：

| 缺的是 | 立刻执行这一条 |
|---|---|
| `vc:*`（会议纪要 / 回放） | `lark-cli vc +search --start "<YESTERDAY_START>" --end "<NOW>" --as user --format json` |
| `search:docs:read` / `docs:document.comment:read`（文档评论） | `lark-cli drive +search --mine --page-size 3 --as user --format json` |

两个域都缺就先撞 `vc`，它返回后再撞 `drive`（同一张卡会复用同一次 device flow，不会弹两张）。

返回 `awaiting_authorization: true` → **本轮只允许输出一句话**：

> 授权卡片已发送，点一下「去授权」，完成后我继续。

**禁止**输出简报正文、JSON、条目列表、"今天没有…"的结论，也**禁止**把"待授权"写成一条 item。
即使你已经取到了部分数据，也整轮丢弃 —— 用户点完授权系统会自动续跑，那一轮重新取数并产出完整结果。

放在取数之前的原因：先取数再弹卡，模型手里已经有半份结果，就会忍不住把"待授权"当成条目塞进简报里
（这正是线上出现的"授权没完成却回了一份简报"）。

## Step 2：取数（六路并行，按顺序做）

六路互相独立：某一路失败**不要**中断整体流程，用其余数据照常出简报。

### A. 消息：谁在等我

```bash
# A1 今天 @我 的消息（最多 2 页 = 100 条）
lark-cli im +messages-search --query "" --is-at-me \
  --start "<TODAY_START>" --end "<NOW>" \
  --page-size 50 --page-limit 2 --format json --as user

# A2 今天别人发给我的私聊
lark-cli im +messages-search --query "" --chat-type p2p --sender-type user \
  --start "<TODAY_START>" --end "<NOW>" \
  --page-size 50 --page-limit 2 --format json --as user
```

- `--query` 留空，靠筛选项限定范围；**不要**把"看看""总结"这类指令词塞进 `--query`，会把真正相关的消息过滤掉。
- 每条结果都带 `source_label`（`<chat_name> · <sender.name>`，私聊是 `私聊 · <sender.name>`）：
  CLI 已把**同一条消息**的群名和发言人绑成一个字段。后面写 `title` 时整段复制它，
  **不要**自己拿 `chat_name` 和别的字段重新拼 —— 一页十几条结构相同的 JSON，
  手工拼最容易把邻行的群名安到这条消息上。
- `--start` / `--end` 一律写成带时区偏移的 ISO 8601（`2026-11-10T11:18:00+08:00`），
  或直接用框架注入的 `<TODAY_START>` / `<NOW>`（本来就是这个格式）。飞书会拒绝
  `2026-11-10 11:18` 这类展示格式并报 `99992402 field validation failed`。
  消息的 `create_time` 常是展示格式，拿它当 `--start` 时先改写：空格换成 `T`、
  补上 `:00+08:00`。**不要**为此调用 shell / date，也不要用原始字符串重试。
- A1 结果里 `mentions[].id` 含我的 `openId` 才算出结果；`@所有人` 也算 @我。
- **搜索结果里会混进我自己发的消息**（`--sender-type user` 不排除我）：`sender.id` 等于我的 `openId` 一律丢弃。
  不过滤会把"我发的消息"报成"我欠人回复"，这是最容易犯的误报。
- 兜底（搜索不可用，或 A1+A2 合计 < 5 条）：改用按会话读，最多 5 个活跃会话：

```bash
lark-cli im +chat-list --sort active_time --exclude-muted --page-size 20 --as user
lark-cli im +chat-messages-list --chat-id <oc_xxx> --start "<TODAY_START>" --end "<NOW>" --page-size 50 --as user
```

只读会话列表里排前面的 5 个，**不要**遍历所有群。

### A3. 我到底回了没有（已读 / 未读 / 已回）

「有人 @我」不等于「我还欠着回复」：可能我早就回过了。这一步把候选消息分成三档，
**已读未回**是最该先处理的一类 —— 对方看到你读了却没动静，比没读更糟。

**范围先收窄，别对全部消息做**：只取 Step 3 初筛后"像要回复"的（@我、私聊问句、
带"能不能/什么时候/确认一下"、有明确 deadline），最多 10 条消息、最多 5 个会话。
否则一通全量查询既慢，也会把一堆"我知道了"式的群发算成欠回复。

**1）批量查我读没读**（一次最多 50 个 `message_id`）：

```bash
lark-cli im +messages-read-status --as user --message-ids om_xxx,om_yyy --format json
```

- `data.items[].is_read = true` → 我读过；`false` → 没读。
- 不在 `items` 里、或落在 `invalid_message_ids` → 状态**未知**，按「未读」处理，但文案里不要断言"你没看"。

**2）判断我回没回**（只对等待最久的**最多 5 个**会话做，不要全量扫）：

```bash
lark-cli im +messages-search --query "" --chat-id "<这条消息自己的 chat_id>" \
  --sender "<我在 Step 1 拿到的 openId>" --start "<该消息的 create_time，改写成 RFC3339>" --end "<NOW>" \
  --page-size 5 --format json --as user
```

- `--chat-id` 必须逐字取**这条消息自己的** `chat_id`（和它的 `source_label` 同一个
  `message_id`）。不要按群名、按印象、或按同批结果里另一条消息另选一个群：
  查错群不仅会让标题写错群，还会把「已读未回」判成另一回事。
- `data.total > 0`（或 `messages` 非空）→ 这条消息之后我在该会话发过言，视为**已回**，丢弃。
- 请求失败、或候选会话超过 5 个 → 记为**未确认**，**不要丢弃**；此时即使 `is_read=true` 也**不能**
  断言"已读未回"，归入「未读待回」，文案写"已读，未确认是否已回"。

**3）三档结论**（写进 Step 3）：

| 档位 | 判定 | 含义 |
|---|---|---|
| 已读未回 | `is_read=true` **且**会话内确认我没有再发言 | 欠对方一个答复，**最高优先级** |
| 未读 | `is_read=false`，或已读但会话没查（未确认） | 还没看到 / 不确定回没回 |
| 已回 | 会话内已有我的消息 | 丢弃，不要出现在简报里 |

`read-status` / 会话检索是**锦上添花**：任一调用失败就退回"未读待回"，绝不能因为没有这两步
就整轮作废或输出半份简报。

### B. 任务：什么快到点了

```bash
lark-cli task +get-my-tasks --complete=false --due-end "<TOMORROW_END>" --as user
```

- 必须带 `--complete=false`，否则已完成任务会被当成待办。
- 分三档：**逾期**（`due` < 现在）、**今天到期**、**明天到期**。没有 `due` 的任务不进简报。

### C. 审批：什么卡在我这儿（**当前部署暂不启用**）

> `approval:task:read` 是**应用级**权限：请求它会让人工授权页多出一行「无法授予的权限」红叉，
> 而且用户点了也授不出来，这一步永远 `missing_scope`。
> **本段先不要执行**。管理员在开放平台开通后，删掉这段提示、恢复下面的命令即可。

```bash
# lark-cli approval tasks query --params '{"topic":"1"}' --as user
```

`topic=1` 是待办。拿 `instance_code` + `task_id` 作为条目的 `ref`；只要数量与最早一条，不要逐条展开。

### D. 日程：接下来有什么会

```bash
lark-cli calendar +agenda --start "<TODAY_START>" --end "<TOMORROW_END>" --as user
```

返回 `data[]`，**只认这几个字段**，没有的就不写（不要用"会议室 A""8 人"这类模板话术凑字）：

| 字段 | 用途 |
|---|---|
| `summary` | 标题；为空写"未命名日程" |
| `start_time.datetime` / `end_time.datetime` | 起止时间；**只有 `date` 没有 `datetime` = 全天事件**，不参与冲突计算 |
| `self_rsvp_status` | `needs_action` = 邀请还没回；`decline` = 已拒，直接丢 |
| `vchat.meeting_url` | 非空 = 线上会 |
| `free_busy_status` | `free` 的日程不占时间，不算冲突 |
| `event_organizer.display_name` | 谁组织的，用于"李四组织的评审" |

**先分档，再排**：

1. **待你回复的邀请**（`self_rsvp_status == "needs_action"`）：优先级仅次于"已读未回"。
   组织者在等你点头，拖到会前就来不及了，不管会议在哪天都要报。
2. **时间冲突**：按开始时间排序后，`下一条.start < 上一条.end` 即为冲突
   （全天事件、`free`、`decline` 不参与）。冲突单独成一条，比并列两个会更重要。
3. **连轴转**：同一段连续会议里 ≥3 个会、且相邻间隔都 < 15 分钟 → 单独一条预警，
   `ref` 用第一个会的 `event_id`。
4. **会前准备**（`alert` 主力）：30 分钟内开始的会照报；45 分钟内开始且
   `vchat.meeting_url` 非空的，补一句"线上会，建议提前 5 分钟进"。

`digest`：保留「现在之后今天剩余的会」+「明天全部」；但**冲突与待回复邀请不受此限**
（今天已经过去的冲突也要说清楚，否则用户事后才知道撞了）。
`alert`：只保留 30 分钟内开始的会，以及第 1 档里**今天就要开**的待回复邀请。

会议室与参会人数：`+agenda` **不返回**这些字段，确实需要时才补查
[`../lark-calendar/references/lark-calendar-list-attendees.md`](../lark-calendar/references/lark-calendar-list-attendees.md)，
**最多补 3 场**；补不到就不写。

### E. 会议产物：昨天开过的会留下了什么（只 `digest` 跑，且**先查权限**）

`alert` 模式**跳过这一路**：工作时间塞历史回顾只会分散注意力。

**0）先看当前用户有没有 vc 权限，没有就整段跳过**：

```bash
lark-cli auth status --json
```

看 `identities.user.scope`：不含 `vc:meeting.search:read` 或 `vc:record:readonly` → **直接撞卡**：
照常执行下面 §2 的 `vc +search`，让插件把授权卡发到当前会话（见「缺权限：直接弹卡」）。
**不要**跳过，更**不要**写成"昨天的会没有纪要"。

**1）有日程的会**：从 D 段里取 `end_time < <NOW>`（已经结束）的 `event_id`，最多 3 个，一次批量查：

```bash
lark-cli vc +recording --calendar-event-ids <evt_1>,<evt_2> --as user --format json
```

返回里有 `minute_token` / 录制信息 → 这场会**有回放或妙记**。

**2）我缺席的会**：只看昨天，用会议记录补一刀：

```bash
lark-cli vc +search --start "<YESTERDAY_START>" --end "<TODAY_START>" --as user --format json
```

- 只挑我 `decline` 过、或日程里有但 `self_rsvp_status != "accept"` 的会；
- 对这几个 `meeting_id` 批量查产物（`note_id` / `minute_token`）：

```bash
lark-cli vc +detail --meeting-ids <mid_1>,<mid_2> --as user --format json
```

**3）能说什么、不能说什么**：

- 只能说"**有**纪要/回放，可以补看"；**不要**引用纪要内容 —— 妙记正文要 `minutes` 权限，
  本部署的应用没开通，用户点了也授不出来。编一段不存在的纪要结论，比不说更糟。
- 一场会一个条目，`ref` 用 `event_id`（有日程的）或 `meeting_id`（缺席补查的）。
- 没有任何产物就**别写**："昨天的会没有纪要"是噪音；只有"我缺席 + 有纪要"才值得占一个位置。

### F. 文档协同：我的文档上有没有新评论（只 `digest` 跑，且**先查权限**）

`alert` 跳过：评论不是"马上要发生"的事。

**0）权限预检**：

`identities.user.scope` 不含 `search:docs:read` 或 `docs:document.comment:read` → **直接撞卡**：
照常执行下面 §1 的 `drive +search`，让插件把授权卡发到当前会话（见「缺权限：直接弹卡」）。
**不要**跳过，**禁止**写成"今天没有新评论" —— 没查过就说没有，是整份简报里最容易骗到用户的一句话。

**1）找有动静的文档**：只看我自己 owner、最近 3 天动过的：

```bash
lark-cli drive +search --query "" --mine --edited-since 3d --page-size 10 --as user --format json
```

- **能挂评论的类型都要查，表格（Excel / 在线表格）不例外**：
  `doc`、`docx`、`sheet`、`bitable` / `base`、`slides`、`file`、`wiki`、`apps`。
  `drive +list-comments --url` 对这几种都原生支持（见
  [`lark-drive-list-comments.md`](../lark-drive/references/lark-drive-list-comments.md)），
  传原始 URL 即可，shortcut 会自己识别类型，不要把 sheet URL 拆成 token 再拼。
  返回里的 `doc_type` 大小写不敏感，统一转小写再比对。
  **禁止**再写"表格不是可评论的 docx，跳过" —— 那是把 skill 的旧假设当成事实。
- 只排除不能挂评论的 `folder` / `shortcut` / `catalog` / `mindnote`；
- 按 `edited_time` 倒序，**最多 3 篇**；
- 一篇都没搜到 → 整段跳过，别报"今天没有新评论"。

**2）查未解决评论**（每篇一次，串行）：

```bash
lark-cli drive +list-comments --url "<文档 URL>" --solved-status false --page-size 20 --as user --format json
```

- 只算 `user_id != 我的 openId` 的评论（自己留的不算）；
- `create_time` 在最近 36 小时内才算"新"；全部被过滤掉 → 这篇不报。

**3）输出**：一篇文档一条，整个 F 段最多 2 条。评论正文只取**第一句**，超过 30 字截断加"…"。

## Step 3：筛选（宁少勿滥）

只保留下面这些类别，其余全部丢弃：

| 类别 | 判定 | 文案要点 |
|---|---|---|
| 已读未回 | A3 判为「已读未回」：对方看得到你读过，你却还没回 | `source_label` 逐字、问的什么、**几点问的**（绝对时间） |
| 卡住的事 | 逾期任务、今天到期的任务、待我处理的审批 | 什么事、等了多久、截止时间 |
| 待你回复的邀请 | 日程 `self_rsvp_status == "needs_action"` | 谁邀请、什么会、什么时候、要你接受还是拒绝 |
| 未读待回 | A3 判为「未读」或未确认，且是 @我 / 私聊问句 | `source_label` 逐字、要你做什么、几点发的 |
| 文档评论 | 我的文档上有别人留的未解决评论（近 36 小时） | 哪篇文档、谁、什么时候、说了什么（只取第一句） |
| 快到点 | `alert` 模式下 30 分钟内开始的会；今天到期任务 | 几点、什么事、要几分钟准备 |
| 冲突/连轴 | 日程重叠、≥3 个会连着且间隔 <15 分钟 | 撞的是哪两个、要不要改期 |
| 会议产物 | 昨天/今天已结束的会有 `note_id`/`minute_token`；或我缺席的会有纪要 | 哪场会、什么时候、有纪要还是回放 |
| 接下来 | 明天日程、需要提前准备材料的会 | 时间、标题、线上/线下 |
| 变更 | 群里已定的结论被改动（"截止改到""最终定""上线时间调整为"） | 从什么改成什么 |

**按会话聚合，别让一个人刷屏**：同一个人在同一会话里的多条未回消息，合并成**一条**
（`title` 用最要紧的那句，`detail` 写"共 N 条，最后一条 14:05"，`ref` 用最新一条的 `message_id`）。
合并后的 `source_label` 仍取这几条**共同**的 `chat_name`，不要拿别的会话的群名来"顺口一写"。

**必须丢弃**：闲聊、表情、接龙、广告、红包、我自己发的、机器人/系统通知、撤回消息（`deleted=true`）、
同一件事的重复消息、纯通告无我无关的群发、`decline` 过的会议、已解决的旧评论。

**排序**：已读未回 > 逾期/审批 > 待你回复的邀请 > 未读待回 > 文档评论 > 今天到期的任务 > 时间冲突 >
连轴转 > 30 分钟内开始的会 > 缺席会议的纪要 > 明天的会。同级按时间升序。

`digest` 里**至少给「已读未回」留 1 条**：它是这一批里最可能被人记恨的事，哪怕已经超出条数上限，
也要挤掉最末位的一条（"明天的会"先让位）。

## Step 4：输出

**仍然输出下面的 JSON 信封**：它是给调度器判重 / 水位用的机器契约，不要擅自改成人话，
否则定时任务会失去去重能力。用户看不到花括号 —— 会话里手动跑时插件会在投递前渲染成
`summary` + `❗/•/· 标题 — 细节 ⟶ 动作`，定时投递由网关侧渲染，两条路径都是人话。
**禁止**把 `status` / `ref` / `priority` 这些字段名、或整段 JSON 直接写进给用户的回复。

`digest` 示例：

```json
{
  "status": "delta",
  "summary": "今天 5 件事要关注：1 个已读未回、1 个等你批、1 个待回复邀请",
  "items": [
    {"title": "技术中台域&AI创新实验室 · 贺世博 @你，已读没回", "detail": "今天 10:12 问周报能不能 18:00 前给", "ref": "om_xxx", "priority": "now", "action": "现在回"},
    {"title": "报销单审批还卡在你这儿", "detail": "张三的差旅报销单，明天前要批", "ref": "ic_xxx:tk_xxx", "priority": "today", "action": "今天批"},
    {"title": "李四邀请你参加明天的评审", "detail": "明天 14:00 产品评审，李四在等答复", "ref": "evt_zzz", "priority": "today", "action": "回个话"},
    {"title": "李四私聊问你排期", "detail": "今天 09:30 发来，还没读", "ref": "om_yyy", "priority": "today", "action": "读一下"},
    {"title": "你缺席的「架构评审」有纪要了", "detail": "昨天 15:00 的会，可补看结论", "ref": "mid_xxx", "priority": "know", "action": "有空看"}
  ]
}
```

`alert` 示例：

```json
{
  "status": "delta",
  "summary": "15:00 有个会，10 分钟后开始",
  "items": [
    {"title": "15:00 产品评审", "detail": "会议室 B，8 人，材料在群里置顶", "ref": "evt_xxx", "priority": "now", "action": "进会"}
  ]
}
```

规则：

- `summary` ≤ 40 字，一句话说清「几件事 + 偏哪类」，必须与 `items` 对得上。
- `title` ≤ 30 字；`detail` ≤ 80 字，含「谁 + 什么事 + 什么时候」。消息类条目若
  `source_label` 本身就长，`title` 可放宽到 45 字，**不许为了凑字数截短群名**。
- **群名只能逐字复制该条的 `source_label`**：消息类条目（已读未回 / 未读待回）的
  `title` 必须以它开头。**禁止**简写（「屯数看数能力移植到汤圆」写成「汤圆项目群」）、
  改写、按消息内容猜群名，或从同批结果里**另一条消息**借群名。真实事故：11:57 钟瑾在
  「屯数看数能力移植到汤圆」@我，日报却写成「天策研发群钟瑾@你」—— 那个群名属于
  同批结果里 15:09 卿红斌的另一条消息。
- 一条 item 里的群名、发言人、时间、内容必须来自**同一个 `message_id`**。输出前逐条
  对照搜索结果核对一次：从 `ref` 找到那条消息，确认 `title` 开头的群名等于它的
  `chat_name`（或 `source_label` 的群名部分）。A3 回查的 `--chat-id` 同理。
- **每条都带 `priority` 和 `action`**，让人一眼看出"先干什么、要我做什么"：
  - `priority`：`now`（现在就处理）／`today`（今天内）／`know`（知道就行）。渲染成 `❗`／`•`／`·`。
  - `action`：≤ 12 字、动词开头的动作短语 —— "现在回""今天批""回个话""进会""补看结论"。
    **不要**写"请注意""建议关注"这种没有动作的废话。
  - 标记只影响**显示**，**顺序仍按 Step 3 的排序输出**，不要自己按 priority 重排：
    重排会让用户看到的"1/2/3"和实际条目错位，回「1」就处理错事。
- `priority` 判定口径：
  - `now`：已读未回、30 分钟内开始且撞车的会、正在等你签字的审批；
  - `today`：今天到期的任务、待你回复的邀请、未读且已经等了 4 小时以上的消息；
  - `know`：明天的会、缺席会议的纪要、不着急的文档评论。
- `ref` 必须能唯一定位到原始对象，且**跨天稳定**：消息用 `message_id`（`om_xxx`），任务用任务 `guid`，
  审批用 `instance_code:task_id`，日程用 `event_id`，会议用 `meeting_id`。框架靠它去重、也靠它支持用户「回 1」处理。
- 条数超过上限时，按排序截断，并把被截断的量写进 `summary`（"另有 3 条…"）——不要静默吞掉。
- 「已读未回」的 `detail` 必须写清**问的时间点**（绝对时间，如"今天 10:12"），不要写"4 小时前"；
  也不要说"对方很生气"这类脑补，只陈述"对方看到你读过、你还没回"。
- **`alert` 完全没事 → 只输出 `NO_UPDATES`**，不要输出空 `items`：半小时一次的巡检发空态消息就是噪音。
- **`digest` 永远给一条，哪怕没事**。用户把它设成每天早上（或每晚）的固定动作，连续几天不响会让人
  以为系统挂了 —— 真实案例：任务 `success`、`delivery_status: not-requested`，用户什么都没收到。
  没事时（注意 `status` 不能是 `empty`、`has_delta` 不能是 `false`，否则会被平台静默）：

  ```json
  {
    "status": "summary",
    "summary": "11 月 5 日：今天没有必须处理的事，也没有安排会议",
    "items": [
      {"title": "今天没有待回复消息，也没有到期任务", "detail": "最近一个日程：明天 09:30 创新应用周会", "ref": "digest:lark-daily-brief:2026-11-05", "priority": "know", "action": "不用管"}
    ]
  }
  ```

  两点必须做到：
  1. **带上当天日期**（如"11 月 5 日"）—— 空态文案如果每天都一字不差，会被水位去重当成"没有变化"再次静默；
  2. 有日程就写**最近一个**日程；一个都没有就明说"今天没有安排会议"，不要省掉这条。

### 多来源 tab 版式（**仅当巡检 prompt 明确要求聚合其它技能时**启用）

一次巡检通过 `includes` 引用了别的系统（OA / EHR / XOne …）时，所有来源的条目
进**同一份信封、同一条消息**，按来源分成多个 tab。下面这些字段全部是可选的，
只加不删 —— `status` / `summary` / `ref` / `priority` / `action` / 排序规则一条不改。

| 位置 | 字段 | 作用 |
|---|---|---|
| 顶层 | `sections` | tab 顺序。数组项写 `{"name":"…","label":"…","hint":"…","headers":[…]}`；也可只写字符串数组 |
| item | `section` | 归属哪个 tab，值必须等于某个 `sections[].name` |
| item | `group` | tab 内的小标题，同名合并。飞书用「群聊 · 已读未回」「日程 · 例会」这类类别，OA 用流程类型 |
| item | `cells` | 表格一行，按列顺序的字符串/数字数组；**组内所有条目都给了才画表格** |
| item | `headers` | 组内表头，只在组内第一条写；没写就用该 tab 的 `headers` |
| item | `note` | 表格「备注」列的补充信息（接收时间等可读内容）；**不要写 `requestId` / `formId` / 「第 N 条」/ 来源缩写**，`action` 照旧写，框架会并进同一列 |

规则：

- **`sections` 里声明的每个 tab，`items` 里都必须有对应 `section` 的条目**：
  `summary` 写了「6 条 EHR 待审批」，就必须在 `items` 里逐条写出这 6 条，
  不能只报一个数字却不给明细 —— 没有条目的 tab 会被整块丢掉，用户只看到头部那句数字。
  收尾前按 `sections[].name` 从头到尾点一遍：每个名字都要能数出 item，
  数量与 `summary` 里的数字对得上才算写完。某个来源确实一条都没查到时，
  也要写一条「今天没有待办」的占位 item 并把 `summary` 写成 0 条，不要留空 tab。
- 所有来源的 item **必须写在同一份 `items` 数组里**，按 tab 顺序连着写完再闭合 `]`；
  不要写完前一个来源就提前收尾。表格行给了 `cells` 也要写 `title` / `detail`，
  别只给 `cells`（表格退化成文字时要有兜底文本）。
- 主技能自己的条目也要标 `section`。只想分区、不想做表格的来源**不要给 `cells`**，
  仍按 `标记 标题 — 细节 ⟶ 动作` 渲染；给了一组就整组画表格。
- tab 名、`label`、`group`、列名与列数由配置里的 `includes[].context` 指定，
  **本文件与框架都不写死**；以后接一个新系统 = 多一个 `includes` 项 + 多一个 `sections` 项，不需要改代码。
- `hint` 只写静态描述，**不要写条数**（条数由框架自动补在 tab 标题上），也不要写相对时间。
  版式字段不参与去重指纹：只改版式、数据没变时会被水位静默，需要重看就清一次水位或 requeue。
- `ref` 仍写 `<来源技能>:<业务ID>`；`ref` 不展示给用户但必须保留。处理单据所需的
  `requestId / formId / 当前节点 / 申请人` 只写在 `ref` 与 `detail` 里，
  **不要写进 `note`**：那串 id 对用户没有意义。表格里的「编号」列由框架按行
  连续生成（1..N），用户回「审批第 N 条」时按编号找对应的 `ref`。
- **没有 `includes` 的普通巡检（含会话里手动触发）不要用这些字段**：
  输出仍是原来的信封，渲染层会逐字节保持旧格式。
- 定时推送到飞书时，框架会把这份信封渲染成 **Card 2.0 原生卡片**：顶部是
  「分类速览」，**每个来源独占一行**（彩色方块 + 来源简称 + 条数 + `hint`），
  下方分区标题用同色方块 + 完整 `label` + 条数；**每个来源合并成一张**
  原生 `table`（有单元格线），列固定为「类别 / 编号 / 流程名称 / 申请人 / 备注」；
  类别取 `group`，编号由框架按表格行连续生成，备注收 `note` 与 `action`。
  飞书单卡最多 5 张表格，按来源各一张不会触及上限，也不会有分组退化成文字。
  其它渠道、旧客户端或卡片发送失败时回退到纯文本版式。飞书消息卡片
  **没有原生 tab 组件，也不支持横向滑动**：早期把三来源三等分放进
  `column_set`，中文长标题在窄列里折行、各列高度参差，看起来像被折叠了，
  因此改用整行纵向导航。`table` 也只能放卡片根节点。速览 + 分区标题只是
  版式标识，不是可点击切换的标签页。

示例（只展示新增字段，其余字段照旧）。**每个 tab 只为演示列了 1 条**，
实际输出必须把每个来源查到的每一条都写进 `items`，包括第三个来源：

```json
{
  "status": "delta",
  "summary": "1 条已读未回 ＋ 4 条 OA 待审批 ＋ 6 条 EHR 待审批",
  "sections": [
    {"name": "飞书", "label": "飞书 · 消息与日程", "hint": "群聊与例会"},
    {"name": "OA 待办", "label": "OA · 待审批", "hint": "待你处理的流程", "headers": ["序号", "流程名称", "申请人"]},
    {"name": "EHR 待办", "label": "EHR · 待审批", "hint": "待你处理的人事流程", "headers": ["序号", "流程名称", "申请人"]}
  ],
  "items": [
    {"title": "技术中台域&AI创新实验室 · 贺世博 @你，已读未回", "detail": "贺世博今天 16:33 …", "ref": "om_xxx", "priority": "now", "action": "更新项目进展", "section": "飞书", "group": "群聊 · 已读未回"},
    {"title": "OA行收文：分行营业部印章使用申请（李四）", "detail": "formId 54，当前节点…，李四申请，已等 1 天", "ref": "oa-workflow:20261104002", "priority": "now", "action": "逐条审批", "section": "OA 待办", "group": "行收文", "cells": [2, "关于分行营业部印章使用的申请", "李四"], "note": "11-04 09:40 接收 · requestId 20261104002"},
    {"title": "EHR请假申请：张三", "detail": "张三的请假申请，待审批", "ref": "ehr-todo:20261104005", "priority": "today", "action": "逐条审批", "section": "EHR 待办", "group": "请假", "cells": [1, "请假申请", "张三"], "note": "requestId 20261104005"}
  ]
}
```

## 降级分支

### 未授权 / 需要用户点授权卡

**数据源分两档：**

| 档位 | 源 | 缺权限时 |
|---|---|---|
| 必选 | 消息、日程、任务 | 任一路 `awaiting_authorization` → **整轮作废**，见下 |
| 可选 | 审批、会议产物（`vc`）、文档协同（`drive`） | **当场撞卡**，见下；不列 scope 名与错误码 |

原因：审批是应用级权限（要管理员审核），用户点卡片授不出来；`vc` / `drive` 是后加的能力，
老用户手上可能还没有。

### 缺权限：直接弹卡，不要让用户回话

`vc` / `docs` 缺 scope 时**不要**输出"回「授权文档评论」开通"这种提示 ——
让用户读完简报再回来打字，是这一环最差的体验。正确做法是**当场把卡弹出来**：

| 缺的能力 | 立刻执行的这一条会触发授权卡 |
|---|---|
| 会议纪要 / 回放 | `lark-cli vc +search --start "<YESTERDAY_START>" --end "<NOW>" --as user --format json` |
| 文档评论 | `lark-cli drive +search --mine --page-size 3 --as user --format json` |

两个都缺就两个都撞（第二张卡会复用同一次 device flow，不会弹两张）。

返回 `awaiting_authorization: true` → 按适配层规则**结束本轮**，只回一句
「授权卡片已发送，点一下「去授权」，完成后我继续」。卡片一次性覆盖本技能声明的全部用户级 scope，
用户点完系统自动续跑，续跑那一轮就会带上会议纪要与文档评论。

**退化成提示条目的唯一情况**：插件没能发卡，返回里带 `verification_url` 或明确说卡片发送失败。
这时才追加一条固定 `ref` 的条目（固定 `ref` 保证只出现一次）：

| 缺的能力 | 追加的条目 |
|---|---|
| 会议纪要 / 回放 | `{"title":"会议纪要还没开通","detail":"授权卡片没能发出来，稍后重试或让管理员检查应用配置","ref":"capability:vc-minutes","priority":"know"}` |
| 文档评论 | `{"title":"文档评论还没开通","detail":"授权卡片没能发出来，稍后重试或让管理员检查应用配置","ref":"capability:docs-comments","priority":"know"}` |

**禁止**把缺权限写成"今天没有新评论""昨天的会没有纪要" —— 用户会当成真的没有，比看不到更糟。

**必选源返回 `awaiting_authorization: true` 时，整轮作废：**

- **不要再取其余数据**，**不要输出半份简报**（"待办有了、日程缺权限"这种半成品比没有更糟）；
- **只输出 `NO_UPDATES`**。授权卡片已经由框架发出，且一次性覆盖本技能声明的用户级权限；
- **禁止输出授权教程**：不写"进入飞书开放平台 → 权限管理 → 添加 XX"，不列 scope 名、不列错误码。

- 返回 `missing_scopes` 且带 `console_url`（**应用级**权限缺失）→ 输出一条固定 `ref` 的条目，
  `ref` 写 `auth:lark-daily-brief`，让去重把它压成只出现一次：

```json
{"status":"delta","summary":"简报暂时缺权限，需要管理员开通","items":[{"title":"飞书应用权限不足","detail":"需要管理员在开放平台开通简报所需权限后重试","ref":"auth:lark-daily-brief"}]}
```

### 用户要求开通扩展能力（会议产物 / 文档协同）

用户说「授权扩展能力」「开通会议纪要」「开通文档评论」这类话时，**不要做预检**，
直接调一个会用到该权限的命令，让插件把授权卡发出去（一张卡覆盖本技能声明的全部用户级 scope）：

- 会议产物：`lark-cli vc +search --start "<YESTERDAY_START>" --end "<NOW>" --as user --format json`
- 文档协同：`lark-cli drive +search --mine --page-size 3 --as user --format json`

返回 `awaiting_authorization: true` → 按适配层规则**立即结束本轮**，只回一句
「授权卡片已发送，点一下「去授权」，完成后我继续」。用户点完系统会自动续跑，不用他再发消息。

E/F 段的预检走的是同一条路：**日常巡检发现缺权限也直接撞卡**，不靠用户回话。
巡检时卡片发出即结束本轮，用户点完系统自动续跑，续跑那一轮就是完整简报
（消息 / 日程 / 任务会重新取，不要指望跨轮缓存）。

### 部分数据源不可用

某一源失败（任务/审批未开通、日程无权限）时：用其余源正常出简报，**不要**在正文里罗列技术错误。
只有两个及以上源不可用、导致简报明显失真时，才在最后追加一条：

```json
{"title":"本次简报不完整","detail":"消息与审批未能读取（权限不足），其余数据正常","ref":"degraded:lark-daily-brief:<今天的日期>"}
```

`ref` 带上当天日期，避免"不完整"这条被永久去重掉，也避免它每天重复出现。

## 反例

- ❌ 把群里 20 条闲聊列出来凑数。
- ❌ 只说"有 5 条未读"，不说谁要你干什么。
- ❌ 编一个不存在的会或截止时间。
- ❌ 自己调 `im +messages-send` 把简报发出去（会收到两份）。
- ❌ `detail` 里写"3 小时前"（每次运行都变，去重失效）。
- ❌ 把 `chat_name` 简写成"某某项目群"、按消息内容猜群名，或把同批结果里另一条消息的
  群名安到这条上：用户会看到「天策研发群钟瑾@你」这种找错群、找错人的标题。只用该条
  `message_id` 的 `source_label`，逐字复制。
- ❌ 按搜索结果原始顺序输出（顺序抖动 → 同批内容被重复推送）。
- ❌ 把"有纪要"写成"纪要说……"：本部署读不到妙记正文，展开内容就是编造。
- ❌ 没查过会话就把消息标成"已读未回"：查不动就写"还没读"，别替用户下结论。
- ❌ 把整段文档评论粘进简报：`detail` 只留第一句（≤30 字）。
- ❌ 把 delta JSON 信封原样发给用户：那是投递前的机器契约，不是给人看的。
- ❌ 因为搜到的是表格（sheet / bitable）就跳过评论查询：表格一样支持 `drive +list-comments`。
- ❌ 自己按 priority 重排 `items`：用户回「1」会处理错事。
- ❌ 多来源巡检时拆成多份信封、分两次发：所有来源必须落在同一份 delta 里。
- ❌ 只在 `summary` 里写「6 条 EHR 待审批」，`items` 里却没有一条 EHR 条目：
  这个 tab 会整块消失，用户只看到头部那句数字。
- ❌ 声明了三个 `sections`，却写完前两个来源的 items 就把 `]` 闭合。
- ❌ 只给组内一部分条目写 `cells`：整组会退回列表，表格就没了。
- ❌ 把条数写进 `hint` / `label`，或给 `group` 写相对时间：数据没变时会被水位静默，
  用户看到的还是旧版式与旧数字。

## 权限与数据来源

| 数据 | 命令 | 身份 | 关键 scope |
|---|---|---|---|
| 我是谁 | `auth status --json --verify` | user | `contact:user.base:readonly` |
| @我 / 私聊消息 | `im +messages-search` | user | `search:message`、`im:message:readonly`、`im:message.reactions:read` |
| 我读没读 | `im +messages-read-status` | user | `im:message:readonly` |
| 我回没回 | `im +messages-search --sender <我的 openId>` | user | `search:message`、`im:message.reactions:read` |
| 兜底按会话读 | `im +chat-list` / `im +chat-messages-list` | user | `im:chat:read`、`im:message:readonly` |
| 我的任务 | `task +get-my-tasks` | user | `task:task:read` |
| 日程 | `calendar +agenda` | user | `calendar:calendar.event:read` |
| 会议记录（缺席的会） | `vc +search` | user | `vc:meeting.search:read` |
| 日程 → 录制/妙记 | `vc +recording --calendar-event-ids` | user | `vc:record:readonly` |
| 会议 → 智能纪要 | `vc +detail` | user | `vc:meeting.meetingevent:read`、`vc:record:readonly` |
| 我 owner 的文档（含表格） | `drive +search --query "" --mine` | user | `search:docs:read` |
| 文档 / 表格未解决评论 | `drive +list-comments --url <原始 URL> --solved-status false`（支持 doc/docx/sheet/bitable/slides/file/wiki/apps） | user | `docs:document.comment:read` |
| 待我处理的审批 | `approval tasks query`（当前停用） | user | 审批相关 scope（应用级） |

**全部数据源都必须 `--as user`**：bot 身份读不到用户的群、私聊、任务、审批与个人日历，会返回"成功但为空"，那是最难排查的静默失败。
