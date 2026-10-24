# webui/ — OPC 网页控制台

把 `bin/opc` 的命令行包装成按钮：选题 → 写稿 → 出片 → 发布，全程在浏览器里看进度和成片。

```bash
./webui/start.sh      # http://127.0.0.1:4180（会自动开浏览器）
./webui/stop.sh
```

零依赖：只用 Node 内置模块 + 根目录已有的 `yaml`。不改 `bin/`、`scheduler/`、`config/`、`workspace/` 的任何代码。

## 它做的事

| 能力 | 实现 |
|---|---|
| 列出可跑流水线 | 读 `config/pipeline.yaml` + `plugins/publishers/pipelines/create-video.yaml` |
| 运行 | `spawn(node bin/opc run …  --launcher spawn --verbose)`，同一时间只允许一个任务 |
| 实时进度 | 解析 `--verbose` 的 `[run] step_start/step_end`，走 SSE 推到页面 |
| 选题/主题 | 扫 `workspace/*/recommend/*/output.json`，选中后写回 `data/themes/latest.json` |
| 指定主题 | 注入 `OPC_THEME_ID`（需 pipeline 的 step 声明 `env`） |
| 真实投稿 | 勾选后注入 `OPC_PUBLISH_ENABLED=1`，并且必须输入「投稿」二次确认 |
| 成片预览 | `/media?p=…` 支持 Range，只放行 `data/productions`、`data/scripts`、`logs`、`dashboard`、`workspace` |
| 结果 | 读 `run.json` + 每个 step 的 `output.json`，渲染播放器/发布记录/脚本/分镜/JSON |
| 历史 | 扫 `workspace/*/run.json`；每次运行的完整控制台输出在 `workspace/<runId>/console.log` |

## 安全边界

- 只监听 `127.0.0.1`（没有账号体系，不要暴露到公网）
- `/media` **拒绝** `data/browser-profiles/`——那是 B 站登录 cookie
- 拒绝路径穿越（`..`、绝对路径）
- 投稿默认关闭；开了也必须二次确认
- 「停止」给整个进程组发 SIGTERM（含 pi 子进程）

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `OPC_WEB_PORT` | `4180` | 端口（4173 常被别的项目占用） |
| `OPC_WEB_HOST` | `127.0.0.1` | 监听地址 |
| `OPC_WEB_NO_OPEN` | 空 | 设为 `1` 不自动开浏览器 |

## 测试

```bash
node --test webui/test/api.test.mjs     # 8 条：路由、选题接口、越权/穿越、400/404
```

## 结构

```
webui/
├── server.mjs          HTTP + API + SSE + Range 媒体
├── public/
│   ├── index.html
│   ├── app.js          无框架前端；含极简 markdown 渲染（教程/口播稿）
│   └── style.css
├── start.sh / stop.sh
└── test/api.test.mjs
```
