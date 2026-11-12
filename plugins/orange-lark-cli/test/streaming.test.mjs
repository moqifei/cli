#!/usr/bin/env node
/**
 * 流式卡片端到端（`npm test`），用假 lark-cli 跑完整生命周期：
 *
 *   首帧（回复用户消息） → 工具面板 → 思考 → 正文 → 终帧
 *
 * 这里的重点是「首帧必须在没有正文时就发出去」——旧插件的用户反馈就是靠它。
 * 另外覆盖旧插件没有的两个线上问题：终帧之后不能再有流式帧、收尾关闭
 * streaming_mode 必须可见且可重试。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { StreamingReply } from "../src/streaming.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeCli = path.join(here, "fake-lark-cli.mjs");

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

function makeLogger() {
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  log.child = () => log;
  return log;
}

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "orange-streaming-"));
  const logFile = path.join(home, "send.log");
  process.env.FAKE_LARK_SEND_LOG = logFile;
  return {
    logFile,
    account: {
      accountId: "test",
      cliPath: fakeCli,
      configDir: home,
      scratchDir: home,
      identity: "bot",
      sendTimeoutMs: 20_000,
      env: {},
    },
  };
}

test("the card is created and replied before any text arrives", async () => {
  const { account, logFile } = setup();
  const stream = new StreamingReply({
    account,
    to: "chat:oc_chat1",
    log: makeLogger(),
    reasoning: { enabled: true, expanded: false },
    card: { showToolUse: true, footer: { status: true, elapsed: true } },
    replyToMessageId: "om_user_1",
  });

  // 模型还在想：只建卡，不发任何正文。
  await stream.ensureStarted();

  const entries = readLog(logFile);
  const created = entries.find((entry) => entry.kind === "cardkit_create");
  const reply = entries.find((entry) => entry.kind === "reply");
  assert.ok(created, "a CardKit entity must exist");
  assert.ok(reply, "the card must be sent immediately");
  assert.equal(reply.reply_to, "om_user_1");
  assert.equal(reply.msg_type, "interactive");
  assert.match(reply.body, new RegExp(created.card_id));

  // 一轮里没有任何正文，也必须收出一张终帧卡（不能一条消息都不发）。
  const ok = await stream.finish("");
  assert.equal(ok, true);

  const updates = readLog(logFile).filter((entry) => entry.kind === "cardkit_update");
  assert.ok(updates.length >= 2, "closing settings + final content update");
});

test("tool steps and reasoning end up on the card, final frame stops streaming", async () => {
  const { account, logFile } = setup();
  const stream = new StreamingReply({
    account,
    to: "chat:oc_chat1",
    log: makeLogger(),
    reasoning: { enabled: true, expanded: false },
    card: { showToolUse: true, footer: { status: true, elapsed: true } },
    replyToMessageId: "om_user_2",
  });

  stream.onReasoning("先看看日程");
  stream.onToolStart("lark_cli");
  stream.onAnswer("今天的日程有三项。");
  stream.onToolEnd("lark_cli");

  const ok = await stream.finish("今天的日程有三项。");
  assert.equal(ok, true);

  const entries = readLog(logFile);
  assert.ok(entries.some((entry) => entry.kind === "cardkit_create"));
  assert.equal(entries.filter((entry) => entry.kind === "reply").length, 1, "one card per turn");
  assert.ok(entries.some((entry) => entry.kind === "cardkit_update"));
  assert.equal(stream.steps[0].status, "success");
});

test("no opening PATCH(true); closing PATCH precedes final PUT; sequence increases", async () => {
  const { account, logFile } = setup();
  const stream = new StreamingReply({
    account,
    to: "chat:oc_chat1",
    log: makeLogger(),
    reasoning: { enabled: true, expanded: false },
    replyToMessageId: "om_user_3",
  });

  const started = stream.ensureStarted();
  await Promise.all([started, stream.flush()]);
  await stream.finish("done");

  const updates = readLog(logFile).filter((entry) => entry.kind === "cardkit_update");
  const sequences = updates.map((entry) => entry.sequence);
  assert.ok(
    sequences.every((sequence) => typeof sequence === "number"),
    "every CardKit update must carry a sequence",
  );
  assert.ok(
    sequences.every((sequence, i) => i === 0 || sequence > sequences[i - 1]),
    `sequence must strictly increase, got ${JSON.stringify(sequences)}`,
  );
  // 旧插件从不做开场 PATCH(true)：开启写在建卡 JSON 里，少一次请求也就
  // 没有 PATCH/PUT 抢 sequence 的窗口。
  assert.equal(
    updates.filter((entry) => entry.method === "PATCH" && entry.streaming_mode === true).length,
    0,
    "there must be no opening settings PATCH(true)",
  );
  const settingsOff = updates.findIndex(
    (entry) => entry.method === "PATCH" && entry.streaming_mode === false,
  );
  assert.ok(settingsOff >= 0, "streaming_mode must be turned off");
  assert.equal(
    updates.at(-1).method,
    "PUT",
    "the last CardKit call must be the final content PUT, not a settings PATCH",
  );
  assert.ok(
    settingsOff < updates.length - 1,
    "streaming_mode must be turned off before the final content PUT",
  );
});

test("a rejected closing PATCH is retried with a larger sequence", async () => {
  process.env.FAKE_LARK_FAIL_FIRST_SETTINGS_PATCH = "1";
  const { account, logFile } = setup();
  const warnings = [];
  const log = { ...makeLogger(), warn: (message) => warnings.push(message) };
  const stream = new StreamingReply({
    account,
    to: "chat:oc_chat1",
    log,
    reasoning: { enabled: true, expanded: false },
    replyToMessageId: "om_user_4",
  });

  try {
    assert.equal(await stream.finish("done"), true);
    const settingsOff = readLog(logFile).filter(
      (entry) => entry.method === "PATCH" && entry.streaming_mode === false,
    );
    assert.equal(settingsOff.length, 1, "the failed attempt is not recorded as an update");
    assert.equal(settingsOff[0].sequence, 2, "the retry must use a larger sequence");
    assert.ok(
      warnings.some((message) => message.includes("retrying")),
      "the failure and retry must be logged",
    );
  } finally {
    delete process.env.FAKE_LARK_FAIL_FIRST_SETTINGS_PATCH;
  }
});

test("the finalizing gate blocks any streaming PUT after the final frame", async () => {
  const { account, logFile } = setup();
  const stream = new StreamingReply({
    account,
    to: "chat:oc_chat1",
    log: makeLogger(),
    reasoning: { enabled: true, expanded: false },
    replyToMessageId: "om_user_5",
  });

  stream.onAnswer("第一句");
  await stream.ensureStarted();
  const finishing = stream.finish("最终答案");
  // 收尾期间再塞内容与强制 flush，都不许发出新帧（旧插件靠 flush.complete +
  // cancelPendingFlush 保证；这里靠 finalizing 闸门）。
  stream.onAnswer("迟到的一句");
  stream.schedule({ force: true });
  await finishing;

  const updates = readLog(logFile).filter((entry) => entry.kind === "cardkit_update");
  assert.equal(stream.finalizing, true);
  assert.equal(stream.closed, true);
  assert.equal(updates.at(-1).method, "PUT", "the final call must be the content PUT");

  // 任何被排队的迟到帧（节流 400ms）都不许在 finish() 之后再落地。
  const countBefore = readLog(logFile).length;
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(
    readLog(logFile).length,
    countBefore,
    "no CardKit call may land after the final frame",
  );
});
