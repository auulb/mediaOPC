# HANDOFF 交接日志（只追加，不改写）

## M0 C-media → A-core, B-data（契约草案，待互审）
- 完成：`contracts/production.schema.json` v1、`contracts/publish-record.schema.json` v1（JSON Schema 2020-12，版本号在 `x-version`，实例里有 `schemaVersion`）
- 样例：`fixtures/render-remotion/output.json`、`fixtures/publish-bilibili/output.json`、`fixtures/publish-bilibili/output.precheck-failed.json`，已通过 ajv@8.17.1 + ajv-formats@3.0.1 校验
- 约定：产物路径一律相对仓库根目录（`data/productions/{productionId}/...`），因为调度器只拷贝 output.json，不拷贝 mp4
- 需要 B：`fetch-internal-metrics` 用 `publish-record.platformVideoId` + `publishedAt` 拉 24h/72h 数据；`status` 只有 `published` 时这几个字段才保证非 null
- 需要 B：提供 `fixtures/recommend-themes/output.json`，C 的 M1（generate-script）要读 `themes[].id / title / targetPlatform / creationPlan`
- 需要 A：(1) `npm run validate:fixtures`（根目录 package.json 归 A 管），把上面 2 个 schema 加进去；(2) 确认 `step-envelope` 是包在外层还是平铺字段，C 会照着调整 output.json
- 已知问题：`publish-record.error.code` 枚举是 C 自己定的，A 的重试策略如需映射到 `NETWORK_ERROR` 等可重试码，请回复

## 2026-10-24 A-core → B-data, C-media（M0 契约定稿 + M1 隔离执行器）
- 完成 M0：
  - `contracts/step-envelope.schema.json` v1（A 定稿）：skill 只把业务数据**平铺**写 `./output.json`（C 现有 fixtures 不用改）；调度器写 attempt 目录下的 `envelope.json`。
  - 可选：`./error.json` `{code,message,retryable,details}` 主动声明业务失败；`./artifacts.json` 数组 `[{path,kind,contract?,description?}]`。
  - `contracts/token-ledger.schema.json` v1：`data/token_ledger.jsonl`，每个 attempt 一行（失败也记账）。
  - `npm run validate:fixtures` 已可用（`node bin/opc validate-fixtures`）：自动加载 `contracts/*.schema.json`，按 fixture 目录名映射契约，只校验 `output*.json`；可用 `fixtures/<dir>/contract.json` 覆盖。
- 完成 M1：
  - `scheduler/lib/{executor,runscript,terminal,schema,usage,fixtures}.js`
  - `bin/opc`：`validate-fixtures` / `validate` / `run-step` / `attempts` / `config-check`
  - `skills/echo`（含失败注入，用于重试验收）
  - `config/{pipeline,schedule,token-budget}.yaml` 骨架
  - 新终端：macOS osascript、Linux gnome-terminal、tmux、spawn 降级；默认 `auto`，CI / 无头环境用 `--launcher spawn` 或 `OPC_LAUNCHER=spawn`
  - 判定成功 = 退出码 0 且 `output.json` 存在且通过契约；任何一项不满足都失败重试；`error.json` 优先于退出码
  - 每次 attempt 新目录，失败现场保留；`exit_code` 原子写；超时杀进程组
  - token 从 `events.jsonl` 的 assistant `message_end` 汇总，写 ledger
- 验收证据：
  - `npm test`：17/17 通过（fake pi：失败 2 次后第 3 次成功、3 个 attempt 保留、ledger 3 行、error.json 不重试、超时清理、密钥不落 run.sh）
  - `npm run validate:fixtures`：10 个 fixture 全过（含 C 的 production / publish-record，B 的 raw-items / dashboard）
  - 真实 pi：`node bin/opc run-step --skill echo --input fixtures/echo/input.json --launcher spawn --run-id real-echo-1` 成功；`real-echo-retry-1` 前两次 `OUTPUT_MISSING`、第三次成功，3 个 attempt 全保留
- 需要 C：
  1. `output.json` 平铺（按 production / publish-record 契约），不要包 `{status,data}`；C 现有 fixtures 已符合，无需改。
  2. 业务失败请写 `./error.json`。例：预检失败 `{code:"PRECHECK_FAILED",message:"...",retryable:false,details:{screenshot:"..."}}`；扫码超时 `{code:"LOGIN_TIMEOUT",retryable:false}`。不写 error.json 且退出码 0 时，调度器会认为步骤成功（即使 `publish-record.status=precheck_failed`）。A 不按 `publish-record.error.code` 名字做映射，只看 `error.json.retryable`；缺省时保留码可重试、其他码不重试。
  3. 产物路径按你们约定相对仓库根；`artifacts.json` 可选。
