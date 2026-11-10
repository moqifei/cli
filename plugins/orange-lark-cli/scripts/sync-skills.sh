#!/usr/bin/env bash
#
# 只重建 / 同步技能，不打包、不编译 lark-cli。
#
# 为什么需要它：
#   `skills/` 是构建产物 —— `build.mjs` 每次都从 `cli/skills/lark-*`（源）重新生成
#   并 `force: true` 覆盖。所以**改技能要改源文件**（`cli/skills/lark-daily-brief/`），
#   而不是改 `plugins/orange-lark-cli/skills/`，否则下次 `package.sh` 会被打回原样。
#
#   Orange 运行时读的是 sandbox 副本，源头是 `~/.orange/workspace/<agent>/skills`
#   （启动时 write-if-missing 同步）。改完技能如果只更新源，运行中的会话看不到变化 ——
#   这个脚本把三层一次写到位：插件目录 → agent workspace → 已有 sandbox 副本。
#
#   ./scripts/sync-skills.sh              # 重建 + 同步插件目录 + 所有 agent workspace
#   ./scripts/sync-skills.sh --sandboxes  # 顺带覆盖各 sandbox 里已有的同名技能
#   ./scripts/sync-skills.sh --no-build   # 不重建，只同步当前 skills/（省 1 秒）
#
# 完整安装（含 lark-cli 二进制、打包 tar）仍然用：
#   ./scripts/package.sh --no-cli-build --install
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORANGE_HOME="${ORANGE_HOME:-$HOME/.orange}"
BUILD=1
SANDBOXES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --sandboxes) SANDBOXES=1; shift ;;
    --no-build) BUILD=0; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ "$BUILD" = "1" ]; then
  echo "==> 从 cli/skills 重建 skills/"
  node "$ROOT/build.mjs"
fi

[ -d "$ROOT/skills" ] || { echo "skills/ 不存在，先跑一次 build" >&2; exit 1; }
SKILLS="$ROOT/skills"

synced=0
copy_into() {
  local dest="$1"
  [ -d "$dest" ] || return 0
  mkdir -p "$dest"
  # 只覆盖 skills/ 里有的技能，不动目标目录里的其它技能
  for skill in "$SKILLS"/*/; do
    [ -d "$skill" ] || continue
    local name
    name="$(basename "$skill")"
    mkdir -p "$dest/$name"
    cp -R "$skill/." "$dest/$name/"
    synced=$((synced + 1))
  done
}

echo "==> 同步到插件安装目录"
copy_into "$ORANGE_HOME/plugins/orange-lark-cli/skills"

echo "==> 同步到 agent workspace"
for ws in "$ORANGE_HOME"/workspace/*/; do
  [ -d "$ws/skills" ] || continue
  copy_into "$ws/skills"
done

if [ "$SANDBOXES" = "1" ]; then
  echo "==> 同步到已有 sandbox 副本"
  while IFS= read -r dir; do
    copy_into "$dir"
  done < <(find "$ORANGE_HOME/sandboxes" -type d -name skills 2>/dev/null)
fi

echo "完成：覆盖 ${synced} 处技能文件"
if [ "$SANDBOXES" = "0" ]; then
  echo "（运行中的会话仍读 sandbox 旧副本；要立刻生效加 --sandboxes，"
  echo "  或删掉对应 sandbox 里的技能目录让 Orange 重新同步）"
fi
