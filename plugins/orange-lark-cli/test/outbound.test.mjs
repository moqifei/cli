#!/usr/bin/env node
/**
 * 出站消息回归测试（`npm test`）。
 *
 * 重点是「回复」：旧插件的卡片永远挂在用户那条消息下面，飞书据此渲染引用块
 * （「回复 某某：…」）。如果退回 `im +messages-send`，界面上就只剩一条孤立消息。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resetDeliveryDedupe, sendCard, validReplyTo } from "../src/outbound.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeCli = path.join(here, "fake-lark-cli.mjs");

test("合成 message id 去掉后缀再作为回复目标", () => {
  // 复现线上事故：ask-user 的合成入站消息 id 是
  // `om_xxx:ask-user-answer:<uuid>`，前缀也是 om_，于是被当成合法 id 发给
  // 飞书，API 400 后整轮答复投递失败——审批已经做完，用户什么都没收到。
  assert.equal(
    validReplyTo("om_x100b61f69bc988b0cfb0762baf40160:ask-user-answer:cbdfd132"),
    "om_x100b61f69bc988b0cfb0762baf40160",
  );
  assert.equal(
    validReplyTo("om_x100b61f69bc988b0cfb0762baf40160:auth-complete"),
    "om_x100b61f69bc988b0cfb0762baf40160",
  );
  // 真 id 原样返回。
  assert.equal(validReplyTo("om_x100b61f69bc988b0cfb0762baf40160"), "om_x100b61f69bc988b0cfb0762baf40160");
  // 完全不是消息 id 的（比如没有上行消息时的 ask-<uuid>）放弃引用，改发新消息。
  assert.equal(validReplyTo("ask-cbdfd132-10a3"), undefined);
  assert.equal(validReplyTo(""), undefined);
});

function readLog(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "orange-outbound-"));
  const logFile = path.join(home, "send.log");
  process.env.FAKE_LARK_SEND_LOG = logFile;
  // 每个用例都发同一张卡：不清掉去重窗口，第二个用例会被当成重复投递。
  resetDeliveryDedupe();
  return {
    account: { cliPath: fakeCli, configDir: home, cwd: home, env: {} },
    logFile,
  };
}

const card = { type: "card", data: { card_id: "card_test" } };

test("a card with replyToMessageId is sent as a reply, not a new message", async () => {
  const { account, logFile } = setup();

  const result = await sendCard({
    ...account,
    identity: "bot",
    to: "chat:oc_chat1",
    content: card,
    replyToMessageId: "om_user_1",
  });

  assert.match(result.messageId, /^om_fake_reply_/);
  const entry = readLog(logFile).find((item) => item.kind === "reply");
  assert.ok(entry, "must go through im +messages-reply");
  assert.equal(entry.reply_to, "om_user_1");
  assert.equal(entry.msg_type, "interactive");
  assert.equal(entry.reply_in_thread, false);
  assert.ok(!entry.argv.includes("--chat-id"), "a reply is addressed by message id");
});

test("replyInThread adds the thread flag", async () => {
  const { account, logFile } = setup();

  await sendCard({
    ...account,
    identity: "bot",
    to: "chat:oc_chat1",
    content: card,
    replyToMessageId: "om_user_2",
    replyInThread: true,
  });

  const entry = readLog(logFile).find((item) => item.kind === "reply");
  assert.equal(entry.reply_in_thread, true);
});

test("without a reply target the card is sent as a normal message", async () => {
  const { account, logFile } = setup();

  await sendCard({ ...account, identity: "bot", to: "chat:oc_chat1", content: card });

  const entry = readLog(logFile).find((item) => item.chat_id === "oc_chat1");
  assert.ok(entry);
  assert.equal(entry.kind, undefined);
  assert.ok(entry.argv.includes("--chat-id"));
});

test("a digest summary envelope is rendered as text, never pasted as JSON", async () => {
  const { renderDeltaForUser } = await import("../src/render.mjs");

  const envelope = JSON.stringify({
    status: "summary",
    summary: "11 月 5 日：没有待回复消息和到期任务；共 2 个会",
    items: [
      {
        title: "今天 14:00 系统分身技能沟通",
        detail: "你自己组织的，今天 14:00–15:00，线上会",
        priority: "know",
        action: "按时参会",
      },
    ],
  });

  const rendered = renderDeltaForUser(envelope);
  assert.ok(rendered, "the no-news digest uses status=summary and must render too");
  assert.match(rendered, /11 月 5 日/);
  assert.match(rendered, /今天 14:00 系统分身技能沟通 — 你自己组织的.* ⟶ 按时参会/);
  assert.ok(!rendered.includes('"status"'));
});

test("the same delivery is sent once inside the dedupe window", async () => {
  const { account, logFile } = setup();
  const options = { ...account, identity: "bot", to: "chat:oc_chat9", content: card };

  // Orange 的 outbound recovery 会在第一次 channel/send 还没返回时重投一遍。
  const [first, second] = await Promise.all([sendCard(options), sendCard(options)]);

  assert.equal(second.messageId, first.messageId, "the retry must observe the same delivery");
  const sends = readLog(logFile).filter(
    (entry) => entry.chat_id === "oc_chat9" && entry.argv.includes("--chat-id"),
  );
  assert.equal(sends.length, 1, "a recovery retry must not produce a second card");
});

test("a synthetic auth message id degrades to a normal send instead of a failing reply", async () => {
  const { account, logFile } = setup();

  // `auth-…:auth-complete` 是授权后续跑注入的合成入站 id，不是真实飞书消息。
  // 拿它做 --message-id 回复会被飞书拒绝，最终答复整条发不出去。
  await sendCard({
    ...account,
    identity: "bot",
    to: "chat:oc_chat1",
    content: card,
    replyToMessageId: "auth-1793842289614:auth-complete",
  });

  const entries = readLog(logFile);
  assert.equal(
    entries.filter((item) => item.kind === "reply").length,
    0,
    "a synthetic id must never be sent as a reply target",
  );
  assert.ok(entries.some((item) => item.chat_id === "oc_chat1" && item.argv.includes("--chat-id")));
});

// ── 多来源 tab 版式：会话内渲染要与 Rust 的 cron 投递渲染一致 ──────────

const TWO_TAB_ENVELOPE = JSON.stringify({
  status: "delta",
  summary: "1 条已读未回 ＋ 4 条 OA 待审批 ｜ 明天 09:30 创新应用周会",
  sections: [
    { name: "飞书", label: "飞书 · 消息与日程", hint: "群聊与例会" },
    {
      name: "OA 待办",
      label: "OA · 待审批",
      hint: "待你处理的流程",
      headers: ["序号", "流程名称", "申请人"],
    },
  ],
  items: [
    {
      title: "技术中台群@所有人：更新项目进展，你已读未回",
      detail: "贺世博今天 16:33 @所有人：记着更新项目进展，明天下午正常周会；你已读、该群未再回复",
      ref: "om_1",
      priority: "now",
      action: "更新项目进展",
      section: "飞书",
      group: "群聊 · 已读未回",
    },
    {
      title: "明天 09:30 创新应用周会（线上）",
      detail: "刘著组织，明天 09:30-10:30，飞书线上会；群里也提醒了更新项目进展",
      ref: "evt_1",
      priority: "know",
      action: "明天参会",
      section: "飞书",
      group: "日程 · 例会",
    },
    {
      title: "OA部门收文：季度团建物资申请（张三）",
      detail: "formId 44，requestId 20261104001",
      ref: "oa-workflow:20261104001",
      priority: "now",
      action: "逐条审批",
      section: "OA 待办",
      group: "部门收文",
      cells: [1, "季度团建物资申请", "张三"],
      note: "11-04 09:12 接收 · requestId 20261104001",
    },
    {
      title: "OA行收文：分行营业部印章使用申请（李四）",
      detail: "formId 54，requestId 20261104002",
      ref: "oa-workflow:20261104002",
      priority: "now",
      action: "逐条审批",
      section: "OA 待办",
      group: "行收文",
      cells: [2, "关于分行营业部印章使用的申请", "李四"],
      note: "11-04 09:40 接收 · requestId 20261104002",
    },
    {
      title: "OA普通：差旅报销 上海-北京（赵六）",
      detail: "formId 100，requestId 20261104004",
      ref: "oa-workflow:20261104004",
      priority: "today",
      action: "可批量审批",
      section: "OA 待办",
      group: "普通",
      cells: [3, "差旅报销申请（上海-北京）", "赵六"],
      note: "11-04 10:31 接收 · requestId 20261104004",
    },
  ],
});

test("a flat envelope stays byte-for-byte unchanged", async () => {
  const { renderDeltaForUser } = await import("../src/render.mjs");
  const rendered = renderDeltaForUser(JSON.stringify({
    status: "delta",
    summary: "2 件事",
    items: [
      { title: "A", detail: "甲", priority: "now", action: "现在回" },
      { title: "B", detail: "乙" },
    ],
  }));
  assert.equal(rendered, "2 件事\n\n❗ A — 甲 ⟶ 现在回\n• B — 乙");
});

test("sections declared without item sections stay flat", async () => {
  const { renderDeltaForUser } = await import("../src/render.mjs");
  const rendered = renderDeltaForUser(JSON.stringify({
    status: "summary",
    summary: "11 月 5 日：没有待回复消息",
    sections: ["飞书", "OA 待办"],
    items: [{ title: "今天没有待回复消息", ref: "digest:lark-daily-brief:2026-11-05" }],
  }));
  assert.equal(rendered, "11 月 5 日：没有待回复消息\n\n• 今天没有待回复消息");
});

test("two tabs are separated and OA groups render as tables", async () => {
  const { renderDeltaForUser } = await import("../src/render.mjs");
  const rendered = renderDeltaForUser(TWO_TAB_ENVELOPE);
  assert.ok(rendered.includes("▍TAB 1 ｜ 飞书 · 消息与日程  │  ▍TAB 2 ｜ OA · 待审批"));
  assert.ok(rendered.includes("群聊与例会  │  待你处理的流程"));
  assert.ok(rendered.includes("━━ TAB 1 ｜ 飞书 · 消息与日程（2 条） ━━"));
  assert.ok(rendered.includes("━━ TAB 2 ｜ OA · 待审批（3 条） ━━"));
  assert.ok(rendered.includes("群聊 · 已读未回\n❗ 技术中台群"));
  assert.ok(rendered.includes("部门收文\n| 序号 | 流程名称 | 申请人 |\n| --- | --- | --- |\n| 1 | 季度团建物资申请 | 张三 |"));
  assert.ok(rendered.includes("↳ 11-04 09:12 接收 · requestId 20261104001 · ⟶ 逐条审批"));
  assert.ok(!rendered.includes('"status"'), "JSON 不能漏给用户");
});

test("a fourth system needs neither a declaration nor a code change", async () => {
  const { renderDeltaForUser } = await import("../src/render.mjs");
  const rendered = renderDeltaForUser(JSON.stringify({
    status: "delta",
    items: [
      { title: "飞书消息", section: "飞书", ref: "m1" },
      { title: "OA 待办", section: "OA 待办", ref: "o1" },
      { title: "EHR 待办", section: "EHR 待办", ref: "e1", group: "入职", cells: [1, "入职确认", "李四"] },
      { title: "XOne 工单", section: "XOne 工单", ref: "x1", group: "工单", cells: [1, "权限开通", "王五"] },
    ],
  }));
  assert.ok(rendered.includes("▍TAB 3 ｜ EHR 待办  │  ▍TAB 4 ｜ XOne 工单"));
  assert.ok(rendered.includes("━━ TAB 4 ｜ XOne 工单（1 条） ━━"));
  assert.ok(rendered.includes("| 1 | 权限开通 | 王五 |"));
});

test("cells are escaped and numeric cells keep their position", async () => {
  const { renderDeltaForUser } = await import("../src/render.mjs");
  const rendered = renderDeltaForUser(JSON.stringify({
    status: "delta",
    sections: [{ name: "X", headers: ["序号", "名称", "申请人"] }],
    items: [{ title: "A", section: "X", cells: [1, "差旅 | 报销\n上海-北京", "张三"] }],
  }));
  assert.ok(rendered.includes("| 1 | 差旅 \\| 报销 上海-北京 | 张三 |"));
});

// 完整输出快照，与 orange/src/proactive/render.rs 的
// layout_snapshot_is_shared_with_the_cli_renderer 一一对应。
test("layout snapshot matches the Rust cron renderer", async () => {
  const { renderDeltaForUser } = await import("../src/render.mjs");
  const envelope = JSON.stringify({
    status: "delta",
    summary: "汇总",
    sections: [
      { name: "飞书", label: "飞书 · 消息与日程" },
      { name: "OA 待办", label: "OA · 待审批", headers: ["序号", "流程名称", "申请人"] },
    ],
    items: [
      { title: "群消息", detail: "张三 10:12", ref: "m1", priority: "now", action: "现在回", section: "飞书", group: "群聊" },
      { title: "部门收文", detail: "formId 44", ref: "o1", priority: "now", action: "逐条审批", section: "OA 待办", group: "部门收文", cells: [1, "季度团建物资申请", "张三"], note: "11-04 09:12 · requestId 001" },
    ],
  });
  const expected = [
    "汇总",
    "",
    "▍TAB 1 ｜ 飞书 · 消息与日程  │  ▍TAB 2 ｜ OA · 待审批",
    "",
    "━━ TAB 1 ｜ 飞书 · 消息与日程（1 条） ━━",
    "群聊",
    "❗ 群消息 — 张三 10:12 ⟶ 现在回",
    "",
    "━━ TAB 2 ｜ OA · 待审批（1 条） ━━",
    "部门收文",
    "| 序号 | 流程名称 | 申请人 |",
    "| --- | --- | --- |",
    "| 1 | 季度团建物资申请 | 张三 |",
    "  ↳ 11-04 09:12 · requestId 001 · ⟶ 逐条审批",
  ].join("\n");
  assert.equal(renderDeltaForUser(envelope), expected);
});

// ── 飞书原生卡片（Card 2.0）：table 组件 + column_set tab 条 ────────────

test("brief card uses native table components, not markdown pipes", async () => {
  const { buildBriefCard } = await import("../src/brief-card.mjs");
  const card = buildBriefCard(TWO_TAB_ENVELOPE);
  assert.ok(card);
  assert.equal(card.schema, "2.0");
  const elements = card.body.elements;

  const bar = elements.find((item) => item.tag === "column_set");
  assert.ok(bar, "tab 条要用原生分栏组件");
  assert.equal(bar.columns.length, 2);
  assert.match(bar.columns[0].elements[0].content, /飞书 · 消息与日程/);
  assert.match(bar.columns[1].elements[0].content, /OA · 待审批/);

  const tables = elements.filter((item) => item.tag === "table");
  assert.equal(tables.length, 3, "三个 OA 分组各一个原生表格");
  assert.deepEqual(
    tables[0].columns.map((column) => column.display_name),
    ["序号", "流程名称", "申请人"],
  );
  assert.deepEqual(tables[0].rows, [
    { c0: "1", c1: "季度团建物资申请", c2: "张三" },
  ]);
  assert.ok(!elements.some((item) => item.tag === "markdown" && item.content.includes("| 序号 |")));
  assert.ok(elements.some((item) => item.tag === "markdown" && item.content.includes("部门收文")));
  assert.ok(
    elements.some((item) => item.tag === "markdown" && item.content.includes("requestId 20261104001")),
    "note / action 不能因为换成原生表格就丢掉",
  );
});

test("brief card is null when there is nothing to render natively", async () => {
  const { buildBriefCard } = await import("../src/brief-card.mjs");
  assert.equal(buildBriefCard("NO_UPDATES"), null);
  assert.equal(
    buildBriefCard(JSON.stringify({ status: "delta", summary: "x", items: [{ title: "A" }] })),
    null,
  );
  assert.equal(
    buildBriefCard(JSON.stringify({ status: "delta", sections: ["飞书"], items: [{ title: "A" }] })),
    null,
  );
});

test("brief card scales to a fourth system", async () => {
  const { buildBriefCard } = await import("../src/brief-card.mjs");
  const card = buildBriefCard(JSON.stringify({
    status: "delta",
    items: [
      { title: "飞书消息", section: "飞书", ref: "m1" },
      { title: "OA 待办", section: "OA 待办", ref: "o1", group: "普通", cells: [1, "报销", "张三"] },
      { title: "EHR 待办", section: "EHR 待办", ref: "e1", group: "入职", cells: [1, "入职确认", "李四"] },
      { title: "XOne 工单", section: "XOne 工单", ref: "x1", group: "工单", cells: [1, "权限开通", "王五"] },
    ],
  }));
  const bar = card.body.elements.find((item) => item.tag === "column_set");
  assert.equal(bar.columns.length, 4);
  assert.equal(card.body.elements.filter((item) => item.tag === "table").length, 3);
});

test("brief card never exceeds the five-table card limit", async () => {
  const { buildBriefCard } = await import("../src/brief-card.mjs");
  const card = buildBriefCard(JSON.stringify({
    status: "delta",
    sections: [{ name: "OA", headers: ["序号", "流程名称", "申请人"] }],
    items: Array.from({ length: 7 }, (_, i) => ({
      title: `事项 ${i}`,
      section: "OA",
      group: `分组 ${i + 1}`,
      cells: [i + 1, `流程 ${i + 1}`, `申请人 ${i + 1}`],
    })),
  }));
  const elements = card.body.elements;
  assert.equal(elements.filter((item) => item.tag === "table").length, 5);
  assert.ok(
    elements.some((item) => item.tag === "markdown" && item.content.includes("流程 6")),
    "放不进表格的组要退化成文本，不能丢内容",
  );
});

test("a group with only some cells is not turned into a broken table", async () => {
  const { buildBriefCard } = await import("../src/brief-card.mjs");
  const card = buildBriefCard(JSON.stringify({
    status: "delta",
    items: [
      { title: "有行", section: "X", group: "G", cells: [1, "甲", "张三"] },
      { title: "普通行", detail: "还有一句", section: "X", group: "G" },
    ],
  }));
  assert.equal(card.body.elements.filter((item) => item.tag === "table").length, 0);
  assert.ok(card.body.elements.some((item) => item.tag === "markdown" && item.content.includes("普通行 — 还有一句")));
});

test("outbound.sendText delivers the brief as an interactive Card 2.0", async () => {
  const { account, logFile } = setup();
  const { createChannelPlugin } = await import("../src/index.mjs");
  const noop = () => {};
  const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log };
  const plugin = createChannelPlugin({
    api: { pluginConfig: {}, config: {}, logger: log },
    pluginConfig: {},
    logger: log,
    resolveAccounts: () => [{
      ...account,
      accountId: "default",
      scratchDir: account.configDir,
      identity: "bot",
      sendTimeoutMs: 5000,
    }],
  });
  const fallbackText = "1 条已读未回 ＋ 4 条 OA 待审批";
  const result = await plugin.outbound.sendText({
    to: "chat:oc_brief",
    text: fallbackText,
    blocks: { orange_brief_card: { envelope: TWO_TAB_ENVELOPE, fallback_text: fallbackText } },
  });

  assert.ok(result.messageId);
  const entry = readLog(logFile).find((item) => item.chat_id === "oc_brief");
  assert.ok(entry);
  assert.ok(entry.argv.includes("--msg-type") && entry.argv.includes("interactive"));
  const sent = JSON.parse(entry.text);
  assert.equal(sent.schema, "2.0");
  assert.ok(sent.body.elements.some((item) => item.tag === "table"));
});
