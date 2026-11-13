/**
 * 通用飞书授权门（auth gate）。
 *
 * 之前的实现散在 `index.mjs` 里：只有 `lark_cli` / `feishu_*` / http 注入器
 * 会主动调 `ensureUserAuthorized`，也就是说「缺权限 → 弹授权卡片 → 授权后回到
 * 原会话续跑」这件事，是**每个工具各自实现一遍**的。旧插件
 * (`openclaw-lark/src/tools/auto-auth.ts`) 也一样：`handleInvokeErrorWithAutoAuth`
 * 必须被每个工具显式调用，漏调就没有卡片。
 *
 * 本模块把这件事收敛成两个层次：
 *
 *   1. **纯函数 + 状态**：`ensureUserAuthorized()`。工具层可以直接调用它做
 *      「调用前预检」（精确到 argv，能算准要申请哪些 scope）。
 *   2. **`after_tool_call` 钩子**：`registerAuthHooks()`。任何工具（本插件的、
 *      内置的、别的插件的）返回「飞书授权类错误」时，钩子都会：
 *        - 在当前会话发出授权卡片（CardKit 实体，授权完成后原地变「已完成」）
 *        - 把工具结果改写成「本轮到此为止」的指令，模型不会再重试/绕路/罗列 scope
 *        - 后台轮询 device flow，完成后用合成消息回到**同一个会话上下文**续跑
 *
 * 有了第 2 层，新加工具不需要再接线：只要它失败时把飞书原始错误透出来即可。
 *
 * 关于钩子预算：Orange 的 `AfterToolCall` 同步预算是 120ms（`policy.rs`
 * `HOOK_SYNC_TIMEOUT_MS`），发卡片要 ~1s，所以卡片一律 **fire-and-forget**，
 * 钩子只做「识别 + 改写 + 起后台任务」三件同步事。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAuthCard,
  buildAuthCardV2,
  clearDeviceFlow,
  completeDeviceFlow,
  createCardEntity,
  domainsForArgv,
  invalidateAuthStatus,
  normalizeOwnerId,
  readAuthStatus,
  startDeviceFlow,
  updateCardEntity,
} from "./auth.mjs";
import { runCli } from "./cli.mjs";
import { sendCard, sendText } from "./outbound.mjs";

/** 等授权时唯一允许发给用户的一句话（渠道投递门也会用它替换模型输出）。 */
export const AUTH_WAIT_LINE = "授权卡片已发送，点一下「去授权」，完成后我继续。";

/** 同一账号 30s 内不重复发起 device flow（卡片本身另有 pending 复用）。 */
const GATE_COOLDOWN_MS = 30_000;
/** 会话记忆的有效期：超过这个时间的旧会话不再用来决定卡片发往哪里。 */
const CHAT_MEMORY_TTL_MS = 30 * 60_000;
/** 授权门对某一轮的抑制有效期。 */
const TURN_GATE_TTL_MS = 10 * 60_000;
/** 旧插件的授权窗口也是 10 分钟：到期就把卡片翻成「已过期」，按钮不再可点。 */
export const AUTH_CARD_TTL_MS = 10 * 60_000;
/** 刚授权完的这段时间内，同类「无明确缺口」的报错不再触发新卡片。 */
const POST_AUTH_SUPPRESSION_MS = 10 * 60_000;
/** `readAuthStatus` 快照的有效期（钩子只有 120ms，不能现跑 CLI）。 */
const VERIFIED_AUTH_TTL_MS = 15 * 60_000;

// ── 状态 ────────────────────────────────────────────────────────────────

/** accountId -> AccountRuntime（授权完成后要用它注入合成消息续跑）。 */
const runtimesByAccount = new Map();
/** 正在轮询的 device code，避免同一 flow 被轮询两次。 */
const pollingDeviceCodes = new Set();
/** 本轮被授权门拦下的 MessageSid -> 时间戳。 */
const authGatedTurns = new Map();
/** configDir -> 最近一个**私聊**会话（定时任务没有入站上下文时用）。 */
const lastDirectChats = new Map();
/** configDir -> 用户最近一条原话，授权后续跑要用它恢复意图。 */
const lastTurnText = new Map();
/** `configDir:senderId` -> 该用户最近一次会话。 */
const chatBySender = new Map();
/** `configDir:sessionKey` -> 该会话的地址，钩子没有入站上下文时靠它定位。 */
const chatBySession = new Map();
/** `configDir:kind` -> 上次发起授权门的时间。 */
const lastGateAt = new Map();
/** configDir -> 最近一次服务端验证过的授权快照（同步可读）。 */
const verifiedAuthByAccount = new Map();
/** configDir -> 最近一次 device flow 成功的时间。 */
const lastAuthorizedAt = new Map();
/** configDir -> 该账号当前待授权卡片的到期定时器。 */
const cardExpiryTimers = new Map();

/**
 * 由 `index.mjs` 注入：`(ownerOpenId, fallbackAccount) => account`。
 *
 * 旧插件把 user token 按 `(appId, senderOpenId)` 分片；本插件的 token 由
 * lark-cli 存在 `LARKSUITE_CLI_CONFIG_DIR` 里，所以等价做法是按 owner 准备一个
 * 独立目录。授权门必须拿到「这个人自己的」账号，绝不能退回到共享的默认账号
 * 借用别人的 user token。
 */
let ownerAccountResolver = null;
export function setOwnerAccountResolver(fn) {
  ownerAccountResolver = typeof fn === "function" ? fn : null;
}

/** 每次 `readAuthStatus` 都留一份同步快照，供 120ms 预算的 after_tool_call 钩子读。 */
function noteVerifiedAuth(account, status) {
  const key = accountChatKey(account);
  if (!key) return;
  verifiedAuthByAccount.set(key, {
    at: Date.now(),
    userReady: Boolean(status?.userReady),
    granted: status?.grantedScopes ?? new Set(),
  });
}

function verifiedAuth(account) {
  const entry = verifiedAuthByAccount.get(accountChatKey(account));
  if (!entry || Date.now() - entry.at > VERIFIED_AUTH_TTL_MS) return null;
  return entry;
}

export function registerRuntime(accountId, runtime) {
  if (!accountId || !runtime) return;
  runtimesByAccount.set(accountId, runtime);
}

export function unregisterRuntime(accountId) {
  if (!accountId) return;
  runtimesByAccount.delete(accountId);
}

// ── 轮次级抑制（避免模型输出「半份结果 + 待授权」） ──────────────────────

export function markTurnGated(turnId) {
  if (!turnId) return;
  authGatedTurns.set(String(turnId), Date.now());
}

export function isTurnGated(turnId) {
  if (!turnId) return false;
  const key = String(turnId);
  const at = authGatedTurns.get(key);
  if (!at) return false;
  if (Date.now() - at > TURN_GATE_TTL_MS) {
    authGatedTurns.delete(key);
    return false;
  }
  return true;
}

export function clearTurnGate(turnId) {
  if (turnId) authGatedTurns.delete(String(turnId));
}

// ── 会话记忆 ────────────────────────────────────────────────────────────

/**
 * 所有会话/授权状态的键都要带上「人」。
 *
 * 旧插件的 pending flow、防抖队列、token 全是 `${accountId}:${senderOpenId}`。
 * 只按 configDir 分片时，A 的授权快照、最近私聊、卡片定时器会被 B 直接读到 ——
 * 这就是「A 点同意，B 也变成同意」的存储层原因。
 */
export function accountChatKey(account, ownerUserId) {
  // 用「渠道账号 + 人」而不是 configDir：入站记忆由渠道账号写入，授权门用的
  // 是按人目录账号，两者 configDir 不同。统一到 runtimeAccountId 才能查到同一份
  // 会话记忆。
  const base =
    account?.runtimeAccountId ?? account?.accountId ?? account?.configDir ?? "";
  const owner =
    normalizeOwnerId(ownerUserId) || normalizeOwnerId(account?.ownerUserId);
  return owner ? `${base}:${owner}` : base;
}

function asString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function fresh(entry, ttl = CHAT_MEMORY_TTL_MS) {
  return Boolean(entry) && Date.now() - (entry.at ?? 0) < ttl;
}

/** map 下标统一：优先 open_id，兼容非 ou_ 的 sender id。 */
function senderSlot(value) {
  return normalizeOwnerId(value) || String(value ?? "").replace(/^feishu:/i, "").trim();
}

/**
 * 记录一次入站：
 *
 * - 会话地址按 **sessionKey** 和 **senderId** 双写，`after_tool_call` 钩子拿不到
 *   chat id（Orange 的 `ToolResultPayload` 只有 session/user/account），只能靠这两
 *   条线索把卡片送回「当前这个会话」。
 * - 私聊地址单独记一份，作为定时任务 / 主动触达的兜底。
 * - 用户原话单独记一份，授权后续跑时用它恢复意图（工具上下文里的 body 不可靠）。
 */
export function rememberTurn(account, inboundContext) {
  if (!account || !inboundContext) return;
  const rawSenderId = inboundContext.SenderId ?? inboundContext.sender_id;
  const slot = senderSlot(rawSenderId);
  const key = accountChatKey(account, normalizeOwnerId(rawSenderId));
  if (!key) return;

  const synthetic = inboundContext.Synthetic === true;
  const chatId = inboundContext.ChatId ?? inboundContext.chat_id;
  const chatType =
    (inboundContext.ChatType ?? inboundContext.chat_type) === "group" ? "group" : "direct";
  const sessionKey = inboundContext.SessionKey ?? inboundContext.session_key;

  const entry = {
    chatId,
    senderId: rawSenderId,
    chatType,
    agentId: inboundContext.AgentId ?? inboundContext.agent_id,
    sessionKey,
    messageId: inboundContext.MessageSid ?? inboundContext.MessageId,
    accountId: account.accountId,
    at: Date.now(),
  };

  if (slot) chatBySender.set(`${key}:${slot}`, entry);
  if (sessionKey) chatBySession.set(`${key}:${sessionKey}`, entry);
  // 「最近私聊」也必须按人存：账号级单条记录会让定时任务把 A 的授权卡发给
  // 刚刚说过话的 B（旧插件完全没有这种全局兜底）。
  if (chatType !== "group" && slot) lastDirectChats.set(`${key}:${slot}`, entry);

  const body = inboundContext.Body ?? inboundContext.RawBody;
  if (!synthetic && typeof body === "string" && body.trim()) {
    lastTurnText.set(key, { text: body.slice(0, 800), at: Date.now() });
  }

  pruneChatMemory(key);
}

