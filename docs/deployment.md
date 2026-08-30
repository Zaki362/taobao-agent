# 场景购部署指南

## 部署边界

权威运行时矩阵见 [双应用运行时合同](./dual-app-runtime-matrix.md)。仓库共享 UI、产品说明浮层和稳定业务逻辑，但正式 runtime 与 Demo 冻结 runtime 严格隔离。

正式部署只托管 Next.js、PostgreSQL、DeepSeek 调用和持久任务队列。用户本机运行 `worker:local`，用设备令牌领取任务并优先直连淘宝桌面版官方 HTTP MCP；HTTP 搜索异常时可降级桌面版官方 CLI，只读结果仍由本机回填。淘宝客户端、MCP/CLI、登录态与设备令牌都不进入 Web 容器，Qoder 不属于正式执行链路。

公开体验是同仓库中的独立静态应用 `apps/public-demo`，部署到独立 Vercel 项目 `scenecart-public-demo`。该项目 Root Directory 为 `apps/public-demo`，允许构建步骤读取 Root Directory 外的共享源码，且环境变量保持为空。根路径是 Demo 唯一正式入口；旧 `/demo` 兼容回根路径，旧 `/product-guide` 回到 `/?guide=1`。

双域名是长期架构，不是迁移期临时状态：正式产品固定使用 `https://scenecart-ai.vercel.app/`，公开冻结体验固定使用 `https://scenecart-public-demo.vercel.app/`。正式站 `/demo` 重定向到公开 Demo 根路径，`?autoplay=1` 可继续透传，但不会绕过入口说明或自动开始播放。两边不共享身份、数据库、API、模型密钥、淘宝环境变量或本地执行器状态，也不在页面展示自动生成的长 Preview 地址。

正式产品固定使用服务端 `SCENECART_ACCESS_MODE=single_user` 和一个已存在 owner；没有场景购登录或注册页。远程运行默认 fail closed：优先使用经实际核验的 Vercel 外层保护；当前 Hobby 的 Standard Protection 不保护固定 Production 域名，因此只有用户明确知情接受公开固定 owner 风险、启用严格的服务端风险开关并取得独立正式 Production 授权后，才允许以 `unprotected_risk_accepted` 发布。受保护 Preview 仍可用于内部验收，但不能替代 Production 授权。

## 本地双应用预览

正式 UI 的本地验收由隔离 E2E fixture 创建随机测试 owner，公开 Demo 由 `npm run demo:dev` 启动；交付时分别保留两个实际监听地址。不要把 Docker Compose 当成正式域名的保护验收。

`docker-compose.yml` 仅保留为本地 PostgreSQL 基础设施 harness：它使用 `SCENECART_PRODUCT_MODE=development`、非 TLS 的容器内数据库，并要求调用者显式传入数据库中已存在的 `SCENECART_SINGLE_USER_ID`。它不会创建账号、不会把 account 登录模式重新带回产品，也不代表 Vercel Production。新环境优先运行隔离 E2E；只有已准备本地测试 owner 的开发者才使用 Compose。

## HTTPS 正式环境

正式域名必须通过反向代理或云平台提供 HTTPS，并配置：

```bash
SCENECART_PRODUCT_MODE=production
ALLOW_DEMO_CART_FALLBACK=false
APP_ORIGIN=https://scenecart-ai.vercel.app
NEXT_PUBLIC_SCENECART_PUBLIC_DEMO_URL=https://scenecart-public-demo.vercel.app
AUTH_COOKIE_SECURE=true
AUTH_REQUIRED=false
SCENECART_ACCESS_MODE=single_user
SCENECART_SINGLE_USER_ID=server-only-existing-owner-id
SCENECART_ALLOW_UNPROTECTED_SINGLE_USER_PRODUCTION=true
SCENECART_OUTER_PROTECTION_VERIFIED=false
RUNTIME_STORE=postgres
DATABASE_SSL=true
DATABASE_SSL_REJECT_UNAUTHORIZED=true
TAOBAO_EXECUTION_BACKEND=local_executor
SCENECART_ENABLE_MCP_DEBUG=false
SCENECART_CRON_SECRET=至少32字符的独立随机密钥
SCENECART_RECOVERY_STALE_MS=180000
DATABASE_POOL_SIZE=1
```

`DATABASE_URL`、`SCENECART_SINGLE_USER_ID`、`DEEPSEEK_API_KEY` 和 `SCENECART_CRON_SECRET` 应使用服务端 Secret，不写入镜像、前端、日志或 Git。设备令牌与 Vercel Bypass 只保存在运行 `worker:local` 的机器，不上传公开 Demo。

