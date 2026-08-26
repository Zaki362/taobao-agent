# SceneCart AI 部署指南

## 部署边界

正式部署只托管 Next.js、PostgreSQL、DeepSeek 调用和持久任务队列。用户本机运行 `worker:local`，用设备令牌领取任务并优先直连淘宝桌面版官方 HTTP MCP；HTTP 搜索异常时可降级桌面版官方 CLI，只读结果仍由本机回填。淘宝客户端、MCP/CLI、登录态与设备令牌都不进入 Web 容器，Qoder 不属于正式执行链路。

公开体验是同仓库中的独立静态应用 `apps/public-demo`，部署到独立 Vercel 项目 `scenecart-public-demo`。该项目 Root Directory 为 `apps/public-demo`，允许构建步骤读取 Root Directory 外的共享源码，且环境变量保持为空。静态导出门禁只允许 `/`、`/demo` 和 404；正式产品继续从仓库根目录部署，不包含 `/demo` 路由。

## 本地生产预览

```bash
POSTGRES_PASSWORD='请替换为随机强密码' \
SCENECART_CRON_SECRET='至少32字符的独立随机密钥' \
APP_ORIGIN='http://127.0.0.1:3000' \
AUTH_COOKIE_SECURE=false \
DEEPSEEK_API_KEY='你的密钥' \
docker compose up --build
```

打开 Compose 暴露的地址（默认 `http://127.0.0.1:3000`），注册账号后前往 `/settings/executor` 注册本机执行器。若通过 `PORT` 映射到其他端口，`APP_ORIGIN` 和本地执行器的 `SCENECART_API_URL` 必须使用同一个实际地址。自动选择空闲端口只适用于 `npm run dev`，不适用于 Compose。

## HTTPS 正式环境

正式域名必须通过反向代理或云平台提供 HTTPS，并配置：

```bash
SCENECART_PRODUCT_MODE=production
ALLOW_DEMO_CART_FALLBACK=false
APP_ORIGIN=https://scenecart.example.com
AUTH_COOKIE_SECURE=true
AUTH_REQUIRED=true
SCENECART_ACCESS_MODE=account
RUNTIME_STORE=postgres
DATABASE_SSL=true
DATABASE_SSL_REJECT_UNAUTHORIZED=true
TAOBAO_EXECUTION_BACKEND=local_executor
SCENECART_ENABLE_MCP_DEBUG=false
SCENECART_CRON_SECRET=至少32字符的独立随机密钥
SCENECART_RECOVERY_STALE_MS=180000
DATABASE_POOL_SIZE=1
```

`DATABASE_URL`、`POSTGRES_PASSWORD`、`DEEPSEEK_API_KEY` 和 `SCENECART_CRON_SECRET` 应使用部署平台 Secret，不写入镜像、Compose 文件或 Git。设备令牌只保存在运行 `worker:local` 的用户机器 `.env.local` 中，不上传到部署平台。自托管 Compose 会启动独立 `recovery` 服务；其他平台应每分钟携带 Bearer Secret 调用 `/api/internal/workflow-recovery`。

只供 owner 验收的受保护 Preview 可设置 `SCENECART_ACCESS_MODE=single_user` 和既有 owner 的 `SCENECART_SINGLE_USER_ID`，从而跳过 SceneCart 自身的登录页；Preview 仍必须保留 Vercel Deployment Protection。受保护 Preview 会把 Vercel 注入的当前 `VERCEL_URL` 加入同源写请求白名单，不需要把每次生成的随机域名手动写回 `APP_ORIGIN`，也不会信任客户端转发的 Host。该模式不会取消淘宝登录或执行器令牌，并会在 Vercel Production 环境直接拒绝运行。公开正式域名继续使用 `SCENECART_ACCESS_MODE=account`。

当前 Vercel Hobby 面试部署在 `vercel.json` 固定使用单一 `sin1` Function Region；Neon 也应选择 `sin1`，让服务端事务与数据库同区。`DATABASE_POOL_SIZE=1` 用于限制每个 Serverless 实例持有的 PostgreSQL 连接数；连接字符串优先使用 Neon 提供的 pooled `DATABASE_URL`。纯本地运行不读取 `vercel.json`，仍由 `npm run dev` 和本地 runtime 独立工作。

## 发布检查

1. GitHub Actions `quality` 全部通过。
2. 数据库 migration 由独立 release 阶段显式执行一次：`npm run db:migrate && npm run db:check`。`npm run build` 永远不会连接或修改数据库；迁移器使用 PostgreSQL advisory lock 防止并发发布重复执行。
3. 设置 `SCENECART_RELEASE_VERIFY_URL=https://正式域名`，运行 `npm run release:verify`。它会依次验证静态配置、数据库 schema、公开 health 与受内部 Bearer 保护的只读 readiness，且不会打印 Key、Token 或数据库连接串。
4. `npm run check`、`npm run eval:agent` 成功；其中 `check` 同时验证正式产品构建与 Demo-only 静态导出边界。
5. 注册测试设备并运行 `npm run executor:doctor`；登录后访问 `/api/runtime/readiness`，设备在线时应得到 `operational_for_shopping=true`。
6. 使用隔离淘宝测试账号完成一次搜索；真实加购仅在明确授权且账号能力稳定时验收。
7. 检查执行台中的任务积压、在线设备、模型 fallback、失败任务和“运行健康诊断”，不得带着严重告警发布。

