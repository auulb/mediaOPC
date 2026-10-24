# OPC 运营动画 · 3 AI 分工合作开发计划

配套文档：`docs/OPC运营动画程序设计文档.md`

核心原则同样适用于开发本身：**3 个 AI 各占一个目录、各开一个 pi 会话，彼此不共享上下文，只通过 `contracts/` 下的契约文件和 `HANDOFF.md` 交接。**

---

## 一、角色分工

| 角色 | 代号 | 负责模块 | 独占目录 | 一句话职责 |
|---|---|---|---|---|
| AI-A 平台工程师 | `A-core` | 0 调度与隔离 + 2.3 Token/任务状态 | `scheduler/` `config/` `bin/` | 让任意 skill 能被定时、隔离、重试地跑起来 |
| AI-B 数据与策划 | `B-data` | 1 数据接口 + 2 看板 + 3 主题引擎 | `plugins/data-sources/` `skills/fetch-*` `skills/build-dashboard` `skills/recommend-themes` `dashboard/` | 从数据里选出值得做的题 |
| AI-C 创作与发布 | `C-media` | 4 创作引擎 + 5 发布引擎 | `plugins/publishers/` `skills/create-*` `skills/render-*` `skills/publish-*` `templates/remotion/` | 把题做成片并发出去，发布结果回写 |

共享目录（只能通过"契约变更流程"修改）：
- `contracts/`：所有 `input.json / output.json` 的 JSON Schema
- `HANDOFF.md`：交接日志（只追加，不改写）
- `fixtures/`：各步骤的样例输入输出，供其他 AI 联调

---

## 二、协作规则

1. **契约先行**：第 0 周三人只写 `contracts/*.schema.json` 和 `fixtures/`，不写实现。契约冻结后才开工。
2. **目录独占**：只改自己的独占目录。需要别人改，在 `HANDOFF.md` 写需求，不直接动手。
3. **用 fixture 解耦**：B、C 开发 skill 时不等 A 的调度器，直接 `pi -p --no-session -ns --skill skills/xxx "..."` 手动跑，输入用 `fixtures/`。A 开发调度器时用一个假 skill（`skills/echo`）验证。
4. **契约变更流程**：提出方在 `HANDOFF.md` 写 `[CONTRACT-CHANGE]` 条目 → schema 版本号 +1 → 受影响方确认后合并。不允许静默改字段。
5. **交接格式**（追加到 `HANDOFF.md`）：
   ```markdown
   ## 2024-01-15 B-data → C-media
   - 完成：recommend-themes v1，输出符合 contracts/themes.schema.json v1
   - 样例：fixtures/recommend-themes/output.json
   - 需要你：create-animation 读取 themes[].creationPlan
   - 已知问题：estimatedCost.budget 目前是估算值
   ```
6. **分支**：每个 AI 一个分支 `feat/a-core`、`feat/b-data`、`feat/c-media`，每个里程碑结束合并一次到 `main`，合并前跑全链路冒烟测试。

---

## 三、契约清单（第 0 周交付）

| 契约文件 | 生产者 | 消费者 | 内容要点 |
|---|---|---|---|
| `step-envelope.schema.json` | A | 全部 | 所有 output.json 的外壳：`status` `stepId` `runId` `artifacts[]` `error` |
| `raw-items.schema.json` | B | B | 统一数据 schema（设计文档 2.2 模块 1） |
| `dashboard.schema.json` | B | B、A | 看板文件，含 `sourceRef` 字段可跳原始数据（2.4） |
| `themes.schema.json` | B | C | 候选主题：理由、置信度、目标平台、预估成本（3.3） |
| `production.schema.json` | C | C | 成片清单：视频路径、封面、时长、标题/描述/标签草稿 |
| `publish-record.schema.json` | C | B、A | 发布记录，回写看板 2.2 |
| `token-ledger.schema.json` | A | B | 每步 token 与成本，供看板 2.3 |

---

## 四、里程碑计划

### M0 契约冻结（第 1 周前 2 天）· 三人并行
- A：`step-envelope`、`token-ledger`，目录骨架，`skills/echo`
- B：`raw-items`、`dashboard`、`themes` + fixtures
- C：`production`、`publish-record` + fixtures
- 验收：三人互审 schema，`fixtures/` 每个文件都能通过对应 schema 校验（`npm run validate:fixtures`）

### M1 单步可跑（第 1–2 周）
| AI | 任务 | 验收 |
|---|---|---|
| A | `run.sh` 生成、新终端拉起（macOS osascript / Linux / tmux 降级）、`attempt-n` 目录、退出码 + schema 双判定、指数退避重试 | `skills/echo` 失败 2 次后第 3 次成功，3 个 attempt 目录都保留 |
| B | `fetch-bilibili-hot`、`fetch-internal-metrics` 两个数据源插件 + 限速 + 缓存 | 手动跑 skill，输出通过 `raw-items` 校验；1 小时内重复调用命中缓存 |
| C | `generate-script`、`render-remotion`（1 个固定模板） | 读 `fixtures/themes` 产出 30 秒 mp4 + `production` 清单 |

