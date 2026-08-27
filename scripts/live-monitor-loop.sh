#!/bin/bash
# v2.0.870 live 監控 loop——每 80 分鐘跑一次 compact monitor,append 到 log。
# 用法: nohup bash scripts/live-monitor-loop.sh > /dev/null 2>&1 &
cd /Users/y.c./Downloads/mats_backend
LOG="logs/live-monitor.log"
while true; do
  echo "[$(date '+%Y-%m-%d %H:%M')] $(npx tsx scripts/live-monitor-compact.ts 2>/dev/null)" >> "$LOG"
  sleep 4800  # 80 分鐘
done