- 需要 B：
  1. 看板 token 面板读 `data/token_ledger.jsonl`（每 attempt 一行，字段见契约）；手动 `run-step` 的 `pipelineId` 为 `adhoc`。
  2. fixtures 目录名用 `fetch-*` / `build-dashboard` / `recommend-themes` 即可自动映射 raw-items / dashboard / themes；非 `output*.json` 的样例不参与校验；有 output 但目录名不识别时加 `fixtures/<dir>/contract.json`。
  3. 失败时写 `error.json`（`NETWORK_ERROR` / `API_RATE_LIMIT`，`retryable:true`）或非零退出，A 会重试。
- 已知限制 / 下一步（A）：
  - M2 才实现 `pipeline.yaml` DAG / `schedule.yaml` cron / `dashboard/task_status.json` / token 预算熔断；现在 `opc run-step` 只跑单步。
  - `opc attempts` 的中途失败不算 run 失败（按该 step 最后一个 attempt 判定）。
  - 敏感变量写 attempt 目录 `env.sh`（0600），不写 `run.sh` / 日志；`workspace/`、`logs/`、`data/` 已 gitignore。
- 待确认：如无异议，`step-envelope` 与 `token-ledger` v1 即视为冻结；有字段异议请走 `[CONTRACT-CHANGE]`。

## 2026-10-24 B-data → A-core, C-media

### 完成
- **M0 契约**：`contracts/raw-items.schema.json` v1、`contracts/dashboard.schema.json` v1、`contracts/themes.schema.json` v1；fixtures 全部通过 `npm run validate:fixtures`（11 个文件）。
- **M1 数据源**：`plugins/data-sources/{bilibili-hot,internal-metrics}.mjs` + `lib/base.mjs`（跨进程限速、1 小时文件缓存、错误码映射）、`lib/step.mjs`（按 step-envelope v1 写平铺 output.json / error.json / artifacts.json）。
- **skills**：`fetch-bilibili-hot`、`fetch-internal-metrics`、`build-dashboard`、`recommend-themes`（每个含 SKILL.md、input/output schema、validate 脚本）。
- **M2 看板**：话题热度/平台流量/榜单/自有表现/token/任务状态，全部指标带 `sourceRef`；写 `dashboard/{dashboard,external_trends,internal_performance,token_usage}.json`（`task_status.json` 只读，归 A）。
- **M2 选题**：`scripts/context.mjs` 压缩看板上下文，pi 负责 3 外部 + 3 内部主题，`scripts/validate.mjs` 强校验（数量、source 配比、evidence 指针必须能在看板中解析）。
- **测试**：`node --test plugins/data-sources/test/data-sources.test.mjs`（17 个）+ `node --test skills/build-dashboard/test/build.test.mjs`（10 个）全绿。
- **真实 API 冒烟**：B 站热门 3 条抓取成功；1 小时内二次调用 `cache.hit=true` 且 timestamp 不变；内部数据用真实 BV 号拉取成功。

### 交接样例（C-media 可直接用）
- `fixtures/recommend-themes/output.json`：6 条主题（3 external / 3 internal），字段含 `id/title/reason/evidence/targetPlatform/brief/estimatedCost/creationPlan`，已按 `contracts/themes.schema.json` 校验。
- `fixtures/fetch-bilibili-hot/output.json`、`fixtures/fetch-internal-metrics/output.json`：raw-items 样例。
- `fixtures/build-dashboard/output.json`：dashboard 样例，可作 `recommend-themes` 的 input。

### 需要 A-core
1. **pipeline 步骤契约名**：`fetch-*` 步骤建议显式声明 `contract: raw-items`；`build-dashboard` → `contract: dashboard`；`recommend-themes` → `contract: themes`。skill 自带 output schema 也能通过（`$ref` 用了契约 `$id`，已用 `scheduler/lib/schema.js` 验证）。
2. **build-dashboard 的多上游输入**：支持在 input.json 里给
   ```json
   { "params": { "upstream": ["fetch-bilibili", "fetch-internal"] } }
   ```
   它会按 `workspace/{OPC_RUN_ID}/{stepId}/attempt-*/output.json` 取 attempt 号最大的一份，无需调度器合并多路输入；也兼容显式 `rawItems` 路径。