/** 丢掉这个账号下过期的会话记忆，避免长跑进程无限增长。 */
function pruneChatMemory(keyPrefix) {
  for (const map of [chatBySender, chatBySession, lastDirectChats]) {
    for (const [key, entry] of map) {
      if (!key.startsWith(`${keyPrefix}:`)) continue;
      if (!fresh(entry)) map.delete(key);
    }
  }
}

/**
 * 按 session / sender / **这个人自己的**最近私聊找回会话。
 *
 * 旧插件 openclaw-lark 没有「账号级最近私聊」：没有入站 ticket 就宁可报
 * 「无法确定发送目标」，也不把卡片发给最后说话的人。这里保留兜底，但把它
 * 限定在当前 owner 名下，且只有能确定 owner 时才用。
 *
 * `kind === "owner"` 表示这是无人值守轮次（授权完成后要重跑该人的 cron）。
 */
function rememberedChat(account, { sessionKey, senderId, ownerUserId } = {}) {
  const owner = normalizeOwnerId(senderId) || normalizeOwnerId(ownerUserId);
  const key = accountChatKey(account, owner);
  if (!key) return null;
  if (sessionKey) {
    const hit = chatBySession.get(`${key}:${sessionKey}`);
    if (fresh(hit)) return { entry: hit, kind: "session" };
  }
  const slot = senderSlot(senderId ?? owner);
  if (slot) {
    const hit = chatBySender.get(`${key}:${slot}`);
    if (fresh(hit)) return { entry: hit, kind: "sender" };
    const last = lastDirectChats.get(`${key}:${slot}`);
    if (fresh(last)) return { entry: last, kind: "owner" };
  }
  return null;
}

// ── 工具上下文 → 会话地址 ────────────────────────────────────────────────

/**
 * 工具上下文里能拿到哪些地址信息。
 *
 * `delivery.target` 是**规范化地址**（`user:ou_x` / `chat:oc_x`），不是 chat id；
 * 直接当 chat id 用会得到 `to=chat:user:ou_x`，卡片发不出去。
 */
export function resolveToolChat(toolCtx) {
  const inbound = toolCtx?.openclawInboundContext ?? {};
  const delivery = toolCtx?.deliveryContext ?? {};
  const target = String(
    delivery.target ?? inbound.OriginatingTo ?? inbound.To ?? inbound.to ?? "",
  );

  let chatId = inbound.ChatId ?? inbound.chat_id ?? delivery.chatId;
  let senderId =
    inbound.SenderId ??
    inbound.sender_id ??
    delivery.userId ??
    inbound.user_id ??
    toolCtx?.requesterSenderId ??
    toolCtx?.user_id;
  let chatType =
    (inbound.ChatType ?? inbound.chat_type ?? delivery.chatType) === "group"
      ? "group"
      : "direct";

  if (target.startsWith("chat:")) {
    chatId = chatId ?? target.slice("chat:".length);
    chatType = "group";
  } else if (target.startsWith("user:")) {
    senderId = senderId ?? target.slice("user:".length);
  } else if (target) {
    // 裸 open_id 是「人」，不是会话：当 chatId 用会得到 `to=chat:ou_...`
    // 并被飞书拒绝（invalid chat ID format, should start with 'oc_'）。
    if (target.startsWith("oc_")) chatId = chatId ?? target;
    else senderId = senderId ?? target;
  }

  // 定时任务 / 主动触达没有入站 SenderId：从「这轮要投递给谁」或调度它的
  // 例程台账里取 owner。拿不到人就不发卡（旧插件是 fail-close）。
  if (!senderId) senderId = ownerIdFromToolCtx(toolCtx) ?? undefined;

  return {
    chatId,
    senderId,
    messageId: inbound.MessageSid ?? delivery.messageId,
    chatType,
    agentId: inbound.AgentId ?? delivery.agentId,
    threadId: inbound.ThreadId ?? delivery.threadId,
    sessionKey: inbound.SessionKey ?? inbound.session_key ?? delivery.sessionKey,
    originText: String(inbound.Body ?? inbound.RawBody ?? "").slice(0, 800),
  };
}

/**
 * `to=` 地址：飞书会话 id 是 `oc_...`，其余（尤其是 `ou_...`）必须走 p2p `user:`。
 */
export function addressFor(chat) {
  const chatId = String(chat?.chatId ?? "");
  if (chatId.startsWith("oc_")) return `chat:${chatId}`;
  return `user:${chat?.senderId ?? chatId}`;
}

// ── 授权错误识别 ────────────────────────────────────────────────────────

/**
 * 用户 token 本身不可用：只有重新走 device flow 才能修。
 */
export function isUserTokenFailure(error) {
  const subtype = String(error?.error?.subtype ?? "");
  const code = Number(error?.error?.code ?? 0);
  if (["token_expired", "token_missing", "token_invalid"].includes(subtype)) return true;
  // 99991677 token 过期，99991663 token 无效，99991668 user token 无效
  if ([99991677, 99991663, 99991668].includes(code)) return true;
  return /token_expired|token_missing|token expired/i.test(String(error?.message ?? ""));
}

/**
 * token 可用，但缺某个 scope（例如 token 只覆盖 docs，而技能要 `search:message`）。
 */
export function isScopeFailure(error) {
  const code = Number(error?.error?.code ?? error?.code ?? 0);
  // 99991679 无权限 / 99991672 scope 不足 / 99991664 应用未开通
  if ([99991679, 99991672, 99991664].includes(code)) return true;
  // CLI 对「从未授权过的 scope」在本地就直接回
  // `{ok:false, error:{subtype:"missing_scope", missing_scopes:[...]}}`，没有数字码。
  if (Array.isArray(error?.error?.missing_scopes) && error.error.missing_scopes.length > 0) {
    return true;
  }
  const blob = [error?.error?.subtype, error?.error?.message, error?.message, error?.stderr]
    .filter(Boolean)
    .join(" ");
  return /missing[_\s-]?scopes?|insufficient[_\s-]?scopes?|no[_\s-]?permission|permission denied|forbidden|9999167[29]|99991664/i.test(
    blob,
  );
}

/** 把工具结果（字符串 / `{text}` / `{content:[{text}]}` / JSON）拍平成文本。 */
function resultText(result) {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return result.map(resultText).filter(Boolean).join("\n");
  if (typeof result === "object") {
    if (typeof result.text === "string") return result.text;
    if (Array.isArray(result.content)) return resultText(result.content);
    try {
      return JSON.stringify(result);
    } catch {
      return "";
    }
  }
  return String(result);
}

