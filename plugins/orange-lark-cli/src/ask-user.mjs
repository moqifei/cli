/**
 * feishu_ask_user_question — interactive form card + synthetic answer turn.
 *
 * Ported from openclaw-lark/src/tools/ask-user-question.ts, adapted to this
 * plugin's lark-cli-only runtime:
 *
 *   1. tool call -> build a CardKit 2.0 `form` card, send it, return `pending`
 *   2. user submits -> `card.action.trigger` arrives on the second
 *      `EventConsumer` (see AccountRuntime.startConsumer)
 *   3. handleCardActionEvent() parses `form_value`, flips the card to answered,
 *      and injects a synthetic inbound message with the answers
 *   4. the agent resumes in a new turn, in the same session
 *
 * lark-cli's SDK auto-ACKs card callbacks with `{"code":200}` within 3s, so
 * there is no synchronous response channel to worry about. Card state changes
 * go through CardKit `PUT .../cards/{id}` (already used by the auth card).
 *
 * Skills that use this tool: oa-workflow (审批确认), and any skill that needs
 * a confirmation card before a write.
 */

import { randomUUID } from "node:crypto";

import { updateCard as updateCardEntity } from "./cardkit.mjs";
import { sendCard } from "./outbound.mjs";
import { createCard as createCardEntity } from "./cardkit.mjs";

const TOOL_NAME = "feishu_ask_user_question";
export const CARD_ACTION_EVENT_KEY = "card.action.trigger";

const SUBMIT_PREFIX = "ask_user_submit_";
const INPUT_PREFIX = "answer_";
const SELECT_PREFIX = "selection_";
const PENDING_TTL_MS = 5 * 60_000;
const V2_CONFIG = { wide_screen_mode: true, update_multi: true, locales: ["zh_cn", "en_us"] };

/** questionId -> context. No Promises are held; the card callback owns the reply. */
const pendingQuestions = new Map();
/** event_id -> true, so a redelivered callback cannot inject the answers twice. */
const handledEvents = new Set();

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function normalizeQuestions(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) return null;
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const question = typeof item.question === "string" ? item.question.trim() : "";
    const header = typeof item.header === "string" ? item.header.trim() : "";
    if (!question || !header) return null;
    const options = Array.isArray(item.options) ? item.options : [];
    if (options.length > 10) return null;
    for (const opt of options) {
      if (!opt || typeof opt.label !== "string" || !opt.label.trim()) return null;
    }
    out.push({
      question,
      header,
      options: options.map((opt) => ({
        label: String(opt.label).trim(),
        description: typeof opt.description === "string" ? opt.description.trim() : "",
      })),
      multiSelect: item.multiSelect === true,
      required: item.required !== false,
    });
  }
  return out;
}

function toolText(text, details) {
  return { content: [{ type: "text", text }], details: details ?? {} };
}

// ---------------------------------------------------------------------------
// Card builders (same layout as openclaw-lark)
// ---------------------------------------------------------------------------

function labeledRow(label, control) {
  return {
    tag: "column_set",
    flex_mode: "stretch",
    horizontal_spacing: "8px",
    margin: "12px 0 0 0",
    columns: [
      { tag: "column", width: "weighted", weight: 1, vertical_align: "center", elements: [label] },
      { tag: "column", width: "weighted", weight: 3, vertical_align: "center", elements: [control] },
    ],
  };
}

function questionElements(q, index) {
  const elements = [];
  const label = { tag: "markdown", content: `**${q.header}**` };
  if (q.question !== q.header) {
    elements.push({ tag: "markdown", content: q.question, text_size: "notation" });
  }

  if (q.options.length === 0) {
    elements.push(
      labeledRow(label, {
        tag: "input",
        name: `${INPUT_PREFIX}${index}`,
        placeholder: { tag: "plain_text", content: "请输入..." },
        required: q.required,
      }),
    );
    return elements;
  }

  const selectOptions = q.options.map((opt) => ({
    text: { tag: "plain_text", content: opt.label },
    value: opt.label,
  }));
  const control = {
    tag: q.multiSelect ? "multi_select_static" : "select_static",
    name: `${SELECT_PREFIX}${index}`,
    placeholder: { tag: "plain_text", content: "请选择..." },
    options: selectOptions,
  };
  elements.push(labeledRow(label, control));

  const descriptions = q.options
    .filter((opt) => opt.description)
    .map((opt) => `• **${opt.label}**: ${opt.description}`);
  if (descriptions.length) {
    elements.push({ tag: "markdown", content: descriptions.join("\n"), text_size: "notation" });
  }
  return elements;
}

