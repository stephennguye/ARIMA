#!/bin/sh
# ARIMA PreToolUse launcher (ADR-0005). Claude Code blocks a tool call only when a hook exits 2,
# so every way this guard could fail to run must end in exit 2, but only inside an ARIMA project:
# outside one the plugin must be invisible, and a missing Node must not lock a user out of Claude
# Code everywhere.
#
#   inside an ARIMA project   Node missing, bundle missing or crashing, Node too old -> exit 2
#   outside an ARIMA project  anything that goes wrong                               -> exit 0
#
# Usage: guard.sh pre-tool-use   (the hook payload JSON arrives on stdin)

kind="${1:-pre-tool-use}"
root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

in_project() {
  for base in "${ARIMA_PROJECT_DIR:-}" "${CLAUDE_PROJECT_DIR:-}"; do
    if [ -n "$base" ] && [ -f "$base/arima.yaml" ]; then return 0; fi
  done
  d="$PWD"
  while :; do
    if [ -f "$d/arima.yaml" ]; then return 0; fi
    p=$(dirname "$d")
    if [ "$p" = "$d" ]; then return 1; fi
    d="$p"
  done
}

block() {
  echo "ARIMA guard $1, so this action is blocked to be safe. $2" >&2
  exit 2
}

if ! command -v node >/dev/null 2>&1; then
  if in_project; then block "cannot run because Node.js was not found" "Install Node.js 22 or newer."; fi
  exit 0
fi

node "$root/scripts/dist/arima-hook.mjs" "$kind"
rc=$?
if [ "$rc" -eq 0 ] || [ "$rc" -eq 2 ]; then exit "$rc"; fi

if in_project; then block "failed unexpectedly (exit $rc)" "Ask the human to check the ARIMA plugin."; fi
exit 0
