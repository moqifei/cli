#!/usr/bin/env node
/**
 * token 注入器回归测试（`npm test`）。
 *
 * 关注四件事：
 *   1. **无人值守也能拿到身份**：应用身份（`contact +get-user --as bot`）优先，
 *      不回落到用户设备码授权 —— 定时任务里没人能点那张卡；
 *   2. 应用身份拿不到时，有用户在的轮次仍然走用户身份并弹授权卡；
 *   3. 无人值守轮解析不到身份就**阻断**，且 reason 里不能带
 *      `FEISHU_AUTH_REQUIRED`（否则 auth-gate 会去发一张没人点的卡）；
 *   4. 负缓存生效：连续失败不会每次工具调用都等一轮 CLI 超时。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { registerHttpTokenInjector } from "../src/http-token-injector.mjs";

const OPEN_ID = "ou_test";

/** 当前用例的 token 服务桩：注入器内部直接 fetch，没法从参数传。 */
let currentFetch = null;
globalThis.fetch = (...args) => currentFetch(...args);

function makeLogger() {
  const lines = [];
  const log = {
    lines,
    info: (m) => lines.push(["info", m]),
    warn: (m) => lines.push(["warn", m]),
    error: (m) => lines.push(["error", m]),
    debug: () => {},
  };
  log.child = () => log;
  return log;
}

/** 收集一个注入器实例注册的钩子，并返回可调用的 handler。 */
function mount({ runCli, fetchImpl, pluginConfig = {}, isScopeFailure, configDir } = {}) {
  let handler = null;
  const api = {
    pluginConfig: {
      http_token_injector: {
        token_service_url: "http://127.0.0.1:5000/user/validate",
        public_key: "pk",
        target_url_prefix: "http://127.0.0.1:5000/",
        ...pluginConfig,
      },
    },
    registerHook: (name, fn) => {
      if (name === "before_tool_call") handler = fn;
    },
  };
  const logger = makeLogger();
  // 每个用例一个独立目录：身份会落盘，共用目录会让"第二次调用不再 spawn"
  // 变成隐式行为，测试之间互相污染。
  const dir = configDir ?? mkdtempSync(path.join(os.tmpdir(), "token-injector-"));
  const accounts = [{ accountId: "work", cliPath: "lark-cli", configDir: dir, scratchDir: "/tmp", env: {} }];

  registerHttpTokenInjector({
    api,
    getAccounts: () => accounts,
    runCli: runCli ?? (async () => ({ ok: true, data: {} })),
    logger,
    isScopeFailure: isScopeFailure ?? ((error) => error?.scope === true),
  });

  assert.ok(handler, "before_tool_call hook must be registered");
  currentFetch = fetchImpl ?? (async () => ({ ok: false, status: 500, json: async () => ({}) }));

  return { handler, logger };
}

function payload(overrides = {}) {
  return {
    tool_name: "http_post",
    tool_call_id: "call-1",
    channel: "feishu",
    account_id: "work",
    user_id: OPEN_ID,
    params: { url: "http://127.0.0.1:5000/api/gateway/oa-todo", body: { pageSize: "30" } },
    ...overrides,
  };
}

function okToken() {
  return async () => ({
    ok: true,
    json: async () => ({ valid: true, token: "tok-123" }),
  });
}

test("无人值守轮用应用身份回源，不依赖用户设备码授权", async () => {
  const calls = [];
  const { handler } = mount({
    runCli: async ({ args }) => {
      calls.push(args.join(" "));
      if (args[1] === "+get-user") {
        return { ok: true, data: { user: { name: "张三", enterprise_email: "zhangsan@corp.com" } } };
      }
      throw new Error("user 身份在无人值守下不该被调用");
    },
    fetchImpl: okToken(),
  });

  const result = await handler(payload());

  assert.equal(result.action, "modify");
  assert.equal(result.payload.params.headers.username, "zhangsan");
  assert.equal(result.payload.params.headers["X-User-Id"], OPEN_ID);
  assert.equal(result.payload.params.headers.token, "tok-123");
  assert.equal(
    typeof result.payload.params.body,
    "string",
    "对象 body 必须被序列化成字符串，内置 http_post 只收字符串",
  );
  assert.ok(calls[0].includes("--as bot"), `应当用应用身份回源，实际: ${calls[0]}`);
  assert.equal(calls.length, 1, "应用身份成功时不应再走用户身份");
});

test("应用身份拿不到邮箱时，有用户在的轮次回落到用户身份", async () => {
  const calls = [];
  const { handler } = mount({
    runCli: async ({ args }) => {
      calls.push(args[1]);
      if (args[1] === "+get-user") {
        // 应用缺 contact:user.email:readonly：有资料但没有邮箱
        return { ok: true, data: { user: { name: "李四" } } };
      }
      return {
        ok: true,
        data: { users: [{ open_id: OPEN_ID, name: "李四", enterprise_email: "lisi@corp.com" }] },
      };
    },
    fetchImpl: okToken(),
  });

  const result = await handler(payload({ user_id: "ou_interactive_fallback" }));

  assert.equal(result.action, "modify");
  assert.equal(result.payload.params.headers.username, "lisi");
  assert.deepEqual(calls, ["+get-user", "+search-user"]);
});

