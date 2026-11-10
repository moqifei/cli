/**
 * 工具调用的展示模型（精简移植自 `openclaw-lark/src/card/tool-use-display.ts`）。
 *
 * 旧插件从 trace store 拿工具入参/结果，能把一步渲染成「标题 · 状态 + 参数 +
 * 结果代码块」。新插件从 Orange 拿到的工具事件只有 `{ name, phase }`
 * （`openapi-shim` 的 `onToolStart`），所以这里保留**标题/图标/状态**这层，
 * 少了参数与结果明细——卡片结构、图标、状态色与旧插件一致。
 */

/** 单步缩进，和旧卡片的 `TOOL_USE_STEP_CONTENT_INDENT` 对齐。 */
export const STEP_CONTENT_INDENT = "0px 0px 0px 22px";

export const EMPTY_TOOL_USE_PLACEHOLDER = "No tool steps available";

const DESCRIPTORS = [
  { aliases: ["skill"], iconToken: "app-default_outlined", title: "Load skill" },
  { aliases: ["read", "open"], iconToken: "file-link-text_outlined", title: "Read" },
  { aliases: ["write", "edit"], iconToken: "edit_outlined", title: "Edit" },
  { aliases: ["web_search", "web-search", "search"], iconToken: "search_outlined", title: "Search web" },
  { aliases: ["web_fetch", "web-fetch", "fetch"], iconToken: "language_outlined", title: "Fetch web page" },
  { aliases: ["grep"], iconToken: "doc-search_outlined", title: "Search text" },
  { aliases: ["glob"], iconToken: "folder_outlined", title: "Search files" },
  { aliases: ["exec", "bash", "command", "run"], iconToken: "setting_outlined", title: "Run command" },
  { aliases: ["browser", "playwright", "navigate"], iconToken: "browser-mac_outlined", title: "Browser" },
  { aliases: ["agent", "task", "spawn"], iconToken: "robot_outlined", title: "Run sub-agent" },
  { aliases: ["check", "determine", "verify"], iconToken: "list-check_outlined", title: "Check" },
  { aliases: ["summarize", "analyze", "prepare"], iconToken: "report_outlined", title: "Analyze" },
];

/** 卡片宽度有限，太长的工具名会撑破一行。 */
const MAX_TITLE = 48;

function normalizeName(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^lark-cli:/, "")
    .replace(/^mcp[:_]/, "");
}

/** 工具名 → 卡片上的标题 + 图标（未知工具退化成名字本身）。 */
export function describeTool(rawName) {
  const name = String(rawName ?? "").trim();
  const key = normalizeName(name);
  const hit = DESCRIPTORS.find((descriptor) => descriptor.aliases.includes(key));
  if (hit) return { title: hit.title, iconToken: hit.iconToken };
  const fallback = key || "tool";
  return {
    title: fallback.length > MAX_TITLE ? `${fallback.slice(0, MAX_TITLE - 1)}…` : fallback,
    iconToken: "app-default_outlined",
  };
}

/**
 * 一步的状态 → `{ label, color }`。
 *
 * 沿用旧插件的英文标签 + 彩色：卡片里的步骤标题是 lark_md，颜色用
 * `<font color>`，这是唯一在 2.0 卡片里稳定生效的着色方式。
 */
export function formatStepStatus(status) {
  switch (status) {
    case "running":
      return { label: "Running", color: "turquoise" };
    case "error":
      return { label: "Failed", color: "red" };
    case "success":
    default:
      return { label: "Succeeded", color: "green" };
  }
}

/** 标题里的 markdown 元字符必须转义，否则工具名里的 `*`/`_` 会吃掉后面的状态。 */
export function escapeMarkdown(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/([`*_{}[\]<>])/g, "\\$1");
}
