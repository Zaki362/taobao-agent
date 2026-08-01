# SceneCart AI 生产运行时与本地执行器

## 1. 架构目标

正式路径把云端产品与用户本机淘宝能力拆成两个安全边界：

1. Next.js 服务负责认证、Session、Agent 决策、任务入队和 SSE。
2. PostgreSQL 保存用户、购物会话、执行设备、任务、租约和事件。
3. 用户本机 `local-executor` 使用设备令牌领取属于该用户的任务。
4. 本地执行器调用 Qoder CLI 与已安装的淘宝 skill，并只把结构化结果回填服务端。
5. 用户确认规划后，浏览器只调用一次 `/api/agent/run`；服务端工作流在每个任务回填后自动决定并排队下一模块。
6. 浏览器通过 SSE 获得任务状态与推荐结果，短轮询只作为断线恢复兜底，不承担工作流编排。

执行设备会显式声明 `module_search` 与 `add_to_cart` 能力。设备默认只有搜索权限，加购权限必须在注册时显式开启；服务端领取任务时按能力过滤，设置页和发布就绪检查也分别验证搜索与加购能力，避免仅有心跳的设备被误判为完整购物链路可用。

设备注册后可以在设置页随时开启或关闭真实加购权限，不需要更换设备令牌。开启操作会再次要求用户确认；关闭后，设备不会再领取新的加购任务，商品搜索能力不受影响。

设备注册、权限变更和令牌撤销会写入独立审计事件。事件只包含设备 ID、设备名和能力变化，不保存令牌、淘宝账号或其他凭证；设置页与后端执行台都可以查看最近记录。

Qoder/Taobao 凭证和淘宝登录态始终保留在用户本机，服务端不读取订单、地址、手机号、聊天记录或账号身份资料。

正式产品模式只接受真实淘宝加购结果。开发预览可以显式保留产品内演示购物车，正式模式会在真实动作失败时返回失败并保留可重试状态，不会产生伪成功清单。

正式模式只允许 `local_executor` 执行外部购物工具。旧 Qoder 直连、Codex 宿主和 experimental bridge 即使被误配，也不会在正式运行时直接获得执行权；系统会安全收敛到持久任务队列，并由 readiness 报告配置错误。

`local_executor` 同时也是未配置 backend 时的默认值。安装 Qoder CLI 不会触发自动 provider 切换；手动 `/api/mcp/run` 调试端点默认关闭，production 无论环境变量如何配置都返回 404。

## 2. 服务端配置

正式环境至少配置：

```bash
SCENECART_PRODUCT_MODE=production
ALLOW_DEMO_CART_FALLBACK=false
RUNTIME_STORE=postgres
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/scenecart
DATABASE_SSL=true
DATABASE_POOL_SIZE=10
AUTH_REQUIRED=true
AUTH_SESSION_TTL_DAYS=30
SCENECART_CRON_SECRET=at-least-32-random-characters
SCENECART_RECOVERY_STALE_MS=180000
TAOBAO_EXECUTION_BACKEND=local_executor
DEEPSEEK_API_KEY=your-secret
DEEPSEEK_CHAT_MODEL=deepseek-chat
DEEPSEEK_REASONER_MODEL=deepseek-reasoner
```

执行 migration：

```bash
npm install
npm run db:migrate
npm run db:check
npm run check
npm run start
```

`db/migrations/001_production_runtime.sql` 会创建：

- `app_users`
- `auth_sessions`
- `shopping_sessions`
- `executor_devices`
- `agent_jobs`
- `execution_events`

`db/migrations/002_security_rate_limits.sql` 创建不保存邮箱或 IP 明文的认证限流表。migration runner 会保存每个 SQL 文件的 SHA-256 checksum；已执行 migration 被修改时会拒绝继续，必须新增 migration。

任务领取使用 PostgreSQL 事务和 `FOR UPDATE SKIP LOCKED`，支持多个执行器并发但不会重复领取同一任务。

## 3. 注册本地设备

1. 在 SceneCart AI 注册并登录。
2. 打开 `/settings/executor`。
3. 输入设备名并注册。
4. 立即保存页面只展示一次的 `SCENECART_DEVICE_TOKEN`。

服务端只保存令牌的 SHA-256 摘要。设备令牌不应提交 Git、写入前端代码或发送给模型。

本地开发可以将 `SCENECART_API_URL`、`SCENECART_DEVICE_TOKEN` 和 `QODERCLI_PATH` 写入被 Git 忽略的 `.env.local`。`executor:doctor` 与 `worker:local` 会自动读取该文件；正式设备建议使用系统密钥存储或进程管理器 Secret。

