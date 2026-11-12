/**
 * Render a proactive `delta` envelope into plain text.
 *
 * The envelope is a machine contract: the scheduler uses it for dedup and
 * watermarks. Cron delivery already renders it in Rust
 * (`orange/src/proactive/render.rs`), but an interactive chat turn goes
 * straight through this plugin's dispatcher, so a manual "跑一次给你看看"
 * used to paste the raw JSON into the Feishu window. Mirror the Rust renderer
 * here so both paths show the same human-readable brief.
 *
 * Multi-source layout (all optional): a digest that aggregates several systems
 * may declare `sections` and put `section` / `group` / `headers` / `cells` /
 * `note` on its items. Each source becomes a TAB; a group whose items all have
 * `cells` becomes a Markdown table. Tab names, group names and columns are not
 * hardcoded — adding another system only adds a section, no code change.
 *
 * With no `section` anywhere, this renderer is byte-for-byte the old flat one.
 * Dedup/watermarks still read the raw envelope; layout fields don't affect them.
 *
 * Not an envelope (or empty) -> `null`, caller falls back to the original text.
 */

/** 平铺版式保持历史行为：最多 10 条，多出来的折叠成「…等共 N 条」。 */
const MAX_FLAT_ITEMS = 10;
/**
 * tab 版式里**每个来源**的明细上限，不是整份信封的总上限。
 * 一次日报常同时有飞书、OA、EHR 三四十条：早先 `items.slice(0, 30)`
 * 会把排在最后的整个来源切没，卡片显示「EHR 0 条 / 未取到明细」，
 * 而接口明明返回了 6 条。额度按来源分配，排第几都能拿到自己的那份。
 */
const MAX_TAB_ITEMS = 30;
const MARKERS = { now: "❗", today: "•", know: "·" };

