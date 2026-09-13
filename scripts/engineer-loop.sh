#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Engineer Boot Orchestrator —— v2.0.877-P9-engineer-boot
#
# 設計初衷（主神 2026-09-13:「why proxy error?我明明冇開其他」→ 開機 race 根治）
#   `npm run engineer` 舊架構 = `concurrently -n ui,engineer` 並行起 UI(:5173)+
#   engineer-loop。Vite 一啟動即刻 poll /api/* → 但 backend(tsx src/index.ts)
#   要等 engineer-loop 做完成個 git update 檢查先至 spawn → 中間 1-N 秒所有
#   proxy request 撞 ECONNREFUSED 刷屏。實證(13:09:53 error / 13:09:54 backend
#   ready 差 1 秒)係純啟動時序競態,唔係 port 衝突、唔係用戶開錯嘢。
#
# 本版架構 = 單一 boot 總管(取代 concurrently),三個 production 原則:
#   ① 啟動順序 = backend 先 → real-HTTP readiness gate → UI 先。
#      開機 0 ECONNREFUSED(UI 第一個 fetch 時 backend 一定 ready)。
#   ② readiness = real-HTTP roundtrip,唔係 port-open check。
#      E1 實證(2026-09-13): backend event-loop 掛死時照 listen :3456 但
#      3s 零 response —— port check 會 false-PASS,curl -m2 先捉到。
#   ③ backend lifecycle(exit 42 / crash)restart 期間 UI 唔郁 ——
#      UI 靠 SSE 指數退避(v2.0.853-fix5, 2s→15s)自癒,唔需要重啟 UI。
#
# ⚠️ 行為改變(對比舊 concurrently -k): UI 死咗唔再殺 backend —— engineer
#    mode 嘅意圖係「SE 長駐診斷 + backend 持續跑」,UI 只係監控面。
#
# 可覆寫環境變數:
#   ENGINEER_UPDATE_CHECK      "1"|"0"     預設 1 —— 啟動前 git fetch + ff-only pull
#   ENGINEER_READY_TIMEOUT_S               預設 180 —— readiness gate 最長等待(秒)
#   ENGINEER_READY_PROBE_URL               預設 http://127.0.0.1:3456/api/status
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

UPDATE_CHECK="${ENGINEER_UPDATE_CHECK:-1}"
READY_TIMEOUT_S="${ENGINEER_READY_TIMEOUT_S:-180}"
READY_PROBE_URL="${ENGINEER_READY_PROBE_URL:-http://127.0.0.1:3456/api/status}"
PROBE_TIMEOUT_S=2

BACKEND_PID=""
UI_PID=""

