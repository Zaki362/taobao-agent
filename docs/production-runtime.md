# SceneCart AI 生产运行时与本地执行器

## 1. 架构目标

正式路径把云端产品与用户本机淘宝能力拆成两个安全边界：

1. Next.js 服务负责认证、Session、Agent 决策、任务入队和 SSE。
2. PostgreSQL 保存用户、购物会话、执行设备、任务、租约和事件。
3. 用户本机 `local-executor` 使用设备令牌领取属于该用户的任务。
4. 本地执行器通过淘宝桌面版官方 Streamable HTTP MCP 调用搜索与加购工具，并只把结构化商品、淘宝链接和执行结果回填服务端；不经过 Qoder 或 CLI 子进程。
5. 用户确认规划后，浏览器只调用一次 `/api/agent/run`；服务端工作流在每个任务回填后自动决定并排队下一模块。
6. 浏览器通过 SSE 获得任务状态与推荐结果，短轮询只作为断线恢复兜底，不承担工作流编排。

执行设备会显式声明 `module_search` 与 `add_to_cart` 能力。设备默认只有搜索权限，加购权限必须在注册时显式开启；服务端领取任务时按能力过滤，设置页和发布就绪检查也分别验证搜索与加购能力，避免仅有心跳的设备被误判为完整购物链路可用。

设备注册后可以在设置页随时开启或关闭真实加购权限，不需要更换设备令牌。开启操作会再次要求用户确认；关闭后，设备不会再领取新的加购任务，商品搜索能力不受影响。

设备注册、权限变更和令牌撤销会写入独立审计事件。事件只包含设备 ID、设备名和能力变化，不保存令牌、淘宝账号或其他凭证；设置页与后端执行台都可以查看最近记录。

淘宝桌面客户端、MCP 会话和登录态始终保留在用户本机，服务端不读取订单、地址、手机号、聊天记录或账号身份资料。

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

正式模式采用 fail-closed 运行契约：即使误设 `AUTH_REQUIRED=false`，请求仍会被强制要求账号身份；即使误设 `AUTH_COOKIE_SECURE=false`，只要 `APP_ORIGIN` 是 HTTPS，登录 Cookie 仍会强制使用 `Secure`；如果未启用 PostgreSQL 或缺少 `DATABASE_URL`，会话、认证和任务仓库会直接拒绝读写，不会静默回退到本地开发存储。Readiness 仍会把这些被安全兜底的误配置标记为失败，必须修正环境变量后才能发布。

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

`db/migrations/002_security_rate_limits.sql` 创建不保存邮箱或 IP 明文的认证限流表；`003_workflow_recovery_index.sql` 增加工作流恢复扫描索引；`004_runtime_service_heartbeats.sql` 保存恢复 Worker / Cron 心跳；`005_executor_authentication_state.sql` 增加登录暂停状态；`006_job_lease_token.sql` 增加租约代次保护；`007_executor_mcp_availability_state.sql` 增加 `mcp_unavailable` 设备状态。migration runner 会保存每个 SQL 文件的 SHA-256 checksum；已执行 migration 被修改时会拒绝继续，必须新增 migration。`db:check` 除了校验所有 migration checksum，还会直接检查包括 `runtime_service_heartbeats` 在内的运行时实体表，防止表被意外删除但 migration 记录仍存在时产生假健康。

当前执行器协议为 **v3**。发布顺序必须是：先对目标数据库执行包含 migration 007 的 `npm run db:migrate && npm run db:check`，再部署 v3 服务端，最后更新本机项目并重启 Worker。Worker、Doctor 与服务端版本不一致时，心跳、领取或回填会以 `426 executor_protocol_mismatch` 失败；不要在旧 schema 上启动 v3 Worker。

任务领取使用 PostgreSQL 事务和 `FOR UPDATE SKIP LOCKED`，支持多个执行器并发但不会重复领取同一任务。

## 3. 注册本地设备

