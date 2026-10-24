# dashboard/

看板数据，由 `skills/build-dashboard` 生成，**不要手改**。

| 文件 | 生产者 | 说明 |
|---|---|---|
| `dashboard.json` | B-data | 权威副本，符合 `contracts/dashboard.schema.json` v1 |
| `external_trends.json` | B-data | 外部热门 / 话题热度 / 平台流量占比 |
| `internal_performance.json` | B-data | 自有已发布内容表现（来自 fetch-internal-metrics） |
| `token_usage.json` | B-data | 今日/本周 token、预算使用率、按步骤聚合 |
| `task_status.json` | A-core | 调度器任务状态；build-dashboard 只读不写 |

## sourceRef

所有指标都带 `sourceRef[]`，每项形如：

```json
{ "source": "raw-0-bilibili-hot", "pointer": "/items/3", "itemId": "BV1xx411c7mD" }
```

- `source`：`dashboard.sources[].id`
- `pointer`：RFC 6901 JSON Pointer，指向 `sources[]` 中 `file` 的内容
- 跳转逻辑：`sources.find(s => s.id === ref.source).file` → 读取该文件 → 按 `pointer` 取值

## 生成

```bash
node skills/build-dashboard/scripts/build.mjs --input <含 params 的 input.json> --output ./output.json
```

最小输入：

```json
{
  "params": {
    "upstream": ["fetch-bilibili", "fetch-internal"],
    "ledger": "data/token_ledger.jsonl",
    "taskStatus": "dashboard/task_status.json"
  }
}
```

`upstream` 会读取 `workspace/{OPC_RUN_ID}/{stepId}/attempt-*/output.json` 中 attempt 号最大的一份；也可以直接给 `rawItems` 路径。

`task_status.json` 不存在时，任务面板会用 token ledger 的 attempt 记录推导，不会中断构建。