function cardShell(title, subtitle, tagText, template, elements) {
  return {
    schema: "2.0",
    config: V2_CONFIG,
    header: {
      title: { tag: "plain_text", content: title },
      subtitle: { tag: "plain_text", content: subtitle },
      text_tag_list: [{ tag: "text_tag", text: { tag: "plain_text", content: tagText } }],
      template,
    },
    body: { elements },
  };
}

export function buildQuestionCard(questions, questionId) {
  const formElements = [];
  questions.forEach((q, index) => {
    if (index > 0) formElements.push({ tag: "hr" });
    formElements.push(...questionElements(q, index));
  });
  formElements.push({ tag: "hr" });
  // `value` does NOT propagate on form submit buttons in Feishu, so the
  // questionId travels in the button `name` instead.
  formElements.push({
    tag: "button",
    name: `${SUBMIT_PREFIX}${questionId}`,
    text: { tag: "plain_text", content: "📮 提交" },
    type: "primary",
    form_action_type: "submit",
  });

  return cardShell("需要你的确认", `共 ${questions.length} 个问题`, "待回答", "blue", [
    { tag: "form", name: "ask_user_form", elements: formElements },
  ]);
}

function buildStateCard(questions, answers, state) {
  const mark = state === "answered" ? "✅" : "⏳";
  const elements = [];
  questions.forEach((q, index) => {
    if (index > 0) elements.push({ tag: "hr" });
    const answer = answers?.[q.question] ?? "—";
    elements.push(
      labeledRow(
        { tag: "markdown", content: `**${q.header}**` },
        { tag: "markdown", content: `${mark} **${answer}**` },
      ),
    );
  });
  if (state === "processing") {
    elements.push({ tag: "markdown", content: "正在处理你的回答...", text_size: "notation" });
  }
  if (state === "expired") {
    elements.push({ tag: "markdown", content: "⏱ 该问题已过期", text_size: "notation" });
  }
  return cardShell(
    state === "answered" ? "已收到回答" : state === "expired" ? "问题已过期" : "已提交回答",
    `共 ${questions.length} 个问题`,
    state === "answered" ? "已完成" : state === "expired" ? "已过期" : "处理中",
    state === "answered" ? "green" : state === "expired" ? "grey" : "turquoise",
    elements,
  );
}

// ---------------------------------------------------------------------------
// Pending registry
// ---------------------------------------------------------------------------

function armTtl(ctx) {
  clearTimeout(ctx.timer);
  ctx.timer = setTimeout(() => {
    if (!pendingQuestions.has(ctx.questionId) || ctx.submitted) return;
    pendingQuestions.delete(ctx.questionId);
    void updateCardEntity(ctx.account, ctx.cardId, buildStateCard(ctx.questions, null, "expired"), ++ctx.sequence, {
      log: ctx.log,
    }).catch((error) => ctx.log?.warn?.(`ask-user card expiry update failed: ${error?.message ?? error}`));
  }, PENDING_TTL_MS);
  ctx.timer.unref?.();
}

function store(ctx) {
  ctx.submitted = false;
  ctx.sequence = 1;
  pendingQuestions.set(ctx.questionId, ctx);
  armTtl(ctx);
}

function consume(questionId) {
  const ctx = pendingQuestions.get(questionId);
  if (ctx) clearTimeout(ctx.timer);
  pendingQuestions.delete(questionId);
  return ctx;
}

function fallbackFor(accountId, chatId, operatorId) {
  const matches = [...pendingQuestions.values()].filter(
    (ctx) =>
      !ctx.submitted &&
      ctx.accountId === accountId &&
      (ctx.chatId === chatId || ctx.senderId === operatorId),
  );
  // Refuse to guess when more than one question is open in this chat.
  return matches.length === 1 ? matches[0] : undefined;
}

// ---------------------------------------------------------------------------
// Form value parsing
// ---------------------------------------------------------------------------

function parseFormValue(raw) {
  if (!raw) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function textField(form, name) {
  const value = form?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function multiField(form, name) {
  const raw = form?.[name];
  if (Array.isArray(raw)) return raw.filter((v) => typeof v === "string" && v.trim());
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((v) => typeof v === "string" && v.trim());
    } catch {
      /* plain string */
    }
    return [raw.trim()];
  }
  return [];
}

