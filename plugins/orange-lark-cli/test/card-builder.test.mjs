#!/usr/bin/env node
/**
 * 卡片结构回归测试（`npm test`）。
 *
 * 这些断言对应旧插件 `src/card/builder.ts` 的可见结构，改坏了用户立刻能看出来：
 *   - 首帧必须是「思考中」卡（否则模型慢就没有任何反馈）；
 *   - 回答前有思考面板，终帧收起并显示「思考了 X」；
 *   - 工具调用是一个可折叠面板（N 步），不是一行灰字；
 *   - 卡片配置里必须带 streaming_mode / locales / summary。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { optimizeMarkdownStyle } from "../src/card-markdown.mjs";
import {
  STREAMING_ELEMENT_ID,
  buildCompleteCard,
  buildStreamingCard,
  buildThinkingCard,
  cleanReasoningText,
  extractThinkingContent,
  formatElapsed,
  splitReasoningText,
  stripThinkTags,
} from "../src/card.mjs";
import { describeTool, formatStepStatus } from "../src/tool-display.mjs";
import { renderDeltaForUser, visibleTabItems } from "../src/render.mjs";
import { buildBriefCard } from "../src/brief-card.mjs";

const flatten = (node) => JSON.stringify(node);

test("thinking card gives immediate feedback and keeps the streaming anchor", () => {
  const card = buildThinkingCard();

  assert.equal(card.schema, "2.0");
  assert.equal(card.config.streaming_mode, true);
  assert.deepEqual(card.config.locales, ["zh_cn", "en_us"]);
  assert.equal(card.config.summary.i18n_content.zh_cn, "处理中...");

  const streaming = card.body.elements.find((element) => element.element_id === STREAMING_ELEMENT_ID);
  assert.ok(streaming, "CardKit needs a stable element_id for the typewriter effect");
  assert.ok(
    !flatten(card).includes("等待工具执行"),
    "the first frame must not ship an empty tool panel the old plugin never had",
  );
});

test("no tool panel until a tool actually starts", () => {
  const idle = buildStreamingCard({ answerText: "答案" });
  assert.ok(
    !idle.body.elements.some((element) => element.tag === "collapsible_panel"),
    "a turn without tool calls must render no tool box at all",
  );

  const busy = buildStreamingCard({
    steps: [{ title: "Read", iconToken: "file-link-text_outlined", status: "running" }],
    answerText: "答案",
  });
  assert.equal(busy.body.elements[0].tag, "collapsible_panel");
});

test("streaming card renders a collapsible tool panel, not a one-line status", () => {
  const card = buildStreamingCard({
    steps: [{ title: "Search web", iconToken: "search_outlined", status: "running" }],
    stepsElapsedMs: 1200,
    answerText: "# 标题\n\n正文",
  });

  const panel = card.body.elements[0];
  assert.equal(panel.tag, "collapsible_panel");
  assert.equal(panel.expanded, true);
  assert.equal(panel.header.title.i18n_content.zh_cn, "🛠️ 工具执行 · 1 步 · (1.2s)");
  assert.match(panel.elements[0].text.content, /Running/);

  const answer = card.body.elements.at(-1);
  assert.equal(answer.element_id, STREAMING_ELEMENT_ID);
  assert.match(answer.content, /#### 标题/, "H1 must be demoted inside the card");
});

test("reasoning panel stays visible after the answer starts", () => {
  const before = buildStreamingCard({ reasoningText: "先看看数据", reasoningActive: true });
  assert.match(flatten(before), /思考中\.\.\./);

  const after = buildStreamingCard({
    reasoningText: "先看看数据",
    answerText: "答案",
    reasoningElapsedMs: 2100,
  });
  assert.match(flatten(after), /思考了 2\.1s/, "the thinking stays readable while the answer streams");
});

test("complete card collapses panels, adds the elapsed reasoning label and the fallback text", () => {
  const card = buildCompleteCard({
    text: "",
    reasoningText: "先看看数据",
    reasoningElapsedMs: 3200,
    steps: [{ title: "Read", iconToken: "file-link-text_outlined", status: "success" }],
    stepsElapsedMs: 800,
  });

  const flat = flatten(card);
  assert.match(flat, /思考了 3\.2s/);
  assert.match(flat, /执行耗时 800\.0ms|执行耗时 0\.8s/);
  assert.match(flat, /本轮没有产生文本输出/, "an empty answer must still produce a message");
  assert.equal(
    card.config.streaming_mode,
    false,
    "the final frame must explicitly stop streaming so the chat-list preview refreshes",
  );

  for (const panel of card.body.elements.filter((element) => element.tag === "collapsible_panel")) {
    assert.equal(panel.expanded, false);
  }
});

test("final frame never ships an empty tool panel", () => {
  const idle = buildCompleteCard({ text: "好，我先跑一次给你看看" });
  const idleFlat = flatten(idle);
  assert.ok(!idleFlat.includes("工具执行"), "征询回复这类无工具轮次不能出现空的工具面板");
  assert.ok(!idleFlat.includes("暂无工具步骤"));
  assert.ok(
    !idle.body.elements.some((element) => element.tag === "collapsible_panel"),
    "没有工具步骤、也没有思考内容时终帧不该有任何折叠面板",
  );
  assert.match(idleFlat, /好，我先跑一次给你看看/, "正文必须照常保留");

  const busy = buildCompleteCard({
    text: "答案",
    steps: [{ title: "Read", iconToken: "file-link-text_outlined", status: "success" }],
    stepsElapsedMs: 800,
  });
  assert.ok(
    busy.body.elements.some(
      (element) => element.tag === "collapsible_panel" && /工具执行|执行耗时/.test(flatten(element)),
    ),
    "真跑过工具时终帧仍然要能看到工具面板",
  );
});

test("footer is opt-in, matching the old plugin defaults", () => {
  const off = buildCompleteCard({ text: "答案", elapsedMs: 4100 });
  assert.ok(!flatten(off).includes("已完成"));

  const on = buildCompleteCard({
    text: "答案",
    elapsedMs: 4100,
    footer: { status: true, elapsed: true },
  });
  assert.match(flatten(on), /已完成 · 耗时 4\.1s/);
});

test("markdown optimization keeps code blocks byte-identical", () => {
  const source = "# 标题\n\n```js\n# not a heading\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
  const out = optimizeMarkdownStyle(source);

  assert.match(out, /#### 标题/);
  assert.match(out, /# not a heading/, "code block content must not be rewritten");
  assert.match(out, /\n<br>\n/, "tables/code blocks get breathing room");
  assert.ok(!out.includes("![image](https://example.com/a.png)"), "non img_ keys are stripped");
});

test("reasoning text is unwrapped from the host envelope", () => {
  assert.equal(cleanReasoningText("Reasoning:\n_第一行_\n_第二行_"), "第一行\n第二行");
});

test("tool descriptors and durations match the old card vocabulary", () => {
  assert.deepEqual(describeTool("web_search"), { title: "Search web", iconToken: "search_outlined" });
  assert.deepEqual(describeTool("lark_cli"), { title: "lark_cli", iconToken: "app-default_outlined" });
  assert.equal(describeTool("mcp:grep").title, "Search text");
  assert.deepEqual(formatStepStatus("running"), { label: "Running", color: "turquoise" });
  assert.equal(formatElapsed(65_000), "1m 5s");
});

test("model think tags never leak into the answer or the chat-list summary", () => {
  const raw = "清淡口的话，推荐广式早茶。\n</think>";
  const final = buildCompleteCard({ text: raw, reasoningText: "想了想", reasoningExpanded: false });
  const body = flatten(final);

  assert.ok(!body.includes("</think>"), "the final card must not render a literal </think>");
  assert.ok(!body.includes("<think>"), "the final card must not render a literal <think>");
  assert.match(body, /清淡口的话/);
  assert.ok(!final.config.summary.content.includes("think"), "the summary must be tag-free");
  assert.equal(final.config.streaming_mode, false);

  const streaming = buildStreamingCard({ answerText: "<think>internal</think>你好" });
  assert.ok(!flatten(streaming).includes("think"), "streaming frames must strip think tags too");
  assert.match(flatten(streaming), /你好/);

  // 旧插件覆盖的变体：<thinking> / <thought> / <antthinking>、带空格标签、
  // 未闭合标签、Reasoning: 前缀。
  for (const tag of ["think", "thinking", "thought", "antthinking"]) {
    assert.equal(stripThinkTags(`答案<${tag}>内部</${tag}>`), "答案", `${tag} block`);
    assert.equal(stripThinkTags(`答案</${tag}>`), "答案", `orphan ${tag}`);
    assert.equal(stripThinkTags(`答案< ${tag} >还在想`), "答案", `unclosed ${tag}`);
  }
  assert.equal(stripThinkTags("Reasoning:\n_想了想_\n"), "");
  assert.equal(extractThinkingContent("答案<think>内部</think>"), "内部");
  assert.deepEqual(splitReasoningText("<think>内部</think>答案"), {
    reasoningText: "内部",
    answerText: "答案",
  });

  // 空回答也必须有 summary，否则服务端保留建卡时的「处理中...」预览。
  const empty = buildCompleteCard({ text: "</think>" });
  assert.ok(empty.config.summary.content.length > 0, "empty answers still need a summary");
  assert.ok(!empty.config.summary.content.includes("think"));
});

// 回归：39 条日报里 EHR 的 6 条排在 index 33–38。旧的全局 slice(0, 30)
// 把整个来源切没，卡片显示「EHR · 待审批 0 条 / 本轮未取到该来源的明细」，
// 但接口和模型信封里这 6 条都在。
const THREE_SOURCE_ENVELOPE = JSON.stringify({
  status: "delta",
  summary: "飞书 3 件待跟进、OA 30 条待审批、EHR 6 条待审批",
  sections: [
    { name: "飞书", label: "飞书 · 消息与日程", hint: "群聊与例会" },
    { name: "OA 待办", label: "OA · 待审批", hint: "待你处理的流程", headers: ["序号", "流程名称", "申请人"] },
    { name: "EHR 待办", label: "EHR · 待审批", hint: "待你处理的人事流程", headers: ["序号", "流程名称", "申请人"] },
  ],
  items: [
    ...Array.from({ length: 3 }, (_, i) => ({ title: `飞书消息 ${i}`, ref: `m${i}`, section: "飞书" })),
    ...Array.from({ length: 30 }, (_, i) => ({
      title: `OA 待办 ${i}`, ref: `o${i}`, section: "OA 待办", group: "部门收文",
      cells: [i + 1, `OA流程 ${i}`, `OA申请人 ${i}`],
    })),
    ...Array.from({ length: 6 }, (_, i) => ({
      title: `EHR 待办 ${i} 孙八`, ref: `e${i}`, section: "EHR 待办", group: "请假",
      cells: [i + 1, `EHR流程 ${i}`, `EHR申请人 ${i}`],
    })),
  ],
});

test("排在最后的来源不会被全局条数上限整段截掉", () => {
  const text = renderDeltaForUser(THREE_SOURCE_ENVELOPE);
  assert.match(text, /TAB 3.*EHR · 待审批（6 条）/);
  // 有 cells 的条目走表格行，纯文本里看不到 title，按行内容断言。
  assert.match(text, /EHR申请人 5/);
  assert.ok(!text.includes("本轮未取到该来源的明细"), "取到了数据就不能报缺明细");

  const card = buildBriefCard(THREE_SOURCE_ENVELOPE);
  assert.ok(card);
  const serialized = flatten(card);
  assert.match(serialized, /\*\*EHR\*\*.*\*\*6 条\*\*/, "速览里 EHR 要数出 6 条");
  assert.match(serialized, /EHR · 待审批.*6 条/, "分区标题也要数出 6 条");
  assert.match(serialized, /EHR申请人 5/, "EHR 表格行要真的渲染出来");
  assert.ok(!serialized.includes("本轮未取到该来源的明细"));
});

test("按来源限额仍然生效，超出的条目折叠而不是无限铺开", () => {
  const items = Array.from({ length: 35 }, (_, i) => ({
    title: `事项 ${i}`, ref: `o${i}`, section: "OA", group: "G",
    cells: [i + 1, `流程 ${i}`, "张三"],
  }));
  assert.equal(visibleTabItems(items.map((item) => ({ ...item, section: null })), 30).length, 30);
  const envelope = JSON.stringify({
    status: "delta",
    sections: [{ name: "OA", label: "OA · 待审批" }],
    items,
  });
  const text = renderDeltaForUser(envelope);
  assert.match(text, /…等共 35 条/);
  assert.ok(!text.includes("流程 34"), "单来源超过 30 条要折叠");
  assert.match(flatten(buildBriefCard(envelope)), /…等共 35 条/);
});