# ── 清理: 保證 UI + backend 一齊收工(取代 concurrently -k)──
#    npm run dev / npx tsx 都會 spawn child —— kill -TERM 後等佢哋自己執行李,
#    超過寬限期先 -9(唔會殺錯 process,因為只針對 recorded pid)。
cleanup() {
  echo "[engineer-loop] Shutting down (UI=${UI_PID:-none}, backend=${BACKEND_PID:-none})..."
  if [ -n "$UI_PID" ] && kill -0 "$UI_PID" 2>/dev/null; then
    kill "$UI_PID" 2>/dev/null || true
    sleep 3
    kill -9 "$UI_PID" 2>/dev/null || true
  fi
  if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
    sleep 2
    kill -9 "$BACKEND_PID" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ── auto-update: remote default branch 動態解析 ──
#    git ls-remote 實證本 repo remote 得 refs/heads/MATS_Backend + MATS_Terminal,
#    冇 main —— 舊 hardcode `origin/main` 永遠攞唔到 → auto-pull 形同虛設 +
#    「couldn't find remote ref main」fatal 噪音。用 remote HEAD symref 解析
#    default branch,冇就 fallback main(向後兼容)。
update_check() {
  if [ "$UPDATE_CHECK" != "1" ] && [ "$UPDATE_CHECK" != "true" ]; then
    echo "[engineer-loop] Update check disabled (ENGINEER_UPDATE_CHECK=$UPDATE_CHECK)."
    return 0
  fi
  echo "[engineer-loop] Checking for updates..."
  if ! git fetch origin 2>&1; then
    echo "[engineer-loop] ⚠️ git fetch failed — continuing with local code."
    return 0
  fi
  local remote_default local_hash remote_hash
  remote_default="$(git ls-remote --symref origin HEAD 2>/dev/null | awk '/^ref:/ {sub("refs/heads/", "", $2); print $2}')"
  remote_default="${remote_default:-main}"
  local_hash="$(git rev-parse HEAD 2>/dev/null || echo '')"
  remote_hash="$(git rev-parse "origin/$remote_default" 2>/dev/null || echo '')"
  if [ -n "$local_hash" ] && [ -n "$remote_hash" ] && [ "$local_hash" != "$remote_hash" ]; then
    echo "[engineer-loop] Update available: ${local_hash:0:9} → ${remote_hash:0:9} (origin/$remote_default)"
    echo "[engineer-loop] Pulling latest code..."
    git pull --ff-only "origin" "$remote_default" 2>&1 | head -20
    echo "[engineer-loop] Update complete."
  else
    echo "[engineer-loop] Already up to date ($(git rev-parse --short HEAD 2>/dev/null || echo 'unknown'))."
  fi
}

# ── readiness gate: real-HTTP roundtrip(E1 實證,唔係 port check)──
backend_ready() {
  curl -fsS -m "$PROBE_TIMEOUT_S" -o /dev/null "$READY_PROBE_URL" 2>/dev/null
}

wait_for_backend() {
  local waited_s=0
  while [ "$waited_s" -lt "$READY_TIMEOUT_S" ]; do
    if backend_ready; then return 0; fi
    sleep 1
    waited_s=$((waited_s + 1))
  done
  return 1
}

start_backend() {
  SYSTEM_ENGINEER_ENABLED=true npx tsx src/index.ts &
  BACKEND_PID=$!
  echo "[engineer-loop] Backend started (pid $BACKEND_PID)."
}

start_ui() {
  (cd ui && npm run dev) &
  UI_PID=$!
  echo "[engineer-loop] UI started (pid $UI_PID) → http://localhost:5173"
}

# ── boot 序 ──
update_check

# fail-fast: UI build 唔過 → abort,唔 boot 一個交易 backend 陪一個爛 UI
echo "[engineer-loop] Building UI first (fail-fast gate)..."
if ! (cd ui && npm run build > /dev/null 2>&1); then
  echo "[engineer-loop] ❌ UI build failed — aborting (backend not started)."
  exit 1
fi
echo "[engineer-loop] UI build OK."

start_backend
if wait_for_backend; then
  echo "[engineer-loop] ✅ Backend ready ($READY_PROBE_URL)."
else
  echo "[engineer-loop] ⚠️ Backend NOT ready within ${READY_TIMEOUT_S}s — starting UI anyway (degraded: SSE backoff-retry v2.0.853-fix5 handles recovery)."
fi
start_ui
echo "[engineer-loop] Press Ctrl+C to stop."

# ── backend lifecycle: exit 42(SE 改 code)/0(正常)/signals/其他(crash)──
while true; do
  wait "$BACKEND_PID" 2>/dev/null
  EXIT_CODE=$?
  if [ "$EXIT_CODE" -eq 42 ]; then
    echo "[engineer-loop] System Engineer triggered restart (exit 42) — restarting backend with new code..."
    sleep 2
    start_backend
    if wait_for_backend; then
      echo "[engineer-loop] ✅ Backend re-ready."
    else
      echo "[engineer-loop] ⚠️ Backend not ready after SE restart — UI will retry via SSE backoff."
    fi
  elif [ "$EXIT_CODE" -eq 0 ]; then
    echo "[engineer-loop] Backend exited normally — stopping UI and shutting down."
    [ -n "$UI_PID" ] && kill "$UI_PID" 2>/dev/null || true
    break
  elif [ "$EXIT_CODE" -eq 130 ] || [ "$EXIT_CODE" -eq 143 ]; then
    # SIGINT/SIGTERM — cleanup trap 已接手
    break
  else
    echo "[engineer-loop] Backend crashed (exit code $EXIT_CODE) — restarting in 5s..."
    sleep 5
    start_backend
    wait_for_backend || echo "[engineer-loop] ⚠️ Backend not ready after crash-restart — UI retries via SSE backoff."
  fi
done