function collectAnswers(questions, form) {
  const answers = {};
  const missing = [];
  questions.forEach((q, index) => {
    let answer;
    if (q.options.length === 0) {
      answer = textField(form, `${INPUT_PREFIX}${index}`);
    } else if (q.multiSelect) {
      const selected = multiField(form, `${SELECT_PREFIX}${index}`);
      if (selected.length) answer = selected.join(", ");
    } else {
      answer = textField(form, `${SELECT_PREFIX}${index}`);
    }
    if (answer) answers[q.question] = answer;
    else if (q.required) missing.push(q.header);
  });
  return { answers, missing };
}

// ---------------------------------------------------------------------------
// Card action handler (called by AccountRuntime.handleCardAction)
// ---------------------------------------------------------------------------

/**
 * @returns {{handled: boolean, note?: string}} — the SDK already ACKed the
 * callback, so any "toast" here is only for logs; the user sees the CardKit
 * update instead.
 */
export async function handleCardActionEvent(event, { account, runtime, log }) {
  if (!event || event.type !== CARD_ACTION_EVENT_KEY) return { handled: false };
  const eventId = String(event.event_id ?? "");
  if (eventId && handledEvents.has(eventId)) return { handled: true, note: "duplicate" };

  const actionName = String(event.action_name ?? "");
  const form = parseFormValue(event.form_value);
  // Ignore stray clicks on standalone selects/inputs; only the submit button
  // (form_value populated) closes a question.
  if (!form) return { handled: false };

  let questionId = actionName.startsWith(SUBMIT_PREFIX) ? actionName.slice(SUBMIT_PREFIX.length) : "";
  if (!questionId) {
    const value = parseFormValue(event.action_value);
    questionId = typeof value?.operation_id === "string" ? value.operation_id : "";
  }

  const operatorId = String(event.operator_id ?? "");
  const chatId = String(event.chat_id ?? "");
  let ctx = questionId ? pendingQuestions.get(questionId) : undefined;
  if (!ctx) ctx = fallbackFor(account.accountId, chatId, operatorId);
  if (!ctx) return { handled: false, note: "no pending question" };
  if (ctx.submitted) return { handled: true, note: "already submitted" };
  if (operatorId && ctx.senderId && operatorId !== ctx.senderId) {
    return { handled: true, note: "operator mismatch" };
  }
  if (eventId) {
    handledEvents.add(eventId);
    setTimeout(() => handledEvents.delete(eventId), 10 * 60_000).unref?.();
  }

  const { answers, missing } = collectAnswers(ctx.questions, form);
  if (missing.length) {
    return { handled: true, note: `missing required: ${missing.join(", ")}` };
  }

  ctx.submitted = true;
  clearTimeout(ctx.timer);

  const answerLines = Object.entries(answers).map(([q, a]) => `- ${q}: ${a}`).join("\n");
  const origin = ctx.originText ? `\n\n我上一条消息是：「${ctx.originText}」` : "";
  const text =
    `用户回答了你的问题：\n${answerLines}` +
    `${origin}\n\n请按我上一条消息的原始要求继续完成任务，不要重新发问，也不要把卡片内容原样复述。`;

  try {
    await updateCardEntity(
      ctx.account,
      ctx.cardId,
      buildStateCard(ctx.questions, answers, "processing"),
      ++ctx.sequence,
      { log },
    );
  } catch (error) {
    log?.warn?.(`ask-user processing card update failed: ${error?.message ?? error}`);
  }

  try {
    await runtime.dispatchSyntheticUserMessage({
      text,
      chatId: ctx.chatId,
      senderId: ctx.senderId,
      messageId: ctx.messageId ?? `ask-${ctx.questionId}`,
      chatType: ctx.chatType,
      agentId: ctx.agentId,
      accountId: ctx.accountId,
      threadId: ctx.threadId,
      sessionKey: ctx.sessionKey,
      idSuffix: `:ask-user-answer:${ctx.questionId}`,
    });
    consume(ctx.questionId);
  } catch (error) {
    // Let the user retry the same card instead of losing the answers.
    ctx.submitted = false;
    armTtl(ctx);
    log?.error?.(`ask-user synthetic injection failed: ${error?.message ?? error}`);
    try {
      await updateCardEntity(ctx.account, ctx.cardId, buildQuestionCard(ctx.questions, ctx.questionId), ++ctx.sequence, {
        log,
      });
    } catch (cardError) {
      log?.warn?.(`ask-user card revert failed: ${cardError?.message ?? cardError}`);
    }
    return { handled: true, note: "injection failed, card reverted" };
  }

  try {
    await updateCardEntity(
      ctx.account,
      ctx.cardId,
      buildStateCard(ctx.questions, answers, "answered"),
      ++ctx.sequence,
      { log },
    );
  } catch (error) {
    log?.warn?.(`ask-user answered card update failed: ${error?.message ?? error}`);
  }
  return { handled: true, note: `answers injected for ${ctx.questionId}` };
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export function createAskUserQuestionTool({ getAccounts, logger, toolCtx, resolveChat, addressFor }) {
  return {
    name: TOOL_NAME,
    label: "Ask User Question",
    description:
      "Ask the user a question via an interactive Feishu form card. " +
      "Returns immediately after sending the card; the user's answers arrive as a follow-up message in this conversation. " +
      "Do NOT poll or call this tool again for the same question — just end the turn and wait. " +
      "Provide options for a dropdown; set options to [] for a free-text input.",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "Questions to ask (1-20)",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "Full question text" },
              header: { type: "string", description: "Short label (max 12 chars)" },
              options: {
                type: "array",
                description: "Choices; [] renders a free-text input instead of a dropdown",
                maxItems: 10,
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "Display text / submitted value" },
                    description: { type: "string", description: "Explanation of this option" },
                  },
                  required: ["label"],
                },
              },
              multiSelect: { type: "boolean", description: "Allow multiple options" },
              required: { type: "boolean", description: "Defaults to true; false makes it optional" },
            },
            required: ["question", "header", "options", "multiSelect"],
          },
        },
      },
      required: ["questions"],
    },

    async execute(_toolCallId, params) {
      const questions = normalizeQuestions(params?.questions);
      if (!questions) {
        return toolText("ERROR: questions 必须是 1-20 条，每条含 question/header/options/multiSelect", { ok: false });
      }

      const chat = resolveChat(toolCtx) ?? {};
      const accounts = getAccounts();
      const inbound = toolCtx?.openclawInboundContext ?? {};
      const wantedId = inbound.AccountId ?? toolCtx?.deliveryContext?.accountId;
      const account = accounts.find((entry) => entry.accountId === wantedId) ?? accounts[0];
      if (!account) return toolText("ERROR: 没有配置飞书账号", { ok: false });

      const to = addressFor(chat);
      if (!to || to === "user:undefined") {
        return toolText("ERROR: 无法确定当前会话，请从飞书会话里调用本工具", { ok: false });
      }

      const log = logger.child(account.accountId);
      const questionId = randomUUID();
      const card = buildQuestionCard(questions, questionId);

      let cardId;
      try {
        cardId = await createCardEntity(account, card, { log });
      } catch (error) {
        log.error(`failed to create ask-user card: ${error?.message ?? error}`);
        return toolText(`ERROR: 创建确认卡片失败：${error?.message ?? error}`, { ok: false });
      }

      let sent;
      try {
        sent = await sendCard({
          cliPath: account.cliPath,
          configDir: account.configDir,
          cwd: account.scratchDir,
          identity: account.identity,
          to,
          content: { type: "card", data: { card_id: cardId } },
          timeoutMs: account.sendTimeoutMs,
          idempotencyKey: `ask-user-${questionId}`,
          env: account.env,
          log,
        });
      } catch (error) {
        log.error(`failed to send ask-user card: ${error?.message ?? error}`);
        return toolText(`ERROR: 发送确认卡片失败：${error?.message ?? error}`, { ok: false });
      }

      store({
        questionId,
        accountId: account.accountId,
        account,
        cardId,
        questions,
        chatId: chat.chatId,
        senderId: chat.senderId,
        chatType: chat.chatType,
        threadId: chat.threadId,
        agentId: chat.agentId,
        sessionKey: chat.sessionKey,
        originText: String(chat.originText ?? "").slice(0, 800),
        messageId: sent?.messageId ?? chat.messageId,
        log,
      });

      log.info(`ask-user card sent id=${questionId} message=${sent?.messageId} to=${to}`);
      return toolText(
        JSON.stringify({
          status: "pending",
          questionId,
          message:
            "确认卡片已发给用户。用户的回答会作为本会话的下一条消息送达。" +
            "本轮到此结束：不要重试本工具、不要改用文字追问、不要自行假设答案。",
        }),
        { ok: true, status: "pending" },
      );
    },
  };
}