本地启动使用 `npm run dev`。启动器会同时检查 `127.0.0.1` 和 Next.js 默认 IPv6 监听地址；3000 被占用时自动选择后续可用端口，并打印准确 URL。注册设备和运行 `executor:configure` 时必须使用这个实际 URL。若需要稳定地址，可在 `.env.local` 设置 `SCENECART_DEV_PORT=3001` 与匹配的 `SCENECART_API_URL=http://127.0.0.1:3001`。显式配置的端口被占用时启动器会直接报错，不会静默把网页和 Worker 分流到不同端口。

默认 `npm run dev` 同时承担本地执行器管理：已有合法设备令牌时会等待 Web 健康后启动 `worker:local`；首次注册时可以保持命令运行，`executor:configure` 原子更新 `.env.local` 后，启动器会在数秒内发现令牌并接入 Worker。令牌不会输出到日志；启动器只维护一个 Worker，异常退出时按 1 秒起、最多 30 秒的指数退避自动重启，稳定运行后重置退避。纯网页调试或自动化测试使用 `npm run dev:web`，正式部署中的用户设备仍建议由 systemd、launchd 或容器 supervisor 独立运行 `worker:local`。

1. 在 SceneCart AI 注册并登录。执行器设备必须绑定账号；匿名访问设置页会安全跳转到登录页，成功后返回原设置页。
2. 打开 `npm run dev` 在终端打印的页面地址，再进入 `/settings/executor`；本地端口可能因占用自动变化。
3. 输入设备名并注册。
4. 立即保存页面只展示一次的 `SCENECART_DEVICE_TOKEN`。

服务端只保存令牌的 SHA-256 摘要。设备令牌不应提交 Git、写入前端代码或发送给模型。

本地开发推荐在项目目录运行 `npm run executor:configure`，按提示粘贴一次性令牌。命令不会回显令牌，会保留 `.env.local` 中的其他配置、原子写入执行器配置，并将文件权限设为 `0600`。`executor:doctor` 与 `worker:local` 会自动读取该文件；正式设备建议使用系统密钥存储或进程管理器 Secret。

开发模式的 `RUNTIME_STORE=local` 默认会把设备令牌摘要、登录会话、任务队列和事件原子写入 `.data/runtime/local-runtime.json`，因此重启 Next.js 后已签发 Token 仍然有效。文件权限固定为当前用户可读写，且只保存 Token 摘要、不保存原始 Token；可用 `SCENECART_LOCAL_RUNTIME_PERSIST=false` 创建一次性测试运行时。该能力只改善本地开发体验，正式部署仍必须使用 PostgreSQL。

## 4. 启动本地执行器

在已安装且启用 AI 应用授权的淘宝桌面版机器执行。正式本地执行器不需要 Qoder：

推荐先运行交互式安全配置，避免 Token 进入 shell history：

```bash
npm run executor:configure
```

命令会要求确认 SceneCart API 地址并隐藏输入设备令牌。若必须手动配置，则将以下内容保存到项目根目录的 `.env.local`：

```dotenv
TAOBAO_EXECUTION_BACKEND=local_executor
SCENECART_API_URL=https://your-scenecart.example.com
SCENECART_DEVICE_TOKEN=your-one-time-device-token
TAOBAO_NATIVE_MCP_URL=http://127.0.0.1:3654/mcp
TAOBAO_SOURCE_APP=SceneCartAI
EXECUTOR_TAOBAO_SEARCH_TIMEOUT_MS=60000
EXECUTOR_TAOBAO_CART_TIMEOUT_MS=60000
EXECUTOR_TAOBAO_AUTH_RECOVERY_POLL_MS=10000
EXECUTOR_TAOBAO_AUTH_PROBE_TIMEOUT_MS=10000
EXECUTOR_TAOBAO_READINESS_PROBE_TIMEOUT_MS=10000
EXECUTOR_TAOBAO_READINESS_BACKOFF_BASE_MS=2000
EXECUTOR_TAOBAO_READINESS_BACKOFF_MAX_MS=30000
```

再执行：

```bash
npm run executor:doctor
```

