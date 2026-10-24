---
name: generate-script
description: 读取 ./input.json（上游 themes 输出），为主题撰写 30 秒动画的口播脚本与分镜草稿，写入 ./draft.json，再运行组装脚本产出 ./output.json。用于 OPC 创作引擎的脚本步骤。
---

# 撰写脚本与分镜

本步的创作判断由你完成，格式校验与组装由脚本完成。**不要做创作以外的调研**。

## 严格禁止

- 禁止浏览仓库，禁止 `ls`/`find`/`rg`/`cat` 查看 `./input.json`、本 skill 目录、`data/scripts/` 之外的任何文件（包括 scheduler/、docs/、其他 skill、仓库根目录的 `p*.md`）
- 禁止运行 `node bin/opc`（该 CLI 尚未实现）
- 禁止手写 `output.json`，禁止修改 `input.json`
- 禁止编造看板里没有的数据（播放量、热度、ROI 等数字只能用输入里已有的）

## 1. 读输入

读 `./input.json`（可能是 themes 契约原样，也可能包在 `data` 里）。
- 有 `OPC_THEME_ID` 环境变量或用户指定主题 id 时用该主题；否则选 `confidence` 最高的主题。
- 只用该主题的 `title` / `brief`（angle、audience、durationSec、keywords、tone）/ `targetPlatform`，不要臆造看板里没有的数据。

## 2. 写 ./draft.json

按 `schemas/draft.schema.json` 写，规则：

- `title` ≤ 80 字符，`tags` 1–12 个，每个 ≤ 20 字符
- `palette` 从 `midnight` / `paper` / `mint` / `sunset` 里选一个
- `scriptMarkdown` 是口播稿，带时间轴小节，中文、口语、信息密度高
- `scenes` 2–12 个，第一个 `kind` 为 `title`，最后一个是 `outro`，中间是 `point`
  - `heading` ≤ 24 字符，`body` ≤ 60 字符
  - **所有 `durationSec` 之和必须接近主题 `brief.durationSec`，偏差不超过 20%**（脚本会校验，不通过直接失败）

## 3. 组装

在本步目录运行：

```bash
node <skill目录>/scripts/assemble.mjs --input ./input.json --draft ./draft.json --output ./output.json
```

## 4. 处理结果

- 退出码 0：完成，结束。
- `DURATION_MISMATCH`：按提示调整 `scenes[].durationSec` 后重跑一次。
- `DRAFT_INVALID`：按报错改 `draft.json` 后重跑一次。
- `INPUT_INVALID` / `THEME_NOT_FOUND`：输入问题，**不要**伪造主题或看板数据，直接结束。
- 其他：最多重跑 1 次，仍失败则结束。

不要手写 `output.json`，不要读写本步目录与 `data/scripts/` 以外的文件。
