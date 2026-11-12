/**
 * CardKit 2.0 卡片体（移植自 `openclaw-lark/src/card/builder.ts`）。
 *
 * 结构（与旧插件逐元素对齐，顺序不能换）：
 *
 *   [🛠️ 工具执行 · N 步 (1.2s)]   ← collapsible_panel，**首帧 / 中间帧 / 终帧都仅在有工具步骤时出现**
 *   [💭 思考中... / 思考了 3.2s]   ← collapsible_panel，一直保留到终帧
 *   回答 markdown                  ← element_id=streaming_content，原地更新
 *   [已完成 · 耗时 4.1s]           ← footer，默认关闭（与旧插件默认值一致）
 *
 * 首帧只有空的流式锚点：不渲染任何占位面板（「等待工具执行」这类空壳旧插件没有，
 * 用户会以为卡住了）。占位 markdown 让 CardKit 的 streaming 光标有落点。
 */

import { optimizeMarkdownStyle } from "./card-markdown.mjs";
import { escapeMarkdown, formatStepStatus } from "./tool-display.mjs";

/** 流式文本区的 element_id：CardKit 靠它做打字机效果。 */
export const STREAMING_ELEMENT_ID = "streaming_content";

const REASONING_PREFIX = /^\s*Reasoning:\s*\n/;

/**
 * Host 把思考内容包成 `Reasoning:\n_逐行斜体_`，去掉两层包装，
 * 否则面板里显示的是字面 markdown。
 */
export function cleanReasoningText(raw) {
  const text = String(raw ?? "").replace(REASONING_PREFIX, "");
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("_") && trimmed.endsWith("_") && trimmed.length > 2) {
        return trimmed.slice(1, -1);
      }
      return line;
    })
    .join("\n")
    .trim();
}

/** 毫秒 → `1.2s` / `1m 5s`（与旧插件 `formatElapsed` 一致）。 */
export function formatElapsed(ms) {
  const seconds = Number(ms) / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) return "0.0s";
  return seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

/** 中英双语字段：卡片按客户端语言自动切换。 */
function i18n(zh, en) {
  return { content: en, i18n_content: { zh_cn: zh, en_us: en } };
}

// ── 思考面板 ────────────────────────────────────────────────────────────

function reasoningPanel({ text, active, expanded, elapsedMs }) {
  const duration = elapsedMs ? formatElapsed(elapsedMs) : null;
  const zh = duration ? `💭 思考了 ${duration}` : active ? "💭 思考中..." : "💭 思考";
  const en = duration ? `💭 Thought for ${duration}` : active ? "💭 Thinking..." : "💭 Thought";
  return {
    tag: "collapsible_panel",
    expanded: Boolean(expanded),
    header: {
      title: { tag: "markdown", ...i18n(zh, en) },
      vertical_align: "center",
      icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
      icon_position: "follow_text",
      icon_expanded_angle: -180,
    },
    border: { color: "grey", corner_radius: "5px" },
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    elements: [{ tag: "markdown", content: stripThinkTags(text), text_size: "notation" }],
  };
}

// ── 工具面板 ────────────────────────────────────────────────────────────

/** 一个步骤：`div(icon + **标题** · <font>状态</font>)`。 */
function stepElement(step) {
  const status = formatStepStatus(step.status);
  return {
    tag: "div",
    icon: { tag: "standard_icon", token: step.iconToken, color: "grey" },
    text: {
      tag: "lark_md",
      content: `**${escapeMarkdown(step.title)}** · <font color='${status.color}'>${status.label}</font>`,
      text_size: "notation",
    },
  };
}

