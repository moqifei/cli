#!/usr/bin/env node
/**
 * 通用授权门回归测试（`node --test test/`）。
 *
 * 覆盖三件容易回退的事：
 *   1. 只认飞书自己的授权签名，不把 `bash: Permission denied` 当成飞书缺权限；
 *   2. 任意工具的授权失败都会**在当前会话**发出授权卡片，并抑制本轮输出；
 *   3. device flow 完成后，合成消息回到**同一个会话**（chat/session key 不变）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeCli = path.join(here, "fake-lark-cli.mjs");

// owner 隔离后授权门要求显式 resolver，否则所有发卡路径都会 fail-close，
// device flow 根本起不来。测试里统一把调用方给的 account 钉上 owner。
const { setOwnerAccountResolver } = await import("../src/auth-gate.mjs");
setOwnerAccountResolver((ownerId, fallback) =>
  fallback ? { ...fallback, ownerUserId: ownerId } : null,
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 10_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error("waitFor timed out");
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "orange-auth-gate-"));
  process.env.ORANGE_HOME = home;
  return home;
}

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

/** Minimal logger the gate expects (`logger.child(accountId)`). */
function makeLogger() {
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  log.child = () => log;
  return log;
}

// ── 1. 错误识别 ─────────────────────────────────────────────────────────

test("detectAuthFailure only reacts to Feishu authorization signatures", async () => {
  const { detectAuthFailure } = await import("../src/auth-gate.mjs");

  assert.deepEqual(
    detectAuthFailure({ tool_name: "lark_cli", channel: "feishu", result: { error: { code: 99991679 } } }),
    { kind: "scope", missingScopes: null },
  );
  assert.deepEqual(
    detectAuthFailure({ tool_name: "lark_cli", channel: "feishu", result: { error: { code: 99991677 } } }),
    { kind: "token", missingScopes: null },
  );
  assert.deepEqual(
    detectAuthFailure({ tool_name: "feishu_get_user", channel: "feishu", result: { error: { code: 99991664 } } }),
    { kind: "app", missingScopes: null },
  );
  assert.deepEqual(
    detectAuthFailure({
      tool_name: "http_post",
      channel: "feishu",
      result: JSON.stringify({ error: { subtype: "missing_scope", missing_scopes: ["calendar:calendar.event:read"] } }),
    }),
    { kind: "scope", missingScopes: ["calendar:calendar.event:read"] },
  );

  // 误报防护
  assert.equal(
    detectAuthFailure({ tool_name: "bash", channel: "feishu", result: "cat: /root/x: Permission denied" }),
    null,
  );
  assert.equal(
    detectAuthFailure({
      tool_name: "lark_cli",
      channel: "feishu",
      result: { ok: false, awaiting_authorization: true },
    }),
    null,
    "a tool that already handled the gate must not be rewritten twice",
  );
  assert.equal(
    detectAuthFailure({ tool_name: "lark_cli", channel: "openim", result: { error: { code: 99991679 } } }),
    null,
  );
});

// ── 2. 钩子 → 当前会话卡片 → 授权后续跑 ─────────────────────────────────

