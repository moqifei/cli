#!/usr/bin/env bash
# Install this package into an Orange plugins directory.
#
#   ./install.sh                     # -> ~/.orange/plugins/orange-lark-cli
#   ./install.sh /opt/orange/plugins
#
# Always copies real files: Orange rejects plugin directories that resolve
# outside the search root (symlinks), so never use `ln -s` here.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_ROOT="${1:-$HOME/.orange/plugins}"
DEST="$DEST_ROOT/orange-lark-cli"

mkdir -p "$DEST_ROOT"
# Merge-copy, never `rm -rf`: some IDE shells cap recursive deletes per turn and
# a packaged plugin (dist + skills + bin) sits right at that cap.
mkdir -p "$DEST/dist" "$DEST/bin" "$DEST/scripts"
cp -R "$SRC/dist/." "$DEST/dist/"
for f in "$SRC/bin"/*; do
  [ "$(basename "$f")" = "lark-cli" ] && continue
  cp -R "$f" "$DEST/bin/"
done
# Replace the CLI atomically. Overwriting the file a *running* consumer is
# executing truncates its inode and macOS kills the process (exit 137), which
# takes the channel down for every account until the plugin is restarted.
cp "$SRC/bin/lark-cli" "$DEST/bin/.lark-cli.new"
chmod +x "$DEST/bin/.lark-cli.new"
mv -f "$DEST/bin/.lark-cli.new" "$DEST/bin/lark-cli"
cp "$SRC/openclaw.plugin.json" "$SRC/package.json" "$DEST/"
# Orange syncs <plugin_dir>/skills into agent workspaces on startup.
if [ -d "$SRC/skills" ]; then
  mkdir -p "$DEST/skills"
  cp -R "$SRC/skills/." "$DEST/skills/"
fi
[ -f "$SRC/README.md" ] && cp "$SRC/README.md" "$DEST/README.md"
mkdir -p "$DEST/scripts"
[ -f "$SRC/scripts/setup-account.sh" ] && cp "$SRC/scripts/setup-account.sh" "$DEST/scripts/"
chmod +x "$DEST/bin/lark-cli" "$DEST/scripts/"*.sh 2>/dev/null || true

echo "installed: $DEST"
echo "  plugin : $DEST/dist/index.mjs"
echo "  cli    : $DEST/bin/lark-cli ($("$DEST/bin/lark-cli" --version 2>/dev/null || echo 'not runnable'))"
echo
echo "next: point plugins.entries.orange-lark-cli.config at this plugin and run"
echo "      ./scripts/setup-account.sh <account-id> <app-id>   # once per account"
