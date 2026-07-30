# SceneCart AI 部署指南

## 部署边界

正式部署只托管 Next.js、PostgreSQL、DeepSeek 调用和持久任务队列。Qoder CLI、淘宝 skill、淘宝桌面版登录态与设备令牌始终留在用户本机，通过 `worker:local` 领取该用户的任务。

## 本地生产预览

```bash
POSTGRES_PASSWORD='请替换为随机强密码' \
APP_ORIGIN='http://127.0.0.1:3000' \
AUTH_COOKIE_SECURE=false \
DEEPSEEK_API_KEY='你的密钥' \
docker compose up --build
```

打开 `http://127.0.0.1:3000`，注册账号后前往 `/settings/executor` 注册本机执行器。

## HTTPS 正式环境

正式域名必须通过反向代理或云平台提供 HTTPS，并配置：

```bash
APP_ORIGIN=https://scenecart.example.com
AUTH_COOKIE_SECURE=true
AUTH_REQUIRED=true
RUNTIME_STORE=postgres
TAOBAO_EXECUTION_BACKEND=local_executor
```

`DATABASE_URL`、`POSTGRES_PASSWORD`、`DEEPSEEK_API_KEY` 和设备令牌应使用部署平台 Secret，不写入镜像、Compose 文件或 Git。

## 发布检查

1. GitHub Actions `quality` 全部通过。
2. `npm run db:migrate` 和 `npm run db:check` 成功。
3. `/api/runtime/health` 返回 `healthy`。
4. 注册测试设备并运行 `npm run executor:doctor`。
5. 使用隔离淘宝测试账号完成一次搜索；真实加购仅在明确授权且账号能力稳定时验收。
6. 检查执行台中的任务积压、在线设备、模型 fallback 和失败任务。

## 回滚原则

- 应用回滚使用上一版镜像，不修改已经执行的 migration 文件。
- 数据结构变更必须通过新的向前兼容 migration 发布。
- 发布前备份 PostgreSQL；破坏性 schema 变更必须拆成“先兼容写入、再迁移数据、最后删除旧字段”三次发布。
- 淘宝执行异常时可停止本地执行器，不影响已保存的规划、候选和产品内购物清单。