test("after_tool_call hook sends the card in the current chat and resumes there", async () => {
  const home = makeHome();
  const sendLog = path.join(home, "send.log");
  process.env.FAKE_LARK_SEND_LOG = sendLog;
  process.env.FAKE_LARK_USER_READY = "0";

  const { registerAuthHooks, registerRuntime, rememberTurn, isTurnGated } = await import(
    "../src/auth-gate.mjs"
  );

  const configDir = fs.mkdtempSync(path.join(home, "cfg-"));
  const account = {
    accountId: "test",
    cliPath: fakeCli,
    configDir,
    scratchDir: configDir,
    identity: "bot",
    sendTimeoutMs: 20_000,
    env: {},
  };

  const hooks = [];
  const api = {
    registerHook(event, handler, opts) {
      hooks.push({ event, handler, opts });
    },
  };
  registerAuthHooks({ api, getAccounts: () => [account], logger: makeLogger() });

  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].event, "after_tool_call");

  // The channel records the turn while it still has the mapped inbound context.
  const sessionKey = "main:feishu:test:direct:ou_user";
  rememberTurn(account, {
    ChatId: "oc_chat1",
    ChatType: "p2p",
    SenderId: "ou_user",
    SessionKey: sessionKey,
    MessageSid: "om_inbound_1",
    Body: "帮我看下今天的日程，然后生成一份简报",
  });

  const resumed = [];
  registerRuntime("test", {
    dispatchSyntheticUserMessage(message) {
      resumed.push(message);
      return Promise.resolve();
    },
  });

  // A tool failing with a Feishu scope error — note it is NOT one of ours.
  const result = await hooks[0].handler({
    tool_name: "some_bridge_tool",
    tool_call_id: "call_1",
    channel: "feishu",
    account_id: "test",
    user_id: "feishu:ou_user",
    session_id: sessionKey,
    is_error: true,
    duration_ms: 12,
    result: { ok: false, error: { code: 99991679, message: "no permission" } },
  });

  assert.equal(result.action, "modify");
  assert.equal(result.payload.is_error, false);
  assert.match(String(result.payload.result), /AUTH_REQUIRED/);
  assert.equal(isTurnGated("om_inbound_1"), true, "the turn must be muted while waiting for consent");

  // The card goes to the conversation that triggered the failure, not "some user".
  const card = await waitFor(() =>
    readLog(sendLog).find((entry) => entry.kind === "cardkit_create"),
  );
  assert.ok(card.card_id);

  const cardMessage = await waitFor(() =>
    readLog(sendLog).find(
      (entry) => entry.kind !== "cardkit_create" && entry.chat_id === "oc_chat1",
    ),
  );
  assert.equal(cardMessage.as, "bot");

  // The device flow completes (fake CLI returns ok) and the task resumes in the
  // same session with the user's original wording.
  const resume = await waitFor(() => resumed[0]);
  assert.equal(resume.chatId, "oc_chat1");
  assert.equal(resume.senderId, "ou_user");
  assert.equal(resume.sessionKey, sessionKey);
  assert.match(resume.text, /帮我看下今天的日程/);
  assert.match(resume.text, /完整/);
});

// ── 3. http 注入器不再自己发卡片，只把授权错误交给通用授权门 ────────────