Doctor 会初始化官方本地 MCP 并检查工具列表、服务端和设备令牌，但不会主动搜索、打开详情页或触发账号动作。如果使用默认 `npm run dev`，配置令牌后 Worker 会自动接入；如果使用 `npm run dev:web`、正式远端服务或进程守护器，则显式启动：

```bash
npm run worker:local
```

Worker 先检查服务端健康、设备令牌、持久失败回执和 `module_search` 能力，然后以 `mcp_unavailable` 心跳进入淘宝就绪检查。它会按指数退避重复执行无副作用的 MCP `tools/list`；在工具未就绪期间保持进程存活、停止领取 Job，网页和执行台明确显示“等待淘宝桌面版工具恢复”。搜索设备必须检测到 `search_products` 与 `get_current_tab`；启用真实加购的设备还必须检测到 `get_product_skus` 和 `add_to_cart`。全部通过后设备才切换为 `online` 并领取任务。因此“Worker 进程存在”“MCP 重连中”和“真实搜索可用”是三个可区分的状态。

真实任务采用最小调用面：搜索使用淘宝 skill 默认的综合搜索路径 `all` 且每次用户确认只调用一次 `search_products`；加购先读取 `get_product_skus`，只有淘宝明确返回无规格或用户已完整选择有效规格时，才调用一次 `add_to_cart`。执行器不在搜索或加购前后调用 `get_current_tab`，因为淘宝桌面端在内部登录状态不同步时会让该工具主动跳转登录页；该工具只会在真实调用已经报告登录失败、Worker 进入鉴权暂停后用于低频检测登录是否恢复。Worker 在完整生命周期内复用同一个 Streamable HTTP `mcp-session-id`，仅在协议明确报告会话失效时重新初始化。退出时只清理本地会话引用，不向淘宝发送远端 `DELETE`；淘宝桌面端会按 TTL 回收旧会话，避免远端终止连带破坏购物 WebView 登录态。

MCP 传输不可达、工具层未加载或必需工具缺失会打开就绪熔断：Worker 切换为 `mcp_unavailable`，不再领取任务，并在每次新探测前重建 MCP 会话。未领取搜索保持 `pending`、尝试次数不增加；连接恢复并通过工具检查后自动继续队列。若真实工具返回登录错误，则进入更严格的 `authentication_required`：用户完成淘宝登录后无需重启 Worker，但登录恢复不会自动重试失败动作；网页保留已回填候选，并要求用户明确选择继续失败搜索或使用部分结果。真实加购在 MCP、Worker 或登录恢复后都不会自动重放，用户必须先确认淘宝购物车实际状态，再重新发起一次显式确认。

Worker、Doctor 和服务端使用统一的执行器协议版本。每次心跳、任务领取和结果回填都会携带协议版本；缺失或不兼容时服务端返回 `426 executor_protocol_mismatch`。升级网页服务后应同步更新本地项目并重启 Worker，旧进程不会继续领取新任务。

可选配置：

```bash
EXECUTOR_POLL_MS=2500
EXECUTOR_TAOBAO_SEARCH_TIMEOUT_MS=60000
EXECUTOR_TAOBAO_CART_TIMEOUT_MS=60000
EXECUTOR_TAOBAO_AUTH_RECOVERY_POLL_MS=10000
EXECUTOR_TAOBAO_AUTH_PROBE_TIMEOUT_MS=10000
EXECUTOR_TAOBAO_READINESS_PROBE_TIMEOUT_MS=10000
EXECUTOR_TAOBAO_READINESS_BACKOFF_BASE_MS=2000
EXECUTOR_TAOBAO_READINESS_BACKOFF_MAX_MS=30000
```

