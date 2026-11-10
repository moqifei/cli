#!/usr/bin/env bash
# End-to-end feasibility check:
#   fake lark-cli event -> Orange channel plugin -> agent -> mock LLM -> outbound CLI call
#
# Usage:
#   scripts/e2e.sh            # run and tear down
#   KEEP=1 scripts/e2e.sh     # leave gateway + mock LLM running for inspection
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_HOME="${TEST_HOME:-/tmp/orange-lark-test}"
ORANGE_BIN="${ORANGE_BIN:-/Users/moqifei/openimsdk/orange/target/release/orange}"
PORT="${PORT:-3999}"
LLM_PORT="${MOCK_LLM_PORT:-18080}"
WAIT_SECS="${WAIT_SECS:-45}"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

"$ROOT/scripts/prepare-test-home.sh" >/dev/null
pkill -f "orange gateway run --port ${PORT}" 2>/dev/null || true
pkill -f "mock-llm.mjs" 2>/dev/null || true
sleep 1
rm -f "$TEST_HOME/logs/gateway.log" "$TEST_HOME/fixtures/sent.jsonl"

(MOCK_LLM_PORT="$LLM_PORT" nohup node "$ROOT/test/mock-llm.mjs" >"$TEST_HOME/logs/mock-llm.log" 2>&1 &)
sleep 1
curl -sf -X POST "http://127.0.0.1:${LLM_PORT}/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"model":"mock-chat","messages":[{"role":"user","content":"health"}],"stream":false}' >/dev/null \
  || fail "mock LLM not reachable on port ${LLM_PORT}"

# Run from a directory that is NOT the Orange home: the default search paths
# include "$ORANGE_HOME/plugins" and CWD "plugins/", so starting inside the home
# discovers the same plugin twice ("Skipping duplicate plugin id").
(cd "$TEST_HOME/workspace" && HOME="$TEST_HOME" ORANGE_HOME="$TEST_HOME" nohup "$ORANGE_BIN" gateway run --port "$PORT" \
  >"$TEST_HOME/logs/gateway.stdout.log" 2>&1 &)

deadline=$((SECONDS + WAIT_SECS))
while [ $SECONDS -lt $deadline ]; do
  if grep -q "inbound done" "$TEST_HOME/logs/gateway.log" 2>/dev/null; then break; fi
  sleep 1
done

grep -q "channel ready" "$TEST_HOME/logs/gateway.log" || fail "channel never became ready"
pass "channel ready (lark-cli consumer spawned)"

grep -q "inbound done" "$TEST_HOME/logs/gateway.log" || fail "inbound message was never dispatched"
pass "inbound event reached the agent"

grep -q "MOCK_REPLY" "$TEST_HOME/fixtures/sent.jsonl" 2>/dev/null || fail "no outbound reply recorded"
pass "agent reply delivered through lark-cli outbound"

if [ "${KEEP:-0}" != "1" ]; then
  pkill -f "orange gateway run --port ${PORT}" 2>/dev/null || true
  pkill -f "mock-llm.mjs" 2>/dev/null || true
  echo "teardown done"
else
  echo "left running: gateway :$PORT, mock llm :$LLM_PORT, logs in $TEST_HOME/logs"
fi

echo
echo "--- evidence ---"
grep -E "channel ready|inbound chat|sent to|inbound done" "$TEST_HOME/logs/gateway.log" | tail -5
