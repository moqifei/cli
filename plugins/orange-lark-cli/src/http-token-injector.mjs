/**
 * http-token-injector — 给 `http_get` / `http_post` 注入网关 token。
 *
 * Ported from openclaw-lark/src/hook/http-token-injector.ts. The old plugin read
 * the sender's email from a cache filled at message-receive time; this one also
 * supports that path: `prefetchInboundIdentity()` is called by the channel when a
 * real Feishu message arrives, using the exact bot account that received it.
 *
 * Flow:
 *   1. 用户主动消息 -> index.mjs calls prefetchInboundIdentity(account, senderOpenId)
 *      -> `contact +get-user --as bot` with the current bot account
 *      -> write identity into account-scoped disk cache and in-memory cache
 *      -> put `SenderUsername` into the inbound context for Orange
 *   2. before_tool_call -> http_get / http_post / shell, only `feishu` channel
 *      -> prefer the prefetched/cached identity (no extra CLI roundtrip)
 *      -> if missing (cron / passive / cold start), lazily resolve identity here
 *   3. http_get/http_post: POST {username, publicKey} to the token service
 *      -> {valid, token} (cached), inject username/token/X-User-Id headers
 *   4. shell: hand the same real username to orange's gateway-token service
 *      (`__gateway_username` param). It mints the token and writes
 *      `ORANGE_HTTP_*` / `.orange_http_token.json` for scripts that make raw
 *      HTTP calls.
 *
 * Cache identity is `${accountId}:${openId}` so the same human talking to two
 * different bots cannot reuse an identity resolved by the wrong app. The disk
 * cache remains per account directory (`token-identity-cache.json`).
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
 * 钩子总预算 1500ms（`BEFORE_TOOL_CALL_HOOK_TIMEOUT_MS`），一次 bot 回源实测约
 * 835ms。用户主动消息在入站时已经预取，正常不会走这里；这里只服务 cron / 被动
 * 触发 / 冷启动，所以仍保留 1200ms 的兜底预算。
 */
const LOOKUP_DEADLINE_MS = 1200;
const LOOKUP_PROCESS_TIMEOUT_MS = 3000;
const TOKEN_TIMEOUT_MS = 900;
/** 磁盘身份缓存：邮箱基本不变，7 天足够把 CLI 调用摊薄到几乎为零。 */
const DEFAULT_IDENTITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IDENTITY_CACHE_FILE = "token-identity-cache.json";

/** `${accountId}:${openId}` -> { name, email, fetchedAt, source } */
const userCache = new Map();
/** `${accountId}:${openId}` -> { token, expiresAt } */
const tokenCache = new Map();
/** `${accountId}:${openId}` -> 失败冷却截止时间 */
const negativeCache = new Map();
/** 入站 prefetch 正在跑的 Promise，避免 hook 和 prefetch 重复 spawn CLI。 */
const prefetching = new Map();

function identityKey(account, openId) {
  const accountId = String(account?.accountId ?? account?.configDir ?? "default");
  return `${accountId}:${openId}`;
}

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
 * 本模块不自己发授权卡片：缺 scope 时返回带签名的 block reason，交给
 * `auth-gate.mjs` 的 after_tool_call 钩子统一发卡、抑轮和续跑。
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

// ---- 磁盘身份缓存：按账号目录落盘，进程内缓存按 accountId:openId ----

function identityFile(account) {
  return path.join(account?.configDir ?? "", IDENTITY_CACHE_FILE);
}

function loadIdentityCache(account) {
  const key = `${String(account?.accountId ?? "default")}|${String(account?.configDir ?? "")}`;
  const hit = identityCacheByAccount.get(key);
  if (hit && Date.now() - hit.loadedAt < 60_000) return hit.users;
  let users = {};
  try {
    users = JSON.parse(readFileSync(identityFile(account), "utf8")) ?? {};
  } catch {
    users = {};
  }
  identityCacheByAccount.set(key, { loadedAt: Date.now(), users });
  return users;
}

const identityCacheByAccount = new Map();

function readIdentity(account, openId, identityTtlMs = DEFAULT_IDENTITY_TTL_MS) {
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
  const key = `${String(account?.accountId ?? "default")}|${String(account?.configDir ?? "")}`;
  identityCacheByAccount.set(key, { loadedAt: Date.now(), users });
  try {
    mkdirSync(account.configDir, { recursive: true });
    writeFileSync(identityFile(account), JSON.stringify(users), { mode: 0o600 });
  } catch (error) {
    loggerFor(account)?.warn?.(`token injector: cannot persist identity cache: ${error?.message ?? error}`);
  }
}

