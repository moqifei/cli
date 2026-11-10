#!/usr/bin/env bash
# Provision one Feishu app for the bundled lark-cli (non-interactive).
#
#   APP_SECRET=xxx ./scripts/setup-account.sh work cli_a97af778eaf99bdb
#   printf '%s' "$SECRET" | ./scripts/setup-account.sh work cli_xxx lark
#
# Writes only to $ORANGE_HOME/data/lark-cli/<account>/config.json (mode 0600).
# The plugin never stores the secret itself; it only tells the CLI where its
# config dir is.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORANGE_HOME="${ORANGE_HOME:-$HOME/.orange}"

ACCOUNT="${1:?usage: setup-account.sh <account-id> <app-id> [feishu|lark]}"
APP_ID="${2:?usage: setup-account.sh <account-id> <app-id> [feishu|lark]}"
BRAND="${3:-feishu}"

CLI_BIN="$ROOT/bin/lark-cli"
[ -x "$CLI_BIN" ] || CLI_BIN="$ROOT/../../lark-cli"
[ -x "$CLI_BIN" ] || { echo "lark-cli binary not found (build the package first)" >&2; exit 1; }

CONFIG_DIR="$ORANGE_HOME/data/lark-cli/$ACCOUNT"
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

if [ -n "${APP_SECRET:-}" ]; then
  printf '%s' "$APP_SECRET" | LARKSUITE_CLI_CONFIG_DIR="$CONFIG_DIR" \
    "$CLI_BIN" config init --app-id "$APP_ID" --app-secret-stdin --brand "$BRAND"
else
  # Reads the secret from stdin (never from argv, to keep it out of `ps`).
  LARKSUITE_CLI_CONFIG_DIR="$CONFIG_DIR" \
    "$CLI_BIN" config init --app-id "$APP_ID" --app-secret-stdin --brand "$BRAND"
fi

echo
echo "verifying bot identity ..."
LARKSUITE_CLI_CONFIG_DIR="$CONFIG_DIR" "$CLI_BIN" api GET /open-apis/bot/v3/info --as bot \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); b=d.get("data",{}); print("bot:", b.get("app_name"), b.get("open_id"), "status=", b.get("activate_status"))' \
  || echo "WARN: could not read bot info (check app id/secret/network)"

echo
echo "done. account=$ACCOUNT config_dir=$CONFIG_DIR"