function parseMissingScopes(text) {
  // 只认两种「真实缺口」：
  //   {"error":{"missing_scopes":["a","b"]}}            — raw CLI envelope
  //   FEISHU_AUTH_REQUIRED … missing_scopes=a,b          — marker from a hook
  //     (hooks block with a *string* reason that json-escapes any quotes, so the
  //      marker uses `k=v` and has to be matched separately)
  //
  // 不加裸 `missing_scopes=` 兜底：技能文档里写「若返回 missing_scopes 且带
  // console_url」是在讲排错方法，不是在报缺权限。
  const json = text.match(/"missing_scopes"\s*:\s*\[([^\]]*)\]/);
  const marker = text.match(/\bFEISHU_AUTH_REQUIRED\b[^\n]*?\bmissing_scopes=([^\s"'\\]+)/);
  const raw = json?.[1] ?? marker?.[1];
  if (!raw) return null;
  const scopes = raw
    .split(",")
    .map((value) => value.trim().replace(/^["']|["']$/g, ""))
    .filter((value) => /^[A-Za-z0-9_:.-]+$/.test(value));
  return scopes.length ? scopes : null;
}

/** 错误码必须出现在 JSON 字段或 hook marker 里，表格里的一行不算。 */
const STRUCTURED_CODE = /(?:"code"\s*:\s*"?|\bcode=)(999916\d{2})\b/g;
const STRUCTURED_SUBTYPE =
  /"subtype"\s*:\s*"(token_expired|token_missing|token_invalid|missing_scope)"/;
const STRUCTURED_MISSING_SCOPES = /"missing_scopes"\s*:\s*\[/;
const AUTH_FAILURE_MARKER = /\bFEISHU_AUTH_REQUIRED\b/;
/** 技能文档 / reference / shell 输出的特征：标题、表格、代码块、超长文本。 */
const DOCUMENT_HINT = /(^|\n)#{1,3}\s|\n\s*\|[^\n]*\|\s*\n|```|^\s*---\s*$/m;
const MAX_ERROR_TEXT = 1200;

/**
 * `Skill` 工具返回的是整份 SKILL.md，`shell` 常把 reference 文档 cat 出来。
 * 这些文档为了教模型排错，写满了 `missing_scopes`、`99991679`、
 * `permission denied` —— 一次成功的技能加载因此被误判成授权失败，发卡 →
 * 授权 → 合成消息要求「重新加载该技能」→ 又加载同一份文档 → 无限循环。
 */
function looksLikeDocument(text) {
  return text.length > MAX_ERROR_TEXT || DOCUMENT_HINT.test(text);
}

/**
 * 判断一次工具结果是不是「飞书授权类失败」，以及是哪一类。
 *
 * 只认**结构化**的飞书错误签名：JSON 错误信封里的 code / subtype /
 * missing_scopes，或注入器打的 `FEISHU_AUTH_REQUIRED` marker。散文里出现同样
 * 的单词一律不算，否则技能文档会被当成错误。
 *
 * @returns {{kind: "token"|"scope"|"app", missingScopes: string[]|null}|null}
 */
export function detectAuthFailure(payload) {
  const toolName = String(payload?.tool_name ?? "");
  const channel = String(payload?.channel ?? "").trim().toLowerCase();
  if (channel && channel !== "feishu") return null;

  // `Skill` 回的是 SKILL.md，`read_file` 回的是 reference 文档：它们不是 API
  // 调用结果，永远不可能真的报飞书授权错误。哪怕文档里刚好有一行 JSON 错误
  // 示例（lark-shared-output-contract.md 就有），也不该弹授权卡片。
  if (/^(Skill|skill|read_file|list_dir)$/i.test(toolName)) return null;

  const text = resultText(payload?.result);
  if (!text) return null;
  // 本插件的工具已经处理过（卡片也发了），不要二次改写。
  if (/"awaiting_authorization"\s*:\s*true/.test(text)) return null;
  if (looksLikeDocument(text)) return null;

  const codes = [...text.matchAll(STRUCTURED_CODE)].map((match) => Number(match[1]));
  const subtype = text.match(STRUCTURED_SUBTYPE)?.[1];
  const subtypeHit = Boolean(subtype);
  const missingEnvelope = STRUCTURED_MISSING_SCOPES.test(text);
  const marker = AUTH_FAILURE_MARKER.test(text);
  const missingScopes = parseMissingScopes(text);

  if (!codes.length && !subtypeHit && !missingEnvelope && !marker) {
    // 宽松兜底只给「本插件工具 + 明确报错」：Skill / shell 永远走不到这里。
    const ownedTool = /^(lark_cli|feishu_|lark_)/.test(toolName);
    if (!ownedTool || payload?.is_error !== true) return null;
    if (!/no[_\s-]?permission|permission denied|forbidden/i.test(text)) return null;
    return { kind: "scope", missingScopes };
  }

  // 应用级权限只能管理员在开放平台开，用户点授权卡片也解决不了。
  if (codes.includes(99991664) || (/console_url/.test(text) && (missingEnvelope || marker))) {
    return { kind: "app", missingScopes };
  }
  if (
    codes.some((code) => [99991677, 99991663, 99991668].includes(code)) ||
    (subtype && subtype !== "missing_scope" && subtype !== "app_scope_missing")
  ) {
    return { kind: "token", missingScopes };
  }
  return { kind: "scope", missingScopes };
}

function hookResultText(kind) {
  if (kind === "app") {
    return (
      "APP_SCOPE_MISSING：该调用缺少**应用级**飞书权限，只能由管理员在开放平台开通，" +
      "用户点授权卡片也无法解决。本轮不要重试该调用，也不要换工具绕过；" +
      "只需回一句「需要管理员在飞书开放平台开通该权限后再试」。"
    );
  }
  if (kind === "not_auth") {
    return (
      "NOT_AUTHORIZATION_ERROR：这次失败不是飞书用户授权问题。已验证过的用户授权仍然有效，" +
      "本次所需权限此前已全部授予，系统**不会**再发授权卡片。" +
      "禁止：重试授权、要求用户重新授权、换工具反复试探、把授权列为待办。" +
      "请直接按工具返回的原始错误说明这次操作为什么失败，然后结束本轮。"
    );
  }
  if (kind === "undeclared_scope") {
    return (
      "UNDECLARED_SCOPE：这条命令需要的飞书权限不在本技能声明的最小授权清单内，" +
      "用户点授权卡片也拿不到它，系统**不会**发授权卡片。这不是你或用户的操作错误。\n" +
      "禁止：重试该命令、要求用户重新授权、等待授权、换工具反复试探、把授权列为待办、罗列 scope 名。\n" +
      "请直接跳过这一个取数步骤（在简报里注明该段因权限跳过或直接省略），" +
      "用已经取到的数据继续把整份日报写完并输出最终结果，不要结束本轮。"
    );
  }
  return (
    "AUTH_REQUIRED：本次调用缺少飞书用户授权。系统**已在本会话发出授权卡片**，" +
    "用户点完「去授权」后会自动继续，本轮到此结束。\n" +
    "禁止：重试该调用、换别的工具绕过、罗列 scope 名、让用户去开放平台点按钮、" +
    "把「待授权」写成一个结果条目。\n" +
    "唯一允许的输出是：" +
    AUTH_WAIT_LINE
  );
}

/**
 * declared 模式下把「工具实报的权限缺口」分类：
 *   - "undeclared_scope"：缺口全部落在技能声明清单之外。授权卡按清单申请，
 *     永远拿不到这些 scope；发卡只会让用户白点一次，应让工具降级跳过。
 *   - "needs_consent"   ：缺口里至少有一项在声明清单内，正常走授权卡流程。
 *   - null              ：没有未授予的缺口，或不是 declared 模式。
 *
 * 纯函数，便于回归测试；钩子的 120ms 预算里也只能做这种同步判断。
 */
export function classifyScopeGap({ mode, missingScopes, granted, declared }) {
  if (mode !== "declared") return null;
  const unresolved = (missingScopes ?? []).filter((scope) => !granted?.has?.(scope));
  if (!unresolved.length) return null;
  const declaredSet = new Set(declared ?? []);
  return unresolved.every((scope) => !declaredSet.has(scope))
    ? "undeclared_scope"
    : "needs_consent";
}

// ── 从哪里申请权限（技能声明 / 命令推断） ───────────────────────────────

let declaredDomainsCache = null;

/** 技能 `metadata.requires.domains` 声明。 */
function skillDomainMap() {
  if (declaredDomainsCache) return declaredDomainsCache;
  const roots = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills"),
  ];
  const home = process.env.ORANGE_HOME || path.join(os.homedir(), ".orange");
  try {
    for (const agent of fs.readdirSync(path.join(home, "workspace"))) {
      roots.push(path.join(home, "workspace", agent, "skills"));
    }
  } catch {
    // 还没有 workspace：内置 skills/ 就够了。
  }

  const map = new Map();
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      let text;
      try {
        text = fs.readFileSync(path.join(root, name, "SKILL.md"), "utf8");
      } catch {
        continue;
      }
      const match = text.match(/^\s*domains\s*:\s*\[([^\]]*)\]/m);
      if (!match) continue;
      const domains = match[1]
        .split(",")
        .map((value) => value.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      if (domains.length) map.set(name, domains);
    }
  }
  declaredDomainsCache = map;
  return map;
}

let declaredScopesCache = null;

/** 技能 `metadata.requires.scopes` 声明。 */
function skillScopeMap() {
  if (declaredScopesCache) return declaredScopesCache;
  const roots = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills"),
  ];
  const home = process.env.ORANGE_HOME || path.join(os.homedir(), ".orange");
  try {
    for (const agent of fs.readdirSync(path.join(home, "workspace"))) {
      roots.push(path.join(home, "workspace", agent, "skills"));
    }
  } catch {
    // 只有内置 skills
  }
  const map = new Map();
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      let text;
      try {
        text = fs.readFileSync(path.join(root, name, "SKILL.md"), "utf8");
      } catch {
        continue;
      }
      const match = text.match(/^\s*scopes\s*:\s*\[([^\]]*)\]/m);
      if (!match) continue;
      const scopes = match[1]
        .split(",")
        .map((value) => value.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      if (scopes.length) map.set(name, scopes);
    }
  }
  declaredScopesCache = map;
  return map;
}

/**
 * 显式 scopes 优先；否则取「当前涉及的业务域」里那些技能的声明。
 *
 * 不能直接取所有技能声明的并集：装了 29 个技能时，跑日程会把通讯录、云文档的
 * 声明一起卷进来 —— 用户看到的就是「这个技能根本不用邮箱，却要邮箱权限」。
 */
export function authScopesFor(account, domains = null) {
  const explicit = account?.authScopes ?? account?.auth_scopes;
  if (Array.isArray(explicit) && explicit.length) return explicit;

  const map = skillScopeMap();
  const union = new Set();
  // declared 模式把清单钉死在技能声明上，忽略本次失败命令的业务域。
  // 否则工具预检门（带 argv）和 after_tool_call 钩子门（argv=null）会算出
  // 两份不同的清单，各自开一个 device flow —— 用户就会连收两张授权卡。
  // declared（技能最小集）和 all（应用全量）都把清单钉死，与本次失败命令的
  // 业务域无关：带 argv 的工具预检门和 argv=null 的钩子门必须拿到同一份清单，
  // 否则 startDeviceFlow.covers() 复用不了，用户会连收两张授权卡。
  const mode = authScopeMode(account);
  const want = new Set(mode === "declared" || mode === "all" ? [] : (domains ?? []));
  if (!want.size) {
    for (const scopes of map.values()) {
      for (const scope of scopes) union.add(scope);
    }
    return [...union];
  }

  const domainMap = skillDomainMap();
  for (const [skill, scopes] of map) {
    const skillDomains = domainMap.get(skill);
    // 没声明 domains 的技能无法判断归属，跳过：宁可少要，也不要申请无关权限。
    if (!skillDomains?.some((domain) => want.has(domain))) continue;
    for (const scope of scopes) union.add(scope);
  }
  return [...union];
}

/**
 * 一次授权要覆盖哪些域。
 *
 * 最小权限是按**已安装技能集**收敛的：只申请「失败命令所属技能声明的域」，
 * 绝不申请「飞书有的一切」。没有 argv（钩子路径，不知道具体子命令）时退化成
 * 所有技能声明的并集——这正是「一次点完，不再二次要权限」需要的。
 */
function authDomainsFor(account, argv) {
  const explicit = account?.authDomains ?? account?.auth_domains;
  if (Array.isArray(explicit) && explicit.length) return explicit;

  const failing = Array.isArray(argv) && argv.length ? domainsForArgv(argv) : [];
  const declared = skillDomainMap();
  const union = new Set();
  for (const domain of failing) {
    let matched = false;
    for (const domains of declared.values()) {
      if (domains.includes(domain)) {
        domains.forEach((value) => union.add(value));
        matched = true;
      }
    }
    // 没有技能声明这个域时才退回命令自身的域：否则 `domainsForArgv` 的兜底
    // （docs+drive）会漏进来，卡片就会索要用户根本用不到的文件权限。
    if (!matched) union.add(domain);
  }
  if (union.size === 0) {
    for (const domains of declared.values()) domains.forEach((value) => union.add(value));
  }
  return [...union];
}

const appScopesCache = new Map();
const APP_SCOPES_TTL_MS = 60_000;
/** configDir -> 本进程见过的所有 scope 缺口，避免每轮只补一个新权限。 */
const knownScopeGaps = new Map();

/**
 * 应用已开通的**全部用户级 scope**（`lark-cli auth scopes --json` → userScopes）。
 *
 * 这既是过滤器（申请应用没开通的 scope 会在同意页打红叉），也是「一次授权完」
 * 的清单：飞书的 OAuth 是增量的，按需补一个就只会拿到一个，下一条命令又冒出
 * 下一个缺口 —— 今早 09:02 补 10 个、09:31 补 wiki、09:36 补 im:chat:read 就是
 * 这么来的。默认改成一次把这份全集全授掉，之后不会再有 scope 缺口。
 */
async function appUserScopes(account, { log } = {}) {
  const cacheKey = account.configDir ?? account.accountId ?? "";
  const cached = appScopesCache.get(cacheKey);
  if (cached && Date.now() - cached.at < APP_SCOPES_TTL_MS) return cached.value;
  try {
    const result = await runCli({
      cliPath: account.cliPath,
      configDir: account.configDir,
      cwd: account.scratchDir,
      args: ["auth", "scopes", "--json"],
      timeoutMs: 15_000,
      env: account.env,
      log,
    });
    const list = result?.data?.userScopes;
    if (Array.isArray(list) && list.length) {
      const value = new Set(list);
      appScopesCache.set(cacheKey, { at: Date.now(), value });
      return value;
    }
  } catch (error) {
    log?.warn?.(
      `could not read the app's user-level scopes, falling back to declared scopes: ${
        error?.message ?? error
      }`,
    );
  }
  return null;
}

/** 把 CLI 报出来的缺口累积起来：就算走最小权限模式，也不会每轮只补一个。 */
function rememberScopeGaps(account, gaps) {
  if (!Array.isArray(gaps) || !gaps.length) return [];
  const key = accountChatKey(account);
  const set = knownScopeGaps.get(key) ?? new Set();
  for (const scope of gaps) {
    if (typeof scope === "string" && scope.trim()) set.add(scope.trim());
  }
  knownScopeGaps.set(key, set);
  return [...set];
}

/**
 * 授权范围模式：
 *   skill    —— 只申请**当前技能/命令涉及的业务域**里的权限（默认）。
 *               旧插件 `auto-auth.ts` 按 TOOL_SCOPES 精确申请，就是这个粒度：
 *               日程技能不会把邮箱权限一起要过来。
 *   all      —— 应用已开通的全部用户级权限。对应旧插件的 `/feishu_auth`
 *               批量授权命令（`auth.ts` → `triggerOnboarding`），用于一次性
 *               「全都授掉」的场景。
 *   declared —— 只申请 SKILL.md 声明的 scope，最小集。
 */
function authScopeMode(account) {
  return String(account?.authScopeMode ?? account?.auth_scope_mode ?? "skill").toLowerCase();
}

/**
 * CLI domain → 它可能用到的 scope 前缀。
 *
 * `lark-cli <domain>` 只能告诉我们要碰哪块业务，具体一条命令用哪个 scope 得靠
 * `lark-cli schema`。授权卡片上不能一条一条试，所以按「同一个域整族给全」：
 * 走 `calendar` 就带全部 calendar scope，走 `docs` 就带文档族，绝不带 `mail`。
 */
const DOMAIN_SCOPE_PREFIXES = Object.freeze({
  application: ["application"],
  approval: ["approval"],
  apps: ["application", "docs"],
  attendance: ["attendance"],
  base: ["base", "bitable"],
  calendar: ["calendar"],
  contact: ["contact"],
  docs: ["docs", "docx", "wiki", "space", "board", "docs_tool", "minutes", "note", "mindnotes", "markdown"],
  // drive 只管云盘文件本身；文档内容操作归 docs 域，别把整个文档族一起卷进来。
  drive: ["drive", "space"],
  wiki: ["wiki", "space"],
  sheets: ["sheets"],
  slides: ["slides"],
  task: ["task"],
  vc: ["vc"],
  im: ["im", "cardkit"],
  mail: ["mail"],
  markdown: ["markdown", "docs", "docx"],
  mindnotes: ["mindnotes", "docs", "docx"],
  minutes: ["minutes", "docs"],
  note: ["note", "minutes"],
  okr: ["okr"],
  whiteboard: ["board"],
  event: ["event"],
});

/** OAuth 的前提权限，任何一次授权都该带上。 */
const ALWAYS_SCOPES = new Set(["offline_access"]);

/**
 * 批量连同域一起授权时避开的高危权限（旧插件 `SENSITIVE_SCOPES` 的等价物）。
 * 当前命令确实报了这条缺口（`keep`）时才放行。
 */
const SENSITIVE_SCOPES = new Set([
  "im:message.send_as_user",
  "space:document:delete",
  "calendar:calendar.event:delete",
  "base:table:delete",
  "base:record:delete",
]);

/** 取「这些业务域」在应用已开通权限里的子集。 */
function scopesForDomains(appScopes, domains, { keep = [] } = {}) {
  if (!appScopes?.size) return [];
  const prefixes = new Set(ALWAYS_SCOPES);
  for (const domain of domains ?? []) {
    for (const prefix of DOMAIN_SCOPE_PREFIXES[domain] ?? [domain]) prefixes.add(prefix);
  }
  const keepSet = new Set(keep);
  return [...appScopes].filter((scope) => {
    if (!prefixes.has(scope.split(":")[0])) return false;
    return !SENSITIVE_SCOPES.has(scope) || keepSet.has(scope);
  });
}

/** 一次授权的标记键：同样的「模式 + 域集合 + 条数」就表示那次已经点过了。 */
function grantSignature(mode, domains, count) {
  return `${mode}:${[...(domains ?? [])].sort().join(",")}#${count}`;
}

/**
 * 「这一次授权已经完成过」的标记，落在账号目录里，重启不丢。
 *
 * 判据不能用 `grantedScopes` 是否等于申请的集合：租户策略可能挡掉个别 scope，
 * 那样每次比对都会显示「还差一点」，又变成一张接一张的卡片。按「这次授权点过
 * 没有」判断更贴合飞书的增量授权语义；域名集合或条数变了（技能扩了域、应用
 * 新开了权限）才重发一次。
 */
function grantMarkerPath(account) {
  if (!account?.configDir) return null;
  // 放在 CLI configDir 的**父目录**：lark-cli 会审计自己的凭证目录（owner/mode/
  // symlink），往里塞一个它不认识的文件有风险。按 accountId 分文件。
  // 授权标记也必须按人分文件：只按 accountId 时，A 点过的那次授权会让 B
  // 被判成「这次授权已经完成过」，B 的 scope 缺口永远拿不到卡片。
  const id = [String(account.accountId ?? "default"), account?.ownerUserId ?? ""]
    .filter(Boolean)
    .map((part) => String(part).replace(/[^A-Za-z0-9_-]/g, "_"))
    .join("-");
  return path.join(path.dirname(account.configDir), `.auth-grant-${id}.json`);
}

function readGrantMarker(account) {
  const file = grantMarkerPath(account);
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeGrantMarker(account, signature, count, log) {
  const file = grantMarkerPath(account);
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify({ at: Date.now(), signature, count }));
    log?.info?.(`recorded the completed authorization grant (${signature})`);
  } catch (error) {
    log?.warn?.(`could not persist the grant marker: ${error?.message ?? error}`);
  }
}

