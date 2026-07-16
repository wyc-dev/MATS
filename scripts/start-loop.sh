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

# v2.0.216: Auto git pull — ensure latest version before starting
# This helps beta testers always run the newest code without manual git pull.
echo "[start-loop] Checking for updates..."
GIT_CHANGES=$(git fetch origin 2>&1)
LOCAL_HASH=$(git rev-parse HEAD)
REMOTE_HASH=$(git rev-parse origin/main 2>/dev/null || echo "")
if [ -n "$REMOTE_HASH" ] && [ "$LOCAL_HASH" != "$REMOTE_HASH" ]; then
  echo "[start-loop] Update available: $LOCAL_HASH → $REMOTE_HASH"
  echo "[start-loop] Pulling latest code..."
  git pull --ff-only origin main 2>&1 | head -20
  echo "[start-loop] Update complete."
else
  echo "[start-loop] Already up to date ($LOCAL_HASH)."
fi

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