3. **task_status.json 格式**：build-dashboard 接受数组、`{tasks:[...]}` 或 `.jsonl`；`status` 用 `success|failed|running|pending`。文件不存在时会用 token ledger 的 attempt 记录推导，不阻塞。
4. **npm scripts**（package.json 归 A）：把两条测试命令加入 `test` 或 CI：
   - `node --test plugins/data-sources/test/data-sources.test.mjs`
   - `node --test skills/build-dashboard/test/build.test.mjs`
5. **trends-analysis 建议步骤**：`fetch-bilibili`(fetch-bilibili-hot) → `fetch-internal`(fetch-internal-metrics) → `build-dashboard`(upstream 指向前两者) → `recommend`(recommend-themes，input 用 build-dashboard 的 output.json)。
6. `fixtures/token-ledger/token_ledger.jsonl` 是给看板算 token 用的样例，保留别删。

### 需要 C-media
1. **发布记录落盘**：`fetch-internal-metrics` 默认读 `data/publish_records.jsonl`（每行一个 publish-record）。请在发布成功后追加一行（或提供 `recordFiles` 路径），字段用 `platformVideoId` + `publishedAt`。
2. 只有 `status=published` 且 `platformVideoId` 非空才会拉数据；`precheck_failed` 等会被跳过并写入 `warnings`。
3. `fixtures/recommend-themes/output.json` 已就绪，`generate-script` 可直接用；`creationPlan` 里 render 工具统一写 `remotion`。

### 契约变更记录
- `[CONTRACT-CHANGE]` `contracts/themes.schema.json`：`themes[].id` 的 pattern 从 `^theme_[0-9]{8}_[0-9]{3}$` 放宽为 `^theme_[A-Za-z0-9_]+$`，兼容 C 已写的 `theme_001`。M0 草案期调整，仍为 v1。

### 已知问题
- `internalPerformance.episodes[].tokensSpent/roi` 暂为 `null`：token ledger 没有 themeId，无法把 token 可靠归因到单条视频；等 A 在 ledger 增加 `themeId`（或 pipeline 传递）后再补。
- 首次运行没有上一版看板时 `growth` 为 `n/a`；B 站热门接口不返回 tags，话题暂用分区名 + 过滤后的推荐语。
- 热门 100 条需翻 2 页，插件层限速 3s/次；建议 pipeline 里该步 timeout ≥ 60s。

### 补充：B-data → C-media（schema 互操作问题）
- `skills/generate-script/schemas/input.schema.json` 现在同时有 `$id: "opc://skills/generate-script/input.schema.json"` 和 `$ref: "opc/themes.schema.json"`。用 A 的 `scheduler/lib/schema.js`（ajv）会把它解析成 `opc://skills/generate-script/themes.schema.json` 而报 `can't resolve reference`。
- 修复方式（二选一）：删掉该文件的 `$id`；或把 `$ref` 写成契约 `$id` 的绝对形式。B 侧 `skills/*/schemas/*.schema.json` 都没写 `$id`，用同样的 `$ref` 已通过 A 的 validator 验证。

### 补充：给 A 的 pipeline 静态输入（可直接 `input:` 引用）
- `fixtures/fetch-bilibili-hot/input.pipeline.json` → `{"params":{"limit":50}}`
- `fixtures/fetch-internal-metrics/input.pipeline.json` → `{"params":{}}`（默认读 `data/publish_records.jsonl`）
- `fixtures/build-dashboard/input.pipeline.json` → `{"params":{"upstream":["fetch-bilibili","fetch-internal"],...}}`，runId 自动读 `OPC_RUN_ID`
- 这三个文件名以 `input.` 开头，不会被 `validate:fixtures` 当输出校验。

### 补充：内部数据窗口快照（M3 用）
- `fetch-internal-metrics` 每次真实抓取会追加一行到 `data/internal_metrics_snapshots.jsonl`（`ts/publishId/window=0h|24h|72h|7d/hoursSincePublish/views/likes/comments/shares/favorites`）；`snapshot:false` 可关闭。
- 当前 `raw-items` 与看板仍只取最新一次；M3 的 24h/72h 对比可直接读这个快照文件，无需重新抓取历史。
- 测试更新：`node --test plugins/data-sources/test/data-sources.test.mjs`（18 个）、`node --test skills/build-dashboard/test/build.test.mjs`（10 个）、`node --test skills/recommend-themes/test/validate.test.mjs`（4 个）。

### 修正（测试数量）
- `data-sources` 18 个、`build-dashboard` 11 个（含冷启动 sourceRef 用例）、`recommend-themes` 4 个测试全部通过。
- 冷启动没有任何自有内容时，`internalPerformance.avgEngagement.sourceRef` 仍指向内部 raw-items 或 token ledger，不会出现空 sourceRef。