只供 owner 验收的 Preview 使用同一 `single_user` 合同，并保留 Vercel Deployment Protection。固定 owner 永远不能使用 anonymous 身份，也不能写入浏览器。Preview 验收不能推导 Production 保护已生效或 Production 已获授权。

当前 Vercel Hobby 面试部署在 `vercel.json` 固定使用单一 `sin1` Function Region；Neon 也应选择 `sin1`，让服务端事务与数据库同区。`DATABASE_POOL_SIZE=1` 用于限制每个 Serverless 实例持有的 PostgreSQL 连接数；连接字符串优先使用 Neon 提供的 pooled `DATABASE_URL`。纯本地运行不读取 `vercel.json`，仍由 `npm run dev` 和本地 runtime 独立工作。

## Worker 穿过 Vercel Protection

受保护的远程正式应用必须让 Worker 同时携带两层独立凭据：

```dotenv
SCENECART_API_URL=https://scenecart-ai.vercel.app
SCENECART_VERCEL_PROTECTED_ORIGIN=https://scenecart-ai.vercel.app
SCENECART_VERCEL_PROTECTION_BYPASS_SECRET=只保存在本机的旁路凭据
SCENECART_DEVICE_TOKEN=只保存在本机的设备凭据
```

Bypass 只穿过 Vercel 外层，设备 Token 才授权场景购的设备心跳、任务领取和结果回填。受保护 origin 缺任一凭据都必须失败；请求禁止跟随跨源重定向，日志必须脱敏。Cron、Webhook、内部 readiness 和后台恢复同样会被外层保护拦截，必须为每条机器调用分别配置 Vercel Automation Bypass 以及它自身的场景购 Bearer Secret。

当前 `unprotected_risk_accepted` Production 不配置 `SCENECART_VERCEL_PROTECTED_ORIGIN` 或 `SCENECART_VERCEL_PROTECTION_BYPASS_SECRET`，因为没有 Vercel 外层挑战需要穿过；但本机 Worker 仍必须携带场景购设备 Bearer Token，Cron、readiness 和后台恢复仍必须携带各自的场景购 Bearer Secret。风险接受开关不能替代任何机器鉴权。

## 公开 Demo 环境

`scenecart-public-demo` 必须保持环境变量为空，尤其不得配置数据库、DeepSeek、场景购认证 Secret、Vercel Bypass、Worker Token、淘宝或 MCP 凭据。构建后应审计网络：页面只能读取打包的冻结资源，不得访问正式 `/api/*`。Demo 刷新恢复初始状态。

## 发布检查

commit、push、Preview、正式产品 Production、公开 Demo Production 都是独立授权。Preview 验收通过也不能自动获得任一 Production 授权。部署前必须确认真实源码工作树 clean、非 detached、有 upstream、ahead/behind 为 `0/0`，且完整 HEAD 与目标项目、环境一致。

1. GitHub Actions `quality` 全部通过。
2. 数据库 migration 由独立 release 阶段显式执行一次：`npm run db:migrate && npm run db:check`。`npm run build` 永远不会连接或修改数据库；迁移器使用 PostgreSQL advisory lock 防止并发发布重复执行。
3. 设置 `SCENECART_RELEASE_VERIFY_URL` 为当前验收地址，运行 `npm run release:verify`。protected 模式先用无凭据请求确认外层挑战，再用本机 Vercel Bypass 读取 health，并以 Bypass + Cron Bearer 读取内部 readiness；`unprotected_risk_accepted` 模式则要求无凭据 health 正常返回、不得出现 Vercel 挑战，并用 Cron Bearer 读取内部 readiness。两种模式都不会打印完整凭据。
4. `npm run check`、`npm run eval:agent` 成功；其中 `check` 同时验证正式产品构建与 Demo-only 静态导出边界。
5. 使用预置测试设备 Token 运行 `npm run executor:doctor`；按当前暴露策略访问 `/api/runtime/readiness`，设备在线时应得到 `operational_for_shopping=true`。protected 模式同时验证 Bypass，风险接受模式不得要求 Bypass，但两者都必须拒绝缺少设备 Bearer 的 Worker API。
6. 使用隔离淘宝测试账号完成一次搜索；真实加购仅在明确授权且账号能力稳定时验收。
7. 检查执行台中的任务积压、在线设备、模型 fallback、失败任务和“运行健康诊断”，不得带着严重告警发布。

