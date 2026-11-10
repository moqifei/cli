/**
 * Build a Feishu Card 2.0 for a multi-source daily brief.
 *
 * Feishu cards have a native `table` component (JSON 2.0) but NO native tab
 * component and NO horizontal scrolling, and `table` may only appear at the
 * card root — it cannot be nested inside a column_set or collapsible_panel.
 * So the layout is:
 *
 *   header → summary → 彩色分类速览（每个来源一行）→
 *   (hr + 分区标题 + 一张表格) repeated per tab
 *
 * 早期把三个来源三等分塞进 column_set：窄列装不下中文长标题，标题被折成
 * 两三行、各列高度参差，看起来像被折叠了。飞书没有原生 tab / 横向滑动，
 * 改成整行纵向导航最稳：不挤压、不截断，label / 条数 / hint 一个不少。
 *
 * The tab bar and table are real card components, not `| ... |` text. The
 * plain-text renderer (render.mjs) is still used as the fallback everywhere.
 *
 * Returns `null` for non-envelopes and for briefs without `section`, so
 * ordinary single-source briefs keep their old message byte-for-byte.
 */

import { parseBriefLayout, plainLine } from "./render.mjs";

/**
 * tab 版式的明细上限。沿用平铺的 10 条会把排在最后的整个来源截没，
 * 连 tab 条都消失；日报三来源合起来常有一二十条，这里放宽到 30。
 */
const MAX_TAB_ITEMS = 30;
/** 飞书硬限制：单张卡片最多 5 个 table 组件。 */
const MAX_TABLES = 5;
/** 官方文档上限：表格最多 50 列。 */
const MAX_COLUMNS = 50;

/** 分类配色：飞书 markdown 的 `<font color>` 基础色，循环使用。 */
const NAV_COLORS = ["blue", "green", "orange", "purple", "red", "grey"];

function navColor(index) {
  return NAV_COLORS[index % NAV_COLORS.length];
}

/** 速览行用来源简称（飞书 / OA / EHR），完整 label 仍写在分区标题上。 */
function shortSectionName(label) {
  const short = String(label).split(/[·｜|]/)[0].trim();
  return short || String(label).trim();
}

/** 一个彩色方块 + 简称，顶部速览和下方分区标题共用，上下呼应。 */
function navBadge(index) {
  return `<font color='${navColor(index)}'>■</font>`;
}

function sectionSpec(sections, name) {
  return sections.find((spec) => spec.name === name) ?? null;
}

function tabOrder(items, sections) {
  const order = [];
  // 声明过的 tab 一律保留，即使本轮没取到明细也要给出占位提示。
  // 旧实现「没有 item 就不显示」会让漏写的来源整块消失。
  for (const spec of sections) {
    if (!order.includes(spec.name)) order.push(spec.name);
  }
  for (const item of items) {
    if (item.section && !order.includes(item.section)) order.push(item.section);
  }
  return order;
}

/** 同名 group 合并到首次出现的位置，和纯文本渲染保持一致。 */
function groupItems(items) {
  const groups = [];
  for (const item of items) {
    let bucket = groups.find(([name]) => name === item.group);
    if (!bucket) {
      bucket = [item.group, []];
      groups.push(bucket);
    }
    bucket[1].push(item);
  }
  return groups.map(([name, bucket]) => ({ name, items: bucket }));
}

/**
 * 表格「备注」列：只留对用户有用的信息。
 * `requestId / formId` 这类业务 id 是给模型定位单据用的，写在表格外面的灰字里
 * 既没意义又难看；表格里的「编号」列才是用户说「审批第 N 条」时的依据。
 */
function compactNote(item) {
  const parts = [];
  if (item.note) {
    for (const raw of item.note.split(/[·｜]/)) {
      let part = raw.trim();
      if (!part) continue;
      // 业务 id、「第 N 条」、纯来源缩写都交给表格的编号 / 类别列表达，
      // 备注里只留接收时间这类对人有用的内容。
      if (/\b(?:requestId|formId|request_id|form_id)\b/i.test(part)) continue;
      part = part.replace(/第\s*\d+\s*条/g, "").trim();
      if (!part || /^[A-Za-z]{1,6}$/.test(part)) continue;
      parts.push(part);
    }
  }
  if (item.action) parts.push(item.action);
  return parts.join(" · ");
}

