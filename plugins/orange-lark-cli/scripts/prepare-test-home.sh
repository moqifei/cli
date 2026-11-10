#!/usr/bin/env bash
# Prepare an isolated Orange home for the orange-lark-cli feasibility harness.
#
#   TEST_HOME   default /tmp/orange-lark-test
#   CLI_PATH    default <repo>/test/fake-lark-cli.mjs  (or a real lark-cli)
#
# Why HOME is overridden: the OpenClaw shim inside Orange reads plugin config
# from `$HOME/.orange/config.yaml` (hardcoded, ORANGE_HOME is ignored), so the
# isolated instance needs both HOME and ORANGE_HOME pointed at the test tree.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_HOME="${TEST_HOME:-/tmp/orange-lark-test}"
CLI_PATH="${CLI_PATH:-$ROOT/test/fake-lark-cli.mjs}"
PORT="${PORT:-3999}"

mkdir -p "$TEST_HOME"/{workspace/main,data/lark-cli/test,logs,plugins,fixtures}
ln -sfn "${ORANGE_LIB:-$HOME/.orange/lib}" "$TEST_HOME/lib"
mkdir -p "$TEST_HOME/.orange"
ln -sfn ../config.yaml "$TEST_HOME/.orange/config.yaml"

node "$ROOT/build.mjs" >/dev/null
rm -rf "$TEST_HOME/plugins/orange-lark-cli"
mkdir -p "$TEST_HOME/plugins/orange-lark-cli"
cp -R "$ROOT/dist" "$ROOT/openclaw.plugin.json" "$ROOT/package.json" "$TEST_HOME/plugins/orange-lark-cli/"

cat > "$TEST_HOME/fixtures/events.jsonl" <<'JSONL'
{"type":"im.message.receive_v1","event_id":"evt_0001","timestamp":"1756500000000","id":"om_msg_p0_0001","message_id":"om_msg_p0_0001","create_time":"1756500000000","chat_id":"oc_p0_test_chat","chat_type":"p2p","message_type":"text","sender_id":"ou_p0_test_user","sender_type":"user","content":"你好，这是一条 lark-cli 可行性验证消息","mentions":[]}
JSONL

cat > "$TEST_HOME/config.yaml" <<YAML
environment: Development

gateway:
  http_addr: 127.0.0.1:${PORT}
  ws_addr: 127.0.0.1:3901
  workspace_base: ${TEST_HOME}/workspace
  admin_api_key: dev-token
  jwt_secret: change-me-in-production
  session:
    dm_scope: per-account-channel-peer
    reset_policy: daily
    timezone: Asia/Shanghai

agent:
  tool_timeout_secs: 60
  defaults:
    model:
      primary: mock/mock-chat
    thinking_level: low
    max_tokens: 1024
    temperature: 0.2
    max_concurrent: 4
    max_tool_turns: 1
    streaming: off
  agents:
  - id: main
    name: Main Agent
    default: true
    workspace: ${TEST_HOME}/workspace/main

security:
  enable_network_proxy: false
  enable_secret_leak_detection: false
  enable_capability_security: false
  enable_audit_logging: false

database:
  db_type: sqlite
  connection_string: ${TEST_HOME}/orange.db
  max_connections: 5
  enable_migrations: true

logging:
  level: debug
  format: text
  enable_file_logging: true
  log_file: ${TEST_HOME}/logs/orange.log
  max_log_file_size_mb: 10
  max_log_file_backups: 3
  enable_syslog: false

onboard:
  completed: true
  mode: Local
  flow: QuickStart
  gateway_bind: Loopback
  gateway_port: ${PORT}
  gateway_auth: Token
  workspace_path: ${TEST_HOME}/workspace
  auto_start: false

models:
  providers:
    mock:
      base_url: http://127.0.0.1:18080/v1
      api_key: mock-key
      env_keys: []
      api: openai
      models:
      - id: mock-chat
        name: Mock Chat

channels:
  feishu:
    requireMention: false
    dmPolicy: open
    allowFrom:
    - '*'
    accounts:
      test:
        enabled: false

plugins:
  entries:
    openclaw-lark:
      enabled: false
    orange-lark-cli:
      enabled: true
      config:
        cli_path: ${CLI_PATH}
        ready_timeout_ms: 15000
        max_concurrent: 2
        env:
          FAKE_LARK_EVENTS: ${TEST_HOME}/fixtures/events.jsonl
          FAKE_LARK_SEND_LOG: ${TEST_HOME}/fixtures/sent.jsonl
        accounts:
          test:
            config_dir: ${TEST_HOME}/data/lark-cli/test
            identity: bot
            enabled: true

bindings:
- agent_id: main
  match:
    channel: feishu
    account_id: test

skills:
  enabled: false
YAML

echo "prepared $TEST_HOME (cli=$CLI_PATH, port=$PORT)"