function textField(value, key) {
  const raw = value && typeof value === "object" ? value[key] : undefined;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/** Cells may be numbers (e.g. 序号 1); empty slots must keep their position. */
function stringArray(value, key) {
  const raw = value && typeof value === "object" ? value[key] : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.map((cell) => {
    if (cell === null || cell === undefined) return "";
    if (typeof cell === "string") return cell.trim();
    if (typeof cell === "number" || typeof cell === "boolean") return String(cell);
    return JSON.stringify(cell);
  });
}

function parseEnvelope(text) {
  const raw = String(text ?? "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let value;
  try {
    value = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const status = typeof value.status === "string" ? value.status.toLowerCase() : "";
  // `digest` 每天必发，没事时用 `status: "summary"`（不是 delta）—— 之前只认
  // delta，于是「今天没有待办」的那封信封被原样贴进飞书。
  if (!["delta", "summary", "alert"].includes(status) && value.has_delta !== true) return null;
  return value;
}

function renderItem(item) {
  if (typeof item === "string") return item.trim() || null;
  const title = textField(item, "title");
  const detail = textField(item, "detail");
  if (title && detail) return `${title} — ${detail}`;
  return title ?? detail ?? null;
}

export function plainLine(item) {
  return `${item.marker} ${item.line}${item.action ? ` ⟶ ${item.action}` : ""}`;
}

function renderFlat(summary, items) {
  const parts = [];
  if (summary) parts.push(summary);
  if (items.length) {
    const lines = items.slice(0, MAX_FLAT_ITEMS).map(plainLine);
    if (items.length > MAX_FLAT_ITEMS) lines.push(`…等共 ${items.length} 条`);
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

function parseSections(delta) {
  const raw = Array.isArray(delta.sections) ? delta.sections : [];
  return raw
    .map((value) => {
      // 字符串简写：`sections: ["飞书", "OA 待办"]`
      const name = typeof value === "string" ? value.trim() : textField(value, "name");
      if (!name) return null;
      return {
        name,
        label: textField(value, "label"),
        headers: stringArray(value, "headers"),
        hint: textField(value, "hint"),
      };
    })
    .filter(Boolean);
}

function sectionSpec(specs, name) {
  return specs.find((spec) => spec.name === name) ?? null;
}

/** `sections` 声明优先，信封里没声明的 section 按首次出现追加。 */
function tabOrder(items, specs) {
  const order = [];
  // 声明过的 tab 一律保留。旧实现要求「至少有一条 item 才显示」，模型漏写
  // 某个来源的明细时，那个 tab 就整块消失，用户只看到 summary 里的数字。
  for (const spec of specs) {
    if (!order.includes(spec.name)) order.push(spec.name);
  }
  for (const item of items) {
    if (item.section && !order.includes(item.section)) order.push(item.section);
  }
  return order;
}

function tabBar(order, specs) {
  const labels = order.map((name, index) => {
    const spec = sectionSpec(specs, name);
    return `▍TAB ${index + 1} ｜ ${spec?.label ?? name}`;
  });
  let out = labels.join("  │  ");
  const hints = order.map((name) => sectionSpec(specs, name)?.hint ?? "");
  // 只有每个 tab 都写了 hint 才输出第二行，避免和空占位拼出半截表格。
  if (hints.length && hints.every(Boolean)) out += `\n${hints.join("  │  ")}`;
  return out;
}

function escapeCell(cell) {
  return String(cell)
    .trim()
    .replaceAll("|", "\\|")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
}

function appendRow(cells) {
  return `| ${cells.map(escapeCell).join(" | ")} |`;
}

function renderGrouped(items, spec) {
  const groups = [];
  for (const item of items) {
    let bucket = groups.find(([name]) => name === item.group);
    if (!bucket) {
      bucket = [item.group, []];
      groups.push(bucket);
    }
    bucket[1].push(item);
  }

  let out = "";
  groups.forEach(([group, bucket], position) => {
    if (group) {
      out += "\n";
      if (position > 0) out += "\n";
      out += group;
    } else if (position > 0) {
      out += "\n";
    }

    const asTable = bucket.length > 0 && bucket.every((item) => item.cells.length > 0);
    if (asTable) {
      const own = bucket.find((item) => item.headers.some((header) => header))?.headers;
      const headers = own ?? (spec?.headers?.length ? spec.headers : null);
      const rows = [];
      if (headers) {
        rows.push(appendRow(headers));
        rows.push(appendRow(headers.map(() => "---")));
      }
      for (const item of bucket) rows.push(appendRow(item.cells));
      // 每行自带换行：没有表头时也不会多出一个空行。
      for (const row of rows) out += `\n${row}`;
      // note 统一放在表格之后：插在表格中间会把 Markdown 表格截断。
      for (const item of bucket) {
        const parts = [];
        if (item.note) parts.push(item.note);
        if (item.action && !parts.some((part) => part.includes(item.action))) {
          parts.push(`⟶ ${item.action}`);
        }
        if (parts.length) out += `\n  ↳ ${parts.join(" · ")}`;
      }
    } else {
      for (const item of bucket) {
        out += `\n${plainLine(item)}`;
        if (item.note) out += `\n  ↳ ${item.note}`;
      }
    }
  });
  return out;
}

/**
 * 按来源分别限额：每个 section 独立计数，未标 section 的条目算一组。
 * 保持原顺序，表格编号 / 分组 / 「审批第 N 条」的对应关系都不变。
 */
export function visibleTabItems(items, limit = MAX_TAB_ITEMS) {
  const quota = new Map();
  const visible = [];
  for (const item of items) {
    const key = item.section ?? "__unassigned__";
    const used = quota.get(key) ?? 0;
    if (used >= limit) continue;
    quota.set(key, used + 1);
    visible.push(item);
  }
  return visible;
}

function renderTabs(summary, items, specs) {
  const visible = visibleTabItems(items);
  let out = summary;
  const unassigned = visible.filter((item) => !item.section);
  if (unassigned.length) {
    if (out) out += "\n\n";
    out += unassigned.map(plainLine).join("\n");
  }

  // tab 存在性基于**完整** items：声明过的来源即使本轮没取到明细也不能
  // 整块消失，否则「头部说有 6 条、下面连 tab 都没有」会变成静默失败。
  const order = tabOrder(items, specs);
  if (order.length) {
    if (out) out += "\n\n";
    out += tabBar(order, specs);
    order.forEach((name, index) => {
      const spec = sectionSpec(specs, name);
      const label = spec?.label ?? name;
      const tabItems = visible.filter((item) => item.section === name);
      // 条数由框架自己数：模型写死的数字会随数据变化，却不影响去重指纹。
      out += `\n\n━━ TAB ${index + 1} ｜ ${label}（${tabItems.length} 条） ━━`;
      if (tabItems.length === 0) {
        out += "\n· 本轮未取到该来源的明细，请重试或检查技能与权限";
      } else {
        out += renderGrouped(tabItems, spec);
      }
    });
  }

  if (visible.length < items.length) out += `\n\n…等共 ${items.length} 条`;
  return out;
}

/**
 * Parse a delta envelope into the structured layout shared by the plain-text
 * renderer and the Feishu Card 2.0 builder. `null` means "not an envelope".
 * The card builder needs the raw `cells`/`group`/`section` — it cannot
 * reconstruct them from the rendered sentence.
 */
export function parseBriefLayout(text) {
  const delta = parseEnvelope(text);
  if (!delta) return null;

  const summary = textField(delta, "summary") ?? "";
  const rawItems = Array.isArray(delta.items) ? delta.items : [];
  const items = [];
  for (const raw of rawItems) {
    const line = renderItem(raw);
    const cells = stringArray(raw, "cells");
    // 只有表格行、没写 title/detail 的条目也要留着：整条丢掉会让这个来源
    // 的 tab 凭空消失。表格本来就用 cells 渲染，line 只是文字兜底。
    if (!line && cells.length === 0) continue;
    const priority = textField(raw, "priority");
    items.push({
      line: line ?? "",
      marker: (priority && MARKERS[priority.toLowerCase()]) || "•",
      action: textField(raw, "action") ?? "",
      section: textField(raw, "section"),
      group: textField(raw, "group"),
      headers: stringArray(raw, "headers"),
      cells,
      note: textField(raw, "note"),
    });
  }
  return { summary, items, sections: parseSections(delta) };
}

export function renderDeltaForUser(text) {
  const layout = parseBriefLayout(text);
  if (!layout) return null;
  const { summary, items, sections } = layout;

  if (!summary && items.length === 0) return null;
  // 没有条目声明 section：完全走旧路径，多一个字段都不能多输出。
  if (items.every((item) => item.section === null)) return renderFlat(summary, items);
  return renderTabs(summary, items, sections);
}

/** Cheap guard for streaming: don't paint half a JSON envelope into a card. */
export function looksLikeEnvelope(text) {
  const head = String(text ?? "").trimStart().slice(0, 200);
  return head.startsWith("{") || head.startsWith("```json");
}
