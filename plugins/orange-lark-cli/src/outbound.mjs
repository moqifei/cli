/**
 * Outbound text delivery through `lark-cli im +messages-send`.
 *
 * Design notes:
 *  - argv only, never a shell string.
 *  - the reply body goes through stdin (`--text -`) so leading `@`/`-` or
 *    multi-line content can never be mistaken for a flag or an @file path.
 *  - `--format json` is passed explicitly even though it is the default, so a
 *    future default change cannot silently turn output into a table.
 */

import { createHash } from "node:crypto";

import { extractMessageId, runCli } from "./cli.mjs";
import { redact } from "./log.mjs";

const CHUNK_LIMIT = 12_000; // Feishu text ceiling is 15k; leave headroom.

export function resolveTarget(to) {
  const raw = String(to ?? "").trim();
  if (!raw) return null;
  if (raw.startsWith("chat:")) return { kind: "chat", id: raw.slice(5) };
  if (raw.startsWith("user:")) return { kind: "user", id: raw.slice(5) };
  if (raw.startsWith("oc_")) return { kind: "chat", id: raw };
  if (raw.startsWith("ou_")) return { kind: "user", id: raw };
  // Unknown shapes: chat ids are the safer default for a channel reply.
  return { kind: "chat", id: raw };
}

/**
 * 只有真实的飞书消息 id 才能拿去 `--message-id` 回复。
 *
 * 授权后续跑会注入一条合成入站，它的 id 形如 `auth-…:auth-complete`。之前直接
 * 把这个 id 当 reply target，飞书回 `invalid message ID: must start with om_`，
 * 于是「已完成授权，正在继续…」之后的最终答复整条发不出去，用户以为没反应。
 */
/**
 * 飞书只认真实的 `om_...` 作为回复目标。
 *
 * 我们自己的合成入站消息会拼一个后缀做关联，形如
 * `om_xxx:ask-user-answer:<uuid>` / `om_xxx:auth-complete`。它的前缀也是
 * `om_`，所以"只看前缀"的校验会放行，随后 API 直接 400：
 *   The request you send is not a valid {open_message_id}
 * 后果是整轮答复投递失败——业务已经做完了，用户却什么都收不到。
 *
 * 这里把冒号之后的部分去掉；真正不认识的（比如 `ask-<uuid>`）仍然放弃回复，
 * 退化成发一条新消息，而不是让整条回复失败。
 *
 * 导出仅为单测覆盖。
 */
export function validReplyTo(raw, log) {
  const value = String(raw ?? "").trim();
  if (!value) return undefined;
  const real = value.split(":")[0];
  if (!/^om_/.test(real)) {
    log?.warn?.(`ignoring synthetic reply target ${value.slice(0, 60)}; sending as a new message`);
    return undefined;
  }
  if (real !== value) {
    log?.info?.(`stripping synthetic suffix from reply target: ${value.slice(0, 60)} -> ${real}`);
  }
  return real;
}

