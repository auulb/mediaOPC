---
name: fetch-bilibili-hot
description: 抓取 B 站综合热门榜并按 raw-items 契约写入 ./output.json。用于 OPC 趋势分析 pipeline 的外部数据采集步骤；带 1 小时文件缓存和跨进程限速。
---

# 抓取 B 站热门

确定性步骤，不需要创作判断。

1. 运行（`<skill目录>` 为本 SKILL.md 所在目录）：
   ```bash
   node <skill目录>/scripts/run.mjs --input ./input.json --output ./output.json
   ```
2. 参数在 `./input.json` 的 `params` 里，全部可选：
   - `limit`：条数，1–100，默认 50
   - `noCache`：true 时跳过缓存读取（仍会写缓存）
   - `cacheTtlSec`：覆盖默认缓存时长（默认 3600 秒）
3. 脚本会调用 `plugins/data-sources/bilibili-hot.mjs`：限速（3 秒/次）→ 命中缓存则直接返回 → 否则抓取 → 校验 → 写 `./output.json`（结构见 `contracts/raw-items.schema.json`）与 `./artifacts.json`。
4. 退出码 0 即完成。
5. 退出码非 0：读 `./error.json`。
   - `INPUT_INVALID`：输入不合格，直接结束，不要改 input.json。
   - `API_RATE_LIMIT` / `NETWORK_ERROR`：网络或被风控，由调度器重试；**不要**自己循环重试。
   - 其他：直接结束并说明错误码。
6. 不要手写或修改 output.json，不要访问 `data/cache/` 以外的路径。