function toolPanelShell({ titleZh, titleEn, expanded, elements, verticalSpacing = "4px" }) {
  return {
    tag: "collapsible_panel",
    expanded: Boolean(expanded),
    header: {
      title: {
        tag: "plain_text",
        ...i18n(titleZh, titleEn),
        text_color: "grey",
        text_size: "notation",
      },
      vertical_align: "center",
      icon: {
        tag: "standard_icon",
        token: "down-small-ccm_outlined",
        color: "grey",
        size: "16px 16px",
      },
      icon_position: "right",
      icon_expanded_angle: -180,
    },
    border: { color: "grey", corner_radius: "5px" },
    vertical_spacing: verticalSpacing,
    padding: "8px 8px 8px 8px",
    elements,
  };
}

/** 执行中：展开，标题带步数与耗时。 */
function activeToolPanel({ steps, elapsedMs }) {
  const parts = ["工具执行", `${steps.length} 步`];
  const enParts = ["Tool use", `${steps.length} step${steps.length === 1 ? "" : "s"}`];
  if (elapsedMs > 0) {
    const duration = formatElapsed(elapsedMs);
    parts.push(`(${duration})`);
    enParts.push(`(${duration})`);
  }
  return toolPanelShell({
    titleZh: `🛠️ ${parts.join(" · ")}`,
    titleEn: `🛠️ ${enParts.join(" · ")}`,
    expanded: true,
    elements: steps.map(stepElement),
  });
}

/** 终态：收起，标题只留耗时。 */
function completeToolPanel({ steps, elapsedMs }) {
  const zhParts = [elapsedMs ? `执行耗时 ${formatElapsed(elapsedMs)}` : "工具执行"];
  const enParts = [elapsedMs ? `Tool use for ${formatElapsed(elapsedMs)}` : "Tool use"];
  return toolPanelShell({
    titleZh: `🛠️ ${zhParts.join(" · ")}`,
    titleEn: `🛠️ ${enParts.join(" · ")}`,
    expanded: false,
    // 调用方保证 steps 非空：没有工具步骤时整块面板都不渲染，
    // 绝不再留一条展开是空的「工具执行」折叠条让用户以为出了什么问题。
    elements: steps.map(stepElement),
  });
}

// ── Footer ──────────────────────────────────────────────────────────────

/**
 * Footer：状态 / 耗时 / 模型。旧插件默认全关（`DEFAULT_FOOTER_CONFIG`），
 * 这里保持一致，由 `channels.feishu.footer` 打开。
 *
 * 旧插件还有 tokens/cache/context，数据来自 session 统计；新插件拿不到，
 * 因此这几项即使打开也不显示（不会显示成 0）。
 */
function footerElements({ footer, elapsedMs, metrics, isError, isAborted }) {
  if (!footer) return [];
  const zh = [];
  const en = [];
  if (footer.status) {
    zh.push(isError ? "出错" : isAborted ? "已停止" : "已完成");
    en.push(isError ? "Error" : isAborted ? "Stopped" : "Completed");
  }
  if (footer.elapsed && elapsedMs > 0) {
    zh.push(`耗时 ${formatElapsed(elapsedMs)}`);
    en.push(`Elapsed ${formatElapsed(elapsedMs)}`);
  }
  if (footer.model && metrics?.model) {
    zh.push(String(metrics.model).trim());
    en.push(String(metrics.model).trim());
  }
  if (!zh.length) return [];
  const content = en.join(" · ");
  const zhContent = zh.join(" · ");
  return [
    {
      tag: "markdown",
      content: isError ? `<font color='red'>${content}</font>` : content,
      i18n_content: {
        zh_cn: isError ? `<font color='red'>${zhContent}</font>` : zhContent,
        en_us: isError ? `<font color='red'>${content}</font>` : content,
      },
      text_size: "notation",
    },
  ];
}

// ── summary（会话列表预览） ──────────────────────────────────────────────