## 2026-10-24 A-core → B-data, C-media（M2 pipeline / cron / task_status）
- 完成：
  - `scheduler/lib/pipeline.js`：解析 `config/pipeline.yaml`、`depends_on` DAG（环 / 缺失依赖 / 重复 id 在启动前报错）、顺序执行、`continue_on_error`、写 `workspace/{runId}/run.json`。
  - input 规则（按优先级）：
    1. `step.input` 静态路径：原样拷贝；若文件内含 `{{steps.<id>.output}}`，替换为依赖产物绝对路径（JSON 模板，给 build-dashboard 这类按路径读文件的 skill 用）。
    2. 无 `input` + 1 个依赖：直接把该依赖的 `output.json` 作为本步 input。
    3. 无 `input` + 多个依赖：合并为 `{ "<depId>": <dep output>, ... }`，写到 `workspace/{runId}/_inputs/<step>.json`。
    4. 无依赖无 input：`{}`。
  - `scheduler/lib/cron.js`：标准 5 段 cron（`*`、`a-b`、`a,b`、`*/n`、`a-b/n`、英文月/周），本地时区；`enabled: true` 才触发；同 schedule 同分钟去重；`dependencies` 未 success 则跳过；`manual_approval` 当前只记 `pending_approval`，不执行（M3 做 approve）。
  - `scheduler/lib/taskstatus.js`：A 写 `dashboard/task_status.json`，`tasks[]` 含 `runId/pipelineId/stepId/skill/status/attempt/tokens/costUsd/output/error`，status 为 `pending|running|success|failed|skipped`；B 的 build-dashboard 已能读取。
  - `bin/opc` 新增：`run <pipeline>`、`pipelines`、`cron-tick [--now]`、`start [--once] [--interval 秒]`；`run-step` 也会写 task_status。
  - 配置：`config/pipeline.yaml` 新增 `echo-chain`、`echo-fail`、`trends-analysis`；`config/inputs/build-dashboard.json`；`config/schedule.yaml` 新增 disabled 的 `daily-trends-analysis`。
  - 修复：`--pi-bin` 相对路径解析；input 模板替换时按 JSON 字符串转义路径。
- 验收证据：
  - `npm test`：31/31 通过（含 pipeline DAG、模板、失败 skipped、cron 匹配/去重/依赖、task_status）。
  - `node bin/opc run echo-chain --launcher spawn --pi-bin scheduler/test/fixtures/fake-pi --run-id cli-chain-3`：2 步成功，后一步 input 等于前一步 output；`run.json` / task_status 落盘。
  - `node bin/opc run trends-analysis --launcher spawn --run-id real-trends-1`：真实 pi 跑通 3 步（fetch-bilibili 10403 tokens、fetch-internal 21285、build-dashboard 25858），dashboard 产出 topics=3 / items=3 / episodes=1，task_status 与 ledger 同步写入。
  - `cron-tick --now 2026-10-24T09:00:00` 跑一次；同分钟再跑 0 次；`opc start --once` 在无 enabled schedule 时退出 0。
  - 真实 pi 的 `real-echo-retry-1`：前两次 `OUTPUT_MISSING`、第三次成功，3 个 attempt 全保留。
- 需要 B：
  1. `build-dashboard` 的 `params.upstream` 已可直接用：调度器按步注入 `OPC_RUN_ID`，示例见 `config/inputs/build-dashboard.json`。A 不写 `dashboard/*.json`（只写 `dashboard/task_status.json`）。
  2. 如需按路径读上游产物，用 `{{steps.<id>.output}}` 模板；多依赖默认合并对象。
  3. `task_status` 目前包含 A/C 的真实 smoke run；A 已移除本轮 fake 的 `cli-chain-*` 记录，未清 `data/token_ledger.jsonl`（避免影响 C 的真实记录）。B 重建 dashboard 时会读到最新状态。
  4. `fetch-*` 业务失败继续写 `error.json`（`retryable:true` 才重试）。
- 需要 C：
  1. 每步可用 `OPC_RUN_ID` / `OPC_STEP_ID` / `OPC_ATTEMPT`；`output.json` 保持平铺；预检/扫码失败写 `error.json`，不要只靠退出码。
  2. pipeline 顺序执行；长渲染把 `timeout` 设足；`continue_on_error: true` 可让后续独立步骤继续。
  3. 发布步骤可先配 `manual_approval: true`；当前 cron 只记 `pending_approval` 不执行，`opc approve <runId>` 在 M3 实现。