function noteLines(items) {
  return items
    .map((item) => {
      const parts = [];
      if (item.note) parts.push(item.note);
      if (item.action && !parts.some((part) => part.includes(item.action))) {
        parts.push(`⟶ ${item.action}`);
      }
      return parts.length ? `· ${parts.join(" · ")}` : null;
    })
    .filter(Boolean);
}

function tableElement(group, headers, index) {
  const rows = group.items.filter((item) => item.cells.length > 0);
  const width = Math.max(0, ...rows.map((item) => item.cells.length));
  const count = Math.min(Math.max(headers.length, width), MAX_COLUMNS);
  const columns = [];
  for (let i = 0; i < count; i++) {
    columns.push({
      name: `c${i}`,
      display_name: headers[i] || `列 ${i + 1}`,
      data_type: "text",
      width: "auto",
    });
  }
  return {
    tag: "table",
    element_id: `brief_table_${index}`,
    // page_size 官方范围 [1,10]，默认 5 会把第 6 条起折进「下一页」。
    // 一屏列完（最多 10 行）才不会让用户以为漏了一条；超过 10 行才分页。
    page_size: Math.min(Math.max(rows.length, 1), 10),
    row_height: "auto",
    header_style: { bold: true, background_style: "grey" },
    columns,
    rows: rows.map((item) => {
      const row = {};
      for (const [i, column] of columns.entries()) {
        row[column.name] = String(item.cells[i] ?? "");
      }
      return row;
    }),
  };
}

/** 表格放不下时（超过 5 个 / 组内只有部分行有 cells）退回可读文本，不丢列。 */
function fallbackLine(item) {
  const cells = item.cells.length ? ` ｜ ${item.cells.join(" ｜ ")}` : "";
  const note = item.note ? `\n· ${item.note}` : "";
  return `${plainLine(item)}${cells}${note}`;
}