test("http token injector defers authorization to the shared gate", async () => {
  const home = makeHome();
  const { registerHttpTokenInjector } = await import("../src/http-token-injector.mjs");
  const { detectAuthFailure, isScopeFailure } = await import("../src/auth-gate.mjs");

  const hooks = [];
  const api = {
    pluginConfig: {
      http_token_injector: {
        token_service_url: "http://127.0.0.1:1/validateUser",
        public_key: "k",
      },
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerHook(event, handler, opts) {
      hooks.push({ event, handler, opts });
    },
  };
  const account = { accountId: "test", cliPath: fakeCli, configDir: home, scratchDir: home, env: {} };
  const authError = Object.assign(new Error("contact +search-user failed"), {
    error: { subtype: "missing_scope", missing_scopes: ["contact:user.base:readonly"] },
  });

  const registered = registerHttpTokenInjector({
    api,
    getAccounts: () => [account],
    // The contact lookup is the only CLI call this test reaches.
    runCli: async () => {
      throw authError;
    },
    logger: makeLogger(),
    isScopeFailure,
  });
  assert.equal(registered, true);
  assert.equal(hooks[0].event, "before_tool_call");

  const action = await hooks[0].handler({
    tool_name: "http_post",
    channel: "feishu",
    user_id: "feishu:ou_user",
    account_id: "test",
    params: { url: "http://gateway.internal/oa/workflow", body: { a: 1 } },
  });

  // The Orange shim only honours `block:true`/`cancel:true`; a bare
  // `{action:"block"}` used to be merged into the payload as a "modify", so the
  // request went out with no headers. Both shapes must be present.
  assert.equal(action.block, true);
  assert.equal(action.action, "block");
  assert.match(action.blockReason, /FEISHU_AUTH_REQUIRED/);
  assert.match(action.blockReason, /missing_scopes=contact:user\.base:readonly/);

  // What Orange actually stores: the reason is embedded in a JSON error string,
  // so the marker has to survive quote escaping.
  const blockedResult = {
    error: `Tool blocked by hook plugin 'http-token-injector': ${action.reason}`,
    code: "TOOL_BLOCKED_BY_HOOK",
    retryable: false,
  };
  assert.deepEqual(
    detectAuthFailure({ tool_name: "http_post", channel: "feishu", result: blockedResult }),
    { kind: "scope", missingScopes: ["contact:user.base:readonly"] },
  );
});

// ── 4. 应用级权限不应该发用户授权卡片 ───────────────────────────────────

test("app-level permission failure is reported, not turned into a device flow", async () => {
  const home = makeHome();
  const sendLog = path.join(home, "send.log");
  process.env.FAKE_LARK_SEND_LOG = sendLog;

  const { registerAuthHooks } = await import("../src/auth-gate.mjs");
  const configDir = fs.mkdtempSync(path.join(home, "cfg-"));
  const account = { accountId: "test", cliPath: fakeCli, configDir, scratchDir: configDir, env: {} };

  const hooks = [];
  registerAuthHooks({
    api: { registerHook: (event, handler) => hooks.push({ event, handler }) },
    getAccounts: () => [account],
    logger: makeLogger(),
  });

  const result = await hooks[0].handler({
    tool_name: "lark_cli",
    channel: "feishu",
    account_id: "test",
    user_id: "feishu:ou_user",
    result: { error: { code: 99991664, message: "app scope missing" } },
  });

  assert.equal(result.action, "modify");
  assert.match(String(result.payload.result), /APP_SCOPE_MISSING/);
  await sleep(300);
  assert.equal(
    readLog(sendLog).filter((entry) => entry.kind === "cardkit_create").length,
    0,
    "an app-level scope cannot be granted by the user, so no card must be sent",
  );
});

// ── 5. 技能文档不是授权失败 ─────────────────────────────────────────────

test("skill / reference docs mentioning auth errors never raise a consent card", async () => {
  const { detectAuthFailure } = await import("../src/auth-gate.mjs");

  const skillDoc = `# 每日飞书简报

> 若返回 \`missing_scopes\` 且带 \`console_url\`（**应用级**权限没开，用户点卡片也解决不了）

| 错误码 | 含义 |
|---|---|
| \`99991679\` | 用户身份缺少授权 |
| \`99991672\` | 应用 scope 不足 |

命中 \`missing scope\`、\`permission denied\` 时停止重试并按 hint 处理。`;

  assert.equal(detectAuthFailure({ tool_name: "Skill", channel: "feishu", result: skillDoc }), null);
  assert.equal(detectAuthFailure({ tool_name: "shell", channel: "feishu", result: skillDoc }), null);
  assert.equal(
    detectAuthFailure({ tool_name: "read_file", channel: "feishu", result: skillDoc }),
    null,
  );
  // 文档里那一行完整的 JSON 错误示例也一样（短到躲不过长度阈值时靠工具名挡）。
  assert.equal(
    detectAuthFailure({
      tool_name: "Skill",
      channel: "feishu",
      result:
        '{ "ok": false, "error": { "code": 99991679, "subtype": "missing_scope", "missing_scopes": ["..."] } }',
    }),
    null,
  );

  // 真实错误信封仍然要认。
  assert.deepEqual(
    detectAuthFailure({
      tool_name: "lark_cli",
      channel: "feishu",
      is_error: true,
      result: {
        ok: false,
        error: { code: 99991679, missing_scopes: ["calendar:calendar.event:read"] },
      },
    }),
    { kind: "scope", missingScopes: ["calendar:calendar.event:read"] },
  );
});

// ── 6. 授权卡片有 10 分钟生命周期 ───────────────────────────────────────

test("expired auth card removes the button and the TTL is 10 minutes", async () => {
  const { buildAuthCardV2 } = await import("../src/auth.mjs");
  const { AUTH_CARD_TTL_MS } = await import("../src/auth-gate.mjs");

  assert.equal(AUTH_CARD_TTL_MS, 10 * 60_000);

  const pending = buildAuthCardV2({ verificationUrl: "https://example.invalid/verify" });
  assert.match(JSON.stringify(pending), /去授权/);

  const expired = buildAuthCardV2({ state: "expired", expiresIn: 600 });
  const flat = JSON.stringify(expired);
  assert.match(flat, /授权链接已过期/);
  assert.ok(!flat.includes("去授权"), "the stale device-code link must not remain clickable");
  assert.ok(!expired.body.elements.some((element) => element.tag === "button"));
});

// ── 7. 授权已齐时不再重复发卡（死循环断路器） ───────────────────────────

test("a verified token covering every scope stops the re-authorization loop", async () => {
  const home = makeHome();
  const sendLog = path.join(home, "send.log");
  process.env.FAKE_LARK_SEND_LOG = sendLog;
  process.env.FAKE_LARK_USER_READY = "1";
  process.env.FAKE_LARK_GRANTED_SCOPES = [
    "contact:user:search",
    "contact:user.basic_profile:readonly",
    "im:message:readonly",
    "search:message",
    "calendar:calendar.event:read",
    "task:task:read",
    "vc:meeting.search:read",
    "vc:record:readonly",
    "vc:meeting.meetingevent:read",
    "search:docs:read",
    "docs:document.comment:read",
  ].join(" ");

  const { registerAuthHooks, ensureUserAuthorized, rememberTurn } = await import(
    "../src/auth-gate.mjs"
  );
  const configDir = fs.mkdtempSync(path.join(home, "cfg-"));
  const account = {
    accountId: "test",
    cliPath: fakeCli,
    configDir,
    scratchDir: configDir,
    identity: "bot",
    sendTimeoutMs: 20_000,
    env: {},
    // 这里测的是「最小权限模式下的逐项覆盖」断路器；全量模式另有一组测试。
    authScopeMode: "declared",
  };
  const sessionKey = "main:feishu:test:direct:ou_user";
  const chat = { chatId: "oc_chat1", senderId: "ou_user", chatType: "direct", sessionKey };

  const hooks = [];
  registerAuthHooks({
    api: { registerHook: (event, handler) => hooks.push({ event, handler }) },
    getAccounts: () => [account],
    logger: makeLogger(),
  });
  rememberTurn(account, {
    ChatId: "oc_chat1",
    ChatType: "p2p",
    SenderId: "ou_user",
    SessionKey: sessionKey,
    MessageSid: "om_inbound_1",
    Body: "生成今天的简报",
  });

  // 先让闸门读一次服务端状态，建立同步快照（真实链路里由上一轮失败完成）。
  const gate = await ensureUserAuthorized({
    account,
    argv: null,
    toolCtx: null,
    chat,
    log: makeLogger(),
    force: true,
    trigger: "scope",
    missingScopes: null,
    toolName: "Skill",
  });
  assert.equal(gate?.already_authorized, true, "no real gap means no device flow");

  // 同类错误再来一次：必须明确告诉模型「不是授权问题」，且一张卡都不发。
  const result = await hooks[0].handler({
    // 用一个会真调飞书 API 的工具名：Skill 本身已被文档黑名单挡在门外。
    tool_name: "some_bridge_tool",
    channel: "feishu",
    account_id: "test",
    user_id: "feishu:ou_user",
    session_id: sessionKey,
    result: { ok: false, error: { code: 99991679, message: "no permission" } },
  });
  assert.equal(result.action, "modify");
  assert.match(String(result.payload.result), /NOT_AUTHORIZATION_ERROR/);
  await sleep(400);
  assert.equal(
    readLog(sendLog).filter((entry) => entry.kind === "cardkit_create").length,
    0,
    "already-granted scopes must never produce another consent card",
  );

  delete process.env.FAKE_LARK_USER_READY;
  delete process.env.FAKE_LARK_GRANTED_SCOPES;
});

// ── 8. 默认一次授完全部用户权限，且授权过就不再要第二次 ─────────────────

test("all-mode asks for the app's entire user-scope set in one card, then stops", async () => {
  const home = makeHome();
  const sendLog = path.join(home, "send.log");
  process.env.FAKE_LARK_SEND_LOG = sendLog;
  process.env.FAKE_LARK_USER_READY = "1";
  process.env.FAKE_LARK_GRANTED_SCOPES = "a:one";
  process.env.FAKE_LARK_USER_SCOPES = "a:one,a:two,a:three";

  const { ensureUserAuthorized } = await import("../src/auth-gate.mjs");
  const configDir = fs.mkdtempSync(path.join(home, "cfg-"));
  const account = {
    accountId: "test",
    cliPath: fakeCli,
    configDir,
    scratchDir: configDir,
    identity: "bot",
    sendTimeoutMs: 20_000,
    env: {},
    // 这一组验证的是 /feishu_auth 那种「全部用户权限一次授完」的显式模式。
    authScopeMode: "all",
  };
  const chat = { chatId: "oc_chat1", senderId: "ou_user", chatType: "direct" };
  const call = () =>
    ensureUserAuthorized({
      account,
      argv: ["contact", "+search-user"],
      toolCtx: null,
      chat,
      log: makeLogger(),
      force: true,
      trigger: "scope",
      missingScopes: ["a:two"],
      toolName: "lark_cli",
    });

  const first = await call();
  assert.equal(first?.awaiting_authorization, true);

  // 一次就把应用开通的全部 scope 带上，而不是只补当前那一个新缺口。
  const flow = await waitFor(() =>
    readLog(sendLog).find((entry) => entry.kind === "device_flow"),
  );
  const requested = String(flow.argv[flow.argv.indexOf("--scope") + 1] ?? "");
  for (const scope of ["a:one", "a:two", "a:three"]) {
    assert.ok(requested.includes(scope), `the one-time grant must include ${scope}`);
  }

  // device flow 完成后写好标记。
  const markerFile = path.join(home, ".auth-grant-test.json");
  await waitFor(() => fs.existsSync(markerFile));
  const marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
  assert.equal(marker.count, 3);
  assert.match(marker.signature, /^all:/);

  // 再来一次同样的报错：不该再起第二张卡。
  const flowsBefore = readLog(sendLog).filter((entry) => entry.kind === "device_flow").length;
  const second = await call();
  assert.equal(second?.already_authorized, true);
  await sleep(300);
  assert.equal(
    readLog(sendLog).filter((entry) => entry.kind === "device_flow").length,
    flowsBefore,
    "a completed one-time grant must not produce another consent card",
  );

  delete process.env.FAKE_LARK_USER_READY;
  delete process.env.FAKE_LARK_USER_SCOPES;
  delete process.env.FAKE_LARK_GRANTED_SCOPES;
});

// ── 10. 默认模式只申请技能涉及的域 ─────────────────────────────────────

test("skill mode scopes the grant to the domains the skill touches, never mail", async () => {
  const home = makeHome();
  const sendLog = path.join(home, "send.log");
  process.env.FAKE_LARK_SEND_LOG = sendLog;
  process.env.FAKE_LARK_USER_READY = "1";
  process.env.FAKE_LARK_GRANTED_SCOPES = "im:message:readonly";
  process.env.FAKE_LARK_USER_SCOPES = [
    "im:message:readonly",
    "im:chat:read",
    "calendar:calendar.event:read",
    "mail:mail:read",
    "mail:user_mailbox:read",
    "contact:user:search",
    "docs:document.comment:read",
  ].join(",");

  const { ensureUserAuthorized } = await import("../src/auth-gate.mjs");
  const configDir = fs.mkdtempSync(path.join(home, "cfg-"));
  const account = {
    accountId: "test",
    cliPath: fakeCli,
    configDir,
    scratchDir: configDir,
    identity: "bot",
    sendTimeoutMs: 20_000,
    env: {},
  };
  const chat = { chatId: "oc_chat1", senderId: "ou_user", chatType: "direct" };

  const gate = await ensureUserAuthorized({
    account,
    argv: ["calendar", "+agenda"],
    toolCtx: null,
    chat,
    log: makeLogger(),
    force: true,
    trigger: "scope",
    missingScopes: ["calendar:calendar.event:read"],
    toolName: "lark_cli",
  });
  assert.equal(gate?.awaiting_authorization, true);

  const flow = await waitFor(() => readLog(sendLog).find((entry) => entry.kind === "device_flow"));
  const requested = String(flow.argv[flow.argv.indexOf("--scope") + 1] ?? "");

  // 日程技能声明的 im/calendar/task/vc/drive 一次给全。
  assert.ok(requested.includes("calendar:calendar.event:read"));
  assert.ok(requested.includes("im:chat:read"), "sibling domains of the same skill come along");
  // 但邮箱、通讯录这些不相关的域一条都不能要。
  assert.ok(!requested.includes("mail:"), "a calendar skill must never ask for mailbox scopes");
  assert.ok(
    !requested.includes("contact:user:search"),
    "another skill's declared scopes must not leak in",
  );

  delete process.env.FAKE_LARK_USER_READY;
  delete process.env.FAKE_LARK_USER_SCOPES;
  delete process.env.FAKE_LARK_GRANTED_SCOPES;
});

// ── 9. 复用判断必须落在 scope 上 ────────────────────────────────────────

test("a live flow is reused only when its scope set still covers the request", async () => {
  const { startDeviceFlow, clearDeviceFlow } = await import("../src/auth.mjs");
  const home = makeHome();
  const configDir = fs.mkdtempSync(path.join(home, "cfg-"));
  process.env.FAKE_LARK_SEND_LOG = path.join(home, "send.log");
  const account = { cliPath: fakeCli, configDir, scratchDir: configDir, env: {} };
  const log = makeLogger();

  await startDeviceFlow(account, ["im"], { scopes: ["im:message:readonly"], log });
  const same = await startDeviceFlow(account, ["im"], { scopes: ["im:message:readonly"], log });
  assert.equal(same.reused, true, "an identical request must keep the same card");

  const wider = await startDeviceFlow(account, ["im"], {
    scopes: ["im:message:readonly", "im:chat:read"],
    log,
  });
  assert.notEqual(wider.reused, true, "a new scope must not reuse the narrower flow");
  clearDeviceFlow(account);
});

// ── 10. declared 模式：所有授权门共用一份最小清单 ────────────────────────

test("declared mode pins the minimal skill scopes for every auth gate", async () => {
  const { authScopesFor } = await import("../src/auth-gate.mjs");
  const account = { authScopeMode: "declared" };

  // 工具预检门（带 argv，算出 im 域）与钩子兜底门（argv=null）必须拿到同一份
  // 清单；不同清单会让 startDeviceFlow 的 covers() 复用失败，用户会收两张卡。
  const fromArgv = authScopesFor(account, ["im"]);
  const fromHook = authScopesFor(account, null);
  assert.deepEqual(fromArgv, fromHook, "two gates must not compute different scope lists");
  assert.deepEqual(
    [...fromHook].sort(),
    [
      "im:message:readonly",
      "search:message",
      "calendar:calendar.event:read",
      "task:task:read",
      "vc:meeting.search:read",
      "vc:record:readonly",
      "vc:meeting.meetingevent:read",
      "search:docs:read",
      "docs:document.comment:read",
      "contact:user:search",
      "contact:user.basic_profile:readonly",
    ].sort(),
    "only the daily-brief and contact skill scopes may be requested",
  );

  // 显式白名单优先级最高，不受业务域影响。
  assert.deepEqual(authScopesFor({ authScopes: ["im:message:readonly"] }, ["mail"]), [
    "im:message:readonly",
  ]);
});