- 已知限制 / 下一步（A）：
  - M2 顺序执行，无并发上限；token 预算熔断（M4）、`opc approve`（M3）未做。
  - 自研 cron 仅标准 5 段、本地时区，不依赖 node-cron。
  - `opc attempts` 仍逐个 attempt 展示，step 最终结果以最后一条 / `run.json` 为准。

## M1 C-media → A-core, B-data（创作链 + 发布预检已跑通）
- 完成：
  - `skills/generate-script/`：pi 写 `draft.json`（标题/标签/口播稿/分镜），`scripts/assemble.mjs` 校验分镜时长与 `themes[].brief.durationSec` 偏差 ≤20%，产出 = render 的输入；附 `schemas/output.schema.json`（自包含，调度器可直接校验）
  - `skills/render-remotion/` + `templates/remotion/`：`remotion/explainer-30s` 固定模板，输出 1920x1080/30fps mp4 + 封面，ffprobe 实测参数，产出 `production`
  - `skills/publish-bilibili/` + `plugins/publishers/`：B 站预检（时长/大小/分辨率/标题/标签/敏感词/封面，按原始值判定、按裁剪值提交）+ Playwright 持久化 profile 上传，扫码为唯一人工节点
- 验收证据（均通过 A 的 `StepExecutor` + 真实 `pi`）：
  - `workspace/m1-pi/render-remotion/attempt-1/`：status=success，`production` 契约通过，产物 `data/productions/prod_20261024_theme_001_m1-pi/{final.mp4,cover.jpg,storyboard.json}`
  - `workspace/m1-pi-gen/generate-script/attempt-1/`：status=success，AI 原创脚本 30s，产物 `data/scripts/m1-pi-gen/theme_001/{script.md,storyboard.json,themes.json}`
  - `workspace/m1-pi-pub3/publish-bilibili/attempt-1/`：12 个标签的输入 → 退出码 2、`error.code=PRECHECK_FAILED`、`retryable=false`，**未启动浏览器、未上传**
- 需要 A：
  1. `config/pipeline.yaml` 里三步分别声明 `contract`：`render-remotion → production`、`publish-bilibili → publish-record`、`generate-script` 不写 contract（用 skill 自带 `schemas/output.schema.json`）。`publish-*` 建议 `manual_approval: true`
  2. 确认重试语义：skill 通过 `error.json` 声明的 `PRECHECK_FAILED` / `LOGIN_TIMEOUT` / `SELECTOR_NOT_FOUND` 都是 `retryable=false`，不要在调度器侧覆盖成重试
  3. 建议 `.gitignore` 加 `p*.md`：pi 会话导出文件落在仓库根目录，已多次被 skill 内 agent 当资料读到，污染上下文
- 需要 B：
  1. `fixtures/recommend-themes/output.json` 仍未提供，C 用 `fixtures/generate-script/input.json` 自测；B 交付后我会改接
  2. `themes[].brief.durationSec` 是 C 的硬依赖（分镜时长校验），缺失或与实际创作计划不符会导致 `DURATION_MISMATCH`
- 契约使用说明（C 侧已按 A 的最终版实现）：
  - skill 只写业务数据到 `output.json`（`production` / `publish-record` 平铺），另写 `artifacts.json`；`envelope.json` 由调度器写
  - 失败写 `error.json`（`{code,message,retryable?}`），不伪造 output.json
- 已知问题 / 待验证：
  - **B 站真实上传未验证**：本机无可用账号，只跑通了预检与失败路径；选择器取自当前投稿页结构，首次真机发布需人工校准 `plugins/publishers/bilibili/platform.json`
  - playwright 依赖在 `plugins/publishers/package.json`（独立 package），需 `npm install` + `npx playwright install chromium`
  - 一次 SKILL.md 写得太松导致 pi 自行翻仓库 19 轮、烧 50 万 token（见 `data/token_ledger.jsonl` 中 runId=m1-pi-pub）；已收紧为“只允许一条命令 + 禁止探索”，同场景降到 1.2 万 token。建议 A 在 token 预算熔断里加“单步 >10 万 token 告警”

### M2 追加（B 的 5 点需求 + 完整 4 步链路）
- 按 B 的建议更新 `config/pipeline.yaml` 的 `trends-analysis`：`fetch-bilibili` / `fetch-internal` 显式 `contract: raw-items`，`build-dashboard` → `dashboard`，新增 `recommend`（`recommend-themes`，`contract: themes`，依赖 `build-dashboard`，无 input，自动用 dashboard output）。
- `build-dashboard` 使用 B 提供的 `fixtures/build-dashboard/input.pipeline.json`（`params.upstream`），调度器注入 `OPC_RUN_ID`，已验证可直接发现上游产物。
- 真实 pi 全链路 `node bin/opc run trends-analysis --launcher spawn --run-id real-trends-2`：
  - 4/4 步 success（fetch-bilibili / fetch-internal / build-dashboard / recommend）；
  - themes 输出 6 条：3 external + 3 internal，id 为 `theme_20261024_001..006`；dashboard topics=3 / items=3 / episodes=1；
  - `run.json`、`dashboard/task_status.json`、`data/token_ledger.jsonl` 均已写入。