/** 过滤掉应用未开通的 scope；拿不到清单时原样返回。 */
async function grantableScopes(account, declared, { log } = {}) {
  if (!declared?.length) return declared;
  const grantable = await appUserScopes(account, { log });
  if (!grantable) return declared;

  const kept = declared.filter((scope) => grantable.has(scope));
  const dropped = declared.filter((scope) => !grantable.has(scope));
  if (dropped.length) {
    log?.warn?.(
      `skipped scope(s) the user cannot grant (enable them in the Feishu console): ${dropped.join(", ")}`,
    );
  }
  // 永远不要给 `--scope` 传空：没有该参数时 lark-cli 会退回「所有已知域」，
  // 那正好是最小权限的反面。
  return kept.length ? kept : declared;
}

// ── 定时任务（unattended）归属 ──────────────────────────────────────────

function readRoutineLedger() {
  const home = process.env.ORANGE_HOME || path.join(os.homedir(), ".orange");
  const ledger = path.join(home, "proactive", "routines.json");
  try {
    const data = JSON.parse(fs.readFileSync(ledger, "utf8"));
    const raw = data?.routines;
    return Array.isArray(raw) ? raw : Object.values(raw ?? {});
  } catch {
    return [];
  }
}

/**
 * 这条定时任务属于哪条例程：决定卡片发给谁（`owner_user_id`）和用哪个账号目录
 * （`origin_account_id`）。
 */
function routineForCtx(toolCtx) {
  const routines = readRoutineLedger();
  const inbound = toolCtx?.openclawInboundContext ?? {};
  const delivery = toolCtx?.deliveryContext ?? {};
  const jobId =
    inbound.CronJobId ??
    inbound.cron_job_id ??
    delivery.jobId ??
    toolCtx?.cronJobId ??
    toolCtx?.cron_job_id;
  if (!jobId) return null;
  return routines.find((routine) => routine?.cron_job_id === jobId) ?? null;
}

/** 定时任务所属用户的那套 lark-cli 账号目录（多用户部署时一人一个）。 */
export function routineAccountFor(toolCtx) {
  return routineForCtx(toolCtx)?.origin_account_id || null;
}

/**
 * 这一轮属于哪个人 —— 等价于旧插件 `ticket.senderOpenId`。
 *
 * 逐个候选试，不能 `a ?? b ?? c` 一把塞进去：cron 轮次注入的
 * `SenderUsername=cronjob` 是非空字符串但不是 open_id，会挡住后面真正的
 * `delivery.target=user:ou_x`。
 *
 * 无法确定时返回 ""，调用方必须 fail-close：宁可不发卡，也不能拿共享默认
 * 账号（里面是别人的 user token）顶上。
 */
export function ownerIdFromToolCtx(toolCtx) {
  const inbound = toolCtx?.openclawInboundContext ?? {};
  const delivery = toolCtx?.deliveryContext ?? {};
  const candidates = [
    inbound.SenderId,
    inbound.sender_id,
    delivery.userId,
    toolCtx?.requesterSenderId,
    toolCtx?.user_id,
    delivery.target,
    inbound.OriginatingTo,
    inbound.To,
    inbound.to,
  ];
  for (const candidate of candidates) {
    const owner = normalizeOwnerId(candidate);
    if (owner) return owner;
  }
  return normalizeOwnerId(routineOwnerFor(toolCtx));
}

/**
 * 无人值守运行的收件人：没有入站消息，工具上下文里也没有地址。
 *
 * 优先用调度它的那条例程的 owner；无法唯一确定时返回 null（把卡片发给错的人，
 * 比打印一个链接更糟）。
 */
