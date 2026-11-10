#!/usr/bin/env bash
# Build a self-contained plugin package: plugin code + the lark-cli binary.
#
# The plugin now lives inside the lark-cli repo (`plugins/orange-lark-cli`), so
# the CLI is rebuilt from the same working tree on every run — a CLI change can
# never be silently left out of the package.
#
#   ./scripts/package.sh                     # rebuild CLI + plugin, then package
#   ./scripts/package.sh --no-cli-build      # reuse the existing repo binary
#   ./scripts/package.sh --install           # install into ~/.orange/plugins + sync skills
#   ./scripts/package.sh --install DIR       # ... or into DIR/orange-lark-cli
#   CLI_SRC=/path/to/lark-cli ./scripts/package.sh   # reuse a specific binary
#   GOOS=linux GOARCH=amd64 ./scripts/package.sh     # cross-compile the CLI
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_REPO="${CLI_REPO:-$(cd "$ROOT/../.." && pwd)}"

CLI_SRC_EXPLICIT=0
if [ -n "${CLI_SRC:-}" ]; then
  CLI_SRC_EXPLICIT=1
fi
CLI_SRC="${CLI_SRC:-$CLI_REPO/lark-cli}"

CLI_BUILD=1
INSTALL=0
INSTALL_DIR="${ORANGE_PLUGINS_DIR:-$HOME/.orange/plugins}"

while [ $# -gt 0 ]; do
  case "$1" in
    --install) INSTALL=1; shift; if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then INSTALL_DIR="$1"; shift; fi ;;
    --no-cli-build) CLI_BUILD=0; shift ;;
    --cli-build) CLI_BUILD=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

VERSION="$(node -p "require('$ROOT/package.json').version")"
CLI_VERSION="$("$CLI_REPO/lark-cli" --version 2>/dev/null | head -1 || true)"
GOOS_TARGET="${GOOS:-$(go env GOOS 2>/dev/null || echo darwin)}"
GOARCH_TARGET="${GOARCH:-$(go env GOARCH 2>/dev/null || echo arm64)}"
STAGE="$ROOT/dist-pkg/orange-lark-cli"
ARCHIVE="$ROOT/dist-pkg/orange-lark-cli-${VERSION}-${GOOS_TARGET}-${GOARCH_TARGET}.tar.gz"

echo "==> building plugin"
# NOTE: do not `rm -rf dist skills` here. Some IDE shells shim `rm` with a
# bulk-delete guard (~500 files per turn) and a full skills/ regeneration is
# ~520 files. build.mjs overwrites in place and prunes removed skills instead.
node "$ROOT/build.mjs"

if [ "$CLI_BUILD" = "1" ] && [ "$CLI_SRC_EXPLICIT" = "0" ]; then
  echo "==> building lark-cli from $CLI_REPO (CLI source changes are picked up)"
  ( cd "$CLI_REPO" && GOOS="$GOOS_TARGET" GOARCH="$GOARCH_TARGET" make build )
else
  echo "==> reusing lark-cli binary: $CLI_SRC"
fi
[ -x "$CLI_SRC" ] || { echo "lark-cli build failed: $CLI_SRC" >&2; exit 1; }
echo "    version: $("$CLI_SRC" --version 2>/dev/null | head -1 || echo unknown)${CLI_VERSION:+ (repo binary: $CLI_VERSION)}"

echo "==> staging $STAGE"
# Merge-copy instead of `rm -rf` + copy: some IDE shells shim recursive deletes
# with a ~500-files-per-turn guard, and a packaged plugin is right at that size.
mkdir -p "$STAGE/bin" "$STAGE/scripts" "$STAGE/dist"
cp -R "$ROOT/dist/." "$STAGE/dist/"
if [ -d "$ROOT/skills" ]; then
  mkdir -p "$STAGE/skills"
  cp -R "$ROOT/skills/." "$STAGE/skills/"
fi
cp "$ROOT/openclaw.plugin.json" "$ROOT/package.json" "$ROOT/README.md" "$STAGE/"
cp "$CLI_SRC" "$STAGE/bin/lark-cli"
chmod +x "$STAGE/bin/lark-cli"
cp "$ROOT/scripts/setup-account.sh" "$ROOT/scripts/install.sh" "$STAGE/scripts/"
chmod +x "$STAGE/scripts/"*.sh

echo "==> verifying bundled binary"
"$STAGE/bin/lark-cli" --version

echo "==> archiving"
mkdir -p "$ROOT/dist-pkg"
tar -czf "$ARCHIVE" -C "$ROOT/dist-pkg" orange-lark-cli
( cd "$ROOT/dist-pkg" && shasum -a 256 "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256" )

echo
echo "package : $ARCHIVE"
echo "size    : $(du -h "$ARCHIVE" | cut -f1)"
echo "sha256  : $(cut -d' ' -f1 "$ARCHIVE.sha256")"

if [ "$INSTALL" = "1" ]; then
  echo
  echo "==> installing into $INSTALL_DIR/orange-lark-cli"
  "$STAGE/scripts/install.sh" "$INSTALL_DIR"

  # Orange 把 <plugin>/skills 同步进 agent workspace 时是 write-if-missing，
  # 只重装插件不会刷新已存在的旧副本，正在运行的会话会继续读旧技能。
  # 装完顺手把技能推到 workspace + 已有 sandbox，用 --no-build 复用上面刚生成的 skills/。
  if [ "$(basename "$INSTALL_DIR")" = "plugins" ]; then
    echo
    echo "==> syncing skills into workspace / sandboxes"
    ORANGE_HOME="$(cd "$INSTALL_DIR/.." && pwd)" "$ROOT/scripts/sync-skills.sh" --no-build --sandboxes
  else
    echo "    (技能同步已跳过：$INSTALL_DIR 不是 <orange_home>/plugins)"
  fi
fi