### M2 流水线串联（第 3 周）
| AI | 任务 | 验收 |
|---|---|---|
| A | `pipeline.yaml` 解析、`depends_on` DAG、output→input 拷贝、`schedule.yaml` cron、任务状态写 `dashboard/task_status.json`、token 解析写 ledger | `opc run trends-analysis` 一条命令跑完整条 pipeline |
| B | `build-dashboard`（含 token/任务状态面板）、`recommend-themes`（外部 3 + 内部 3） | 看板每个指标都有 `sourceRef`；主题 6 条且字段齐全 |
| C | `publish-bilibili`：持久化浏览器 profile、扫码人工节点、预检（时长/大小/敏感词/标签数） | 扫码一次后，7 天内重复发布免扫码；预检失败不进入上传 |

### M3 闭环（第 4 周）· 联调为主
- C：发布记录写 `publish-record`；B：`fetch-internal-metrics` 读取发布记录拉取 24h/72h 数据
- A：人工审批节点（`manual_approval: true` 时暂停并通知，CLI `opc approve <runId>` 继续）
- 验收：**端到端冒烟**——定时触发 → 拉数据 → 看板 → 选题 → 成片 → 扫码发布 → 次日数据回到看板

### M4 扩展（第 5–6 周）· 三人并行
- A：简易 Web 看板页（只读 `dashboard/*.json`），并发上限与 token 预算熔断
- B：新增 YouTube/抖音数据源，验证"加一个插件不改调度"
- C：接入 hyperframes / hypit 作为可选渲染器，新增抖音发布器

---

## 五、依赖与关键路径

```
M0 契约 ──┬── A: 隔离执行器 ── A: pipeline/cron ──┐
          ├── B: 数据源 ── B: 看板 ── B: 选题 ────┼── M3 端到端
          └── C: 脚本 ── C: 渲染 ── C: 发布 ──────┘
```

- 关键路径：**C 的发布器**（平台页面不稳定、扫码依赖人工），最早开工、预留缓冲。
- A 在 M1 后是全组依赖：A 的执行器未稳定前，B/C 一律用手动 `pi -p` + fixtures，不阻塞。

---

## 六、每个 AI 的启动提示词

每个 AI 开工时在自己的新终端里启动 pi，第一句：

**A-core**
> 你是 OPC 项目的平台工程师。先读 `docs/OPC运营动画程序设计文档.md` 第二、四、五、七章和 `HANDOFF.md`。你只能修改 `scheduler/ config/ bin/ skills/echo/ contracts/step-envelope* contracts/token-ledger*`。当前里程碑见 `docs/3AI分工合作开发计划.md`。完成后在 `HANDOFF.md` 追加交接条目。

**B-data**
> 你是 OPC 项目的数据与策划工程师。先读设计文档模块 1–3 和 `HANDOFF.md`。你只能修改 `plugins/data-sources/ skills/fetch-* skills/build-dashboard skills/recommend-themes dashboard/` 及你负责的契约。用 `fixtures/` 自测，不要等调度器。完成后在 `HANDOFF.md` 追加交接条目。

**C-media**
> 你是 OPC 项目的创作与发布工程师。先读设计文档模块 4–5 和 `HANDOFF.md`。你只能修改 `plugins/publishers/ skills/create-* skills/render-* skills/publish-* templates/` 及你负责的契约。扫码步骤必须停下等人工，不要尝试绕过平台登录。完成后在 `HANDOFF.md` 追加交接条目。

---

## 七、风险与对策

| 风险 | 负责人 | 对策 |
|---|---|---|
| 平台无公开 API / 抓取违规 | B | 优先官方 API 与授权数据；抓取遵守 robots 与频率限制，插件层统一限速 |
| 发布页面改版导致脚本失效 | C | 选择器集中在 `publishers/*/selectors.json`；失败时截图 + 降级为人工发布 |
| pi 单步跑偏（不写 output.json） | A | schema 校验失败即判失败并重试；skill 内写明输出路径与格式 |
| Token 失控 | A | ledger 实时累计，超日预算 95% 暂停非发布类 pipeline |
| 契约频繁变更 | 全员 | 变更必须走 `[CONTRACT-CHANGE]`，每里程碑最多一次 |

---

## 八、完成定义（DoD）

每个任务合并前满足：
- 输出通过对应 schema 校验，`fixtures/` 已更新
- skill 能用 `pi -p --no-session -ns --skill <dir>` 单独跑通
- 日志写到 `logs/{runId}/{stepId}/`，不含密钥
- `HANDOFF.md` 已追加交接条目