function routineOwnerFor(toolCtx) {
  const hit = routineForCtx(toolCtx);
  if (hit?.owner_user_id) return hit.owner_user_id;

  const owners = new Set(
    readRoutineLedger()
      .filter((routine) => ["active", "proposed"].includes(routine?.status))
      .map((routine) => routine?.owner_user_id)
      .filter(Boolean),
  );
  return owners.size === 1 ? [...owners][0] : null;
}

/** `ORANGE_PORT` 不会导出给插件子进程，所以从 config.yaml 读真实地址。 */
function gatewayPort() {
  const explicit = process.env.ORANGE_PORT || process.env.ORANGE_GATEWAY_PORT;
  if (explicit && Number(explicit) > 0) return Number(explicit);
  try {
    const home = process.env.ORANGE_HOME || path.join(os.homedir(), ".orange");
    const text = fs.readFileSync(path.join(home, "config.yaml"), "utf8");
    const match = text.match(/^\s{2}http_addr:\s*["']?[^:"'\n]*:(\d+)/m);
    if (match) return Number(match[1]);
  } catch {
    // 落到默认端口
  }
  return 3000;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 授权完成后，触发这次授权的那轮日报往往还在跑（一次 2–6 分钟）。网关的
// `/api/v1/cron/jobs/:id/run` 把 scheduler 返回的**所有** Err 都映射成 404，
// 其中就包括 "job already running"（见 gateway/api.rs::run_cron_job）。所以
// 404 不能当成「作业不存在」直接放弃，必须等到当前 run 结束；旧实现只重试
// 3 次 ×10s，会在 run 结束前耗尽，用户只看到失败提示、收不到补跑的日报。
export const RERUN_MAX_ATTEMPTS = 36; // 10s × 36 = 6min，覆盖一次完整日报
const RERUN_RETRY_MS = 10_000;

/**
 * POST /run 失败后还要不要继续等。404/409 代表「上一轮还没结束」或临时冲突，
 * 5xx 多半是网关重启；其余 4xx（参数 / 鉴权错）重试也没有意义。
 * 抽成纯函数便于回归测试，不依赖真实网关。
 */
export function shouldRetryProactiveRerun(status, attempt, maxAttempts = RERUN_MAX_ATTEMPTS) {
  if (attempt >= maxAttempts) return false;
  return status === 404 || status === 409 || status >= 500;
}

async function waitUntilJobIdle(port, jobId, { timeoutMs = 6 * 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/cron/jobs/${jobId}/runs`);
      if (res.ok) {
        const data = await res.json();
        const runs = Array.isArray(data.runs) ? data.runs : [];
        if (!runs.some((run) => !run.finished_at)) return;
      }
      // 探测失败（网关重启 / 端口未就绪）不等于空闲，继续等。
    } catch {
      // 网络抖动同理，不该让补跑窗口提前关闭。
    }
    await sleep(5_000);
  }
}

/** 只表示对授权征询的答复，不是一条任务描述。 */
const CONSENT_ONLY_TASK =
  /^(同意|好(的|吧)?|确认|确定|可以|ok|okay|yes|y|是|嗯|行|继续|授权|1|✅|👌)[\s。.!！,，、~]*$/i;

/**
 * 授权完成后还要不要注入一条合成入站消息去「继续刚才的任务」。
 *
 * 定时任务重跑自带完整的技能上下文，再起一条会话轮次就是两条链并行跑同一
 * 件事；而「同意 / 好的」这类答复被当成原始任务时，模型无从知道要做什么，
 * 只会反问「原始需求不在我当前的上下文中」并弹出确认卡片。两种情况都只
 * 需要那一条状态通知，不要启动新的 agent run。
 */
export function shouldInjectResume({ rerunJobs = 0, originTask = "" } = {}) {
  if (rerunJobs > 0) return false;
  const origin = String(originTask ?? "").trim();
  if (!origin || CONSENT_ONLY_TASK.test(origin)) return false;
  return true;
}

/**
 * 授权完成后重跑触发它的主动任务。
 *
 * 否则定时轮因为「数据源未授权」产出 NO_UPDATES，调度器判定无增量不投递，
 * 用户授权完就再也听不到消息了。返回拉起的作业数，调用方据此决定是否还要
 * 注入合成 resume（见 shouldInjectResume）。
 */
function triggerProactiveRerun(log, ownerId) {
  // 只重跑**刚完成授权的那个人**的作业。旧实现把台账里所有 active job 一起
  // POST /run：A 授权完 B 的日报轮次也被拉起来，B 于是又收到一张授权卡 ——
  // 14:39:43 相隔 0.3 秒发给两个人的两张卡就是这么来的。
  const owner = normalizeOwnerId(ownerId);
  if (!owner) {
    log.warn("proactive rerun skipped: cannot attribute this authorization to a user");
    return 0;
  }
  let jobIds = [];
  try {
    const home = process.env.ORANGE_HOME || path.join(os.homedir(), ".orange");
    const ledger = JSON.parse(
      fs.readFileSync(path.join(home, "proactive", "routines.json"), "utf8"),
    );
    const routines = Array.isArray(ledger.routines)
      ? ledger.routines
      : Object.values(ledger.routines ?? {});
    jobIds = routines
      .filter(
        (routine) =>
          routine?.status === "active" &&
          routine?.cron_job_id &&
          normalizeOwnerId(routine?.owner_user_id) === owner,
      )
      .map((routine) => routine.cron_job_id);
  } catch (error) {
    log.warn(`proactive rerun skipped: ${error?.message ?? error}`);
    return 0;
  }
  log.info(`proactive rerun: ${jobIds.length} job(s) owned by ${owner}`);

  const port = gatewayPort();
  for (const jobId of jobIds) {
    void (async () => {
      const shortId = String(jobId).slice(0, 8);
      // run log 只在 run 结束时落盘，这里通常看不到「进行中」；真正的等待由
      // 下面对 404(=job already running) 的重试完成。
      await waitUntilJobIdle(port, jobId);
      for (let attempt = 1; attempt <= RERUN_MAX_ATTEMPTS; attempt += 1) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/v1/cron/jobs/${jobId}/run`, {
            method: "POST",
          });
          if (res.ok) {
            log.info(`re-ran proactive job ${shortId} after authorization (attempt ${attempt})`);
            return;
          }
          const body = await res.text().catch(() => "");
          const retry = shouldRetryProactiveRerun(res.status, attempt);
          log.warn(
            `proactive rerun responded ${res.status} for ${shortId} ` +
              `(attempt ${attempt}/${RERUN_MAX_ATTEMPTS}${retry ? ", waiting for the active run" : ", giving up"}): ` +
              `${body.slice(0, 160)}`,
          );
          if (!retry) return;
        } catch (error) {
          log.warn(
            `proactive rerun failed (attempt ${attempt}/${RERUN_MAX_ATTEMPTS}) for ${shortId}: ${
              error?.message ?? error
            }`,
          );
          if (attempt >= RERUN_MAX_ATTEMPTS) return;
        }
        await sleep(RERUN_RETRY_MS);
      }
      log.warn(`proactive rerun gave up for ${shortId} after ${RERUN_MAX_ATTEMPTS} attempts`);
    })();
  }
  return jobIds.length;
}

// ── 授权门主逻辑 ────────────────────────────────────────────────────────

/**
 * 需要用户身份时的统一闸门。
 *
 * 返回 `null` 表示可以继续；返回对象表示本轮结束、已发授权卡片，工具应把它原样
 * 作为结果交给模型。
 *
 * `argv` 可选：钩子路径不知道具体子命令，只要求「一次授权覆盖该技能集」。
 * `chat` 可选：钩子自己解析出的会话地址（比工具上下文更准）。
 */
