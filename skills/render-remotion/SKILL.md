---
name: render-remotion
description: 读取 ./input.json 中的分镜（storyboard），用 Remotion 固定模板渲染成片 mp4 和封面，产出 production 成片清单写入 ./output.json。用于 OPC 创作引擎的渲染步骤。
---

# 渲染成片（Remotion）

这是一个**只按命令执行**的确定性步骤，不需要任何调研、创作或排查。

## 允许做的全部动作

只运行这一条命令（`<skill目录>` = 本 SKILL.md 所在目录，用绝对路径）：

```bash
node <skill目录>/scripts/render.mjs --input ./input.json --output ./output.json
```

## 严格禁止

- 禁止浏览仓库、禁止 `ls`/`find`/`rg`/`cat` 查看本 skill 目录与 `./input.json` 之外的任何文件（包括 scheduler/、docs/、其他 skill、仓库根目录的 `p*.md`）
- 禁止读 `render.mjs` 或 `templates/remotion/` 的源码
- 禁止运行 `node bin/opc`（该 CLI 尚未实现）
- 禁止手写、修补或重排 `output.json`；禁止修改 `input.json` 或自造分镜
- 不要为了“确认结果”反复渲染

## 判定与结束（照做即可）

| 情况 | 动作 |
|---|---|
| 退出码 0 | 完成，结束 |
| `error.json` 的 `code=INPUT_INVALID` | 输入不合格，结束（由上游修正），不要改输入 |
| 其他失败 | 最多重跑上面这条命令 1 次；仍失败则结束，保留 `error.json` 原样 |

渲染通常需要 30–90 秒，耐心等待命令返回即可。