执行器每 15 秒发送心跳，并在有运行任务时续租。服务端明确拒绝续租时，Worker 会立即中止本地工具子进程；连续心跳失败达到 `EXECUTOR_LEASE_FAILURE_LIMIT`（默认 3）时也会 fail closed，避免失去任务所有权后继续执行真实淘宝动作或回填旧结果。任务完成结果会先写入 `.data/local-executor/results`，再回填服务端；若回执失败，租约恢复后会重放结果，不重复执行淘宝动作。

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
- 响应设备处于 `mcp_unavailable` 时不会领取任务；未开始的搜索保持原 `pending` Job，MCP 就绪后自动领取。`authentication_required` 仍必须由用户确认是否继续失败搜索；加购永不因连接恢复自动重放。
- 搜索空结果和最终失败会写入模块搜索轨迹，Agent 会跳过该模块继续执行，不阻塞整条工作流。
- `agent_runtime.workflow_status` 保存 `running / waiting_for_tools / completed / paused / error`，同时记录运行 ID、当前模块和状态转换次数。
- 本地执行器完成或终态失败一个模块后，回填 API 会调用服务端 `workflow-runner`；即使浏览器已关闭，后续模块仍会串行入队。
- 用户可通过 `/api/agent/pause` 请求协作式暂停：当前已领取模块仍允许完成并回填，但 `auto_continue=false` 会阻止下一模块入队。`/api/agent/resume` 会复用原 `workflow_run_id`、候选池和工具预算继续，不会重置整轮搜索。
- 重复提交已完成任务只返回 `already_completed=true`，不会再次触发 Agent 续跑。
- Worker 领取不到新任务时会检查本账号仍处于自动续跑状态的会话；独立 `worker:recovery` 或云端 Cron 也会扫描所有持久会话。若发现 Job 结果已持久化但 Session 尚未回填，系统只重放数据库结果并补排下一模块，不会再次执行淘宝动作。

## 6. Agent Runtime 2.0

平衡与探索档位会向 DeepSeek 请求 `decide_next_action`，允许模型在白名单内提议：

- `search_module`
- `retry_module`
- `skip_module`
- `wait_for_tools`
- `complete_workflow`

后端在执行前验证模块 ID、活跃任务、重复搜索、补搜关键词、可跳过条件、置信度和剩余工具预算。模型生成的 `keyword_override` 可以自主增加品牌、功能与价格带；若只漏写品类词，但筛选词能由当前模块策略解释且不含跨品类/指令内容，后端会补齐典型品类锚点并记录修复说明。其他情况仍必须原样通过模块锚点、URL、工具指令、命令行参数、控制字符与长度检查；`retry_module` 还必须已有首轮搜索轨迹。`product-matcher` 入队前继续执行严格校验，并覆盖候选复盘建议、规划主/备用词及用户手动编辑入口，因此修复能力不会绕过工具边界。模型输出无效、低置信度、超时或超过预算时，系统自动使用确定性规则决策，并把相应会话模型凭证标记为 Guardrail fallback。工具调用权不直接交给模型。

模型路由按任务复杂度选择：没有候选或恢复证据的常规模块调度使用 `deepseek-chat`，候选偏薄补搜、模块失败恢复或真实价格产生预算压力时使用 `deepseek-reasoner`。两类决策分别受 `DEEPSEEK_AGENT_CHAT_TIMEOUT_MS` 和 `DEEPSEEK_AGENT_REASONER_TIMEOUT_MS` 约束，执行台会记录实际模型、fallback 原因和 P95 延迟。

每个 Session 同时保留最多 120 条隐私安全模型调用凭证，Session 列表接口只返回最近 40 条。凭证不保存 Prompt、用户需求原文、商品摘要或模型输出，只记录能力任务、模型、真实成功/规则降级、耗时、降级原因和时间。执行台默认显示本次会话成功/降级摘要，详细时间线折叠展示；这与进程级 telemetry 互补，避免把其他用户或其他会话的成功调用误认为当前购物链路已经使用模型。

