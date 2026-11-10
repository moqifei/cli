#!/usr/bin/env node
/**
 * 流式卡片端到端（`npm test`），用假 lark-cli 跑完整生命周期：
 *
 *   首帧（回复用户消息） → 工具面板 → 思考 → 正文 → 终帧
 *
 * 这里的重点是「首帧必须在没有正文时就发出去」——旧插件的用户反馈就是靠它。
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
  assert.ok(updates.length >= 2, "settings + at least one content update");
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