// 对齐旧插件 openclaw-lark/src/card/builder.ts 的推理标签处理：
// <think> / <thinking> / <thought> / <antthinking>，含带空格与未闭合变体。
const THINK_SCAN_RE = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
const THINK_BLOCK_RE = /<\s*(?:think(?:ing)?|thought|antthinking)\s*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
const THINK_UNCLOSED_RE = /<\s*(?:think(?:ing)?|thought|antthinking)\s*>[\s\S]*$/gi;
const THINK_ORPHAN_RE = /<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
const EMPTY_REPLY_FALLBACK = "Done.";

/** 提取标签内的推理文本（含未闭合标签），用于送进思考面板。 */
export function extractThinkingContent(text) {
  const source = String(text ?? "");
  const scanRe = new RegExp(THINK_SCAN_RE.source, "gi");
  let result = "";
  let lastIndex = 0;
  let inThinking = false;
  for (const match of source.matchAll(scanRe)) {
    const idx = match.index ?? 0;
    if (inThinking) result += source.slice(lastIndex, idx);
    inThinking = match[1] !== "/";
    lastIndex = idx + match[0].length;
  }
  if (inThinking) result += source.slice(lastIndex);
  return result.trim();
}

/** 正文 / 预览清洗：完整块、未闭合块、孤立闭合标签、`Reasoning:` 前缀。 */
export function stripThinkTags(text) {
  const source = String(text ?? "");
  if (REASONING_PREFIX.test(source)) return "";
  return source
    .replace(THINK_BLOCK_RE, "")
    .replace(THINK_UNCLOSED_RE, "")
    .replace(THINK_ORPHAN_RE, "")
    .trim();
}

/** dispatcher 入口用：拆出推理文本，剩下的才是能给用户看的正文。 */
export function splitReasoningText(text) {
  if (typeof text !== "string" || !text.trim()) return { answerText: text ?? "" };
  if (REASONING_PREFIX.test(text)) {
    return { reasoningText: cleanReasoningText(text), answerText: "" };
  }
  const reasoningText = extractThinkingContent(text);
  const answerText = stripThinkTags(text);
  if (!reasoningText && answerText === text) return { answerText: text };
  return { reasoningText: reasoningText || undefined, answerText: answerText || undefined };
}

