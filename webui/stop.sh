#!/usr/bin/env bash
# 停止 OPC Web 控制台
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
PIDFILE=".webui.pid"
if [ ! -f "$PIDFILE" ]; then
  echo "没有找到 $PIDFILE（可能没启动过，或用 Ctrl+C 前台运行的）"
  exit 0
fi
PID="$(cat "$PIDFILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "已停止（pid ${PID}）"
else
  echo "进程 $PID 已经不在了"
fi
rm -f "$PIDFILE"
