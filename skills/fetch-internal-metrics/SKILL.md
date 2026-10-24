---
name: fetch-internal-metrics
description: 读取 C-media 的 publish-record，按平台拉取已发布视频的当前数据，按 raw-items 契约写入 ./output.json。用于 OPC 数据回写看板的步骤（24h/72h 表现）。
---

# 拉取自有内容数据

确定性步骤，不需要创作判断。只处理 `status=published` 且 `platformVideoId` 非空的记录。

1. 运行（`<skill目录>` 为本 SKILL.md 所在目录）：
   ```bash
   node <skill目录>/scripts/run.mjs --input ./input.json --output ./output.json
   ```
2. 参数在 `./input.json` 的 `params` 里，全部可选：
   - `recordFiles`：publish-record JSON 文件数组（相对仓库根或绝对路径）
   - `records`：直接给 publish-record 对象数组（联调/测试用）
   - `recordsJsonl`：publish-record JSONL，默认 `data/publish_records.jsonl`（存在才读）
   - `noCache` / `cacheTtlSec`：同 fetch-bilibili-hot
   - `snapshotsJsonl`：窗口快照路径，默认 `data/internal_metrics_snapshots.jsonl`；`snapshot:false` 可关闭
3. 脚本会：汇总记录 → 去重（同 publishId 取最后一条）→ 逐条限速拉平台数据 → 校验 → 写 `./output.json`、`./artifacts.json`。
4. 每次真实抓取会追加一行窗口快照（0h/24h/72h/7d），供后续回看；当前输出仍只取最新一次。
5. 拉取失败的单条记录会跳过并写入 `warnings`；只有遇到平台限流（`API_RATE_LIMIT`）才整体失败交给调度器重试。
6. 退出码非 0 时读 `./error.json`，处理方式同 fetch-bilibili-hot。
7. 不要手写或修改 output.json。