开发模式的 `RUNTIME_STORE=local` 默认会把设备令牌摘要、登录会话、任务队列和事件原子写入 `.data/runtime/local-runtime.json`，因此重启 Next.js 后已签发 Token 仍然有效。文件权限固定为当前用户可读写，且只保存 Token 摘要、不保存原始 Token；可用 `SCENECART_LOCAL_RUNTIME_PERSIST=false` 创建一次性测试运行时。该能力只改善本地开发体验，正式部署仍必须使用 PostgreSQL。

## 4. 启动本地执行器

在已安装 Qoder CLI、淘宝 skill 和淘宝桌面版的机器执行：

先将配置保存到项目根目录的 `.env.local`，避免 Token 进入 shell history：

```dotenv
SCENECART_API_URL=https://your-scenecart.example.com
SCENECART_DEVICE_TOKEN=your-one-time-device-token
QODERCLI_PATH=/Users/your-name/.local/bin/qodercli
```

再执行：

```bash
npm run executor:doctor
```

Doctor 会额外执行一次不调用淘宝工具的 Qoder headless 请求，用于提前识别 CLI 版本过旧或登录失效。若显示 `Qoder CLI 未登录`，先运行 `qodercli` 并输入 `/login`；若显示需要升级，运行 `qodercli update`。这两类配置错误会被标记为不可重试，避免真实任务重复消耗三次执行机会。

Doctor 只检查服务端、设备令牌和 Qoder CLI，不触发淘宝页面或账号动作。全部通过后启动：

```bash
npm run worker:local
```

Worker 启动时会再次执行无副作用的 Qoder headless 会话检查；只有 Qoder 登录、服务端健康、设备令牌和 `module_search` 能力都通过后，才会发送鉴权心跳并开始领取任务。Doctor 会打印令牌当前拥有的商品搜索 / 真实加购能力。因此设置页显示“在线”代表基础执行链路已通过，而不只是本地进程存在。

Worker、Doctor 和服务端使用统一的执行器协议版本。每次心跳、任务领取和结果回填都会携带协议版本；缺失或不兼容时服务端返回 `426 executor_protocol_mismatch`。升级网页服务后应同步更新本地项目并重启 Worker，旧进程不会继续领取新任务。

可选配置：

```bash
EXECUTOR_POLL_MS=2500
EXECUTOR_QODER_TIMEOUT_MS=180000
```

执行器每 15 秒发送心跳，并在有运行任务时续租。服务端明确拒绝续租时，Worker 会立即中止 Qoder 子进程；连续心跳失败达到 `EXECUTOR_LEASE_FAILURE_LIMIT`（默认 3）时也会 fail closed，避免失去任务所有权后继续执行真实淘宝动作或回填旧结果。任务完成结果会先写入 `.data/local-executor/results`，再回填服务端；若回执失败，租约恢复后会重放结果，不重复执行淘宝动作。

## 5. 任务生命周期

```text
pending -> leased -> running -> completed
                    -> pending (retry)
                    -> failed  (max attempts)
```

- `idempotency_key` 以会话、模块、搜索词和工作流运行 ID 为边界，阻止重复请求与重复回填造成同一任务重复入队。
- `lease_owner_id` 限制只有领取设备能续租和完成任务。
- 过期租约会自动返回 `pending`，达到最大次数后转为 `failed`。
- 完成接口可安全重放，已经完成的任务返回 `already_completed=true`。
- 只有 `pending` 任务可以由用户取消；已被执行器领取的任务不会伪装成可撤销。
- `completed` 任务始终幂等去重；`failed/cancelled` 任务只有在用户再次点击搜索、加购或执行台“重新入队”后才会清空旧错误并重置尝试次数。
- 搜索空结果和最终失败会写入模块搜索轨迹，Agent 会跳过该模块继续执行，不阻塞整条工作流。
- `agent_runtime.workflow_status` 保存 `running / waiting_for_tools / completed / paused / error`，同时记录运行 ID、当前模块和状态转换次数。
- 本地执行器完成或终态失败一个模块后，回填 API 会调用服务端 `workflow-runner`；即使浏览器已关闭，后续模块仍会串行入队。
- 重复提交已完成任务只返回 `already_completed=true`，不会再次触发 Agent 续跑。
- Worker 领取不到新任务时会检查本账号仍处于自动续跑状态的会话；独立 `worker:recovery` 或云端 Cron 也会扫描所有持久会话。若发现 Job 结果已持久化但 Session 尚未回填，系统只重放数据库结果并补排下一模块，不会再次执行淘宝动作。

## 6. Agent Runtime 2.0

平衡与探索档位会向 DeepSeek 请求 `decide_next_action`，允许模型在白名单内提议：

- `search_module`
- `retry_module`
- `skip_module`
- `wait_for_tools`
- `complete_workflow`

后端在执行前验证模块 ID、活跃任务、重复搜索、补搜关键词、可跳过条件、置信度和剩余工具预算。模型输出无效、低置信度、超时或超过预算时，系统自动使用确定性规则决策。工具调用权不直接交给模型。