export function splitText(text, limit = CHUNK_LIMIT) {
  const value = String(text ?? "");
  if (value.length <= limit) return [value];
  const chunks = [];
  let rest = value;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * System notices (consent prompt, receipts, reminders) used to go out as plain
 * text bubbles while the authorization card and the brief render as cards, so
 * one bot looked like three different speakers in the same chat.
 *
 * Rendering them as cards keeps a single visual language: same bubble shape,
 * same markdown, same width. v1 (not CardKit) because these are one-shot
 * notices that never need in-place updates.
 */
/**
 * 同一份内容 10 秒内只发一次。
 *
 * Orange 的 `outbound recovery` 会在 channel/send 还没返回时就去扫 pending 队列：
 * 卡片投递要 1s+（建卡 + 发送），于是同一条简报被当成「没发成功」重投一遍，用户
 * 收到两条。这里让第二次请求等第一次的 promise —— 它会拿到同样的 messageId，
 * 核心也就能正常把队列项标成已完成，而不是再发一条。
 */
const DEDUPE_WINDOW_MS = 10_000;
const recentDeliveries = new Map();

function fingerprint(value) {
  return createHash("sha1").update(String(value ?? "")).digest("hex").slice(0, 16);
}

function deliveryTargetKey(to) {
  const target = resolveTarget(to);
  return target ? `${target.kind}:${target.id}` : fingerprint(JSON.stringify(to ?? null));
}

/** Test hook: forget the dedupe window so repeated sends in one process still go out. */
export function resetDeliveryDedupe() {
  recentDeliveries.clear();
}

function dedupeDelivery(key, run, log) {
  const now = Date.now();
  for (const [existingKey, entry] of recentDeliveries) {
    if (now - entry.at > DEDUPE_WINDOW_MS * 2) recentDeliveries.delete(existingKey);
  }
  const hit = recentDeliveries.get(key);
  if (hit && now - hit.at < DEDUPE_WINDOW_MS) {
    log?.warn("duplicate delivery suppressed; reusing the in-flight send result");
    return hit.promise;
  }
  const promise = run().catch((error) => {
    recentDeliveries.delete(key);
    throw error;
  });
  recentDeliveries.set(key, { at: now, promise });
  return promise;
}

function buildNoticeCard(text) {
  return {
    config: { wide_screen_mode: true },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: String(text) } },
    ],
  };
}

export function sendText(options) {
  // blocks 形态（admin 通知）没有 text，用渲染后的纯文本做指纹，否则所有 blocks
  // 消息会共用一个空指纹，被误判成重复。
  const body = String(options?.text ?? "").trim() || blocksToPlainText(options?.blocks);
  const key = `text|${deliveryTargetKey(options?.to)}|${fingerprint(body)}`;
  return dedupeDelivery(key, () => sendTextInner(options), options?.log);
}

async function sendTextInner(options) {
  const {
    cliPath,
    configDir,
    cwd,
    identity = "bot",
    to,
    text,
    timeoutMs = 60_000,
    idempotencyKey,
    env,
    log,
    replyToMessageId,
    replyInThread = false,
  } = options;

  const target = resolveTarget(to);
  if (!target) {
    throw new Error(`cannot resolve delivery target: ${JSON.stringify(to)}`);
  }
  const replyTo = validReplyTo(replyToMessageId, log);
  const body = String(text ?? "");
  if (!body.trim()) {
    throw new Error("refusing to send empty text");
  }

  // Card-first: a system notice should look like the authorization card and the
  // brief, not like a separate plain-text bot. Any failure falls back to text so
  // a card problem can never silence a message.
  try {
    return await sendCard({ ...options, card: buildNoticeCard(body) });
  } catch (error) {
    log?.warn(`notice card failed, falling back to text: ${error?.message ?? error}`);
  }

  const args = replyTo
    ? [
        "im",
        "+messages-reply",
        "--as",
        identity,
        "--message-id",
        String(replyTo),
        ...(replyInThread ? ["--reply-in-thread"] : []),
        "--text",
        "-",
        "--format",
        "json",
      ]
    : [
        "im",
        "+messages-send",
        "--as",
        identity,
        target.kind === "chat" ? "--chat-id" : "--user-id",
        target.id,
        "--text",
        "-",
        "--format",
        "json",
      ];
  if (idempotencyKey) args.push("--idempotency-key", String(idempotencyKey).slice(0, 50));

  const result = await runCli({
    cliPath,
    configDir,
    cwd,
    args,
    stdinText: body,
    timeoutMs,
    env,
    log,
  });

  const messageId = extractMessageId(result);
  const where = replyTo
    ? `reply to ${replyTo}${replyInThread ? " (thread)" : ""}`
    : `${target.kind}:${target.id}`;
  log?.info(`sent to ${where} message_id=${messageId ?? "?"} chars=${body.length}`);
  return { messageId, target };
}