工作流恢复任务会至多每 12 小时执行一次数据保留清理：过期登录会话立即删除，限流记录保留 48 小时、执行事件 30 天、终态任务 90 天、归档会话 365 天、已撤销设备 180 天。可通过 `.env.example` 中的 `SCENECART_*_RETENTION_*` 变量调整，但代码会阻止过短或无界的配置。

```bash
SCENECART_RELEASE_VERIFY_URL=https://当前正式验收地址 npm run release:verify
```

只想在部署前验证环境变量而不访问数据库和线上实例时，可以运行 `npm run release:verify -- --static`。完整验证会复用 `SCENECART_CRON_SECRET` 调用 `/api/internal/runtime-readiness`；该接口只读、不扫描或恢复任务，并使用与恢复端点相同的常量时间 Bearer 校验。完整验证只接受非本地 HTTPS 目标，地址不得包含用户名、密码或查询参数。

如果本机开发服务器正在运行，验证生产构建时可使用 `NEXT_DIST_DIR=.next-verify npm run build`，避免构建过程覆盖开发服务器正在使用的 `.next` 热更新产物。正式 Docker/CI 构建无需设置该变量。

`health` 只回答进程和数据库是否存活；`readiness` 还必须检查 production、PostgreSQL、固定 owner 存在且配置有效、明确的单用户暴露策略、DeepSeek 和 Worker 状态。protected 模式要求外层保护人工验证；风险接受模式必须如实返回 `single_user_exposure_mode=unprotected_risk_accepted`、`outer_protection_verified=false` 与 `unprotected_risk_accepted=true`。内部 readiness 不返回 owner UUID。应用启动后应等待至少一次恢复 Worker/Cron 心跳，再考虑加入流量。

`production` 运行时会安全阻断 anonymous owner、缺失或不存在的固定 owner、无效暴露策略、非 PostgreSQL 持久化和不安全 Origin。保护模式的环境变量声明不能替代无凭据浏览器的实际保护验证；风险接受模式则只允许 canonical Production、明确的 `OUTER_PROTECTION_VERIFIED=false`、无残留保护证明和服务端专用风险开关，不能用于 Preview、其他域名或浏览器代码。

`db:check` 会同时核对 migration checksum 与运行时实体表，包括恢复调度依赖的 `runtime_service_heartbeats`。Docker 镜像只包含 Web、数据库迁移和恢复 Worker；用户设备令牌、淘宝桌面版 MCP 地址与淘宝登录态不得进入镜像或 Compose 环境。

`SCENECART_PRODUCT_MODE=production` 会强制关闭演示购物车回退，即使误设 `ALLOW_DEMO_CART_FALLBACK=true` 也不会把真实加购失败伪装成成功。开发回退也不是所有失败的总兜底：只有 development、`ALLOW_DEMO_CART_FALLBACK=true` 且使用同步开发兼容 provider 时，失败才会生成明确标记的“演示购物车”条目；正式 `local_executor` 的异步 Job 失败会保留为失败并等待用户重试。

历史 `qoder_cli` 与 `experimental_local` 执行适配器已经删除；旧配置仍会被识别为误配置并安全收敛到 `local_executor`。正式模式也会阻断 `codex_hosted`。readiness 会保持失败，直到部署环境显式配置正确。

正式环境还必须保持 `SCENECART_ENABLE_MCP_DEBUG=false`；production 即使误配为 `true` 也会隐藏 `/api/mcp/run`，但 release audit 会继续报错直到配置被修正。

正式环境不要配置 `HOSTED_WORKER_TOKEN`，也不要运行 `npm run worker:codex`。production 会直接拒绝 `/api/hosted/tasks*` 旧 Worker 协议；浏览器主流程也不会轮询旧宿主状态。`/hosted` 页面仍是当前会话、任务、模型和执行器的运维控制台，并不代表继续使用 Codex hosted 执行淘宝任务。

场景购的交易边界止于购买确认页与淘宝购物车。即使设备拥有 `add_to_cart` 能力，也必须由用户逐件显式确认；系统不会自动提交订单、结算或支付。面试环境的固定预检、现场步骤与无 MCP 兜底见 [面试演示 Runbook](./interview-demo.md)。

## 回滚原则

- 应用回滚使用上一版镜像，不修改已经执行的 migration 文件。
- 数据结构变更必须通过新的向前兼容 migration 发布。
- 发布前备份 PostgreSQL；破坏性 schema 变更必须拆成“先兼容写入、再迁移数据、最后删除旧字段”三次发布。
- 淘宝执行异常时可停止本地执行器，不影响已保存的规划、候选和产品内购物清单。