工作流恢复任务会至多每 12 小时执行一次数据保留清理：过期登录会话立即删除，限流记录保留 48 小时、执行事件 30 天、终态任务 90 天、归档会话 365 天、已撤销设备 180 天。可通过 `.env.example` 中的 `SCENECART_*_RETENTION_*` 变量调整，但代码会阻止过短或无界的配置。

```bash
SCENECART_RELEASE_VERIFY_URL=https://scenecart.example.com npm run release:verify
```

只想在部署前验证环境变量而不访问数据库和线上实例时，可以运行 `npm run release:verify -- --static`。完整验证会复用 `SCENECART_CRON_SECRET` 调用 `/api/internal/runtime-readiness`；该接口只读、不扫描或恢复任务，并使用与恢复端点相同的常量时间 Bearer 校验。完整验证只接受非本地 HTTPS 目标，地址不得包含用户名、密码或查询参数。

如果本机开发服务器正在运行，验证生产构建时可使用 `NEXT_DIST_DIR=.next-verify npm run build`，避免构建过程覆盖开发服务器正在使用的 `.next` 热更新产物。正式 Docker/CI 构建无需设置该变量。

`health` 只回答进程和数据库是否存活；`readiness` 才会检查正式产品模式、演示加购回退、数据库持久化、认证、服务端恢复心跳、安全 Cookie、正式 HTTPS Origin、DeepSeek、`local_executor`、手动 MCP 调试端点、旧 Mock 标志和当前账号执行器状态，不能用前者代替发布验收。内部 readiness 不带用户身份，因此只验证平台发布条件；某个用户是否具备真实搜索与加购能力，仍必须通过登录后的 `/api/runtime/readiness` 和 `executor:doctor` 验证。应用启动后应等待至少一次恢复 Worker/Cron 心跳，再把实例加入正式流量。

`production` 运行时会安全阻断三类误配置：匿名访问会被强制关闭；HTTPS Origin 下的 Cookie 不允许被 `AUTH_COOKIE_SECURE=false` 降级；本地 Session 仓库不能代替 PostgreSQL。安全覆盖只用于 fail-closed，不会让 readiness 变绿，部署环境仍必须显式配置 `AUTH_REQUIRED=true`、`AUTH_COOKIE_SECURE=true`、`RUNTIME_STORE=postgres` 和 `DATABASE_URL`。

`db:check` 会同时核对 migration checksum 与运行时实体表，包括恢复调度依赖的 `runtime_service_heartbeats`。Docker 镜像只包含 Web、数据库迁移和恢复 Worker；用户设备令牌、淘宝桌面版 MCP 地址与淘宝登录态不得进入镜像或 Compose 环境。

`SCENECART_PRODUCT_MODE=production` 会强制关闭演示购物车回退，即使误设 `ALLOW_DEMO_CART_FALLBACK=true` 也不会把真实加购失败伪装成成功。开发回退也不是所有失败的总兜底：只有 development、`ALLOW_DEMO_CART_FALLBACK=true` 且使用同步开发兼容 provider 时，失败才会生成明确标记的“演示购物车”条目；正式 `local_executor` 的异步 Job 失败会保留为失败并等待用户重试。

历史 `qoder_cli` 与 `experimental_local` 执行适配器已经删除；旧配置仍会被识别为误配置并安全收敛到 `local_executor`。正式模式也会阻断 `codex_hosted`。readiness 会保持失败，直到部署环境显式配置正确。

正式环境还必须保持 `SCENECART_ENABLE_MCP_DEBUG=false`；production 即使误配为 `true` 也会隐藏 `/api/mcp/run`，但 release audit 会继续报错直到配置被修正。

正式环境不要配置 `HOSTED_WORKER_TOKEN`，也不要运行 `npm run worker:codex`。production 会直接拒绝 `/api/hosted/tasks*` 旧 Worker 协议；浏览器主流程也不会轮询旧宿主状态。`/hosted` 页面仍是当前会话、任务、模型和执行器的运维控制台，并不代表继续使用 Codex hosted 执行淘宝任务。

SceneCart 的交易边界止于购买确认页与淘宝购物车。即使设备拥有 `add_to_cart` 能力，也必须由用户逐件显式确认；系统不会自动提交订单、结算或支付。面试环境的固定预检、现场步骤与无 MCP 兜底见 [面试演示 Runbook](./interview-demo.md)。

## 回滚原则

- 应用回滚使用上一版镜像，不修改已经执行的 migration 文件。
- 数据结构变更必须通过新的向前兼容 migration 发布。
- 发布前备份 PostgreSQL；破坏性 schema 变更必须拆成“先兼容写入、再迁移数据、最后删除旧字段”三次发布。
- 淘宝执行异常时可停止本地执行器，不影响已保存的规划、候选和产品内购物清单。
