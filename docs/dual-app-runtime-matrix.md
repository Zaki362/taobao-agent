# SceneCart 双应用运行时合同

本文件是 SceneCart 当前发布边界的权威摘要。仓库只维护一份共享 UI 与稳定业务逻辑，但构建为两个相互隔离的应用；任何旧文档与本表冲突时，以本表和当前代码门禁为准。

| 边界 | 正式产品 | 公开 Demo |
| --- | --- | --- |
| Vercel 项目 | `scenecart-ai` | `scenecart-public-demo` |
| 固定 Production 域名 | `https://scenecart-ai.vercel.app` | `https://scenecart-public-demo.vercel.app` |
| 源码入口 | 仓库根目录 | `apps/public-demo` |
| 身份 | `SCENECART_ACCESS_MODE=single_user`；服务端固定既有 owner | 无登录、无 owner |
| 数据 | PostgreSQL，所有 Session、设备和 Job 绑定固定 owner | 冻结样本；购物会话与演示清单仅在浏览器内存 |
| AI / 执行 | DeepSeek、正式 API、本机 Worker、淘宝 MCP | 不调用 DeepSeek、正式 `/api/*`、Worker、数据库或淘宝 |
| 产品说明 | 共享浮层；`?guide=1` 可直接打开 | 同一共享浮层；`?guide=1` 可直接打开 |
| 根路径 | 正式产品 | Demo 正式入口 |
| `/demo` | 重定向到公开 Demo 根路径 | 兼容重定向到 Demo 根路径 |
| `/product-guide` | 重定向到 `/?guide=1` | 重定向到 `/?guide=1` |

两边右上角都打开同一个产品说明浮层，不跳转独立页面。浮层保留目标用户、用户痛点、信息过载、场景化购物、礼物选购、价格决策、淘宝不足、产品定位、Agent 购物流程与技术方案；支持左侧章节导航、关闭按钮、Esc、遮罩关闭、焦点锁定、键盘和移动端。关闭后原页面状态不丢失，Demo 的自动演示状态也不重置。

## 正式产品身份与秘密边界

正式产品只供一个 owner 使用。`SCENECART_SINGLE_USER_ID` 指向正式数据库中已经存在的唯一 owner，并且只能保存在服务端环境；不得使用 `NEXT_PUBLIC_` 前缀、写入前端、日志、仓库或 Demo。数据库凭据、DeepSeek Key、Cron Secret、Vercel Protection Bypass Secret 和设备 Token 同样只能存在于各自的服务端或本机 Worker。

SceneCart 不再显示登录、注册或创建账号入口。进入正式产品后直接绑定服务端固定 owner；`/login` 回到首页，注册页面或普通登录/注册 API 不再提供公众账号能力。固定 owner 不能是 anonymous、public-demo 或临时身份。

## 正式产品暴露策略门禁

固定 owner 的远程运行默认 fail closed，只有以下两种互斥策略之一完整有效时才允许启动：

1. **protected**：Vercel 外层保护范围、核验时间、项目 ID、正式 origin 与当前部署完全一致；固定 Production 还必须使用 **All Deployments Protection** 并经过无凭据与已授权浏览器实际验证。
2. **unprotected_risk_accepted**：仅允许 canonical `https://scenecart-ai.vercel.app` 的 Vercel Production 使用；必须同时设置 `SCENECART_ALLOW_UNPROTECTED_SINGLE_USER_PRODUCTION=true` 与 `SCENECART_OUTER_PROTECTION_VERIFIED=false`，不得残留保护范围、核验时间、项目 ID、保护 origin 或审计回执，并且必须取得用户明确知情接受公开固定 owner 风险的独立 Production 授权。

受保护 Preview 可以用于验收，但 Preview 通过不代表 Production 获得保护，也不等于 Production 发布授权。当前团队使用 Vercel Hobby，其 Standard Protection 可保护 Preview / 自动生成部署地址，但不保护固定 Production 域名；当前正式 Production 因此采用第二种风险接受模式。知道固定域名的人可以直接进入同一个固定 owner 产品，readiness 必须如实返回 `single_user_exposure_mode=unprotected_risk_accepted`、`outer_protection_verified=false` 与 `unprotected_risk_accepted=true`，不能把风险开关包装成保护。升级到支持 All Deployments Protection 的方案并完成实际验证后，应切回第一种策略。公开 Demo 的 Production 发布同样需要独立授权，但不需要访问保护。

## Worker 机器鉴权

Vercel 外层保护与 SceneCart 设备鉴权是两个独立边界。连接受保护 origin 时，远程 Worker 请求必须同时携带：

1. `SCENECART_VERCEL_PROTECTED_ORIGIN` 与 `SCENECART_VERCEL_PROTECTION_BYPASS_SECRET`，只用于穿过 Vercel Protection；
2. `SCENECART_DEVICE_TOKEN`（或云端专用设备 Token），只用于 SceneCart Worker API 鉴权。

只有 Bypass 没有设备 Token 时，仍不得注册心跳、领取任务或回传结果；只有设备 Token 没有 Bypass 时，请求应被 Vercel 外层拦截。无保护的 `unprotected_risk_accepted` Production 不配置 Vercel Protected Origin 或 Bypass，但 SceneCart 设备 Bearer Token 仍是必需鉴权，缺失或失效时必须拒绝 Worker API。所有凭据只保存在 Worker 所在机器的 `0600` 本地环境文件或系统密钥存储中。日志必须脱敏，跨源重定向必须 fail closed。Cron、Webhook、readiness 与后台恢复调用也要按实际暴露策略配置，并始终保留各自的 SceneCart Bearer Secret。

## Demo 冻结边界

Demo 必须保留自动演示、模拟鼠标、步骤卡片、暂停/继续/重播、手动探索、推荐理由、备选商品、演示加购和购物清单。刷新恢复冻结初始状态。Demo Vercel 项目不配置 `DATABASE_URL`、`DEEPSEEK_API_KEY`、认证 Secret、Protection Bypass、Worker Token、淘宝或 MCP 凭据，也不展示任何自动生成的长 Preview 地址。

## 发布授权

提交、push、Preview 和 Production 是四个不同动作。每个远程动作都需要对应授权；两个 Preview 验收通过后，仍需分别请求正式产品 Production 和公开 Demo Production 授权。部署源必须 clean、非 detached、具有 upstream 且 ahead/behind 为 `0/0`，并确保完整 HEAD 与目标 Vercel 项目、环境和最终别名一致。