模型路由按任务复杂度选择：没有候选或恢复证据的常规模块调度使用 `deepseek-chat`，候选偏薄补搜、模块失败恢复或真实价格产生预算压力时使用 `deepseek-reasoner`。两类决策分别受 `DEEPSEEK_AGENT_CHAT_TIMEOUT_MS` 和 `DEEPSEEK_AGENT_REASONER_TIMEOUT_MS` 约束，执行台会记录实际模型、fallback 原因和 P95 延迟。

`lib/agent/workflow-runner.ts` 是正式搜索阶段的推进器。它对单进程内同一 Session 做互斥，并依赖持久任务幂等键抵御重复入队；每次只允许一个淘宝模块任务处于等待执行状态。用户取消任务会关闭自动续跑，终态工具失败则记录错误、跳过当前模块并继续下一模块。`workflow-recovery.ts` 与受 `SCENECART_CRON_SECRET` 保护的 `/api/internal/workflow-recovery` 补偿“Job 已提交结果但续跑尚未触发”的进程中断窗口。

`RUNTIME_STORE=postgres` 时，每次推进还会获取基于 Session ID 的 PostgreSQL transaction-level advisory lock。锁内的 Session 读取、Agent 决策落盘、Job 创建和事件写入通过 `AsyncLocalStorage` 复用同一数据库 client，并在同一事务提交；竞争实例立即返回等待状态，不会重复创建下一模块。Executor 的成功、失败和取消回填也使用同一把锁，避免重复回执用旧 Session 快照覆盖下一步任务。锁不覆盖 Qoder/Taobao 的长时间执行；平衡/探索档位下只可能额外包含一次有界的 DeepSeek 下一动作判断，常规 chat 默认 8 秒、复杂 reasoner 默认 15 秒。

每个模块获得真实候选后，`market-feedback` 会基于有效价格样本计算模块预算压力、参考入手价和跨模块余量。该结果会进入下一动作 prompt：平衡/探索档位可以在候选整体超预算时提出一次未尝试过的性价比补搜词。预算调拨最多按模块预算的 15% 生成总额守恒的建议，始终标记为“需要用户确认”，不会静默改写已经确认的购物规划。

## 7. 运维与诊断

- `GET /api/runtime/health`：检查运行时与数据库连接。
- `GET /api/runtime/jobs?session_id=...`：查看当前会话任务。
- `GET /api/runtime/events/stream?session_id=...`：检查 SSE 事件。
- `GET /api/runtime/metrics?session_id=...`：检查积压、耗时、失败/取消数量、在线设备和分级运行告警。
- `GET|POST /api/internal/workflow-recovery`：内部恢复扫描端点，仅接受 `Authorization: Bearer $SCENECART_CRON_SECRET`。
- `/settings/executor`：查看设备、最后心跳和撤销令牌。
- `/hosted`：查看会话需求、Agent 决策、工具日志和候选回填状态。

应用已经对“有任务但无执行器”、队列等待过久、任务失败率、DeepSeek fallback 和 Guardrail 拒绝率生成会话级告警。正式环境仍应增加进程守护（systemd、launchd 或容器 supervisor），并把这些告警接入外部监控与通知渠道。

自托管环境运行 `npm run worker:recovery`，默认每 30 秒处理最多 5 个可恢复会话；云平台可每分钟调用一次内部恢复端点。PostgreSQL 会通过活动工作流部分索引定位扫描范围，先排除仍有健康运行 Job 的会话，再按最旧更新时间选出真正需要补偿的候选，避免普通会话数量超过 100 或健康任务长期占位造成扫描饥饿。单个异常 Session 的恢复失败会被隔离并计入 `failed`，不会阻塞同批其他会话。每次扫描会 UPSERT `runtime_service_heartbeats`；readiness 和执行台默认在 180 秒无新心跳后报告失联。两种方式都不会调用淘宝，只处理服务端持久状态。可用 `SCENECART_RECOVERY_INTERVAL_MS` 调整常驻 Worker 间隔，最小 10 秒；用 `SCENECART_RECOVERY_STALE_MS` 调整失联阈值。

仓库 `.github/workflows/quality.yml` 已提供 PostgreSQL 16 集成验证、migration 检查、advisory lock 竞争测试、单元测试、生产构建和端到端测试。正式发布应将该 workflow 设为主分支必需检查。

## 8. 验证

```bash
npm run test:unit
npm run test:e2e
npm run check
npm run release:audit
```

E2E 使用隔离的本地执行器模拟器验证认证、规划、持久任务、SSE、推荐回填与异步加购；测试会在首个模块排队后离开产品页，确认服务端仍可完成全部模块，再返回执行摘要由用户进入推荐。测试不会触发真实淘宝账号动作。
