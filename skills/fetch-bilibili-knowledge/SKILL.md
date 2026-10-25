---
name: fetch-bilibili-knowledge
description: 抓取 B 站知识区（tid=36，可切子分区）最新视频，按 raw-items 契约写入 ./output.json。确定性脚本，禁止使用 AI / 大模型；Cookie 必须由人手动配置在 data/secrets/bilibili-cookie.txt。
---

# 抓取 B 站知识区最新视频

确定性步骤，不做任何创作判断，**不调用 pi / 大模型**。

1. 运行（`<skill目录>` 为本 SKILL.md 所在目录）：
   ```bash
   node <skill目录>/scripts/run.mjs --input ./input.json --output ./output.json
   ```
2. 参数在 `./input.json` 的 `params` 里，全部可选：
   - `tid`：知识区=36（默认）；子分区如科学科普=201、人文历史=228
   - `limit`：条数 1–50，默认 20
   - `mode`：`latest`（默认，按发布时间倒序）或 `ranking`（分区排行，易触发 -352）
   - `enrich`：默认 true，逐条补抓播放/点赞（`newlist` 的 stat 恒为 0）
   - `enrichLimit`：补抓条数上限，默认 8
   - `noCache` / `cacheTtlSec`：默认缓存 300 秒（"最新"要新，别调大）
3. **Cookie 只能手动给，禁止 AI 生成或自动获取**：
   - 数据接口页手动粘贴 → 写入 `data/secrets/bilibili-cookie.txt`（0600）；
   - 脚本只读该文件，Cookie 不会写进 `output.json`、日志或缓存 key。
4. 插件：`plugins/data-sources/bilibili-knowledge.mjs`
   - `latest` 走 `x/web-interface/newlist`（无需登录）；
   - `ranking` 走 `x/web-interface/ranking/v2`（-352 风控时先配 Cookie）。
5. 退出码 0 即完成；非 0 读 `./error.json`：
   - `INPUT_INVALID`：输入不合格，直接结束，不要改 input.json。
   - `API_RATE_LIMIT`：被风控/限流。**不要自己循环重试**；提示用户到「数据接口」页手动粘贴 Cookie（这是唯一允许的解决方式），再由调度器退避。
   - `NETWORK_ERROR`：网络问题，交给调度器重试。
6. 不要手写或修改 output.json。
