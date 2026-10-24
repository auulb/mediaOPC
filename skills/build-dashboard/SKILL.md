---
name: build-dashboard
description: 汇总 raw-items、token_ledger、task_status，生成带 sourceRef 的数据看板 ./output.json 与 dashboard/*.json。用于 OPC 趋势分析 pipeline 的看板步骤。
---

# 生成数据看板

确定性步骤，不需要创作判断。

1. 运行（`<skill目录>` 为本 SKILL.md 所在目录）：
   ```bash
   node <skill目录>/scripts/build.mjs --input ./input.json --output ./output.json
   ```
2. 参数在 `./input.json` 的 `params` 中：
   - `rawItems`：raw-items JSON 文件数组，相对仓库根；省略时用 `upstream` 自动发现
   - `upstream`：上游 stepId 列表，按 `workspace/{OPC_RUN_ID}/{stepId}/attempt-*` 取最新一次产物
   - `ledger`：token ledger JSONL，默认 `data/token_ledger.jsonl`
   - `taskStatus`：A-core 写的任务状态，默认 `dashboard/task_status.json`
   - `previousDashboard`：上一版看板，用于算 `growth`，默认 `dashboard/dashboard.json`
   - `dailyTokenBudget`：日预算 tokens，默认 500000
   - `dashboardDir`：看板目录，默认 `dashboard`
3. 脚本会：聚合话题/流量/自有内容/token/任务状态 → 按 `contracts/dashboard.schema.json` 校验 → 写 `./output.json`、`./artifacts.json` 和 `dashboard/{dashboard,external_trends,internal_performance,token_usage}.json`。
4. `dashboard/task_status.json` 归 A-core 写，本步骤只读不写；文件不存在时用 token ledger 的 attempt 记录推导任务面板。
5. 退出码非 0 时读 `./error.json`：
   - `INPUT_INVALID`：输入不合格，直接结束，不要自行编造数据。
   - `OUTPUT_INVALID`：聚合结果不符合契约，直接结束并报告 `details.errors`。
6. 不要手写或修改 output.json / dashboard/*.json。