test("身份解析失败时 fail-open，绝不用固定兜底身份冒充别人", async () => {
  const { handler } = mount({
    runCli: async () => {
      throw new Error("network down");
    },
  });

  const result = await handler(payload({ user_id: "ou_fail_open" }));

  assert.equal(result.action, "continue", "解析失败就走原样，不阻断也不注入");
  assert.equal(result.payload, undefined, "不能篡改 params");
});

test("有人值守时缺通讯录权限仍然交给授权门发卡", async () => {
  const { handler } = mount({
    runCli: async ({ args }) => {
      if (args[1] === "+get-user") throw new Error("bot has no scope");
      const error = new Error("permission denied");
      error.scope = true;
      error.error = { code: 99991672, missing_scopes: ["contact:user.base:readonly"] };
      throw error;
    },
  });

  const result = await handler(payload({ user_id: "ou_interactive_card" }));

  assert.equal(result.action, "block");
  assert.ok(String(result.blockReason).includes("FEISHU_AUTH_REQUIRED"));
  assert.ok(String(result.blockReason).includes("contact:user.base:readonly"));
});

test("解析成功会落盘，定时任务不必每次都付这一轮 CLI 调用", async () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), "token-injector-"));
  const { handler } = mount({
    configDir,
    runCli: async () => ({
      ok: true,
      data: { user: { name: "张三", enterprise_email: "zhangsan@corp.com" } },
    }),
    fetchImpl: okToken(),
  });

  await handler(payload({ user_id: "ou_persist" }));

  const saved = JSON.parse(readFileSync(path.join(configDir, "token-identity-cache.json"), "utf8"));
  assert.equal(saved.ou_persist.email, "zhangsan@corp.com", "身份要写进 account 目录");
});

test("磁盘里已有身份时直接命中，不再 spawn CLI", async () => {
  // 这是定时任务的主路径：一次 835ms 的回源已经落盘，之后每次都是 0ms。
  const configDir = mkdtempSync(path.join(os.tmpdir(), "token-injector-"));
  writeFileSync(
    path.join(configDir, "token-identity-cache.json"),
    JSON.stringify({
      ou_disk: { name: "李四", email: "lisi@corp.com", fetchedAt: Date.now(), source: "bot" },
    }),
  );

  let cliCalls = 0;
  const { handler } = mount({
    configDir,
    runCli: async () => {
      cliCalls += 1;
      throw new Error("不该走到这里");
    },
    fetchImpl: okToken(),
  });

  const result = await handler(payload({ user_id: "ou_disk" }));

  assert.equal(cliCalls, 0, "磁盘命中后不应再调用 CLI");
  assert.equal(result.action, "modify");
  assert.equal(result.payload.params.headers.username, "lisi");
});

test("身份解析失败后进入负缓存，不再每次调用都等一轮超时", async () => {
  let cliCalls = 0;
  const { handler } = mount({
    runCli: async () => {
      cliCalls += 1;
      throw new Error("lookup down");
    },
    pluginConfig: { negative_ttl_ms: 60_000 },
  });

  await handler(payload({ user_id: "ou_negative_cache" }));
  assert.equal(cliCalls, 2, "首次失败会试两条路：bot + user");

  await handler(payload({ user_id: "ou_negative_cache", tool_call_id: "call-2" }));
  assert.equal(cliCalls, 2, "冷却期内不应再 spawn CLI");
});

test("shell 与 http_post 共用同一身份解析，只把真人用户名交给框架", async () => {
  let tokenCalls = 0;
  const { handler } = mount({
    runCli: async ({ args }) => {
      if (args[1] === "+get-user") {
        return {
          ok: true,
          data: { user: { name: "叶君骄", enterprise_email: "yejunjiao@corp.com" } },
        };
      }
      throw new Error("user 身份不该被调用");
    },
    fetchImpl: async () => {
      tokenCalls += 1;
      return { ok: true, json: async () => ({ valid: true, token: "tok-123" }) };
    },
  });

  const result = await handler(
    payload({
      tool_name: "shell",
      // lookupUser 的进程内缓存按 open_id 存，换个 id 才不会命中前面用例。
      user_id: "ou_shell",
      params: { command: "python skills/attendance-query/ehr_todo.py list" },
    }),
  );

  assert.equal(result.action, "modify");
  assert.equal(result.payload.params.__gateway_username, "yejunjiao");
  assert.equal(
    result.payload.params.command,
    "python skills/attendance-query/ehr_todo.py list",
    "不应改写脚本命令",
  );
  assert.equal(result.payload.params.headers, undefined, "shell 不需要认证头");
  assert.equal(tokenCalls, 0, "shell 分支不铸 token，交给 orange 的凭据服务");
});

test("shell 在非 feishu 渠道不注入", async () => {
  const { handler } = mount({ fetchImpl: okToken() });
  const result = await handler(
    payload({ tool_name: "shell", channel: "openim", params: { command: "date" } }),
  );
  assert.equal(result.action, "continue");
});