export async function ensureUserAuthorized({
  account: accountParam,
  argv,
  toolCtx,
  chat: presetChat = null,
  log,
  force = false,
  trigger = "token",
  missingScopes = null,
  toolName = null,
}) {
  // ── 先把「这一轮是谁」钉死，再读任何授权状态 ──────────────────────
  // 旧插件 openclaw-lark 全程用 ticket.senderOpenId；这里如果先拿共享账号
  // 读 auth status，读到的可能是别人的 user token（work 目录里存的是 A），
  // `userReady=true` 会直接放行，B 就永远拿不到自己的授权卡。
  const chat = presetChat ? { ...presetChat } : resolveToolChat(toolCtx);
  const ownerId =
    normalizeOwnerId(chat.senderId) ||
    ownerIdFromToolCtx(toolCtx) ||
    normalizeOwnerId(accountParam?.ownerUserId);
  if (!ownerId) {
    log.warn("authorization refused: no owner open_id in this turn (fail-closed)");
    return {
      ok: false,
      awaiting_authorization: true,
      message:
        "无法确定当前用户身份。为避免把别人的飞书授权误用给你，本轮不会发送授权卡片；" +
        "请在飞书私聊里直接发起这次操作。",
    };
  }
  // 按人解析独立的 lark-cli 账号目录；拿不到就 fail-close，绝不退回共享默认
  // 账号（那里面是另一个人的 user token）。
  const scoped = ownerAccountResolver?.(ownerId, accountParam);
  if (!scoped) {
    log.warn(`authorization refused: no per-user lark-cli account for ${ownerId}`);
    return {
      ok: false,
      awaiting_authorization: true,
      message: "无法为当前用户准备独立的飞书账号目录，本轮不会借用其他用户的授权。",
    };
  }
  const account = { ...scoped, ownerUserId: ownerId };
  chat.ownerUserId = ownerId;

  let status;
  try {
    status = await readAuthStatus(account, { force, log, ownerUserId: ownerId });
    noteVerifiedAuth(account, status);
  } catch (error) {
    // 状态读不出来的话不能让命令直接卡住：CLI 自己会报真正的授权错误。
    log.warn(`auth status failed, continuing without gate: ${error?.message ?? error}`);
    return null;
  }
  if (!force && status.userReady) return null;
  if (force) {
    log.info(
      trigger === "scope"
        ? "scope failure reported; checking the verified token before starting a device flow"
        : "forcing re-authorization: server rejected the stored user token",
    );
  }

  const argvList = Array.isArray(argv) ? argv : [];

  if (!chat.chatId && !chat.senderId) {
    // 没有入站 turn == 定时任务 / 主动触达。会话记忆只查**这个人**名下的记录；
    // 查不到也只用 owner 本人，绝不退回「这个账号最近跟谁说过话」。
    chat.unattended = true;
    const remembered = rememberedChat(account, {
      sessionKey: chat.sessionKey,
      senderId: ownerId,
      ownerUserId: ownerId,
    });
    if (remembered) {
      Object.assign(chat, remembered.entry);
      if (remembered.kind === "owner") chat.chatType = "direct";
      log.info(
        `unattended run without inbound context: sending the card to ${ownerId} (${remembered.kind})`,
      );
    } else {
      chat.senderId = ownerId;
      chat.chatType = "direct";
      log.info(`unattended run: sending the card to the routine owner ${ownerId}`);
    }
  }
  // 无论走哪条分支，私聊卡片的目标都必须是这一轮识别出来的人。
  if (!chat.chatId && normalizeOwnerId(chat.senderId) !== ownerId) {
    chat.senderId = ownerId;
  }

  const domains = authDomainsFor(account, argvList);
  const declared = authScopesFor(account, domains);
  const explicit = account?.authScopes ?? account?.auth_scopes;
  const gaps = rememberScopeGaps(account, missingScopes);
  const mode = authScopeMode(account);
  // 「清单钉死」的两种情形：显式 auth_scopes，或 declared 模式（技能声明的最小集）。
  // 这两种都不该再被「本次失败命令的域」或历史缺口撑大：一旦两个门算出不同条数，
  // startDeviceFlow 的 covers() 就复用不了，用户会连收两张授权卡。
  const pinned = Boolean(explicit?.length) || mode === "declared";
  // 申请范围：
  //   pinned   —— 钉死的清单（+ OAuth 前提权限），所有授权门完全一致。
  //   skill    —— 技能声明域 ∪ 失败命令域，在应用已开通权限里取子集（默认）。
  //   all      —— 应用已开通的全部用户级权限（旧插件 /feishu_auth 语义）。
  const appScopes = await appUserScopes(account, { log });
  const full = !explicit?.length && mode === "all" ? appScopes : null;
  const domainScoped =
    !explicit?.length && mode === "skill"
      ? scopesForDomains(appScopes, domains, { keep: [...declared, ...gaps] })
      : [];
  // all 模式把清单钉死在「应用已开通的全部用户级权限」上：不并技能声明，
  // 更不并历史 gaps。否则每报一次 missing_scope，gaps 就多一项，两个门算出的
  // 条数和签名都不同，covers() 复用失败 —— 一次授权变成两张卡。
  let wanted = explicit?.length
    ? [...explicit]
    : full?.size
      ? [...full]
      : pinned
        ? [...new Set([...declared, ...ALWAYS_SCOPES])]
        : [...new Set([...domainScoped, ...declared, ...gaps])];
  // 什么线索都没有时退回声明全集：宁可多要一条，也好过发一张空 scope 的卡。
  if (!wanted.length) wanted = authScopesFor(account);
  const granted = status.grantedScopes ?? new Set();
  // 申请前先过滤：同意页上出现一行红色「无法授予」会让整套授权看起来是坏的。
  const scopes = await grantableScopes(account, wanted, { log });
  const batchMode = Boolean(full?.size) && !explicit?.length;
  // 钉死清单（pinned）和全量清单（all）的签名都只看 scope 内容：工具预检门
  // （有 argv）和钩子门（argv=null）算出的 domains 天然不同，旧签名含
  // domains+count 会让两个门、以及重启后的 marker 永远对不上，授权完成后又
  // 被判成「没点过」再弹一张卡。
  const signature =
    mode === "all"
      ? `all:${[...scopes].sort().join(",")}`
      : pinned
        ? `pinned:${[...scopes].sort().join(",")}`
        : grantSignature(mode, domains, scopes.length);
  log.info(
    `authorization scope request: mode=${mode} domains=${domains.join("+") || "-"} ` +
      `count=${scopes.length} gaps=${gaps.length} granted=${granted.size}`,
  );

  // 旧插件 `oauth.ts`：token 有效且权限已齐就返回「用户已授权，无需重复授权」。
  // 这里看的是「同模式 + 同域集合 + 同条数」的那次授权点过没有 —— 用 grantedScopes
  // 逐项比对会被租户策略挡掉的个别 scope 拖成无限弹卡。
  if (force && trigger === "scope" && status.userReady) {
    // 工具实报的缺口全部落在声明清单之外时，用户授权卡永远拿不到这些 scope：
    // 发一张卡既解决不了问题，还让用户多点一次。直接判「不是授权问题」，
    // 由工具把原始错误抛回模型，钩子再注入降级提示。
    const gapKind = classifyScopeGap({
      mode,
      missingScopes,
      granted,
      declared: authScopesFor(account),
    });
    if (gapKind === "undeclared_scope") {
      log.warn(
        `scope gap outside declared set (${(missingScopes ?? []).join(",")}); ` +
          "no device flow: a user consent card cannot grant these scopes",
      );
      return { ok: true, already_authorized: true, reason: "undeclared_scope" };
    }

    const marker = readGrantMarker(account);
    // 两个互补的「不用再授权」判据：
    //   1. token 已经覆盖钉死清单里的每一项 —— 用户此前授过更大的范围，
    //      切成最小权限模式时不该再让他点一次卡片。
    //   2. 这次清单已经点过（marker）—— 钉死清单的签名与 argv 无关，两个门
    //      和重启后都能命中；个别 scope 被租户策略挡掉也不会拖成无限弹卡。
    // `offline_access` 这类 OAuth 前提权限不体现在 grantedScopes 里，逐项
    // 比对时要把它们排除，否则「已授过全量」的老用户会被判成还差一条。
    // 工具明确报了仍未授予的 scope 时，绝不能靠 marker 短路成「已授权齐全」。
    const unresolvedGap = (missingScopes ?? []).filter((scope) => !granted.has(scope));
    const pinnedCovered =
      unresolvedGap.length === 0 &&
      pinned &&
      scopes.length > 0 &&
      scopes.filter((scope) => !ALWAYS_SCOPES.has(scope)).every((scope) => granted.has(scope));
    const alreadyGranted =
      (pinned ? unresolvedGap.length === 0 : true) &&
      (pinnedCovered || Boolean(marker?.signature === signature && scopes.length > 0));
    if (alreadyGranted) {
      log.warn(
        `authorization grant already completed for ${signature}; ` +
          "skipping another device flow (the tool error is not a consent problem)",
      );
      return { ok: true, already_authorized: true };
    }
  }

  const flow = await startDeviceFlow(account, domains, {
    scopes,
    log,
    ownerUserId: ownerId,
  });
  flow.grantSignature = signature;
  // 授权完成后重跑作业、卡片更新、resume 都只认这个人。
  flow.ownerUserId = ownerId;
  // 授权窗口的硬上限沿用旧插件的 10 分钟。device code 本身可能更长，但卡片到期
  // 就必须把「去授权」按钮撤掉，否则用户点开的是一个已经失效的链接。
  if (!flow.cardExpiresAt) {
    const cardTtlMs = Math.min(AUTH_CARD_TTL_MS, Math.max(1000, flow.expiresAt - Date.now()));
    flow.cardExpiresAt = Date.now() + cardTtlMs;
    flow.cardTtlSeconds = Math.max(1, Math.round(cardTtlMs / 1000));
    flow.cardSequence = 0;
  }
  if (argvList.length) flow.pendingCommand = `lark-cli ${argvList.join(" ")}`;
  else if (toolName) flow.pendingCommand = toolName;
  // 工具上下文常常没有 body，渠道自己记的原话更可靠。
  const recorded = lastTurnText.get(accountChatKey(account));
  flow.originTask =
    chat.originText ||
    (recorded && Date.now() - recorded.at < 10 * 60_000 ? recorded.text : "") ||
    "";

  if (!chat.chatId && !chat.senderId) {
    return {
      ok: false,
      awaiting_authorization: true,
      verification_url: flow.verificationUrl,
      message:
        "当前没有会话上下文，无法代为发送授权卡片。请把 verification_url 原样发给用户点击完成授权，然后再重试。",
    };
  }

  if (flow.cardSent) {
    return {
      ok: false,
      awaiting_authorization: true,
      expires_in: Math.max(1, Math.round((flow.cardExpiresAt - Date.now()) / 1000)),
      message:
        "授权卡片此前已发给用户，仍在等待他点击完成。本轮不要重试该命令，直接提醒用户查看上面那张授权卡片。",
    };
  }

  const subject = argvList.length
    ? `\`lark-cli ${argvList.slice(0, 3).join(" ")}\``
    : toolName
      ? `\`${toolName}\``
      : "这项操作";
  const cardParams = {
    verificationUrl: flow.verificationUrl,
    expiresIn: flow.cardTtlSeconds,
    // 全量模式下别把 245 个 scope 逐项贴到卡片上，给个总数就够了。
    scopes: batchMode ? [] : (flow.scopes ?? flow.domains ?? []),
    reason:
      (trigger === "scope"
        ? `需要你额外授权一项能力才能继续：${subject}`
        : `要执行的操作需要**你本人身份**：${subject}`) +
      (batchMode
        ? `\n\n本次一次性申请应用已开通的全部 **${scopes.length} 项**用户权限，` +
          "点这一次之后不会再逐项冒出新授权。"
        : domainScoped.length
          ? `\n\n本次一次性申请该技能涉及的 **${domains.join(" / ")}** 相关权限共 **${scopes.length} 项**，` +
            "不含未涉及的域（比如邮箱）；点这一次之后这些能力都不用再逐项授权。"
          : ""),
  };
  const sendOptions = {
    cliPath: account.cliPath,
    configDir: account.configDir,
    cwd: account.scratchDir,
    identity: account.identity,
    to: addressFor(chat),
    timeoutMs: account.sendTimeoutMs,
    env: account.env,
    log,
  };

  // CardKit 优先：只有它能在授权完成后把同一条消息改成「已完成」。静态 v1 卡片兜底。
  try {
    const cardId = await createCardEntity(account, buildAuthCardV2(cardParams), { log });
    await sendCard({
      ...sendOptions,
      content: { type: "card", data: { card_id: cardId } },
    });
    flow.cardId = cardId;
  } catch (cardKitError) {
    log.warn(
      `cardkit unavailable, falling back to static card: ${cardKitError?.message ?? cardKitError}`,
    );
    try {
      await sendCard({ ...sendOptions, card: buildAuthCard(cardParams) });
    } catch (error) {
      log.error(`auth card send failed: ${error?.message ?? error}`);
      return {
        ok: false,
        awaiting_authorization: true,
        verification_url: flow.verificationUrl,
        message:
          "授权卡片发送失败，请把 verification_url 原样发给用户点击完成授权，然后再重试。",
      };
    }
  }

  flow.cardSent = true;
  // 本轮其余输出都对用户没有价值：卡片才是唯一该看的东西。
  if (chat.messageId) markTurnGated(chat.messageId);
  armCardExpiry({ account, flow, log });
  scheduleAuthorizationCompletion({ account, flow, chat, log });

  return {
    ok: false,
    awaiting_authorization: true,
    expires_in: flow.cardTtlSeconds,
    message:
      "已向用户发送飞书授权卡片（含授权链接）。本轮**不要**重试该命令、不要用其它工具替代；" +
      "直接简短回复用户：请他点击卡片里的「去授权」完成授权，完成后会自动继续，他不需要再发消息。",
  };
}

