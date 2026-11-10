/**
 * http-token-injector — 给 `http_get` / `http_post` 注入网关 token。
 *
 * Ported from openclaw-lark/src/hook/http-token-injector.ts. The old plugin read
 * the sender's email from a cache filled at message-receive time; this one fills
 * the same cache lazily on first use, so a cold start costs one lookup per user
 * per TTL instead of one per inbound message.
 *
 * Flow:
 *   1. before_tool_call -> http_get / http_post / shell, only `feishu` channel
 *   2. open_id -> email/name (cached 30 min) — one identity resolution, both branches
 *   3. http_get/http_post: POST {username, publicKey} to the token service
 *      -> {valid, token} (cached 5 min), inject username/token/X-User-Id headers
 *   4. shell: hand the same real username to orange's gateway-token service
 *      (`__gateway_username` param). It mints the token and writes
 *      `ORANGE_HTTP_*` / `.orange_http_token.json` for scripts that make raw
 *      HTTP calls (e.g. EHR skills). Without this, unattended runs only have
 *      the cron service identity and would query the gateway as `cronjob`.
 *
 * 身份回源有两条路，顺序不能反：
 *   - **bot（应用身份）优先**：`contact +get-user --as bot`。它走 tenant token，
 *     不需要用户点授权卡，因此**定时任务（简报、OA 待办提醒）也能拿到身份**。
 *     这是本节改动的全部理由：以前只走 user 身份，无人值守时必然 miss。
 *   - **user（设备码身份）兜底**：`contact +search-user --as user`。应用没开
 *     通讯录权限、但用户自己开了的部署靠这条；多要一次设备码授权即可。
 *
 * Contract notes discovered the hard way:
 *   - The hook budget is 1500 ms, so every await here is bounded.
 *   - The builtin `http_post` declares `body` as a *string*. Skills (oa-workflow,
 *     the knowledge-base proxies) pass a JSON object, so normalise it here rather
 *     than making every skill stringify by hand.
 *   - Fail-open for ordinary errors: no user info / service says invalid ->
 *     `{action:"continue"}`, the request goes out unauthenticated and the gateway
 *     answers 401.
 *   - Authorization is NOT handled here. A missing contact scope on the **user**
 *     path blocks the call with a `FEISHU_AUTH_REQUIRED …` reason and lets the
 *     generic `after_tool_call` gate (`auth-gate.mjs`) raise the card, mute the
 *     turn and resume the task afterwards. One implementation, every tool.
 *   - 无人值守轮真正会用到的只有 **bot** 那条路：定时任务里没人能点授权卡。
 *     应用身份失败时仍会退回用户身份，那时由 `auth-gate.mjs` 决定把卡发到
 *     例程 owner 的私聊并在授权后续跑 —— 这条恢复路径是它本来就有的能力，
 *     本节不重复实现。
 *   - 负缓存（`negative_ttl_ms`，默认 60s）避免身份服务持续失败时，每次工具
 *     调用都白等一轮 CLI 超时。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const HOOK_NAME = "http-token-injector";
const HOOK_PRIORITY = 80;
const TOOL_NAMES = ["http_get", "http_post", "shell"];
/** 钩子与 orange 工具预检之间约定的内部参数名，只在 shell 分支使用。 */
const GATEWAY_USERNAME_PARAM = "__gateway_username";
const DEFAULT_TOKEN_TTL_MS = 5 * 60 * 1000;
const DEFAULT_USER_CACHE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_NEGATIVE_TTL_MS = 60 * 1000;
/**
 * 等身份回源的预算。
 *
 * 钩子总预算 1500ms（`BEFORE_TOOL_CALL_HOOK_TIMEOUT_MS`），而一次
 * `contact +get-user --as bot` 实测约 835ms（进程启动 + 两次飞书 API 往返）。
 * 之前给 600ms 是照着"本地调用应该很快"拍的，结果每次都超时、请求裸奔到
 * 网关上 401。这里给 1200ms：够一次真调用，也留得下铸 token 的余量。
 */
