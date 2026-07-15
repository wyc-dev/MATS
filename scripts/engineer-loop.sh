#!/usr/bin/env bash
# ─── System Engineer Loop ───
# v2.0.187: Wrapper script that runs MATS with System Engineer enabled,
# and automatically restarts after System Engineer modifies code.
#
# Flow:
#   1. Start tsx src/index.ts with SYSTEM_ENGINEER_ENABLED=true
#   2. System Engineer modifies code → tsc + test → git commit
#   3. System Engineer calls process.exit(0) with a special exit code (42)
#   4. This script detects exit code 42 → restarts the process
#   5. New process loads the modified code
#   6. Repeat
#
# If the process crashes (exit code != 0 and != 42), wait 5s and restart.
# If the process exits normally (exit code 0), stop.

set -uo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

echo "[engineer-loop] Starting MATS with System Engineer enabled..."
echo "[engineer-loop] Press Ctrl+C to stop."

while true; do
  SYSTEM_ENGINEER_ENABLED=true npx tsx src/index.ts
  EXIT_CODE=$?

  if [ "$EXIT_CODE" -eq 42 ]; then
    echo "[engineer-loop] System Engineer triggered restart (exit code 42) — restarting with new code..."
    sleep 2
    continue
  elif [ "$EXIT_CODE" -eq 0 ]; then
    echo "[engineer-loop] Process exited normally — stopping."
    break
  else
    echo "[engineer-loop] Process crashed (exit code $EXIT_CODE) — restarting in 5s..."
    sleep 5
    continue
  fi
done