/** 卡片发出后给它装上生命周期：到期原地翻成「已过期」，按钮一起撤掉。 */
function armCardExpiry({ account, flow, log }) {
  const key = accountChatKey(account);
  const previous = cardExpiryTimers.get(key);
  if (previous) clearTimeout(previous);
  const delay = Math.max(0, (flow.cardExpiresAt ?? flow.expiresAt) - Date.now());

  const timer = setTimeout(() => {
    cardExpiryTimers.delete(key);
    // 授权已完成 / 卡片是静态 v1 兜底（无法更新）就不再动它。
    if (flow.settled || !flow.cardId) return;
    flow.settled = true;
    flow.expired = true;
    pollingDeviceCodes.delete(flow.deviceCode);
    clearDeviceFlow(account);
    log.warn("authorization card expired; flipping the same card to its expired state");
    void updateCardEntity(
      account,
      flow.cardId,
      buildAuthCardV2({ state: "expired", expiresIn: flow.cardTtlSeconds }),
      ++flow.cardSequence,
      { log },
    ).catch((error) =>
      log.warn(`auth card expiry update failed: ${error?.message ?? error}`),
    );
  }, delay);
  timer.unref?.();
  cardExpiryTimers.set(key, timer);
}

function clearCardExpiry(account) {
  const key = accountChatKey(account);
  const timer = cardExpiryTimers.get(key);
  if (timer) clearTimeout(timer);
  cardExpiryTimers.delete(key);
}

/**
 * 后台轮询 device flow，用户完成后回到**原会话**续跑。
 *
 * 不这样做的话用户得重新问一遍，而那时模型早就不知道原来要干什么了。
 */
function scheduleAuthorizationCompletion({ account, flow, chat, log }) {
  if (flow.settled || flow.expired) return;
  if (pollingDeviceCodes.has(flow.deviceCode)) return;
  pollingDeviceCodes.add(flow.deviceCode);

  const to = addressFor(chat);

  void (async () => {
    // 卡片可能在排队等轮询时就到期了，别再为一个失效的 flow 干活。
    if (flow.settled || flow.expired) {
      pollingDeviceCodes.delete(flow.deviceCode);
      return;
    }
    let authorized = false;
    let failureDetail = "";

    try {
      await completeDeviceFlow(account, flow.deviceCode, { log });
      authorized = true;
    } catch (error) {
      failureDetail = String(error?.message ?? error);
      log.warn(`device flow exited with error: ${failureDetail}`);
      // 这里绝不能退回 `status.userReady`：只要存在**任意** user token 它就是 true，
      // 于是还在等待的 flow 会被误判成「已授权」——卡片翻成「已完成」、flow 被清掉，
      // 下一条命令又开一张新卡片。只有 exit 0 才算成功。
    }

    if (!authorized) {
      // 被消费 / 未知的 device code 是终态：每 5s 轮询它只会永远转圈。
      const fatal = /invalid|expired|expire|denied|cancel|already|not found/i.test(failureDetail);
      flow.pollAttempts = (flow.pollAttempts ?? 0) + 1;
      if (fatal || flow.pollAttempts > 120 || flow.expiresAt <= Date.now()) {
        // 过期定时器可能已经把卡片翻成「已过期」并收尾，别再覆盖它。
        if (flow.settled) return;
        flow.settled = true;
        clearCardExpiry(account);
        pollingDeviceCodes.delete(flow.deviceCode);
        clearDeviceFlow(account);
        invalidateAuthStatus(account);
        let ready = false;
        try {
          ready = (await readAuthStatus(account, { force: true, log })).userReady;
        } catch (statusError) {
          log.warn(`auth status after failed poll: ${statusError?.message ?? statusError}`);
        }
        log.warn(`device flow ended (${fatal ? "terminal" : "timeout"}); user token ready=${ready}`);
        const timedOut = (flow.cardExpiresAt ?? flow.expiresAt) <= Date.now();
        if (flow.cardId) {
          await updateCardEntity(
            account,
            flow.cardId,
            buildAuthCardV2({
              state: timedOut ? "expired" : ready ? "done" : "failed",
              expiresIn: flow.cardTtlSeconds,
            }),
            ++flow.cardSequence,
            { log },
          ).catch((error) => {
            log.warn(`failed to update auth card: ${error?.message ?? error}`);
          });
        }
        // 过期卡片自己已经写清楚了，不再补一条重复的文本提醒。
        if (ready && !timedOut) {
          await sendText({
            cliPath: account.cliPath,
            configDir: account.configDir,
            cwd: account.scratchDir,
            identity: account.identity,
            to,
            text: "✅ 已收到授权。下一条消息我会用新权限重跑一遍。",
            timeoutMs: account.sendTimeoutMs,
            env: account.env,
            log,
          }).catch((error) => log.warn(`post-auth notice failed: ${error?.message ?? error}`));
        }
        return;
      }

      // `auth login --device-code` 是一次性状态探针，不是阻塞等待：用户还没点
      // 时它以 exit 3 返回。把它当失败会清掉 flow、把卡片翻成「失败」、下一条
      // 命令再发一张新卡片——一条命令一张卡片就是这么来的。
      if (!flow.settled && flow.expiresAt > Date.now()) {
        pollingDeviceCodes.delete(flow.deviceCode);
        log.info("device flow not finished yet; keeping the existing card and re-checking later");
        setTimeout(() => scheduleAuthorizationCompletion({ account, flow, chat, log }), 5_000)
          .unref?.();
        return;
      }
      log.warn(`authorization did not complete: ${failureDetail.slice(0, 400)}`);
      if (!flow.settled) {
        flow.settled = true;
        clearCardExpiry(account);
        clearDeviceFlow(account);
        pollingDeviceCodes.delete(flow.deviceCode);
        if (flow.cardId) {
          // 10 分钟生命周期到了：同一张卡片变「已过期」，不再另发一条消息。
          await updateCardEntity(
            account,
            flow.cardId,
            buildAuthCardV2({ state: "expired", expiresIn: flow.cardTtlSeconds }),
            ++flow.cardSequence,
            { log },
          ).catch((error) => {
            log.warn(`failed to update auth card: ${error?.message ?? error}`);
          });
        }
      }
      return;
    }

    pollingDeviceCodes.delete(flow.deviceCode);
    clearDeviceFlow(account);
    invalidateAuthStatus(account);
    clearCardExpiry(account);
    // 卡片已经过期才完成授权：不要再注入一次 resume 重跑，那正是「点完又弹卡」
    // 循环的放大器；用户需要时自己发一句话即可。
    if (flow.settled) {
      log.warn("device flow completed after the card expired; skipping card update and resume");
      return;
    }
    flow.settled = true;
    lastAuthorizedAt.set(accountChatKey(account), Date.now());
    // 这次授权点过之后就别再要第二次；标记持久化，重启不丢。
    if (flow.grantSignature) {
      writeGrantMarker(account, flow.grantSignature, flow.scopes?.length ?? 0, log);
    }
    // 旧快照里还是授权前的 scope 列表，留着会让下一次判断用过期数据。
    verifiedAuthByAccount.delete(accountChatKey(account));
    log.info("user identity authorized via device flow");

    // 触发这次授权的 run 已经以 NO_UPDATES 收尾，不重跑就等于没有输出。
    // 现在按 owner 过滤，所以入站轮次也可以安全地补跑这个人自己的作业，
    // 不会再像旧实现那样把台账里所有人的 active job 一起拉起来。
    const rerunJobs = triggerProactiveRerun(
      log,
      flow.ownerUserId ?? normalizeOwnerId(chat?.senderId),
    );
    const originTask = String(flow.originTask ?? "").trim();
    const injectResume = shouldInjectResume({ rerunJobs, originTask });

    if (flow.cardId) {
      await updateCardEntity(account, flow.cardId, buildAuthCardV2({ state: "done" }), ++flow.cardSequence, {
        log,
      }).catch((error) => {
        log.warn(`failed to update auth card: ${error?.message ?? error}`);
      });
    }

    await sendText({
      cliPath: account.cliPath,
      configDir: account.configDir,
      cwd: account.scratchDir,
      identity: account.identity,
      to,
      text: rerunJobs > 0
        ? "✅ 已完成飞书授权，正在重新执行刚才的定时任务…"
        : injectResume
          ? "✅ 已完成飞书授权，正在继续刚才的操作…"
          : "✅ 已完成飞书授权。当前会话里没有可继续的原始任务，需要我继续时再说一句需求即可。",
      timeoutMs: account.sendTimeoutMs,
      env: account.env,
      log,
    }).catch((error) => {
      log.warn(`failed to send auth confirmation: ${error?.message ?? error}`);
    });

    // 有定时任务重跑、或原始任务只是「同意」这类确认词时，不要再起一条会话
    // 轮次：那条链的上下文里没有任务描述，模型只会反问「原始需求不在上下文中」
    // 并弹出确认卡片，与正在重跑的日报并行出现，就成了「日报 + 不知道要做什么」。
    if (!injectResume) {
      log.info(
        `skipping synthetic resume after authorization ` +
          `(rerunJobs=${rerunJobs}, originTask=${originTask ? `"${originTask.slice(0, 40)}"` : "missing"})`,
      );
      return;
    }

    // runtime 是按**渠道账号**注册的，按人目录账号的 accountId 是 open_id，
    // 直接拿它去查会找不到。resume 也必须走渠道账号，否则入站路由认不出会话。
    const runtimeAccountId = account.runtimeAccountId ?? account.accountId;
    const runtime =
      runtimesByAccount.get(runtimeAccountId) ?? runtimesByAccount.get(account.accountId);
    if (!runtime) {
      log.warn("no runtime registered, cannot resume after authorization");
      return;
    }
    // 走到这里一定有可引用的真实任务（见 shouldInjectResume）。要点名被打断的
    // 任务；只说「请继续刚才的操作」时模型会答「我找不到刚才的操作」。
    // 刻意不提被打断的那条命令：提到 `lark-cli calendar +agenda …` 会让模型把
    // 那一次调用当成整个任务，跑完一条命令就收工。
    const origin = originTask;
    const resumeText =
      `${origin}\n\n——以上是我上一条消息的原话。我已完成飞书账号授权，权限已齐全。` +
      "请按上面的要求把整件事**从头完整重做一遍**并给出最终结果；" +
      "如果这是一项由技能定义的任务（例如每日飞书简报），请重新加载该技能并从第一步做起；" +
      "不要只重跑其中一条命令，也不要把一条命令的输出当成答案（那只是整件事里的一个取数步骤）。";
    log.info(`resume after authorization: originTask=${origin ? `"${origin.slice(0, 60)}"` : "missing"}`);
    void runtime
      .dispatchSyntheticUserMessage({
        text: resumeText,
        chatId: chat.chatId ?? chat.senderId,
        senderId: chat.senderId ?? chat.chatId,
        messageId: chat.messageId ?? `auth-${Date.now()}`,
        chatType: chat.chatType,
        agentId: chat.agentId,
        accountId: runtimeAccountId,
        threadId: chat.threadId,
        sessionKey: chat.sessionKey,
      })
      .catch((error) => {
        log.error(`failed to resume after authorization: ${error?.message ?? error}`);
      });
  })();
}

