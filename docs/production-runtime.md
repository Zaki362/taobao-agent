# SceneCart AI 生产运行时与本地执行器

## 1. 架构目标

正式路径把云端产品与用户本机淘宝能力拆成两个安全边界：

1. Next.js 服务负责认证、Session、Agent 决策、任务入队和 SSE。
2. PostgreSQL 保存用户、购物会话、执行设备、任务、租约和事件。
3. 用户本机 `local-executor` 使用设备令牌领取属于该用户的任务。
4. 本地执行器调用 Qoder CLI 与已安装的淘宝 skill，并只把结构化结果回填服务端。
5. 浏览器通过 SSE 获得任务状态与推荐结果，不等待长时间 HTTP 请求。

Qoder/Taobao 凭证和淘宝登录态始终保留在用户本机，服务端不读取订单、地址、手机号、聊天记录或账号身份资料。

正式产品模式只接受真实淘宝加购结果。开发预览可以显式保留产品内演示购物车，正式模式会在真实动作失败时返回失败并保留可重试状态，不会产生伪成功清单。

正式模式只允许 `local_executor` 执行外部购物工具。旧 Qoder 直连、Codex 宿主和 experimental bridge 即使被误配，也不会在正式运行时直接获得执行权；系统会安全收敛到持久任务队列，并由 readiness 报告配置错误。

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

## 4. 启动本地执行器

在已安装 Qoder CLI、淘宝 skill 和淘宝桌面版的机器执行：

```bash
SCENECART_API_URL=https://your-scenecart.example.com \
SCENECART_DEVICE_TOKEN=your-one-time-device-token \
QODERCLI_PATH="$HOME/.local/bin/qodercli" \
npm run executor:doctor
```

Doctor 会额外执行一次不调用淘宝工具的 Qoder headless 请求，用于提前识别 CLI 版本过旧或登录失效。若显示 `Qoder CLI 未登录`，先运行 `qodercli` 并输入 `/login`；若显示需要升级，运行 `qodercli update`。这两类配置错误会被标记为不可重试，避免真实任务重复消耗三次执行机会。

Doctor 只检查服务端、设备令牌和 Qoder CLI，不触发淘宝页面或账号动作。全部通过后启动：

```bash
SCENECART_API_URL=https://your-scenecart.example.com \
SCENECART_DEVICE_TOKEN=your-one-time-device-token \
QODERCLI_PATH="$HOME/.local/bin/qodercli" \
npm run worker:local
```

Worker 启动时会再次执行无副作用的 Qoder headless 会话检查；只有 Qoder 登录、服务端健康和设备令牌都通过后才开始发送心跳和领取任务。因此设置页显示“在线”代表基础执行链路已通过，而不只是本地进程存在。

可选配置：

```bash
EXECUTOR_POLL_MS=2500
EXECUTOR_QODER_TIMEOUT_MS=180000
```

执行器每 15 秒发送心跳，并在有运行任务时续租。任务完成结果会先写入 `.data/local-executor/results`，再回填服务端；若回执失败，租约恢复后会重放结果，不重复执行淘宝动作。

## 5. 任务生命周期

```text
pending -> leased -> running -> completed
                    -> pending (retry)
                    -> failed  (max attempts)
```

- `idempotency_key` 阻止同一 Agent 决策重复入队。
- `lease_owner_id` 限制只有领取设备能续租和完成任务。
- 过期租约会自动返回 `pending`，达到最大次数后转为 `failed`。
- 完成接口可安全重放，已经完成的任务返回 `already_completed=true`。
- 只有 `pending` 任务可以由用户取消；已被执行器领取的任务不会伪装成可撤销。
- `completed` 任务始终幂等去重；`failed/cancelled` 任务只有在用户再次点击搜索、加购或执行台“重新入队”后才会清空旧错误并重置尝试次数。
- 搜索空结果和最终失败会写入模块搜索轨迹，Agent 会跳过该模块继续执行，不阻塞整条工作流。

## 6. Agent Runtime 2.0

平衡与探索档位会向 DeepSeek 请求 `decide_next_action`，允许模型在白名单内提议：

- `search_module`
- `retry_module`
- `skip_module`
- `wait_for_tools`
- `complete_workflow`

后端在执行前验证模块 ID、活跃任务、重复搜索、补搜关键词、可跳过条件、置信度和剩余工具预算。模型输出无效、低置信度、超时或超过预算时，系统自动使用确定性规则决策。工具调用权不直接交给模型。

## 7. 运维与诊断

- `GET /api/runtime/health`：检查运行时与数据库连接。
- `GET /api/runtime/jobs?session_id=...`：查看当前会话任务。
- `GET /api/runtime/events/stream?session_id=...`：检查 SSE 事件。
- `GET /api/runtime/metrics?session_id=...`：检查积压、耗时、失败/取消数量、在线设备和分级运行告警。
- `/settings/executor`：查看设备、最后心跳和撤销令牌。
- `/hosted`：查看会话需求、Agent 决策、工具日志和候选回填状态。

应用已经对“有任务但无执行器”、队列等待过久、任务失败率、DeepSeek fallback 和 Guardrail 拒绝率生成会话级告警。正式环境仍应增加进程守护（systemd、launchd 或容器 supervisor），并把这些告警接入外部监控与通知渠道。

仓库 `.github/workflows/quality.yml` 已提供 PostgreSQL 16 集成验证、migration 检查、单元测试、生产构建和端到端测试。正式发布应将该 workflow 设为主分支必需检查。

## 8. 验证

```bash
npm run test:unit
npm run test:e2e
npm run check
```

E2E 使用隔离的本地执行器模拟器验证认证、规划、持久任务、SSE、推荐回填与异步加购，不会触发真实淘宝账号动作。
