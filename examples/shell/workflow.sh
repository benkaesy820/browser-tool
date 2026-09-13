#!/bin/sh
# Independent daemon client using POSIX sh + jq + the `bridge` CLI.
# Assumes a running daemon (start one first, stop it when done):
#   1. bridge daemon start --detach
#   2. FIXTURE_URL="file:///path/to/index.html" ./workflow.sh
#   3. bridge daemon stop
# Prerequisites: sh, jq, bridge on PATH. Isolated daemons via
# BRIDGE_DAEMON_DIR (passed through as bridge --daemon-dir).
set -eu

: "${FIXTURE_URL:?set FIXTURE_URL to the fixture file:// URL}"
BRIDGE_BIN="${BRIDGE_BIN:-bridge}"

if [ -n "${BRIDGE_DAEMON_DIR:-}" ]; then
  # shellcheck disable=SC2209
  bridge() { command "$BRIDGE_BIN" --daemon-dir "$BRIDGE_DAEMON_DIR" "$@"; }
else
  bridge() { command "$BRIDGE_BIN" "$@"; }
fi

N=0
call() {
  N=$((N + 1))
  REQ="$(printf '{"protocolVersion":"1.0","requestId":"exsh-%s","op":"%s"%s}' "$N" "$1" "$2")"
  OUT="$(printf '%s' "$REQ" | bridge call --stdin)"
  STATUS="$(printf '%s' "$OUT" | jq -r .status)"
  if [ "$STATUS" != "completed" ]; then
    printf 'op %s failed: %s\n' "$1" "$OUT" >&2
    exit 1
  fi
  printf '%s' "$OUT"
}

SESSION="$(call create '' | jq -r .sessionId)"
OPENED="$(call open ",\"sessionId\":\"$SESSION\",\"url\":\"$FIXTURE_URL\"")"
INPUT="$(printf '%s' "$OPENED" | jq -r '.observation.controls[] | select(.role=="textbox") | .ref')"
FILLED="$(call fill ",\"sessionId\":\"$SESSION\",\"ref\":\"$INPUT\",\"text\":\"apples\"")"
ADD="$(printf '%s' "$FILLED" | jq -r '.observation.controls[] | select(.name=="Add to cart") | .ref')"
TEXT="$(call click ",\"sessionId\":\"$SESSION\",\"ref\":\"$ADD\"" | jq -r .observation.text)"
case "$TEXT" in
  *"Item added: apples"*) ;;
  *) printf 'expected confirmation text missing: %s\n' "$TEXT" >&2; exit 1 ;;
esac
SHOT="$(call screenshot ",\"sessionId\":\"$SESSION\"")"
PATH_="$(printf '%s' "$SHOT" | jq -r '.artifacts[0].path')"
[ -f "$PATH_" ] || { printf 'screenshot artifact missing\n' >&2; exit 1; }
call close ",\"sessionId\":\"$SESSION\"" >/dev/null
echo "PASS: shell workflow"