/**
 * Send an interactive card (`msg_type=interactive`).
 *
 * Accepts either `content` (the raw `content` object — used for CardKit refs,
 * `{type:"card",data:{card_id}}`) or `card` (a legacy v1 card JSON). The
 * payload goes through stdin so its size and quoting never touch argv.
 */
export function sendCard(options) {
  const payload = options?.content ?? options?.card;
  const key = `card|${deliveryTargetKey(options?.to)}|${fingerprint(JSON.stringify(payload ?? null))}`;
  return dedupeDelivery(key, () => sendCardInner(options), options?.log);
}

async function sendCardInner(options) {
  const {
    cliPath,
    configDir,
    cwd,
    identity = "bot",
    to,
    card,
    content,
    timeoutMs = 60_000,
    idempotencyKey,
    env,
    log,
    replyToMessageId,
    replyInThread = false,
  } = options;

  const target = resolveTarget(to);
  const replyTo = validReplyTo(replyToMessageId, log);
  if (!target && !replyTo) {
    throw new Error(`cannot resolve delivery target: ${JSON.stringify(to)}`);
  }
  const payload = content ?? card;
  if (!payload || typeof payload !== "object") {
    throw new Error("refusing to send an empty card");
  }

  // 回复用户那条消息：飞书会渲染引用块（「回复 某某：…」）并把消息挂进同一条
  // 会话线程。旧插件一直这么发，用户能一眼看出这条是在答哪句话。
  const args = replyTo
    ? [
        "im",
        "+messages-reply",
        "--as",
        identity,
        "--message-id",
        String(replyTo),
        ...(replyInThread ? ["--reply-in-thread"] : []),
        "--msg-type",
        "interactive",
        "--content",
        "-",
        "--format",
        "json",
      ]
    : [
        "im",
        "+messages-send",
        "--as",
        identity,
        target.kind === "chat" ? "--chat-id" : "--user-id",
        target.id,
        "--msg-type",
        "interactive",
        "--content",
        "-",
        "--format",
        "json",
      ];
  if (idempotencyKey) args.push("--idempotency-key", String(idempotencyKey).slice(0, 50));

  const result = await runCli({
    cliPath,
    configDir,
    cwd,
    args,
    stdinText: JSON.stringify(payload),
    timeoutMs,
    env,
    log,
  });

  const messageId = extractMessageId(result);
  const where = replyTo
    ? `reply to ${replyTo}${replyInThread ? " (thread)" : ""}`
    : `${target.kind}:${target.id}`;
  log?.info(`sent card to ${where} message_id=${messageId ?? "?"}`);
  return { messageId, target };
}

// ---------------------------------------------------------------------------
// Rich post (`msg_type=post`)
// ---------------------------------------------------------------------------

/**
 * Orange's admin console sends rich content as `blocks`
 * (`{ zh_cn: { title?, content: [[...]] } }`) while leaving `text` empty — the
 * old openclaw-lark plugin rendered those blocks as a Feishu post. This plugin
 * used to ignore `blocks`, so the CLI received an empty text, Feishu accepted
 * it, Orange reported success and the group saw nothing.
 *
 * Feishu requires images to be `{ tag: "img", image_key }`; the editor emits
 * bare `{ image_key }`, which the API rejects. Fill in the missing tag.
 */
function normalizePostElement(element) {
  if (!element || typeof element !== "object") return null;
  if (typeof element.tag === "string" && element.tag) return element;
  if (element.image_key) return { tag: "img", image_key: String(element.image_key) };
  if (element.file_key) return { tag: "media", file_key: String(element.file_key) };
  if (typeof element.text === "string" && element.text) return { tag: "text", text: element.text };
  return null;
}

function normalizePostRow(row) {
  if (!Array.isArray(row)) return [];
  return row.map(normalizePostElement).filter(Boolean);
}