const LOOKUP_DEADLINE_MS = 1200;
/** 进程本身的超时放宽：钩子放行后它还能跑完，把身份写进磁盘缓存。 */
const LOOKUP_PROCESS_TIMEOUT_MS = 3000;
const TOKEN_TIMEOUT_MS = 900;
/** 磁盘身份缓存：邮箱基本不变，7 天足够把 CLI 调用摊薄到几乎为零。 */
const DEFAULT_IDENTITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IDENTITY_CACHE_FILE = "token-identity-cache.json";

/** openId -> { name, email, fetchedAt, source } */
const userCache = new Map();
/** openId -> { token, expiresAt } */
const tokenCache = new Map();
/** openId -> 失败冷却截止时间：连续失败时别再每次工具调用都等一轮超时 */
const negativeCache = new Map();

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 机器可读的授权失败标记。
 *
 * 本模块**不再自己发授权卡片**：选 scope、device flow、卡片、授权后回到原会话
 * 续跑，这套逻辑只有 `auth-gate.mjs` 一份实现。这里只把飞书原生授权错误翻译成
 * 一个带签名的 block reason，交给通用的 `after_tool_call` 授权门统一处理。
 *
 * 标记必须能穿过 JSON 字符串转义（block reason 会被塞进
 * `{"error":"Tool blocked by hook plugin ...: <reason>"}`），所以用 `k=v` 而不是
 * 引号 JSON。
 */
const AUTH_FAILURE_MARKER = "FEISHU_AUTH_REQUIRED";

