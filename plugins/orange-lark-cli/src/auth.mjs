/**
 * User-identity authorization for the `lark_cli` tool.
 *
 * Mirrors openclaw-lark's auto-auth experience without a card-callback server:
 *
 *   1. a tool call needs the user's own identity (`--as user`)
 *   2. `auth status --json` says the user identity is missing
 *   3. start a device flow (`auth login --no-wait --json`) and post the
 *      verification URL to the chat as an interactive card
 *   4. the tool returns `{ awaiting_authorization: true }` so this turn ends
 *   5. a background poller finishes the flow (`auth login --device-code …`) and
 *      the channel injects a synthetic "I'm authorized, please continue" message
 *
 * Why polling instead of a card button callback: the button is a plain URL
 * button, so Feishu never calls us back — the CLI's device-code poll is the
 * only completion signal. That keeps the plugin free of card-action routing.
 */

import { runCli } from "./cli.mjs";

const STATUS_TTL_MS = 5_000;
/** Device codes are valid for 10 minutes; poll a little past that. */
const DEVICE_LOGIN_TIMEOUT_MS = 11 * 60_000;

const statusCache = new Map();
/**
 * `${configDir}:${ownerOpenId}` -> { verificationUrl, deviceCode, expiresAt }
 *
 * 旧插件 openclaw-lark 用 `${appId}:${senderOpenId}` 作 device flow 与 token 的
 * 分片键。这里沿用同一个原则：账号目录只是「应用凭证」，**用户**才是授权态的
 * 单位。只按 configDir 分片时，同一个账号目录下的 A/B 会复用同一个 device
 * flow、互相覆盖授权结果。
 */
const pendingFlows = new Map();

function asNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * 所有按人状态的键。缺 owner 时退回账号级（单用户部署保持历史行为）。
 * owner 可以显式传入，也可以来自 `account.ownerUserId`。
 */
export function ownerStateKey(account, ownerUserId) {
  const base = account?.configDir ?? account?.accountId ?? "";
  const owner = asNonEmptyString(ownerUserId) || asNonEmptyString(account?.ownerUserId);
  return owner ? `${base}:${owner}` : base;
}

/** 从入站/工具上下文里挑出「人」：`ou_xxx`、`user:ou_xxx`、`feishu:ou_xxx`。 */
export function normalizeOwnerId(value) {
  let raw = asNonEmptyString(value);
  if (!raw) return "";
  raw = raw.replace(/^(?:feishu|user|chat):/i, "");
  // 会话 id（oc_）不能当人用。
  if (raw.startsWith("oc_")) return "";
  return /^ou_[A-Za-z0-9]+$/.test(raw) ? raw : "";
}

/**
 * Domains accepted by `lark-cli auth login --domain`, which double as the first
 * argv token of the matching command family.
 */
const KNOWN_DOMAINS = new Set([
  "application",
  "approval",
  "apps",
  "attendance",
  "base",
  "calendar",
  "contact",
  "docs",
  "drive",
  "event",
  "im",
  "mail",
  "markdown",
  "mindnotes",
  "minutes",
  "note",
  "okr",
  "sheets",
  "slides",
  "task",
  "vc",
  "wiki",
]);

/**
 * Which scopes to request, derived from the command the model was about to run.
 * `docs` also needs `drive`: creating a document writes into the user's space.
 */
export function domainsForArgv(argv) {
  const head = String(argv?.[0] ?? "").toLowerCase();
  if (head === "docs") return ["docs", "drive"];
  if (head === "drive") return ["drive", "docs"];
  if (KNOWN_DOMAINS.has(head)) return [head];
  return ["docs", "drive"];
}

export function argvWantsUserIdentity(argv) {
  return argv?.some((token, index) => token === "--as" && argv[index + 1] === "user");
}

export function argvHasExplicitIdentity(argv) {
  return argv?.some((token) => token === "--as");
}

/** `docs +create` belongs in the caller's own space, not the bot's. */
export function wantsUserIdentityByDefault(argv) {
  return argv?.[0] === "docs" && argv?.[1] === "+create";
}