// ── 钩子：任何工具的授权类失败都走同一条路 ───────────────────────────────

/** 钩子拿不到 chat id，只能靠会话记忆；返回 null 表示无处可发。 */
/** 钩子拿不到 toolCtx，只能从 payload 里挖 owner：open_id 或 cron job -> 例程 owner。 */
function ownerIdFromHookPayload(payload) {
  const blob = [
    payload?.user_id,
    payload?.session_id,
    payload?.session_key,
    payload?.conversation_id,
    payload?.to,
  ]
    .filter(Boolean)
    .join(" ");
  const direct = normalizeOwnerId(String(blob).match(/ou_[A-Za-z0-9]+/)?.[0]);
  if (direct) return direct;
  const jobMatch = String(blob).match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  if (jobMatch) {
    const routine = readRoutineLedger().find((entry) => entry?.cron_job_id === jobMatch[0]);
    return normalizeOwnerId(routine?.owner_user_id);
  }
  return "";
}

function resolveHookChat({ account, payload, log }) {
  const ownerId =
    normalizeOwnerId(payload?.user_id) ||
    ownerIdFromHookPayload(payload) ||
    normalizeOwnerId(account?.ownerUserId);
  if (!ownerId) {
    log.warn("auth gate: no owner open_id for this tool call; refusing to send a card");
    return null;
  }
  const remembered = rememberedChat(account, {
    sessionKey: payload?.session_id,
    senderId: ownerId,
    ownerUserId: ownerId,
  });
  if (remembered) {
    return {
      ...remembered.entry,
      senderId: ownerId,
      unattended: remembered.kind === "owner",
    };
  }
  log.warn(`auth gate: no remembered conversation for ${ownerId}; falling back to p2p delivery`);
  return { senderId: ownerId, chatType: "direct", unattended: true };
}

/**
 * 注册通用授权钩子。
 *
 * `after_tool_call` 是**任何**工具都会经过的点：本插件工具、内置 http 工具、
 * 其它插件的工具都一样。于是「缺权限 → 卡片 → 续跑」不再需要每个工具各写一遍。
 *
 * 同步预算 120ms：只做识别 + 改写 + fire-and-forget。
 */
export function registerAuthHooks({ api, getAccounts, logger }) {
  if (typeof api?.registerHook !== "function") return false;

  const handler = async (payload) => {
    try {
      const failure = detectAuthFailure(payload);
      if (!failure) return { action: "continue" };

      const accounts = getAccounts?.() ?? [];
      if (!accounts.length) return { action: "continue" };
      // 旧插件所有授权路径都显式用 `ticket.senderOpenId`；这里也必须按人取账号，
      // 不能用 `payload.account_id` 或 `accounts[0]` 落到共享目录 —— 那里面是
      // 另一个人的 user token，卡片和授权都会串到别人身上。
      const ownerId =
        normalizeOwnerId(payload?.user_id) || ownerIdFromHookPayload(payload);
      if (!ownerId) {
        logger.warn("auth gate: cannot attribute this failure to a user; no card sent");
        return { action: "continue" };
      }
      const scoped = ownerAccountResolver?.(ownerId, accounts[0]);
      if (!scoped) {
        logger.warn(`auth gate: no per-user account for ${ownerId}; no card sent`);
        return { action: "continue" };
      }
      const account = { ...scoped, ownerUserId: ownerId };
      const log = logger.child(`${account.runtimeAccountId ?? account.accountId}:${ownerId}`);
      const toolName = String(payload?.tool_name ?? "unknown");
      log.warn(
        `auth gate: tool=${toolName} failed with ${failure.kind} auth error` +
          `${failure.missingScopes?.length ? ` (missing: ${failure.missingScopes.join(",")})` : ""}`,
      );

      if (failure.kind === "app") {
        // 应用级权限只能管理员开，发授权卡片是错的。
        return {
          action: "modify",
          payload: { ...payload, is_error: false, result: hookResultText("app") },
        };
      }

      // 死循环断路器（同步，只读内存快照）：token 已经覆盖全部所需 scope，工具却
      // 还在报 scope 错误时，再开一次 device flow 只会让飞书回一句「请重新授权／
      // 此前已授予的权限」，用户点完还是回到原点。今早 09:02–09:09 连发 4 张卡
      // 就是这个形状。旧插件在 oauth.ts 里也有这一步：「已授权，无需重复授权」。
      if (failure.kind === "scope") {
        const snapshot = verifiedAuth(account);
        const declared = authScopesFor(account);
        const explicitGap = failure.missingScopes ?? [];
        // 缺口落在 declared 清单之外时，授权卡根本不会包含它：既不能发卡，
        // 更不能 markTurnGated 把本轮已取到的数据一起吞掉。旧逻辑在这里先
        // 告诉模型「已发卡请等待」，异步才判 already_authorized，模型于是
        // 卡在等一张不存在的卡，整轮被拖到十几分钟且没有日报。
        const gapKind = classifyScopeGap({
          mode: authScopeMode(account),
          missingScopes: explicitGap,
          granted: snapshot?.granted,
          declared,
        });
        if (gapKind === "undeclared_scope") {
          log.warn(
            `auth gate: scope gap outside declared set (${explicitGap.join(",")}) ` +
              `for tool=${toolName}; not a consent problem — letting the turn finish`,
          );
          return {
            action: "modify",
            payload: { ...payload, is_error: false, result: hookResultText("undeclared_scope") },
          };
        }
        const alreadyCovered = Boolean(
          snapshot?.userReady &&
            (explicitGap.length
              ? explicitGap.every((scope) => snapshot.granted.has(scope))
              : declared.length > 0 && declared.every((scope) => snapshot.granted.has(scope))),
        );
        const justAuthorized =
          Date.now() - (lastAuthorizedAt.get(accountChatKey(account)) ?? 0) <
          POST_AUTH_SUPPRESSION_MS;
        if (alreadyCovered || (justAuthorized && !explicitGap.length)) {
          log.warn(
            `auth gate: suppressing a redundant authorization card for tool=${toolName} ` +
              `(verified=${Boolean(snapshot?.userReady)} justAuthorized=${justAuthorized})`,
          );
          // 不 markTurnGated：让模型把「不是权限问题、真正错在哪」讲给用户。
          return {
            action: "modify",
            payload: { ...payload, is_error: false, result: hookResultText("not_auth") },
          };
        }
      }

      const chat = resolveHookChat({ account, payload, log });
      if (!chat) {
        log.warn("auth gate: no conversation to send the authorization card to");
        return { action: "continue" };
      }
      // 本轮不要再把模型的「半份结果」发出去。
      markTurnGated(chat.messageId);

      const cooldownKey = `${accountChatKey(account)}:${failure.kind}`;
      const cooled = Date.now() - (lastGateAt.get(cooldownKey) ?? 0) < GATE_COOLDOWN_MS;
      if (!cooled) {
        lastGateAt.set(cooldownKey, Date.now());
        // fire-and-forget：卡片要 ~1s，钩子只有 120ms。ensureUserAuthorized 内部
        // 会复用 pending flow（一张卡片只发一次），重复触发不会刷屏。
        void ensureUserAuthorized({
          account,
          argv: null,
          toolCtx: null,
          chat,
          log,
          force: true,
          trigger: failure.kind === "token" ? "token" : "scope",
          missingScopes: failure.missingScopes,
          toolName,
        })
          .then(async (gate) => {
            if (gate?.awaiting_authorization) {
              log.info(`auth gate: authorization card sent for tool=${toolName}`);
            } else if (gate?.already_authorized && gate.reason !== "undeclared_scope") {
              // 钩子已经把结果改写成「已发卡片」，这里补一句，免得用户去找一张
              // 根本不存在的授权卡。
              log.info("auth gate: no card sent, token already covers the requested scopes");
              await sendText({
                cliPath: account.cliPath,
                configDir: account.configDir,
                cwd: account.scratchDir,
                identity: account.identity,
                to: addressFor(chat),
                text: "✅ 已确认飞书授权仍然有效，无需重新授权；刚才的失败不是权限问题。",
                timeoutMs: account.sendTimeoutMs,
                env: account.env,
                log,
              }).catch((error) =>
                log.warn(`auth gate: could not send the no-op notice: ${error?.message ?? error}`),
              );
            }
          })
          .catch((error) =>
            log.warn(`auth gate: could not raise auth card: ${error?.message ?? error}`),
          );
      }

      return {
        action: "modify",
        payload: { ...payload, is_error: false, result: hookResultText(failure.kind) },
      };
    } catch (error) {
      logger.warn(`auth gate hook failed: ${error?.message ?? error}`);
      return { action: "continue" };
    }
  };

  api.registerHook("after_tool_call", handler, {
    name: "feishu-auth-gate",
    priority: 90,
  });
  return true;
}