function authFailureReason(error) {
  const code = Number(error?.error?.code ?? error?.code ?? 0);
  const subtype = String(error?.error?.subtype ?? "");
  const scopes = Array.isArray(error?.error?.missing_scopes)
    ? error.error.missing_scopes.join(",")
    : "";
  return [
    AUTH_FAILURE_MARKER,
    subtype ? `subtype=${subtype}` : "",
    code ? `code=${code}` : "",
    scopes ? `missing_scopes=${scopes}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function registerHttpTokenInjector({
  api,
  getAccounts,
  runCli,
  logger,
  isScopeFailure,
  resolveOwnerAccount = null,
}) {
  const apiLog = api.logger ?? logger;
  const cfg = api.pluginConfig?.http_token_injector ?? {};

  const tokenServiceUrl = String(cfg.token_service_url ?? "");
  const publicKey = String(cfg.public_key ?? "");
  const tokenTtlMs = Number(cfg.token_ttl_ms) || DEFAULT_TOKEN_TTL_MS;
  const userCacheTtlMs = Number(cfg.user_cache_ttl_ms) || DEFAULT_USER_CACHE_TTL_MS;
  const negativeTtlMs = Number(cfg.negative_ttl_ms) || DEFAULT_NEGATIVE_TTL_MS;
  const targetUrlPrefix = String(cfg.target_url_prefix ?? "http://");

  if (!tokenServiceUrl || !publicKey) {
    logger.warn("http_token_injector not configured — gateway token injection disabled");
    return false;
  }

  logger.info(`http_token_injector ready: ${tokenServiceUrl} (ttl=${tokenTtlMs}ms, prefix=${targetUrlPrefix})`);

  function callCli(account, args, label, log, deadlineMs = LOOKUP_DEADLINE_MS) {
    // 两个超时故意不同：钩子只等 deadlineMs，但进程本身允许跑到 3000ms。
    // 这样"钩子放行、请求裸奔一次"之后，那次调用仍能跑完并把身份写进磁盘，
    // 下一次就不必再付这份启动 + 往返的时间。
    const pending = runCli({
      cliPath: account.cliPath,
      configDir: account.configDir,
      cwd: account.scratchDir,
      args,
      timeoutMs: LOOKUP_PROCESS_TIMEOUT_MS,
      env: account.env,
      log,
    });
    return { pending, result: withTimeout(pending, deadlineMs, label) };
  }

  // ---- 磁盘身份缓存：把"一次 835ms"摊成"一周一次" ----
  const identityCache = new Map(); // accountId -> { loadedAt, users: { [openId]: value } }
  const identityTtlMs = Number(cfg.identity_ttl_ms) || DEFAULT_IDENTITY_TTL_MS;

  function identityFile(account) {
    return path.join(account.configDir ?? "", IDENTITY_CACHE_FILE);
  }

  function loadIdentityCache(account) {
    const key = account.accountId ?? "";
    const hit = identityCache.get(key);
    if (hit && Date.now() - hit.loadedAt < 60_000) return hit.users;
    let users = {};
    try {
      users = JSON.parse(readFileSync(identityFile(account), "utf8")) ?? {};
    } catch {
      users = {};
    }
    identityCache.set(key, { loadedAt: Date.now(), users });
    return users;
  }

  function readIdentity(account, openId) {
    if (!account) return null;
    const users = loadIdentityCache(account);
    const value = users[openId];
    if (!value?.email) return null;
    if (Date.now() - Number(value.fetchedAt ?? 0) > identityTtlMs) return null;
    return value;
  }

  function writeIdentity(account, openId, value) {
    if (!account) return;
    const users = loadIdentityCache(account);
    users[openId] = value;
    identityCache.set(account.accountId ?? "", { loadedAt: Date.now(), users });
    try {
      mkdirSync(account.configDir, { recursive: true });
      writeFileSync(identityFile(account), JSON.stringify(users), { mode: 0o600 });
    } catch (error) {
      logger.warn(`token injector: cannot persist identity cache: ${error?.message ?? error}`);
    }
  }

  /**
   * 应用身份回源：`contact +get-user --user-id <open_id> --as bot`。
   *
   * 走 tenant token，**不需要用户授权卡**，所以定时任务也能用。这也是它与
   * `+search-user --as user` 的本质区别：后者在无人值守时必然拿不到 token。
   *
   * 返回 `{ name, email }` 或 `null`；权限不足只打日志，绝不发卡 —— 应用级
   * scope 用户点不出来，弹卡只会让人以为点一下就好了。
   */
  async function lookupViaBot(openId, account, log) {
    const { pending, result } = callCli(
      account,
      ["contact", "+get-user", "--user-id", openId, "--as", "bot", "--format", "json"],
      "get-user(bot)",
      log,
    );
    // 钩子只等 1200ms，但进程允许跑到 3000ms：这次没等到不代表白跑，
    // 跑完就把身份写进磁盘，下一次直接命中，不再付这 800ms。
    pending
      .then((done) => {
        const value = botUserFromEnvelope(done?.data, openId);
        if (value) writeIdentity(account, openId, { ...value, fetchedAt: Date.now(), source: "bot" });
      })
      .catch(() => {});
    try {
      const value = botUserFromEnvelope((await result)?.data, openId);
      if (!value) {
        // 有通讯录基本信息但没有邮箱：多半是应用级
        // `contact:user.email:readonly` 没开。这条用户自己授不出来，
        // 只能管理员在开放平台加。
        log.warn(`token injector: bot lookup has no email for ${openId} (app scope contact:user.email:readonly)`);
        return null;
      }
      return value;
    } catch (error) {
      log.warn(`token injector: bot lookup failed for ${openId}: ${error?.message ?? error}`);
      return null;
    }
  }

  /** 从 `contact +get-user` 的返回里取 `{ name, email }`；字段缺失返回 null。 */
  function botUserFromEnvelope(data, openId) {
    const envelope = data ?? {};
    const payload = envelope?.data && typeof envelope.data === "object" ? envelope.data : envelope;
    const user = payload?.user ?? payload?.data?.user ?? null;
    if (!user) return null;
    const email = String(user.enterprise_email || user.email || "");
    if (!email) return null;
    return { name: String(user.name || user.localized_name || ""), email };
  }

  /** 用户身份回源：`contact +search-user --user-ids <open_id> --as user`。 */
  async function lookupViaUser(openId, account, log, deadlineMs = LOOKUP_DEADLINE_MS) {
    try {
      const { result } = callCli(
        account,
        ["contact", "+search-user", "--user-ids", openId, "--as", "user", "--format", "json"],
        "search-user(user)",
        log,
        deadlineMs,
      );
      const envelope = (await result)?.data ?? {};
      const payload = envelope?.data && typeof envelope.data === "object" ? envelope.data : envelope;
      const users = Array.isArray(payload?.users) ? payload.users : [];
      const user = users.find((entry) => entry?.open_id === openId) ?? users[0];
      if (!user) return null;
      const email = String(user.enterprise_email || user.email || "");
      if (!email) return null;
      return { name: String(user.localized_name || user.name || ""), email };
    } catch (error) {
      // 缺通讯录权限时不在这里发卡片：只回一个带签名的失败标记，由
      // `auth-gate.mjs` 的 after_tool_call 钩子统一发卡 / 抑轮 / 授权后续跑。
      if (isScopeFailure?.(error)) {
        return { authFailure: authFailureReason(error) };
      }
      log.warn(`token injector: user lookup failed for ${openId}: ${error?.message ?? error}`);
      return null;
    }
  }

  async function lookupUser(openId, account, log) {
    const hit = userCache.get(openId);
    if (hit && Date.now() - hit.fetchedAt < userCacheTtlMs) return hit;
    if (!account) return null;

    // 磁盘缓存优先：命中就完全不 spawn CLI，这是定时任务的主路径。
    const stored = readIdentity(account, openId);
    if (stored) {
      userCache.set(openId, stored);
      return stored;
    }

    const coolingUntil = negativeCache.get(openId) ?? 0;
    if (Date.now() < coolingUntil) {
      log.debug?.(`token injector: ${openId} in negative cache, skipping lookup`);
      return null;
    }

    // bot 优先：它不需要用户点授权卡，定时任务也能用。
    const startedAt = Date.now();
    const viaBot = await lookupViaBot(openId, account, log);
    if (viaBot) {
      const value = { ...viaBot, fetchedAt: Date.now(), source: "bot" };
      userCache.set(openId, value);
      writeIdentity(account, openId, value);
      negativeCache.delete(openId);
      log.info(`token injector: resolved ${openId} -> ${value.name || "?"} <${value.email}> (bot)`);
      return value;
    }

    // 只剩不到 600ms 就别再试第二条路了：用户身份本身更慢，硬试只会把
    // 整个钩子撑过 1500ms 的预算，最后连 fail-open 都来不及。
    const remaining = LOOKUP_DEADLINE_MS - (Date.now() - startedAt);
    if (remaining < 600) {
      negativeCache.set(openId, Date.now() + negativeTtlMs);
      return null;
    }

    const viaUser = await lookupViaUser(openId, account, log, remaining);
    if (viaUser?.authFailure) return viaUser;
    if (viaUser) {
      const value = { ...viaUser, fetchedAt: Date.now(), source: "user" };
      userCache.set(openId, value);
      writeIdentity(account, openId, value);
      negativeCache.delete(openId);
      log.info(`token injector: resolved ${openId} -> ${value.name || "?"} <${value.email}> (user)`);
      return value;
    }

    negativeCache.set(openId, Date.now() + negativeTtlMs);
    return null;
  }

  async function fetchToken(username, openId, log) {
    const hit = tokenCache.get(openId);
    if (hit && Date.now() < hit.expiresAt) return hit.token;

    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS)
      : null;
    timer?.unref?.();
    try {
      const res = await fetch(tokenServiceUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, publicKey }),
        signal: controller?.signal,
      });
      if (!res.ok) {
        log.warn(`token injector: validateUser returned ${res.status}`);
        return null;
      }
      const data = await res.json();
      if (!data?.valid || !data?.token) {
        log.warn(`token injector: validateUser rejected ${username}: ${data?.message ?? "invalid"}`);
        return null;
      }
      tokenCache.set(openId, { token: data.token, expiresAt: Date.now() + tokenTtlMs });
      log.info(`token injector: token issued for ${username}`);
      return data.token;
    } catch (error) {
      log.warn(`token injector: validateUser failed: ${error?.message ?? error}`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const handler = async (payload) => {
    const toolName = String(payload?.tool_name ?? "");
    if (!TOOL_NAMES.includes(toolName)) return { action: "continue" };

    const channel = String(payload?.channel ?? "").trim().toLowerCase();
    if (channel && channel !== "feishu") return { action: "continue" };

    const openId = String(payload?.user_id ?? "").replace(/^feishu:/, "");
    if (!openId) return { action: "continue" };

    const params =
      payload?.params && typeof payload.params === "object" ? { ...payload.params } : {};

    const accounts = getAccounts();
    const wantedId = payload?.account_id;
    const fallback =
      accounts.find((entry) => entry.accountId === wantedId) ?? accounts[0] ?? null;
    // 是个具体的人就用他自己的 user token；`cronjob` 这类框架身份没有 user
    // token，仍走共享账号的 bot 路径（网关凭据注入依赖它，不能断）。
    const ownerId = /^ou_[A-Za-z0-9]+$/.test(openId) ? openId : "";
    const account = ownerId
      ? (resolveOwnerAccount?.(ownerId) ?? fallback)
      : fallback;
    const log = account ? logger.child(account.accountId) : logger;

    const user = await lookupUser(openId, account, log);
    if (user?.authFailure) {
      // 普通 shell 命令不该被通讯录授权卡拦住：缺身份时不注入，
      // 由 http_post 那条分支发起授权，授权后续跑时两条分支一起恢复。
      if (toolName === "shell") {
        log.warn("token injector: identity needs authorization; shell runs without gateway username");
        return { action: "continue" };
      }
      // Blocking is deliberate: letting the request through would 401 at the
      // gateway and the model would report an auth error instead of the card.
      // The reason carries the Feishu signature, so the shared authorization
      // gate recognises it and owns everything that happens next.
      // The marker tokens stay space-separated so the gate can parse them even
      // after the reason has been embedded into a JSON error string.
      const reason =
        `${user.authFailure} 本次网关调用未发出（缺少飞书通讯录权限），` +
        "等待用户完成授权后系统会自动继续。";
      return {
        // `block: true` is what the Orange shim actually honours; `action:
        // "block"` is the documented envelope and is forwarded for newer
        // shims. Sending both means the block cannot silently degrade into a
        // "modify with the original params" (which sent the request out with no
        // auth headers at all).
        block: true,
        blockReason: reason,
        action: "block",
        reason,
      };
    }
    const username = user?.email ? user.email.split("@")[0] || "" : "";
    if (!username) {
      log.warn(`token injector: no username for ${openId}, request goes out unauthenticated`);
      return { action: "continue" };
    }

    // shell 与 http_post 共用上面这一次身份解析：这里不铸 token，也不解析
    // 命令内容，只把「当前真人是谁」交给 orange，由它按该用户名铸 token
    // 并写进工作区凭据。无人值守轮次因此也拿到真人身份，而不是 cronjob。
    if (toolName === "shell") {
      log.info(`token injector: resolved ${username} for shell (${openId})`);
      return {
        action: "modify",
        payload: {
          ...payload,
          params: { ...params, [GATEWAY_USERNAME_PARAM]: username },
        },
      };
    }

    const url = String(params.url ?? "");
    if (!url) return { action: "continue" };
    if (targetUrlPrefix && !url.startsWith(targetUrlPrefix)) return { action: "continue" };

    const token = await fetchToken(username, openId, log);
    if (!token) return { action: "continue" };

    const headers = { ...(params.headers ?? {}), username, token, "X-User-Id": openId };
    // The builtin tool declares `body` as a string; skills hand it an object.
    let body = params.body;
    if (body !== null && body !== undefined && typeof body !== "string") {
      try {
        body = JSON.stringify(body);
        if (!headers["Content-Type"] && !headers["content-type"]) {
          headers["Content-Type"] = "application/json";
        }
      } catch {
        body = params.body;
      }
    }

    log.info(`token injector: injected ${username} -> ${url}`);
    return { action: "modify", payload: { ...payload, params: { ...params, url, headers, body } } };
  };

  api.registerHook("before_tool_call", handler, {
    name: HOOK_NAME,
    priority: HOOK_PRIORITY,
    tool_names: TOOL_NAMES,
  });
  return true;
}
