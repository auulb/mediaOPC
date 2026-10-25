# webui/ — OPC 网页制作台

把整条流水线包成六个页签：**数据接口 → 数据看板 → 选题引擎 → 创作引擎 → 发布引擎 → 定时定点**。

> **数据接口 + Cookie 这一块禁止使用 AI**：抓取只跑确定性脚本（`node skills/fetch-bilibili-knowledge/scripts/run.mjs`），
> 不经过 pi / 大模型；Cookie 只能由人手动粘贴（`data/secrets/bilibili-cookie.txt`，0600，不进日志/产物）。

```bash
./webui/start.sh      # http://127.0.0.1:4180（自动开浏览器）
./webui/stop.sh
OPC_WEB_PORT=8080 ./webui/start.sh
```

零依赖：Node 内置模块 + 根目录已有的 `yaml`。网页只是壳：流水线通过 `bin/opc`（AI 步骤）或 `skills/*/scripts/run.mjs`（确定性步骤）调用，不改 `scheduler/`、`config/`、`dashboard/` 任何一行。

## 六个页签

| 页签 | 数据来源 | 动作 |
|---|---|---|
| 数据接口 | `dashboard.json.sources` + `data/sources/*.json` 原始 items | Cookie 手动填写 / 抓 B 站热门 / 抓知识区最新（**全部不用 AI**）；完整 AI 选题流水线在数据看板 / 选题引擎 |
| 数据看板 | `dashboard/*.json` + `config/schedule.yaml` + 博主聚合 | 只读 |
| 选题引擎 | `data/themes/latest.json` + 历史 `recommend` 产出 | 重新生成选题 / 用这个主题创作 |
| 创作引擎 | `POST /api/create/script` → 人工确认 → `POST /api/create/render` | 写稿、改稿、5 秒自动渲染 |
| 发布引擎 | `workspace/*/render` + `publish` 记录 | 预检、真实投稿 |
| 定时定点 | `data/schedule/jobs.json` + `state.json` + `runs.jsonl` | 定点（多个 HH:MM + 星期）自动抓知识区最新；立即执行一次 |

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/bootstrap` | pipelines、选题文件、历史 run、当前活跃 run |
| GET | `/api/data` | 看板 + 数据源原始样本 + 博主聚合 + 定时计划 + Cookie 状态 |
| GET/POST/DELETE | `/api/cookie` | Cookie 状态（永不回显原文）/ 手动保存 / 清除 |
| POST | `/api/fetch/knowledge` | `{tid, limit, enrich, keywords}` → 直接跑知识区抓取脚本（不经过 AI） |
| POST | `/api/fetch/hot` | `{limit}` → 直接跑 B 站热门抓取脚本（不经过 AI） |
| GET/POST | `/api/schedule` | 定时定点任务读取 / 保存（时间点与星期会被规范化） |
| POST | `/api/schedule/run` | `{job}` → 先存再立即跑一次确定性抓取 |
| GET | `/api/topics` | 主题库、外部/内部推荐各 3、使用状态 |
| GET | `/api/productions` | 成片清单（含横/竖封面、发布记录） |
| GET | `/api/create/draft?id=` | 某次写稿的稿子（口播稿 + 分镜） |
| POST | `/api/create/script` | `{themesPath, themeId}` → 跑 `generate-script`，返回稿子 |
| POST | `/api/create/render` | `{runId, patch}` → 改稿并跑 `render-remotion` |
| POST | `/api/publish` | `{runId, publish, metadata}` → 预检 / 真实投稿 |
| POST | `/api/run` | 跑整条 pipeline（`trends-analysis` 等） |
| POST | `/api/stop` | 停掉当前进程组 |
| GET | `/api/stream` | SSE：日志、step_start/step_end、done |
| GET | `/media?p=` | 成片/封面/产物，支持 Range；白名单目录 |

创作/发布接口内部都是 `node bin/opc run-step …`，与命令行完全等价：

```bash
# 写稿
node bin/opc run-step --skill generate-script --id script \
  --input data/themes/latest.json --run-id <id> --launcher spawn
# 渲染
node bin/opc run-step --skill render-remotion --id render --contract production \
  --input workspace/<id>/script/attempt-1/output.json --run-id <id> --launcher spawn
# 发布（预检 / 真投稿）
OPC_PUBLISH_ENABLED=1 node bin/opc run-step --skill publish-bilibili --id publish \
  --contract publish-record --input workspace/<id>/render/attempt-1/output.json --run-id <id> --launcher spawn
```

## 人工确认（5 秒自动下一步）

1. 写稿步骤返回后，页面进入「人工确认」：口播稿、标题、简介、标签、每个分镜的标题/说明/时长都可改。
2. 右上角倒计时 5 秒；**只要点进任一输入框就暂停**。
3. 不操作 → 自动渲染；点「立即渲染」→ 立刻渲染；点「重新写稿」→ 丢弃重来。

改动会写成 `workspace/<runId>/edit/script-output.json`（口播稿改动写 `edit/script.md`），原步骤产物保持不动。

## 数据采集（禁止 AI）与定时定点

```bash
# 与页面「立即抓取」等价：直接跑确定性脚本，不经过 pi / 大模型
node skills/fetch-bilibili-knowledge/scripts/run.mjs --input <in.json> --output <out.json>
#   {"params": {"tid": 36, "limit": 20, "enrich": true, "keywords": ["AI"]}}

# 定时定点的产物与状态
data/sources/bilibili-knowledge.json      # 抓取结果（raw-items v1），数据接口页直接读
data/schedule/jobs.json                   # 定点设置（times[] / days[] / params）
data/schedule/state.json                  # 上次结果、去重用的 lastRunKey
data/schedule/runs.jsonl                  # 每次运行一条（定时 / 手动）
data/secrets/bilibili-cookie.txt          # 手动 Cookie，0600，不进 /media 白名单
```

- 调度器跑在 `webui/server.mjs` 进程里，每 20 秒检查一次「星期 + HH:MM」；同一分钟只触发一次。
- 到点后 `spawn` 脚本 → 写 `data/sources/` → SSE 推送 `done`，页面自动刷新。
- 风控（`-352`）时唯一的解决方式是**人工**在数据接口页粘贴 Cookie；脚本不会自动登录、不会自动重试刷接口。
- 时区取服务器本地时区（页面会显示，如 `Asia/Shanghai`）。

## 安全边界

- 只监听 `127.0.0.1`
- `/media` 白名单：`data/productions`、`data/scripts`、`data/themes`、`dashboard`、`logs`、`workspace`；
  **拒绝** `data/browser-profiles/`（B 站登录 cookie）、`data/secrets/`（手动 Cookie）与 `../` 穿越
- `/api/cookie` 只返回 `configured / bytes / savedAt / hasSessdata`，永不返回 Cookie 原文；Cookie 不写入 `output.json` 的 `params`，也不参与缓存 key
- 同一时间只允许一个任务（第二次 409）
- 真实投稿必须二次输入「投稿」；未开启时只预检并记录 `manual_fallback + PUBLISH_DISABLED`

## 测试

```bash
node --test webui/test/api.test.mjs          # 含 Cookie 手动写入 / 定时定点规范化用例
node --test plugins/data-sources/test/knowledge.test.mjs   # 知识区抓取（离线 mock）
npm test                                     # 全量（含 webui）
```