export function toPostContent(blocks) {
  if (!blocks || typeof blocks !== "object") return null;

  // Already post content: `{ locale: { title?, content: [[...]] } }`.
  if (!Array.isArray(blocks)) {
    const locales = {};
    for (const [locale, value] of Object.entries(blocks)) {
      if (!value || typeof value !== "object" || !Array.isArray(value.content)) continue;
      const content = value.content.map(normalizePostRow).filter((row) => row.length > 0);
      if (!content.length) continue;
      locales[locale] = {
        ...(value.title ? { title: String(value.title) } : {}),
        content,
      };
    }
    if (Object.keys(locales).length) return locales;
  }

  // Fallback: a bare row array.
  const rows = Array.isArray(blocks) ? blocks : [];
  const content = rows
    .map((row) => normalizePostRow(Array.isArray(row) ? row : [row]))
    .filter((row) => row.length > 0);
  if (!content.length) return null;
  return { zh_cn: { content } };
}

/** blocks → plain text, used when the post render is rejected. */
export function blocksToPlainText(blocks) {
  if (!blocks || typeof blocks !== "object") return "";
  let rows = null;
  if (Array.isArray(blocks)) {
    rows = blocks;
  } else if (blocks.zh_cn && Array.isArray(blocks.zh_cn.content)) {
    rows = blocks.zh_cn.content;
  } else {
    const localized = Object.values(blocks).find(
      (entry) => entry && typeof entry === "object" && Array.isArray(entry.content),
    );
    rows = localized?.content ?? null;
  }
  if (!Array.isArray(rows)) return "";

  const lines = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const parts = [];
    for (const element of row) {
      if (!element || typeof element !== "object") continue;
      if (element.tag === "img" || element.image_key) parts.push("[图片]");
      else if (element.tag === "media" || element.file_key) parts.push("[文件]");
      else if (element.tag === "at") parts.push(`@${element.user_name ?? element.user_id ?? "某人"}`);
      else if (typeof element.text === "string" && element.text) parts.push(element.text);
    }
    if (parts.length) lines.push(parts.join(""));
  }
  return lines.join("\n").trim();
}

/** Send a rich post (`msg_type=post`) built from Orange `blocks`. */
export function sendPost(options) {
  const key = `post|${deliveryTargetKey(options?.to)}|${fingerprint(
    JSON.stringify(options?.content ?? null),
  )}`;
  return dedupeDelivery(key, () => sendPostInner(options), options?.log);
}

async function sendPostInner(options) {
  const {
    cliPath,
    configDir,
    cwd,
    identity = "bot",
    to,
    content,
    timeoutMs = 60_000,
    idempotencyKey,
    env,
    log,
  } = options;

  const target = resolveTarget(to);
  if (!target) {
    throw new Error(`cannot resolve delivery target: ${JSON.stringify(to)}`);
  }
  const payload = toPostContent(content);
  if (!payload) {
    throw new Error("refusing to send an empty post");
  }

  const args = [
    "im",
    "+messages-send",
    "--as",
    identity,
    target.kind === "chat" ? "--chat-id" : "--user-id",
    target.id,
    "--msg-type",
    "post",
    "--content",
    "-",
    "--format",
    "json",
  ];
  if (idempotencyKey) args.push("--idempotency-key", String(idempotencyKey).slice(0, 50));

  const result = await runCli({
    cliPath,
    configDir,
    cwd,
    args,
    stdinText: JSON.stringify(payload),
    timeoutMs,
    env,
    log,
  });

  const messageId = extractMessageId(result);
  log?.info(`sent post to ${target.kind}:${target.id} message_id=${messageId ?? "?"}`);
  return { messageId, target };
}

export async function sendTextChunked(options) {
  const chunks = splitText(options.text);
  const ids = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (!chunk.trim()) continue;
    try {
      const { messageId } = await sendText({
        ...options,
        text: chunk,
        idempotencyKey: options.idempotencyKey
          ? `${options.idempotencyKey}-${index}`.slice(0, 50)
          : undefined,
      });
      ids.push(messageId);
    } catch (error) {
      throw new Error(
        `chunk ${index + 1}/${chunks.length} failed: ${redact(error?.message ?? error)}`,
      );
    }
  }
  return ids;
}