- `npm test` 已合并 B/C 的测试（A 33 + B 18+11+4 + C 2+6 = 74），全部通过；提供 `test:core` / `test:data` / `test:skills`。
- 额外修复：`runId` / `pipelineId` 路径字符校验；`opc attempts` 跳过 `_inputs/`；daemon 单次 tick 异常不退出。
- B 的 5 点：1 显式 contract 已加；2 upstream 已通；3 task_status 已通；4 npm test 已合并；5 recommend 步骤已加。

### M2 追加（回应 C 的 token 失控）
- `scheduler/lib/executor.js` 新增单步 token 告警：默认 `DEFAULT_STEP_TOKEN_WARN=100000`，超过只写 `WARN` 到 `logs/{runId}/{stepId}/step.log.jsonl`，不判失败、不熔断；pipeline step 可用 `tokenWarn` 覆盖。
- `config/token-budget.yaml` 增加 `stepWarnTokens: 100000`；真正的日预算熔断仍在 M4。
- 测试：单步 token 超阈值只告警用例已加；`npm test` 现在 **75/75**（A 34 + B 33 + C 8）。

## M1 补充 C-media → A-core（发布安全开关 + 两个实测事故）
- **必须让 A 配的 env**：`publish-*` 步骤需在 `pipeline.yaml` 的 `env` 里加 `OPC_PUBLISH_ENABLED`。未设置时 `publish.mjs` 只做预检、不启动浏览器，直接以 `UNKNOWN`（retryable=false）失败。生产流水线设 `OPC_PUBLISH_ENABLED=1`；本地联调不要设
- 事故 1（已修）：投稿页初始没有 file input，需先点“上传视频”按钮才出现。原实现直接找 `input[type=file]`，导致扫码成功后卡在“找不到标题输入框”，降级 `manual_fallback`。**未提交任何稿件**
- 事故 2（已修）：`publishId` 原来只由 productionId 派生，同一生产重发会撞 ID；改为 productionId 指纹 + 时间后缀
- 实测情况：本机浏览器 profile 在 2026-10-24 09:39 由人工扫码登录成功（`data/browser-profiles/bilibili` 已存 SESSDATA）。真实上传→投稿这一步仍未被我验证，首次真机发布请人工盯一次
- 建议 A：token 预算熔断里加“单步 >10 万 token 告警”，并考虑对 `publish-*` 单独设上限（它不需要创作，正常 1 万 token 内）
- 测试入口（C 侧，未接入 A 的 npm test）：
  - `node --test skills/generate-script/test/schema-parity.test.mjs`
  - `cd plugins/publishers && node --test test/precheck.test.mjs`

## M2 C-media 全链路联调完成（2026-10-24）
- 新增 `plugins/publishers/pipelines/create-video.yaml` + `run-create-video.sh`：script → render → publish 三步，用 `--pipeline-config` 加载，**未改 A 的 `config/pipeline.yaml`**。A 若要并进主配置，把 `create-video` 段整体粘过去即可（`env: [OPC_PUBLISH_ENABLED]` 请保留）
- 实测（真实 pi + 真实 B 站热门）：
  - `opc run trends-analysis --run-id demo-trends-1`：4/4 success，产出 6 条主题（含 `brief.durationSec` 30–60s）
  - `opc run create-video --run-id demo-video-2`：3/3 success；45s / 1920x1080 / 30fps / 1.03MB 成片；publish 记录 `manual_fallback + PUBLISH_DISABLED`（预检 7 项全过、未上传）
  - 总 token：trends 17.9 万、create-video 5.2 万（写稿 4.1 万 + 渲染 0.2 万 + 发布 1.2 万）
- 两个 bug（已修，影响面见下）：
  1. `contracts/publish-record.schema.json` 的 `if/then` 未写 `required: ["status"]`，导致**缺 status 时所有 then 分支同时命中**（误报 published 缺 url 等）。已加 required；新增 `plugins/publishers/test/record.test.mjs` 10 条用例锁死 6 种状态 + 缺 status
  2. `STATUS.manual_fallback` 实际键名是 `manualFallback`，导致发布记录缺 `status` 字段、被调度器判 `OUTPUT_INVALID` 并重试 3 次。已修，并用测试覆盖
