# SceneCart AI 部署指南

## 部署边界

正式部署只托管 Next.js、PostgreSQL、DeepSeek 调用和持久任务队列。Qoder CLI、淘宝 skill、淘宝桌面版登录态与设备令牌始终留在用户本机，通过 `worker:local` 领取该用户的任务。

## 本地生产预览

```bash
POSTGRES_PASSWORD='请替换为随机强密码' \
SCENECART_CRON_SECRET='至少32字符的独立随机密钥' \
APP_ORIGIN='http://127.0.0.1:3000' \
AUTH_COOKIE_SECURE=false \
DEEPSEEK_API_KEY='你的密钥' \
docker compose up --build
```

打开 `http://127.0.0.1:3000`，注册账号后前往 `/settings/executor` 注册本机执行器。

## HTTPS 正式环境

正式域名必须通过反向代理或云平台提供 HTTPS，并配置：

```bash
SCENECART_PRODUCT_MODE=production
ALLOW_DEMO_CART_FALLBACK=false
APP_ORIGIN=https://scenecart.example.com
AUTH_COOKIE_SECURE=true
AUTH_REQUIRED=true
RUNTIME_STORE=postgres
TAOBAO_EXECUTION_BACKEND=local_executor
SCENECART_CRON_SECRET=至少32字符的独立随机密钥
SCENECART_RECOVERY_STALE_MS=180000
```

`DATABASE_URL`、`POSTGRES_PASSWORD`、`DEEPSEEK_API_KEY`、`SCENECART_CRON_SECRET` 和设备令牌应使用部署平台 Secret，不写入镜像、Compose 文件或 Git。自托管 Compose 会启动独立 `recovery` 服务；其他平台应每分钟携带 Bearer Secret 调用 `/api/internal/workflow-recovery`。

## 发布检查

1. GitHub Actions `quality` 全部通过。
2. `npm run release:audit` 返回 `READY`。该命令只报告配置是否满足正式要求，不打印 Key、Token 或数据库连接串。
3. `npm run db:migrate`、`npm run db:check`、`npm run check` 和 `npm run eval:agent` 成功。
4. `/api/runtime/health` 返回 `healthy`。
5. 登录后访问 `/api/runtime/readiness`，确认 `ready_for_production=true`。
6. 注册测试设备并运行 `npm run executor:doctor`；设备在线后应得到 `operational_for_shopping=true`。
7. 使用隔离淘宝测试账号完成一次搜索；真实加购仅在明确授权且账号能力稳定时验收。
8. 检查执行台中的任务积压、在线设备、模型 fallback、失败任务和“运行健康诊断”，不得带着严重告警发布。

`health` 只回答进程和数据库是否存活；`readiness` 才会检查正式产品模式、演示加购回退、数据库持久化、认证、服务端恢复心跳、安全 Cookie、正式 HTTPS Origin、DeepSeek、`local_executor`、旧 Mock 标志和当前账号执行器状态，不能用前者代替发布验收。应用启动后应等待至少一次恢复 Worker/Cron 心跳，再把实例加入正式流量。

`SCENECART_PRODUCT_MODE=production` 会强制关闭演示购物车回退，即使误设 `ALLOW_DEMO_CART_FALLBACK=true` 也不会把真实加购失败伪装成成功。开发预览仍可保留该回退，但 UI 与购物清单必须明确标记“演示购物车”。

正式模式也会阻断旧的 `qoder_cli`、`codex_hosted` 与 `experimental_local` 直连路径。误配置时 effective backend 会安全收敛为 `local_executor`，但 readiness 仍保持失败，直到部署环境显式配置正确。

正式环境不要配置 `HOSTED_WORKER_TOKEN`，也不要运行 `npm run worker:codex`。production 会直接拒绝 `/api/hosted/tasks*` 旧 Worker 协议；浏览器主流程也不会轮询旧宿主状态。`/hosted` 页面仍是当前会话、任务、模型和执行器的运维控制台，并不代表继续使用 Codex hosted 执行淘宝任务。

## 回滚原则

- 应用回滚使用上一版镜像，不修改已经执行的 migration 文件。
- 数据结构变更必须通过新的向前兼容 migration 发布。
- 发布前备份 PostgreSQL；破坏性 schema 变更必须拆成“先兼容写入、再迁移数据、最后删除旧字段”三次发布。
- 淘宝执行异常时可停止本地执行器，不影响已保存的规划、候选和产品内购物清单。