function loggerFor(account) {
  return account?.__logger ?? null;
}

function callCli({ account, runCli, args, label, log, deadlineMs = LOOKUP_DEADLINE_MS }) {
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

/**
 * 应用身份回源：`contact +get-user --user-id <open_id> --as bot`。
 *
 * 用传入的 account 的 tenant token；用户主动消息由入站侧传入“当前机器人账号”，
 * 因此不会再出现拿第一个账号模板去查别人通讯录的问题。
 */
async function lookupViaBot({ openId, account, runCli, log }) {
  const { pending, result } = callCli({
    account,
    runCli,
    args: ["contact", "+get-user", "--user-id", openId, "--as", "bot", "--format", "json"],
    label: "get-user(bot)",
    log,
  });
  pending
    .then((done) => {
      const value = botUserFromEnvelope(done?.data, openId);
      if (value) writeIdentity(account, openId, { ...value, fetchedAt: Date.now(), source: "bot" });
    })
    .catch(() => {});
  try {
    const value = botUserFromEnvelope((await result)?.data, openId);
    if (!value) {
      log?.warn?.(`token injector: bot lookup has no email for ${openId} (app scope contact:user.email:readonly)`);
      return null;
    }
    return value;
  } catch (error) {
    log?.warn?.(`token injector: bot lookup failed for ${openId}: ${error?.message ?? error}`);
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

/**
 * 用户主动消息入口：在当前机器人账号下预取 sender 身份。
 *
 * 这是给 index.mjs 在 dispatch 前调用的。它只做 bot/应用身份回源，不创建
 * per-user 账号，不触碰 accounts[0]，因此不会把 A 机器人的通讯录能力借给 B。
 */
export function prefetchInboundIdentity({ account, openId, runCli, log, identityTtlMs = DEFAULT_IDENTITY_TTL_MS }) {
  if (!account || !openId || !/^ou_[A-Za-z0-9]+$/.test(openId)) return Promise.resolve(null);
  const key = identityKey(account, openId);
  const cached = getCachedIdentity(account, openId, identityTtlMs);
  if (cached) return Promise.resolve(cached);
  const running = prefetching.get(key);
  if (running) return running;

  const task = (async () => {
    try {
      const value = await lookupViaBot({ openId, account, runCli, log });
      if (!value) return null;
      const resolved = { ...value, fetchedAt: Date.now(), source: "bot" };
      userCache.set(key, resolved);
      writeIdentity(account, openId, resolved);
      log?.info?.(`token injector: prefetched ${openId} -> ${resolved.name || "?"} <${resolved.email}> (${account.accountId})`);
      return resolved;
    } catch (error) {
      log?.warn?.(`token injector: prefetch failed for ${openId}: ${error?.message ?? error}`);
      return null;
    } finally {
      prefetching.delete(key);
    }
  })();
  prefetching.set(key, task);
  return task;
}

/** 读进程内/当前账号磁盘缓存；cron 和 lazy hook 都先走这里。 */
export function getCachedIdentity(account, openId, identityTtlMs = DEFAULT_IDENTITY_TTL_MS) {
  if (!account || !openId) return null;
  const key = identityKey(account, openId);
  const hit = userCache.get(key);
  if (hit && Date.now() - Number(hit.fetchedAt ?? 0) < identityTtlMs) return hit;
  const stored = readIdentity(account, openId, identityTtlMs);
  if (stored) {
    userCache.set(key, stored);
    return stored;
  }
  return null;
}

/** hook 里等一小会儿入站 prefetch，避免 prefetch 与工具调用竞态。 */
export async function waitForIdentityPrefetch(account, openId, timeoutMs = 200) {
  if (!account || !openId || timeoutMs <= 0) return null;
  const running = prefetching.get(identityKey(account, openId));
  if (!running) return null;
  try {
    return await withTimeout(running, timeoutMs, "identity prefetch");
  } catch {
    return null;
  }
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
  const identityTtlMs = Number(cfg.identity_ttl_ms) || DEFAULT_IDENTITY_TTL_MS;
  const negativeTtlMs = Number(cfg.negative_ttl_ms) || DEFAULT_NEGATIVE_TTL_MS;
  const targetUrlPrefix = String(cfg.target_url_prefix ?? "http://");

  if (!tokenServiceUrl || !publicKey) {
    logger.warn("http_token_injector not configured — gateway token injection disabled");
    return false;
  }

  logger.info(`http_token_injector ready: ${tokenServiceUrl} (ttl=${tokenTtlMs}ms, prefix=${targetUrlPrefix})`);

  /** 用户身份回源：`contact +search-user --user-ids <open_id> --as user`。 */
  async function lookupViaUser(openId, account, log, deadlineMs = LOOKUP_DEADLINE_MS) {
    try {
      const { result } = callCli({
        account,
        runCli,
        args: ["contact", "+search-user", "--user-ids", openId, "--as", "user", "--format", "json"],
        label: "search-user(user)",
        log,
        deadlineMs,
      });
      const envelope = (await result)?.data ?? {};
      const payload = envelope?.data && typeof envelope.data === "object" ? envelope.data : envelope;
      const users = Array.isArray(payload?.users) ? payload.users : [];
      const user = users.find((entry) => entry?.open_id === openId) ?? users[0];
      if (!user) return null;
      const email = String(user.enterprise_email || user.email || "");
      if (!email) return null;
      return { name: String(user.localized_name || user.name || ""), email };
    } catch (error) {
      if (isScopeFailure?.(error)) return { authFailure: authFailureReason(error) };
      log.warn(`token injector: user lookup failed for ${openId}: ${error?.message ?? error}`);
      return null;
    }
  }

  async function lookupUser(openId, account, log, userAccount = account) {
    const key = identityKey(account, openId);
    const hit = userCache.get(key);
    if (hit && Date.now() - Number(hit.fetchedAt ?? 0) < identityTtlMs) return hit;
    if (!account) return null;

    const stored = readIdentity(account, openId, identityTtlMs);
    if (stored) {
      userCache.set(key, stored);
      return stored;
    }

    const coolingUntil = negativeCache.get(key) ?? 0;
    if (Date.now() < coolingUntil) {
      log.debug?.(`token injector: ${openId} in negative cache, skipping lookup`);
      return null;
    }

    // bot 优先：用当前消息所属账号，不再用 owner/per-user 的 accounts[0] 模板。
    const startedAt = Date.now();
    const viaBot = await lookupViaBot({ openId, account, runCli, log });
    if (viaBot) {
      const value = { ...viaBot, fetchedAt: Date.now(), source: "bot" };
      userCache.set(key, value);
      writeIdentity(account, openId, value);
      negativeCache.delete(key);
      log.info(`token injector: resolved ${openId} -> ${value.name || "?"} <${value.email}> (bot)`);
      return value;
    }

    const remaining = LOOKUP_DEADLINE_MS - (Date.now() - startedAt);
    if (remaining < 600) {
      negativeCache.set(key, Date.now() + negativeTtlMs);
      return null;
    }

    // user 兜底：只有确实需要 UAT 时才用这个人自己的 per-user 账号。
    const viaUser = await lookupViaUser(openId, userAccount ?? account, log, remaining);
    if (viaUser?.authFailure) return viaUser;
    if (viaUser) {
      const value = { ...viaUser, fetchedAt: Date.now(), source: "user" };
      userCache.set(key, value);
      writeIdentity(account, openId, value);
      if (userAccount && userAccount !== account) writeIdentity(userAccount, openId, value);
      negativeCache.delete(key);
      log.info(`token injector: resolved ${openId} -> ${value.name || "?"} <${value.email}> (user)`);
      return value;
    }

    negativeCache.set(key, Date.now() + negativeTtlMs);
    return null;
  }

  async function fetchToken(username, cacheKey, log) {
    const hit = tokenCache.get(cacheKey);
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
      tokenCache.set(cacheKey, { token: data.token, expiresAt: Date.now() + tokenTtlMs });
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
    // bot 身份固定用当前消息所属账号；owner/per-user 只服务需要 UAT 的 user 兜底。
    const ownerId = /^ou_[A-Za-z0-9]+$/.test(openId) ? openId : "";
    const userAccount = ownerId
      ? resolveOwnerAccount?.(ownerId, fallback?.accountId) ?? fallback
      : fallback;
    const account = fallback;
    const log = account ? logger.child(account.accountId) : logger;

    // 用户主动消息在入站时通常已经 prefetch；这里只等很短一会让 prefetch 落地，
    // 没等到就继续走 lazy（cron / 被动触发的主路径）。
    await waitForIdentityPrefetch(account, openId, 200);

    const user = await lookupUser(openId, account, log, userAccount);
    if (user?.authFailure) {
      if (toolName === "shell") {
        log.warn("token injector: identity needs authorization; shell runs without gateway username");
        return { action: "continue" };
      }
      const reason =
        `${user.authFailure} 本次网关调用未发出（缺少飞书通讯录权限），` +
        "等待用户完成授权后系统会自动继续。";
      return {
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

    const token = await fetchToken(username, identityKey(account, openId), log);
    if (!token) return { action: "continue" };

    const headers = { ...(params.headers ?? {}), username, token, "X-User-Id": openId };
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