- 契约增量（向后兼容，消费方无需改）：`publish-record.error.code` 增加 `PUBLISH_DISABLED`；语义=预检通过但未启用真实投稿，`status=manual_fallback`，**退出码 0**（调度器显示绿色，但记录明确未上传）。请 B 在 `fetch-internal-metrics` 里忽略非 `published/submitted` 的记录
- 文档：`docs/使用教程.md`（准备/一条命令出片/真发布/定时/排障/产物地图）
- 测试：`npm test` 现在 85/85（A 34 + B 33 + C 18）
- 仍需 A：把 `publish-*` 的 `OPC_PUBLISH_ENABLED` 写进生产环境的 env（daemon 启动时导出）；`manual_approval` 已在 cron 侧支持，发布类 schedule 建议开启

## M3 Web 控制台（2026-10-24，C 侧新增，未改 A/B 代码）
- 新增 `webui/`：`./webui/start.sh` → http://127.0.0.1:4180 ，把「抓数据+选题」「一键出片」「冒烟 ×4」做成按钮
- 实现方式：`POST /api/run` 调 `spawn(node bin/opc run … --launcher spawn --verbose)`；SSE 解析 `[run] step_start/step_end` 做进度；`/media` 带 Range 直接 `<video>` 播成片
- 业务选项：选题文件（写回 `data/themes/latest.json`）、指定主题（注入 `OPC_THEME_ID`）、真实投稿（注入 `OPC_PUBLISH_ENABLED=1` + 输入「投稿」二次确认）
- 安全：只监听 127.0.0.1；`/media` 白名单排除 `data/browser-profiles/`（登录 cookie）；拒绝路径穿越；同一时间只允许一个 run；停止按钮杀整个进程组
- 实测：UI 触发的 `create-video` 全程 63s / 51.5k token，指定 theme_003 生效，成片 30s/1920x1080/662KB，发布记录 `manual_fallback + PUBLISH_DISABLED`
- 测试：`node --test webui/test/api.test.mjs` 8/8
- 需要 A：
  1. 把 `webui/test/*.test.mjs` 加进根 `package.json` 的 test glob（现在 93 条里少了这 8 条）
  2. 若生产要用网页触发真发布，daemon 侧同样需要导出 `OPC_PUBLISH_ENABLED`
  3. `DURATION_MISMATCH`、`PUBLISH_DISABLED` 等新增 error code 请同步进 A 的错误码文档
- 文档：`docs/使用教程.md` 新增第 0 节（网页点按钮），`webui/README.md` 说明 API 与安全边界

## M4 Web 制作台改版：五段式界面 + 人工确认 + 竖版封面（2026-10-24，C 侧）
- `webui/` 由「一个运行控制台」改成五个页签：数据接口 / 数据看板 / 选题引擎 / 创作引擎 / 发布引擎（hash 深链 #sources #dashboard #topics #create #publish）
- 新增 API：`/api/data`（看板+原始样本+博主聚合+定时计划）、`/api/topics`（外部3+内部3+主题库使用状态）、`/api/productions`、`/api/create/draft|script|render`、`/api/publish`
- 创作引擎改为三段式：写稿（run-step）→ 人工确认（口播稿/标题/简介/标签/分镜可改，5 秒倒计时自动下一步，输入即暂停）→ 渲染；改动写 `workspace/<runId>/edit/`，不覆盖原始 step 产物
- 渲染新增竖版封面 9:16（Remotion composition `cover-portrait`）：`data/productions/<id>/cover-portrait.jpg`，production 契约新增**可选**字段 `coverPortrait`（向后兼容，旧 fixture 仍通过）
- 发布引擎：成片列表 + 7 项预检可视化 + 投稿信息编辑 + 发布历史；「只跑预检」永不注入 `OPC_PUBLISH_ENABLED`（显式置空，防继承）
- 实测：UI 内 theme_20261024_003 → 写稿 → 5 秒自动渲染 → `prod_..._create-20261024-211127`（30s / 1920x1080 / 635KB / 双封面）→ 预检 7/7 通过 → `manual_fallback + PUBLISH_DISABLED`
- 测试：`node --test webui/test/api.test.mjs` 13/13；`npm test` 85/85 不变
- 需要 B：
  1. 抖音 adapter 与「同赛道博主榜」——现在 数据接口/看板 明确显示为缺口，只有 B 站 Top3 样本
  2. `fetch-bilibili` 的 limit 可从 3 提到 10+，否则博主维度样本太薄
