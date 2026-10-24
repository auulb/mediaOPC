---
name: recommend-themes
description: 读取 dashboard v1，结合外部热度与内部表现推荐 6 个候选主题（外部 3 + 内部 3），写成符合 contracts/themes.schema.json 的 ./output.json。用于 OPC 主题推荐步骤。
---

# 主题推荐

这是需要判断的步骤：你负责选题，脚本只负责提供上下文和校验。

1. 先运行（`<skill目录>` 为本 SKILL.md 所在目录），得到压缩后的看板上下文：
   ```bash
   node <skill目录>/scripts/context.mjs --input ./input.json
   ```
2. 基于上下文提出 **6 个**主题：`source=external` 3 个（跟进热点），`source=internal` 3 个（放大已验证的表现或修正问题）。
3. 每个主题必须包含：
   - `id`：`theme_YYYYMMDD_001` … `_006`，用 context 里的 `themeIdPrefix`，外部 001–003、内部 004–006
   - `title`：≤ 40 字，具体到看点，不要写“关于 XX 的视频”
   - `confidence`：0–1，热点证据越强越高，不要全部 ≥0.9
   - `reason`：一句话说明为什么做，必须引用 context 里的数字（热度、播放、互动率）
   - `evidence`：1–3 条，`pointer` 必须从 context 直接复制（外部用 `/externalTrends/...`；内部优先 `/internalPerformance/...`，冷启动没有历史数据时可用 `/tokenUsage/...` 或 `/taskStatus/...`），可加 `note`
   - `targetPlatform`：1–2 个，从 `bilibili` `youtube` `douyin` `tiktok` 中选
   - `brief`：`angle`（一句话看点）、`audience`、`durationSec`（10–120）、`keywords`（3–6 个）
   - `estimatedCost`：`tokens`（整数）、`time`（如“2小时”）、`budget`（如“$15”）
   - `creationPlan.steps`：按 `script` → `storyboard` → `render`，工具写 `pi` 或 `remotion`，各步给 `duration`
4. 把结果（只有 `schemaVersion`、`generatedAt`、`dashboardRef`、`themes` 四个顶层字段）写到 `./output.json`。`dashboardRef` 写 `./input.json`。
5. 运行校验，不通过就按报错修正后重跑（最多 2 次）：
   ```bash
   node <skill目录>/scripts/validate.mjs ./output.json --dashboard ./input.json
   ```
6. 校验通过即结束。不要修改 input.json，不要写其他文件，不要执行发布或渲染。