export async function readAuthStatus(account, { force = false, log, ownerUserId } = {}) {
  const key = `${account.cliPath}|${ownerStateKey(account, ownerUserId)}`;
  const cached = statusCache.get(key);
  if (!force && cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.value;

  // `--verify` asks the server. Without it the CLI only reads the local token
  // file: a user who revokes the app in the Feishu client still looks
  // "authorized" here, the gate waves the call through, and the failure only
  // shows up one command later. The local file is a cache, not the truth.
  const result = await runCli({
    cliPath: account.cliPath,
    configDir: account.configDir,
    cwd: account.scratchDir,
    args: ["auth", "status", "--json", "--verify"],
    timeoutMs: 20_000,
    env: account.env,
    log,
  });

  const raw = result.data ?? {};
  const user = raw?.identities?.user ?? {};
  // Server-verified scope list, space separated. Kept as a Set so callers can
  // ask "which of these are actually granted" instead of trusting a cached flag.
  const grantedScopes = new Set(
    String(user.scope ?? "")
      .split(/\s+/)
      .filter(Boolean),
  );

  // 旧插件 openclaw-lark/oauth.ts 的 `verifyTokenIdentity`：device flow 换回
  // token 后用 UAT 调 `authen/v1/user_info`，确认「实际授权人 == 发起授权的人」，
  // 否则拒绝落盘 —— 防的就是「群聊里另一个人点了授权链接，token 被绑到 owner
  // 身上」。lark-cli 的 `auth status --verify` 已经做过服务端校验并把 openId
  // 放在 `identities.user.openId`，直接比对就是同一道闸门。
  const expectedOwner =
    normalizeOwnerId(ownerUserId) || normalizeOwnerId(account?.ownerUserId);
  const tokenOwner = normalizeOwnerId(user.openId ?? user.open_id ?? user.userOpenId);
  const ownerMismatch = Boolean(expectedOwner && tokenOwner && tokenOwner !== expectedOwner);
  if (ownerMismatch) {
    log?.warn?.(
      `refusing a user token that belongs to ${tokenOwner} for ${expectedOwner}; ` +
        "this account must authorize with its own Feishu identity",
    );
  }

  const value = {
    raw,
    // 别人的 token 不算「这个人已授权」，否则 A 授权完 B 会被直接免询。
    userReady: Boolean(user.available) && user.verified !== false && !ownerMismatch,
    userStatus: ownerMismatch ? "wrong_user" : (user.status ?? "unknown"),
    botReady: Boolean(raw?.identities?.bot?.available),
    appId: raw?.appId,
    grantedScopes,
    tokenOwner,
    expectedOwner,
    ownerMismatch,
    verifiedAt: Date.now(),
  };
  // Publish a tiny state file so Orange can decide "already authorized → just
  // send the brief, don't ask again" *before* the first run, instead of
  // discovering it after a tool call fails.
  //
  // `user_open_id` 是 Rust 侧按人判定的依据：只有 token 属于这个收件人时才免
  // 掉他的征询。缺这个字段时，共享账号目录里 A 的授权会被算到 B 头上。
  try {
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    if (account.configDir) {
      writeFileSync(
        join(account.configDir, "auth-state.json"),
        JSON.stringify({
          checked_at: Date.now(),
          user_ready: value.userReady,
          user_status: value.userStatus,
          user_open_id: tokenOwner || null,
          owner_user_id: expectedOwner || null,
        }),
      );
    }
  } catch {
    // Best-effort: a missing state file only costs one extra consent prompt.
  }

  statusCache.set(key, { at: Date.now(), value });
  return value;
}

export function invalidateAuthStatus(account, ownerUserId) {
  statusCache.delete(`${account.cliPath}|${ownerStateKey(account, ownerUserId)}`);
}

/**
 * Start (or reuse) a device flow for this account.
 *
 * Returns the verification URL to show the user. Reusing a live flow keeps one
 * card per pending authorization instead of one per tool call.
 */
export async function startDeviceFlow(account, domains, { scopes, log, ownerUserId } = {}) {
  const key = ownerStateKey(account, ownerUserId);
  // Returned object identity matters: callers annotate it (`cardSent`,
  // `cardId`) so a second tool call reuses the same card instead of spamming.
  const pending = pendingFlows.get(key);
  // Reuse only when the live flow already covers everything we now need.
  // 判据必须落在 **scopes** 上：只比 domains 时，两次请求同属 `im` 域但 scope
  // 清单不同（先 `im:message:readonly`，后 `im:chat:read`）也会复用旧 flow ——
  // 用户点完发现新权限还是没授，于是又来一张卡。
  const covers = (flow) => {
    const wantedScopes = new Set(scopes ?? []);
    if (wantedScopes.size) {
      const held = new Set(flow.scopes ?? []);
      return [...wantedScopes].every((scope) => held.has(scope));
    }
    if (!domains?.length) return true;
    const heldDomains = new Set(flow.domains ?? []);
    return domains.every((domain) => heldDomains.has(domain));
  };
  // 卡片已经翻成「已过期」的 flow 不能再复用：用户点的是一张按钮已撤掉的旧卡。
  if (pending && !pending.expired && pending.expiresAt > Date.now() && covers(pending)) {
    pending.reused = true;
    return pending;
  }

  const args = ["auth", "login", "--no-wait", "--json"];
  if (scopes?.length) {
    // Precise scopes beat `--domain`: a domain is a bundle, and `--domain im`
    // ships "upload image/file" with it, which a daily brief never needs.
    //
    // ONE `--scope`, comma separated. `--scope` is a single-string flag in
    // lark-cli (only `--domain` is repeatable), so `--scope a --scope b …`
    // silently keeps just the last value: the consent page showed a single
    // 「云文档」 row and the token came back with one scope out of nine.
    args.push("--scope", scopes.join(","));
  } else if (domains?.length) {
    args.push("--domain", domains.join(","));
  }

  const result = await runCli({
    cliPath: account.cliPath,
    configDir: account.configDir,
    cwd: account.scratchDir,
    args,
    timeoutMs: 30_000,
    env: account.env,
    log,
  });

  const data = result.data ?? {};
  if (!data.device_code || !data.verification_url) {
    throw new Error("lark-cli auth login did not return a device code");
  }
  const flow = {
    deviceCode: data.device_code,
    verificationUrl: data.verification_url,
    expiresIn: Number(data.expires_in) > 0 ? Number(data.expires_in) : 600,
    expiresAt: Date.now() + (Number(data.expires_in) > 0 ? Number(data.expires_in) : 600) * 1_000,
    domains,
    // What we actually asked for. The card must show this rather than `domains`:
    // a domain bundle is not what the consent page lists, and telling the user
    // "im, calendar, task, approval" when only three scopes were requested reads
    // as a bait-and-switch.
    scopes: scopes?.length ? [...scopes] : null,
  };
  pendingFlows.set(key, flow);
  return flow;
}

export function clearDeviceFlow(account, ownerUserId) {
  pendingFlows.delete(ownerStateKey(account, ownerUserId));
}

/** Blocking poll; resolves once the user finishes (or throws on expiry). */
export async function completeDeviceFlow(account, deviceCode, { log } = {}) {
  return runCli({
    cliPath: account.cliPath,
    configDir: account.configDir,
    cwd: account.scratchDir,
    args: ["auth", "login", "--device-code", deviceCode],
    timeoutMs: DEVICE_LOGIN_TIMEOUT_MS,
    env: account.env,
    log,
  });
}

/**
 * CardKit v2 card: same shape openclaw-lark ships, so the user sees the same
 * authorization prompt. A CardKit entity (rather than a static v1 card) is what
 * lets us flip the same message to "已授权" after the device flow completes.
 */
export function buildAuthCardV2({
  verificationUrl,
  expiresIn = 600,
  reason,
  state = "pending",
  scopes = [],
}) {
  const minutes = Math.max(1, Math.round(expiresIn / 60));
  const multiUrl = {
    url: verificationUrl,
    pc_url: "",
    android_url: "",
    ios_url: "",
  };

  if (state === "done") {
    return {
      schema: "2.0",
      config: { wide_screen_mode: true, update_multi: true },
      header: { template: "green", title: { tag: "plain_text", content: "✅ 已完成飞书授权" } },
      body: {
        elements: [
          { tag: "markdown", content: "已以你的身份完成授权，正在继续刚才的操作…" },
        ],
      },
    };
  }

  if (state === "expired") {
    // 旧插件的授权窗口有生命周期：10 分钟后同一张卡片原地变成「已过期」，
    // 「去授权」按钮必须一起拿掉，否则用户点开的是一个早已失效的 device code。
    return {
      schema: "2.0",
      config: { wide_screen_mode: true, update_multi: true },
      header: { template: "grey", title: { tag: "plain_text", content: "⏱ 授权链接已过期" } },
      body: {
        elements: [
          {
            tag: "markdown",
            content: `这张授权卡片已超过 **${minutes} 分钟**有效期，链接和按钮都不再可用。`,
          },
          {
            tag: "markdown",
            content: "需要继续的话，直接发一句话，我会重新发起一次授权。",
            text_size: "notation",
          },
        ],
      },
    };
  }

  if (state === "failed") {
    return {
      schema: "2.0",
      config: { wide_screen_mode: true, update_multi: true },
      header: { template: "orange", title: { tag: "plain_text", content: "⚠️ 授权未完成" } },
      body: {
        elements: [
          {
            tag: "markdown",
            content: "授权链接已过期或被取消。需要的话直接说一声，我再发一张新的授权卡片。",
          },
        ],
      },
    };
  }

  return {
    schema: "2.0",
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: "blue", title: { tag: "plain_text", content: "🔐 需要完成一次飞书授权" } },
    body: {
      elements: [
        {
          tag: "markdown",
          content:
            (reason ? `${reason}\n\n` : "") +
            "为了**以你本人身份**执行这项操作（例如把文档建到你自己的云空间），需要你完成一次授权登录。",
        },
        // Transparency for security review: show exactly which domains are
        // requested, and that it is a closed set — not "everything Feishu has".
        ...(scopes.length
          ? [
              {
                tag: "markdown",
                content: `本次仅申请：${scopes.map((scope) => `\`${scope}\``).join("、")}。点一次即可，不用逐项授权。`,
              },
            ]
          : []),
        { tag: "hr" },
        {
          tag: "button",
          text: { tag: "plain_text", content: "去授权" },
          type: "primary",
          multi_url: multiUrl,
        },
        {
          tag: "markdown",
          content: `链接 **${minutes} 分钟**内有效。授权完成后我会自动继续，这张卡片也会变成「已完成」。\n若按钮无效，可复制：${verificationUrl}`,
        },
      ],
    },
  };
}

// Card entity helpers live in cardkit.mjs; re-exported so callers keep a single
// import site for "authorization" concerns.
export { createCard as createCardEntity, updateCard as updateCardEntity } from "./cardkit.mjs";

/**
 * Interactive card (v1 schema) with a URL button, accepted by im/v1/messages.
 * Fallback when CardKit is unavailable; it renders the same prompt but cannot
 * be updated in place, so completion is reported by a follow-up message.
 */
export function buildAuthCard({ verificationUrl, expiresIn = 600, reason }) {
  const minutes = Math.max(1, Math.round(expiresIn / 60));
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "需要完成一次飞书授权" },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content:
            (reason ? `${reason}\n\n` : "") +
            "为了**以你本人身份**执行这项操作（例如把文档建到你自己的云空间），" +
            "需要你完成一次授权登录。",
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "去授权" },
            type: "primary",
            url: verificationUrl,
          },
        ],
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: `链接 ${minutes} 分钟内有效。授权完成后我会自动继续，无需再发消息。若按钮无效可复制：${verificationUrl}`,
          },
        ],
      },
    ],
  };
}
