#!/usr/bin/env bash
# 启动 OPC Web 控制台（后台常驻，自动打开浏览器）
#
#   ./webui/start.sh              → http://127.0.0.1:4180
#   OPC_WEB_PORT=8080 ./webui/start.sh
#   OPC_WEB_NO_OPEN=1 ./webui/start.sh   # 不自动开浏览器
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PORT="${OPC_WEB_PORT:-4180}"
PIDFILE=".webui.pid"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  if curl -sf "http://127.0.0.1:${PORT}/api/bootstrap" > /dev/null 2>&1; then
    echo "已经在运行（pid $(cat "$PIDFILE")）：http://127.0.0.1:${PORT}"
    exit 0
  fi
  echo "pid $(cat "$PIDFILE") 还在但端口没响应，按陈旧 pid 处理"
  rm -f "$PIDFILE"
fi

mkdir -p logs
nohup node webui/server.mjs > logs/webui.log 2>&1 &
echo $! > "$PIDFILE"

for _ in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:${PORT}/api/bootstrap" > /dev/null 2>&1; then
    echo "OPC 控制台已启动：http://127.0.0.1:${PORT}"
    echo "日志：logs/webui.log   停止：./webui/stop.sh"
    exit 0
  fi
  sleep 0.3
done

echo "启动失败，看看 logs/webui.log：" >&2
tail -20 logs/webui.log >&2
exit 1