function summaryOf(text) {
  const plain = stripThinkTags(text)
    .replace(/[*_`#>[\]()~]/g, "")
    .trim();
  // 终帧 summary 恒非空：空回答时若不下发 summary，服务端会保留建卡时的
  // 「处理中...」预览，会话列表就一直显示「[生成中...]」。
  return { content: (plain || EMPTY_REPLY_FALLBACK).slice(0, 120) };
}

function baseConfig({ summary, streaming }) {
  return {
    wide_screen_mode: true,
    update_multi: true,
    locales: ["zh_cn", "en_us"],
    // 终帧显式写 false：CardKit 在流式模式下会把会话列表预览锁成「[生成中...]」，
    // 让终帧卡片自己带上「非流式」语义，不完全依赖 settings 接口的时序。
    streaming_mode: Boolean(streaming),
    ...(summary ? { summary } : {}),
  };
}

// ── 卡片 ────────────────────────────────────────────────────────────────

/**
 * 首帧：文字还没到就先发这张卡，用户立刻看到反馈。
 *
 * 只放一个空的流式锚点，不再渲染「等待工具执行」占位面板：那是个永远填不满的
 * 空壳，回答出来后还挂在正文上方，旧插件没有这块。
 *
 * `showToolUse` 仅为调用方签名兼容保留，首帧已经没有工具面板可开关。
 *
 * `loadingIcon` 是租户自传的转圈图标（`img_v3_...`）。默认不发：img_key 是
 * 应用级资源，别的租户用自己的 key 会渲染失败甚至让整次更新报错。
 */
export function buildThinkingCard({ loadingIcon } = {}) {
  const elements = [];
  elements.push({
    tag: "markdown",
    content: "",
    text_align: "left",
    text_size: "normal_v2",
    margin: "0px 0px 0px 0px",
    element_id: STREAMING_ELEMENT_ID,
  });
  if (loadingIcon) {
    elements.push({
      tag: "markdown",
      content: " ",
      icon: { tag: "custom_icon", img_key: loadingIcon, size: "16px 16px" },
      element_id: "loading_icon",
    });
  }
  return {
    schema: "2.0",
    config: baseConfig({
      streaming: true,
      summary: { content: "Processing...", i18n_content: { zh_cn: "处理中...", en_us: "Processing..." } },
    }),
    body: { elements },
  };
}

/**
 * 中间帧。
 *
 * 思考面板**一旦出现就不再撤回**：回答开始输出后仍然留在正文上方（折叠状态
 * 只显示「💭 思考了 Xs」标题），否则用户往下滚想看推理过程时已经找不到它了。
 *
 * 工具面板只在真有步骤时才渲染，绝不再补一个「等待工具执行」的空壳。
 */
export function buildStreamingCard({
  steps,
  stepsElapsedMs = 0,
  answerText = "",
  reasoningText = "",
  reasoningActive = false,
  reasoningExpanded = false,
  reasoningElapsedMs,
  showToolUse = true,
  loadingIcon,
  streaming = true,
}) {
  const elements = [];
  const hasSteps = Boolean(steps?.length);

  if (showToolUse && hasSteps) {
    elements.push(activeToolPanel({ steps, elapsedMs: stepsElapsedMs }));
  }

  const answer = stripThinkTags(answerText);
  if (reasoningText) {
    elements.push(
      reasoningPanel({
        text: reasoningText,
        active: reasoningActive,
        expanded: reasoningExpanded,
        elapsedMs: reasoningElapsedMs,
      }),
    );
  }
  if (answer.trim()) {
    elements.push({
      tag: "markdown",
      content: optimizeMarkdownStyle(answer),
      element_id: STREAMING_ELEMENT_ID,
    });
    if (loadingIcon) {
      elements.push({
        tag: "markdown",
        content: " ",
        icon: { tag: "custom_icon", img_key: loadingIcon, size: "16px 16px" },
        element_id: "loading_icon",
      });
    }
  }

  return {
    schema: "2.0",
    config: baseConfig({ streaming }),
    body: { elements },
  };
}

/**
 * 终帧：工具面板与思考面板都收起，正文完整，可选 footer。
 *
 * 与中间帧保持一致：**只有真跑过工具才渲染工具面板**。征询回复「同意」这类
 * 轮次没有任何工具步骤，旧逻辑会在终帧无条件塞一条「🛠️ 工具执行」空壳，
 * 展开只有「暂无工具步骤」，用户容易误以为卡住了或执行失败。
 *
 * 空回答也照样出卡：用户至少看到思考过程与正文，而不是一条消息都不弹。
 */
export function buildCompleteCard({
  text = "",
  steps,
  stepsElapsedMs = 0,
  reasoningText = "",
  reasoningElapsedMs,
  reasoningExpanded = false,
  reasoningEnabled = true,
  showToolUse = true,
  footer,
  metrics,
  elapsedMs,
  isError = false,
  isAborted = false,
}) {
  const elements = [];
  const hasSteps = Boolean(steps?.length);
  if (showToolUse && hasSteps) {
    elements.push(completeToolPanel({ steps, elapsedMs: stepsElapsedMs }));
  }
  if (reasoningEnabled && reasoningText) {
    elements.push(
      reasoningPanel({
        text: reasoningText,
        active: false,
        expanded: reasoningExpanded,
        elapsedMs: reasoningElapsedMs,
      }),
    );
  }
  const body = stripThinkTags(text);
  elements.push({
    tag: "markdown",
    content: body ? optimizeMarkdownStyle(body) : "（本轮没有产生文本输出）",
  });
  elements.push(...footerElements({ footer, elapsedMs, metrics, isError, isAborted }));

  return {
    schema: "2.0",
    config: baseConfig({ streaming: false, summary: summaryOf(body) }),
    body: { elements },
  };
}