`lib/agent/workflow-runner.ts` 是正式搜索阶段的推进器。它对单进程内同一 Session 做互斥，并依赖持久任务幂等键抵御重复入队；每次只允许一个淘宝模块任务处于等待执行状态。用户取消任务会关闭自动续跑，终态工具失败则记录错误、跳过当前模块并继续下一模块。`workflow-recovery.ts` 与受 `SCENECART_CRON_SECRET` 保护的 `/api/internal/workflow-recovery` 补偿“Job 已提交结果但续跑尚未触发”的进程中断窗口。

候选回填采用增量证据池，而不是末次写入覆盖：每轮执行器结果会先与 Session 已有候选按 `product_id` 合并，保留更完整的价格、图片、店铺、链接、标签和风险字段，再对全部唯一商品重新生成稳妥 / 性价比 / 升级三档。候选池复盘读取的是合并后的最终池；轨迹分别记录本轮返回数、累计结果数和最终保留数。补搜失败时旧候选仍然可用，失败只写入本轮 attempt，不会把已有模块错误标记为空。

工作流结束时会生成持久化的 `completion_report`，按必需模块覆盖率、候选总数、候选池复盘、价格压力、无价格样本和容错跳过形成 `ready / partial / needs_attention` 结论。报告复用最终 DeepSeek Runtime 或规则决策的停止理由，并先用确定性组合算法生成预算安全兜底，再发起一次有界的 `compose_purchase_bundle` 调用：常规状态使用 chat，必需覆盖不足或存在预算压力时升级 reasoner。模型只能从已知候选 ID 中提案；后端再次验证每模块最多一件、总价不超预算、必需覆盖不低于兜底方案。超时、结构异常或 guardrail 拒绝都会直接保留规则组合，不阻塞工作流完成。重新搜索、调整规划、修改关键词或切换执行档位会立即使旧报告和组合失效。

用户可以显式调用 `/api/session/purchase-bundle` 采纳当前组合。请求只携带组合生成时间，商品 ID 由服务端从当前报告重建并再次核对候选标题、价格和模块归属，避免前端篡改。采纳结果写入独立的 `bundle_adoption` 待处理清单；真实、演示或异步执行器加购回填都会更新逐件进度。清单不会批量执行，任何真实加购仍需用户逐件确认；重新规划或重搜会同时清除完成报告和旧清单。

购买组合调用还会返回最多 3 条上下文调整建议，用于替代结果页完全固定的快捷按钮排序。模型只能从当前场景 `quick_actions` 白名单原样选择动作，只能引用当前规划模块，并且不能无依据建议“我已有某物品”等事实声明；结构、动作或模块越界会让本次提案整体降级到确定性建议。该能力复用现有组合调用，不额外增加一次模型等待，且所有调整仍需用户显式点击后回到规划确认页。

购物车确认页按来源隔离操作：`POST /api/cart/remove` 只接受用户显式确认并移除 `cart_source=demo` 的产品内演示项，同时重新计算 `bundle_adoption` 进度。真实淘宝项及缺少来源的历史条目一律 fail-closed，必须前往淘宝购物车管理；当前系统没有稳定、可限定到本产品商品的淘宝删除工具，因此不会把本地状态删除伪装成真实购物车删除。

`POST /api/cart/add` 在 Session 事务锁内完成最新状态读取、幂等任务创建和持久化，随后由本地 Worker 在锁外执行淘宝动作。用户连续确认多件商品或执行器同时回填时，不会因为旧 Session 快照覆盖而丢失另一件加购任务。

当报告存在未覆盖模块时，用户可以显式确认调用 `/api/agent/remediate`。服务端在 Session 锁内仅清理这些模块上一轮的失败、跳过和搜索轨迹，保留其他模块候选、预算与已选商品，然后创建新的运行 ID 继续持久工作流；该入口不能静默触发，也不会因候选偏贵而自动改预算。

当报告只有候选偏薄而不是模块空白时，同一 API 可使用 `scope=thin`。服务端为报告列出的薄弱模块选择未尝试过的新关键词，在对应 `module_review` 写入一次性 `user_confirmed_retry` 授权，不永久改变用户原有的保守/平衡档位。Agent 随后使用跨轮次候选池增量补搜；回填生成新复盘时该授权自然失效，避免一次确认被重复消费。

