#!/usr/bin/env bash
# ─── MATS Start Loop ───
# v2.0.206: Wrapper for `npm start` that auto-restarts on crash (exit 137 = OOM).
# On 8GB Macs, the full trading system can get SIGKILL'd by macOS jetsam
# during peak memory (embeddings + WebSockets + trading engine all loaded).
# This wrapper detects the crash and restarts automatically, like engineer-loop.sh
# but without System Engineer enabled.
#
# Flow:
#   1. Start tsx src/index.ts (no SYSTEM_ENGINEER_ENABLED)
#   2. If crash (exit code != 0) → wait 5s → restart
#   3. If normal exit (exit code 0) → stop
#
# Use `npm run engineer` for autonomous code repair mode.

set -uo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

echo "[start-loop] Starting MATS (no System Engineer)..."
echo "[start-loop] Press Ctrl+C to stop."

while true; do
  npx tsx src/index.ts
  EXIT_CODE=$?

  if [ "$EXIT_CODE" -eq 0 ]; then
    echo "[start-loop] Process exited normally — stopping."
    break
  else
    echo "[start-loop] Process crashed (exit code $EXIT_CODE) — restarting in 5s..."
    sleep 5
    continue
  fi
done