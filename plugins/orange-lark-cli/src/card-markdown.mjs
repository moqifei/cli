/**
 * Markdown 样式优化（移植自 `openclaw-lark/src/card/markdown-style.ts`）。
 *
 * 飞书 CardKit 的 markdown 渲染和模型输出的通用 markdown 有两处不匹配，
 * 不处理就会出现「标题比正文还大」「表格贴着上一段」「代码块没留白」：
 *
 *   - 标题降级：H1 → H4、H2~H6 → H5（卡片里 H1 视觉重量失真）；
 *   - 表格/代码块前后补 `<br>`，否则卡片里会粘在一起。
 *
 * 另外剥掉非 `img_` 的图片引用：CardKit 只认 `img_xxx`，直接塞 URL 会报
 * 200570 整张卡片更新失败。
 */

/** 提取代码块 → 处理其余文本 → 还原，保证代码块内容一个字符都不动。 */
export function optimizeMarkdownStyle(text, cardVersion = 2) {
  const source = String(text ?? "");
  if (!source) return "";
  try {
    return stripInvalidImageKeys(optimize(source, cardVersion));
  } catch {
    return source;
  }
}

function optimize(text, cardVersion) {
  const MARK = "___CB_";
  const codeBlocks = [];
  let result = text.replace(/(^|\n)(`{3,})([^\n]*)\n[\s\S]*?\n\2(?=\n|$)/g, (match, prefix = "") => {
    const block = match.slice(String(prefix).length);
    return `${prefix}${MARK}${codeBlocks.push(block) - 1}___`;
  });

  // 只有原文档含 h1~h3 才降级。顺序不能颠倒：先 H1→H4，H4 会被 #{2,6} 再降成 H5。
  if (/^#{1,3} /m.test(text)) {
    result = result.replace(/^#{2,6} (.+)$/gm, "##### $1");
    result = result.replace(/^# (.+)$/gm, "#### $1");
  }

  if (cardVersion >= 2) {
    // 连续标题之间留段落间距
    result = result.replace(/^(#{4,5} .+)\n{1,2}(#{4,5} )/gm, "$1\n<br>\n$2");

    // 表格前后留白（4a~4e 与旧实现一一对应，改动会直接影响视觉）
    result = result.replace(/^([^|\n].*)\n(\|.+\|)/gm, "$1\n\n$2");
    result = result.replace(/\n\n((?:\|.+\|[^\S\n]*\n?)+)/g, "\n\n<br>\n\n$1");
    result = result.replace(/((?:^\|.+\|[^\S\n]*\n?)+)/gm, (table, _all, offset) => {
      const after = result.slice(offset + table.length).replace(/^\n+/, "");
      if (!after || /^(---|#{4,5} |\*\*)/.test(after)) return table;
      return `${table}\n<br>\n`;
    });
    result = result.replace(/^((?!#{4,5} )(?!\*\*).+)\n\n(<br>)\n\n(\|)/gm, "$1\n$2\n$3");
    result = result.replace(/^(\*\*.+)\n\n(<br>)\n\n(\|)/gm, "$1\n$2\n\n$3");
    result = result.replace(/(\|[^\n]*\n)\n(<br>\n)((?!#{4,5} )(?!\*\*))/gm, "$1$2$3");

    codeBlocks.forEach((block, index) => {
      result = result.replace(`${MARK}${index}___`, `\n<br>\n${block}\n<br>\n`);
    });
  } else {
    codeBlocks.forEach((block, index) => {
      result = result.replace(`${MARK}${index}___`, block);
    });
  }

  return result.replace(/\n{3,}/g, "\n\n");
}

const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

/** 只保留 `img_xxx`；URL/本地路径在 CardKit 里会直接让卡片更新失败。 */
function stripInvalidImageKeys(text) {
  if (!text.includes("![")) return text;
  return text.replace(IMAGE_RE, (full, _alt, value) => (value.startsWith("img_") ? full : ""));
}