`RUNTIME_STORE=postgres` 时，每次推进还会获取基于 Session ID 的 PostgreSQL transaction-level advisory lock。锁内的 Session 读取、Agent 决策落盘、Job 创建和事件写入通过 `AsyncLocalStorage` 复用同一数据库 client，并在同一事务提交；竞争实例立即返回等待状态，不会重复创建下一模块。Executor 的成功、失败和取消回填也使用同一把锁，避免重复回执用旧 Session 快照覆盖下一步任务。锁不覆盖 Qoder/Taobao 的长时间执行；平衡/探索档位下可能包含一次有界的 DeepSeek 下一动作判断，常规 chat 默认 8 秒、复杂 reasoner 默认 15 秒；工作流收敛时还可能包含一次默认 12 秒上限的购买组合提案。两者失败都使用确定性结果继续，不等待淘宝工具执行。

`RUNTIME_STORE=local` 也使用进程内、按 Session ID 隔离的可重入锁队列：等待型事务会串行执行，Agent 推进使用非阻塞抢锁，超时等待者会安全退出队列。这样本机验收时并发回填、暂停/继续和加购不会互相覆盖；该锁只在单个 Node.js 进程内有效，因此多实例正式部署仍必须使用 PostgreSQL。

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

`/api/runtime/readiness` 会把 DeepSeek 配置状态与真实运行证据分开：`deepseek` 检查只确认 Key 和禁用开关，`deepseek_runtime` 则根据当前服务实例已经发生的调用元数据报告 `unverified / connected / degraded / unavailable`。它不发送额外探测请求，也不保存 Prompt、用户需求或模型正文；服务刚重启且尚无调用时显示“等待真实验证”，完成一次需求理解后才可能显示“已真实连接”。多实例部署时该摘要只代表响应请求的实例，正式集中监控仍应汇总各实例指标。

自托管环境运行 `npm run worker:recovery`，默认每 30 秒处理最多 5 个可恢复会话；云平台可每分钟调用一次内部恢复端点。PostgreSQL 会通过活动工作流部分索引定位扫描范围，先排除仍有健康运行 Job 的会话，再按最旧更新时间选出真正需要补偿的候选，避免普通会话数量超过 100 或健康任务长期占位造成扫描饥饿。单个异常 Session 的恢复失败会被隔离并计入 `failed`，不会阻塞同批其他会话。每次扫描会 UPSERT `runtime_service_heartbeats`；readiness 和执行台默认在 180 秒无新心跳后报告失联。两种方式都不会调用淘宝，只处理服务端持久状态。可用 `SCENECART_RECOVERY_INTERVAL_MS` 调整常驻 Worker 间隔，最小 10 秒；用 `SCENECART_RECOVERY_STALE_MS` 调整失联阈值。

面试使用 Vercel Hobby 且没有外部分钟级调度时，可以从运行淘宝桌面版的电脑临时启动完整本机侧：

```bash
npm run demo:cloud -- --url https://你的正式域名
```

启动器会先检查云端 production/PostgreSQL 契约和本机淘宝能力，再监督 `worker:local` 与 `worker:recovery`。它只用于面试预热到结束的短时窗口；不是生产守护进程，也不替代数据库 migration。若外部恢复调度已就绪，可显式加 `--skip-recovery`，避免重复的恢复心跳。

仓库 `.github/workflows/quality.yml` 已提供 PostgreSQL 16 集成验证、migration 检查、advisory lock 竞争测试、单元测试、生产构建和端到端测试。正式发布应将该 workflow 设为主分支必需检查。

## 8. 验证

```bash
npm run test:unit
npm run test:e2e
npm run check
npm run release:audit
```

E2E 使用隔离的本地执行器模拟器验证认证、规划、持久任务、SSE、推荐回填与异步加购；测试会在首个模块排队后离开产品页，确认服务端仍可完成全部模块，再返回执行摘要由用户进入推荐。测试不会触发真实淘宝账号动作。