export function buildBriefCard(text) {
  const layout = parseBriefLayout(text);
  if (!layout) return null;
  const { summary, items, sections } = layout;
  if (!items.some((item) => item.section)) return null;

  const visible = items.slice(0, MAX_TAB_ITEMS);
  // tab 存在性基于**完整** items：声明过的来源即使本轮没取到明细也要保留
  // tab 位并给出提示，不能让「summary 说有 6 条、下面连 tab 都没有」静默发生。
  const order = tabOrder(items, sections);
  const elements = [];

  if (summary) elements.push({ tag: "markdown", content: `**${summary}**` });

  const unassigned = visible.filter((item) => !item.section);
  if (unassigned.length) {
    elements.push({ tag: "markdown", content: unassigned.map(plainLine).join("\n") });
  }

  // 分类速览：一个来源一行，彩色方块 + 简称 + 条数 + 说明。
  // 不再用等分 column_set —— 中文长标题在 1/3 宽度里必然折行，三列高度还
  // 不一样，正是「分类不明显、像被折叠」的来源。整行排版在手机端也不会挤。
  if (order.length) {
    const lines = order.map((name, index) => {
      const spec = sectionSpec(sections, name);
      const label = spec?.label ?? name;
      const count = visible.filter((item) => item.section === name).length;
      const hint = spec?.hint ? `　<font color='grey'>${spec.hint}</font>` : "";
      return `${navBadge(index)} **${shortSectionName(label)}**　**${count} 条**${hint}`;
    });
    elements.push({ tag: "markdown", content: lines.join("\n") });
  }

  // 一个来源 = 一张表格：OA / EHR 格式统一，都带「类别 / 编号 / … / 备注」列。
  // 飞书官方限制单卡最多 5 个 table，按来源各一张远低于上限，也不会再出现
  // 前面 tab 把配额占满、后面分组退化成文字的情况。
  let tableCount = 0;
  order.forEach((name, index) => {
    const spec = sectionSpec(sections, name);
    const label = spec?.label ?? name;
    const tabItems = visible.filter((item) => item.section === name);
    elements.push({ tag: "hr" });
    // 分区标题和顶部速览同色同款，`TAB N ｜` 这种技术前缀换成彩色方块，
    // 完整 label 与条数都保留；hint 已在速览里，这里不再重复一遍。
    elements.push({
      tag: "markdown",
      content: `${navBadge(index)} **${label}**　<font color='grey'>${tabItems.length} 条</font>`,
    });
    if (tabItems.length === 0) {
      elements.push({
        tag: "markdown",
        content: "本轮未取到该来源的明细，请重试或检查技能与权限",
        text_size: "notation",
      });
    }

    const groups = groupItems(tabItems);
    const ready = groups.filter(
      (group) =>
        group.items.length > 0 && group.items.every((item) => item.cells.length > 0),
    );
    const sameWidth =
      ready.length > 0 &&
      ready.every(
        (group) => group.items[0].cells.length === ready[0].items[0].cells.length,
      );
    // 同一个来源的所有分组合进一张表，OA / EHR 完全同构：
    // 「类别」列保留分组名，「编号」列是用户引用条目的依据，「备注」列收下
    // 接收时间与动作；业务 id 不再出现在用户眼前。
    if (tableCount < MAX_TABLES && sameWidth) {
      const ownHeaders = ready[0].items.find((item) =>
        item.headers.some(Boolean),
      )?.headers;
      const headers = (ownHeaders ?? spec?.headers ?? []).map((header) =>
        header === "序号" ? "编号" : header,
      );
      // 模型给的「序号」是按来源内部顺序写的，分组打散后会跳号（1、4、2、5…）。
      // 表格里的「编号」必须由框架按行重新生成，用户说「审批第 N 条」才不会错位。
      const hasSerial = headers[0] === "编号" || headers[0] === "序号";
      const rows = [];
      for (const group of ready) {
        for (const item of group.items) {
          const body = hasSerial
            ? [String(rows.length + 1), ...item.cells.slice(1)]
            : [...item.cells];
          rows.push({
            ...item,
            cells: [group.name || label, ...body, compactNote(item)],
          });
        }
      }
      const merged = { name: null, items: rows };
      elements.push(
        tableElement(merged, ["类别", ...headers, "备注"], tableCount + 1),
      );
      tableCount += 1;
      for (const group of groups.filter((candidate) => !ready.includes(candidate))) {
        if (group.name) elements.push({ tag: "markdown", content: `**${group.name}**` });
        elements.push({
          tag: "markdown",
          content: group.items.map(fallbackLine).join("\n"),
        });
      }
      return;
    }

    // 列数不齐或没有表格行时保留原来的逐组渲染兜底。
    for (const group of groups) {
      if (group.name) elements.push({ tag: "markdown", content: `**${group.name}**` });
      const allCells =
        group.items.length > 0 && group.items.every((item) => item.cells.length > 0);
      const ownHeaders = group.items.find((item) => item.headers.some(Boolean))?.headers;
      const headers = ownHeaders ?? spec?.headers ?? [];

      if (allCells && tableCount < MAX_TABLES && group.items[0].cells.length > 0) {
        elements.push(tableElement(group, headers, tableCount + 1));
        tableCount += 1;
        const notes = noteLines(group.items);
        if (notes.length) {
          elements.push({ tag: "markdown", content: notes.join("\n"), text_size: "notation" });
        }
      } else {
        elements.push({
          tag: "markdown",
          content: group.items.map(fallbackLine).join("\n"),
        });
      }
    }
  });

  if (items.length > MAX_TAB_ITEMS) {
    elements.push({ tag: "markdown", content: `…等共 ${items.length} 条` });
  }

  const header = {
    template: "blue",
    title: { tag: "plain_text", content: "每日简报" },
  };
  if (summary) {
    // 旧客户端（< 7.20）只显示 header，副标题至少还能看到摘要。
    header.subtitle = { tag: "plain_text", content: summary.slice(0, 100) };
  }

  return {
    schema: "2.0",
    // v2 用 width_mode / update_multi，不是 v1 的 wide_screen_mode。
    config: { update_multi: true, width_mode: "fill" },
    header,
    body: { direction: "vertical", padding: "12px 12px 20px 12px", elements },
  };
}