- 需要 A：`webui/test/*.test.mjs` 进根 test glob（+13 条）；`schedule.yaml` 目前全 disabled，看板已展示
- 仍未做：B 站封面上传（只准备横/竖两张图，投稿页封面仍由平台自动截帧）；真实投稿仍需人工扫码验证

## M5 数据接口（禁止 AI）+ 手动 Cookie + 定时定点（2026-10-25，C 侧）
- 新增第六个页签「定时定点」（发布引擎之后，hash `#schedule`）：定点设置（启用 / 分区 / 条数 / 关键词 / 多个 HH:MM / 星期）、下次执行、上次结果、调度器状态、最近运行记录
- **数据接口 + Cookie 区域明确「不使用 AI」**：页面顶部有绿色说明条；抓取只 `spawn(node skills/<skill>/scripts/run.mjs)`，不经过 pi、无 prompt、无 token
- 数据接口新增两块卡片：
  1. Cookie（手动填写）：只接受人手粘贴（必须含 `SESSDATA`），写 `data/secrets/bilibili-cookie.txt`（目录 0700 / 文件 0600）；`/api/cookie` 只回 `configured/bytes/savedAt/hasSessdata`，**永不回显原文**；`data/secrets/` 不在 `/media` 白名单
  2. 知识区最新视频：`tid` 可选知识（36）/ 科学科普（201）/ 人文历史（228）等 9 个分区；条数、补抓播放/点赞、关键词筛选
- 新增插件 `plugins/data-sources/bilibili-knowledge.mjs`（id `bilibili-knowledge`，缓存 5 分钟）：
  - `mode=latest` 走 `x/web-interface/newlist`（按 pubdate 倒序 = 知识区最新），`mode=ranking` 走 `ranking/v2`（易 -352）
  - newlist 的 `stat` 恒为 0 → 逐条 `x/web-interface/view` 补播放/点赞（默认 8 条，连续失败 2 条即停止并写 warning）
  - 翻页会因新投稿顶位产生重复 → 按 bvid 去重；关键词为**纯字符串匹配**（中文 substring / ASCII 词边界，避免 "AI" 命中 "email"），不调用任何模型
- 新增 skill `skills/fetch-bilibili-knowledge/`（SKILL.md + input/output schema + `scripts/run.mjs` + `validate.mjs`），fixture `fixtures/fetch-bilibili-knowledge/output.json`（真实抓取样本），`validate-fixtures` 12/12
- Cookie 安全：`plugins/data-sources/lib/cookie.mjs`；`base.mjs` 的 `stripControl` 现在剔除 `cookie/cookieFile`，Cookie 不进 `output.json.params`、不进缓存 key、不进日志
- 定时定点实现（不碰 A 的 scheduler）：webui 进程内 20s tick，命中「星期 + HH:MM」且同一分钟未跑才触发；状态落 `data/schedule/{jobs.json,state.json,runs.jsonl}`；页面 SSE 收 `done` 自动刷新
- 新增 API：`GET/POST/DELETE /api/cookie`、`POST /api/fetch/knowledge`、`POST /api/fetch/hot`、`GET/POST /api/schedule`、`POST /api/schedule/run`；`/api/data` 增补 `cookie` 与 `zones`
- 数据接口页不再有「跑完整 AI 流水线」按钮（挪到数据看板 / 选题引擎），页内只剩确定性抓取：`POST /api/fetch/hot` 与 `POST /api/fetch/knowledge` 共用 `runDirectFetch()`（单飞、SSE 日志、写 `data/sources/`）；`sourcesView()` 按 dataSource 去重（保留时间最新的一份）
- 测试：`npm test` 108/108（新增 knowledge 8 条 + webui Cookie/定时 2 条；`webui/test/*.test.mjs` 已并入根 test glob，共 15 条）
- 实测：知识区 latest 抓 20 条 7.0s；关键词 `AI` 60→3 条；定时保存后下一次 07:30 生效；手动「立即执行一次」写入 runs.jsonl
- 已知限制 / 后续：
  1. `newlist` 按分区标签返回，知识区里混有少量「游戏/影视解说」投稿（平台分类所致），需要更高信噪比时用 `mode=ranking` + 手动 Cookie，或收紧 `keywords`
  2. `-352` 只能人工粘 Cookie 解决（这是设计约束，不做自动登录/自动重试刷接口）
  3. 定时依赖 `webui/server.mjs` 常驻（关闭服务即停）；目前只维护单个 job，多 job 需要给 `jobs.json` 换数组结构
