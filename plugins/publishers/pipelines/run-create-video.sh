#!/usr/bin/env bash
# 一条命令跑完 C-media 的创作+发布链路。
#
#   ./run-create-video.sh                     # 用 data/themes/latest.json
#   ./run-create-video.sh path/to/themes.json # 用指定选题文件（= recommend-themes 的 output.json）
#
# 发布默认只预检不上传；要真发：
#   OPC_PUBLISH_ENABLED=1 ./run-create-video.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
THEMES="${1:-$ROOT/data/themes/latest.json}"
if [ "$#" -gt 0 ]; then shift; fi

if [ ! -f "$THEMES" ]; then
  cat >&2 <<EOF
缺选题文件：$THEMES
先跑数据段：  node bin/opc run trends-analysis --launcher spawn
或先用样例：  cp fixtures/recommend-themes/output.json data/themes/latest.json
EOF
  exit 1
fi

# 流水线第一步固定读 data/themes/latest.json，这里把外部传入的文件固化过去
mkdir -p "$ROOT/data/themes"
if [ "$(cd "$(dirname "$THEMES")" && pwd)/$(basename "$THEMES")" != "$ROOT/data/themes/latest.json" ]; then
  cp "$THEMES" "$ROOT/data/themes/latest.json"
fi

exec node "$ROOT/bin/opc" run create-video \
  --pipeline-config "$ROOT/plugins/publishers/pipelines/create-video.yaml" \
  --launcher spawn "$@"
