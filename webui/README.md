# webui/ — OPC 网页制作台

把整条流水线包成五个页签：**数据接口 → 数据看板 → 选题引擎 → 创作引擎 → 发布引擎**。

```bash
./webui/start.sh      # http://127.0.0.1:4180（自动开浏览器）
./webui/stop.sh
OPC_WEB_PORT=8080 ./webui/start.sh
```

零依赖：Node 内置模块 + 根目录已有的 `yaml`。不改 `bin/`、`scheduler/`、`config/`、`plugins/data-sources/`、`dashboard/` 任何一行。

## 五个页签

| 页签 | 数据来源 | 动作 |
|---|---|---|
| 数据接口 | `dashboard.json.sources` → 各 `fetch-*/output.json` 原始 items | 抓取最新数据（`trends-analysis`） |
| 数据看板 | `dashboard/*.json` + `config/schedule.yaml` + 博主聚合 | 只读 |
| 选题引擎 | `data/themes/latest.json` + 历史 `recommend` 产出 | 重新生成选题 / 用这个主题创作 |
| 创作引擎 | `POST /api/create/script` → 人工确认 → `POST /api/create/render` | 写稿、改稿、5 秒自动渲染 |
| 发布引擎 | `workspace/*/render` + `publish` 记录 | 预检、真实投稿 |

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/bootstrap` | pipelines、选题文件、历史 run、当前活跃 run |
| GET | `/api/data` | 看板 + 数据源原始样本 + 博主聚合 + 定时计划 |
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

## 安全边界

- 只监听 `127.0.0.1`
- `/media` 白名单：`data/productions`、`data/scripts`、`data/themes`、`dashboard`、`logs`、`workspace`；
  **拒绝** `data/browser-profiles/`（B 站登录 cookie）与 `../` 穿越
- 同一时间只允许一个任务（第二次 409）
- 真实投稿必须二次输入「投稿」；未开启时只预检并记录 `manual_fallback + PUBLISH_DISABLED`

## 测试

```bash
node --test webui/test/api.test.mjs
```
