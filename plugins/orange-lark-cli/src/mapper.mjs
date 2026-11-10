/**
 * `im.message.receive_v1` (lark-cli flattened shape) -> Orange inbound context.
 *
 * The field names on the right-hand side are the ones the Orange OpenClaw shim
 * reads (see orange/src/plugins/typescript/openclaw-host-runtime.ts). They are
 * deliberately the OpenClaw spelling (`Provider`, `From`, `Body`, …) so the
 * host's inference helpers work unchanged.
 */

const SUPPORTED_MESSAGE_TYPES = new Set(["text"]);

/**
 * @returns {{ ok: true, context: object } | { ok: false, reason: string }}
 */
export function mapMessageEvent(event, options) {
  const { accountId, agentRoute, botOpenId, allowMessageTypes } = options;
  const supported = allowMessageTypes ?? SUPPORTED_MESSAGE_TYPES;

  if (!event || event.type !== "im.message.receive_v1") {
    return { ok: false, reason: `unexpected event type ${event?.type}` };
  }
  if (!event.message_id) {
    return { ok: false, reason: "missing message_id" };
  }
  if (event.sender_type === "bot") {
    return { ok: false, reason: "sender is a bot (loop guard)" };
  }
  if (!supported.has(event.message_type ?? "")) {
    return { ok: false, reason: `unsupported message_type ${event.message_type} (P0: text only)` };
  }
  const text = typeof event.content === "string" ? event.content.trim() : "";
  if (!text) {
    return { ok: false, reason: "empty content" };
  }

  const chatType = event.chat_type === "p2p" ? "direct" : "group";
  const isGroup = chatType === "group";
  const mentions = Array.isArray(event.mentions) ? event.mentions : [];
  const mentioned =
    mentions.some((mention) => mention?.id && botOpenId && mention.id === botOpenId) ||
    mentions.some((mention) => mention?.id === "all" || mention?.key === "@_all") ||
    (mentions.length > 0 && !botOpenId);

  const peer = { kind: isGroup ? "group" : "direct", id: isGroup ? event.chat_id : event.sender_id };
  const route = agentRoute ? agentRoute(peer) : undefined;

  const to = isGroup ? `chat:${event.chat_id}` : `user:${event.sender_id}`;
  const context = {
    // identity
    Provider: "feishu",
    Surface: "feishu",
    AccountId: accountId,
    account_id: accountId,
    // who / where
    From: `feishu:${event.sender_id}`,
    SenderId: event.sender_id,
    To: to,
    OriginatingTo: to,
    ChatId: event.chat_id,
    ChatType: chatType,
    ...(isGroup ? { GroupId: event.chat_id, GroupSubject: event.chat_id } : {}),
    // body
    Body: text,
    BodyForAgent: text,
    RawBody: text,
    CommandBody: text,
    // ids / threading
    MessageSid: event.message_id,
    MessageId: event.message_id,
    ...(event.thread_id ? { MessageThreadId: event.thread_id } : {}),
    ...(event.reply_to ? { ReplyToId: event.reply_to } : {}),
    WasMentioned: mentioned,
    // routing
    ...(route?.agentId ? { AgentId: route.agentId } : {}),
    ...(route?.sessionKey ? { SessionKey: route.sessionKey } : {}),
    Timestamp: Number(event.create_time || event.timestamp || Date.now()),
    // raw passthrough for tooling / debugging
    _larkCli: {
      event_id: event.event_id,
      message_id: event.message_id,
      chat_id: event.chat_id,
      chat_type: event.chat_type,
      message_type: event.message_type,
      sender_id: event.sender_id,
      thread_id: event.thread_id,
      root_id: event.root_id,
      reply_to: event.reply_to,
      mentions,
    },
  };

  return { ok: true, context };
}

/** Small bounded dedup cache keyed by message id. */
export function createDeduper({ ttlMs = 10 * 60_000, maxEntries = 5_000 } = {}) {
  const seen = new Map();
  const prune = (now) => {
    if (seen.size <= maxEntries) return;
    for (const [key, at] of seen) {
      if (now - at > ttlMs || seen.size > maxEntries) seen.delete(key);
      if (seen.size <= maxEntries) break;
    }
  };
  return {
    firstTime(messageId) {
      const now = Date.now();
      const previous = seen.get(messageId);
      if (previous && now - previous < ttlMs) return false;
      seen.set(messageId, now);
      prune(now);
      return true;
    },
    get size() {
      return seen.size;
    },
  };
}
