# 淘宝 MCP 接入说明

> 本页同时记录当前正式接法和旧 experimental bridge，避免把历史兼容路径误当成面试主链路。

## 当前正式链路

网页中的真实搜索与显式确认后的真实加购统一走：

```text
Browser -> Next.js Agent workflow -> durable Job Queue
        -> local_executor -> 淘宝桌面版官方 Streamable HTTP MCP
        -> idempotent result callback -> Session -> Browser
```

浏览器不直接调用淘宝，Next.js 请求也不等待淘宝长任务。用户在网页确认规划后，服务端持久化 `module_search` Job；本机 `worker:local` 用设备令牌领取任务，再直连淘宝桌面版官方 HTTP MCP。正式链路不经过 Qoder、Codex hosted、旧 bridge 或 mock adapter。

默认 MCP 地址为：

```text
http://127.0.0.1:3654/mcp
```

`.env.local` 至少使用：

```dotenv
TAOBAO_EXECUTION_BACKEND=local_executor
TAOBAO_NATIVE_MCP_URL=http://127.0.0.1:3654/mcp
TAOBAO_SOURCE_APP=SceneCartAI
ALLOW_DEMO_CART_FALLBACK=false
```

首次使用时：

1. 启动并登录淘宝桌面版，开启官方本地 MCP / AI 应用授权。
2. 启动 `npm run dev`，在 `/settings/executor` 注册本机设备并复制一次性令牌。
3. 运行 `npm run executor:configure`，按提示保存页面地址和设备令牌。
4. 运行 `npm run executor:doctor`。Doctor 只检查 MCP 工具列表、SceneCart 服务和设备令牌，不执行商品搜索。
5. 保持 `npm run dev` 运行；默认启动器会在发现令牌后接入 `worker:local`。需要单独管理 Worker 时运行 `npm run worker:local`。
6. 在网页中逐步填写需求、确认 Scene Brief 和购物规划，再点击开始搜索。第一条真实搜索才会验证淘宝当前登录态。

正式 Worker 使用官方工具 `search_products` 获取候选；具备真实加购能力的设备还会使用 `get_product_skus` 和 `add_to_cart`。`get_current_tab` 只在真实调用已经明确报告登录失效后，用于低频检测登录是否恢复，不作为每次任务的预探针。

## 淘宝掉登录时

真实搜索报告登录失效后，系统不会自动回退到 mock，也不会伪造成功：

1. Worker 停止领取新的淘宝任务，并把设备标记为等待重新登录。
2. 当前工作流暂停；已经回填的真实候选仍保存在原 Session。
3. 网页显示“搜索已暂停，已有结果不会丢失”，并提供两个显式选择：
   - 在淘宝桌面版重新登录后，点击“重新登录后继续搜索”。Worker 检测到登录恢复后会恢复领取能力，用户这次确认才会重试失败模块；系统不会自动重放任务，也不会重跑已完成模块。
   - 点击“用已有部分结果进入选购”，直接查看登录失效前保存的真实候选。未完成模块会继续标明缺口；恢复登录前不会创建新的真实搜索或加购任务。

完成淘宝登录后不需要重启 Worker。若页面仍显示暂停，保持淘宝主界面和 SceneCart 打开，等待下一次恢复检查后再由用户确认继续。

## 安全与结果边界

- 搜索结果必须来自当前 `local_executor` Job 的官方 MCP 回填；模型 fallback 只可补需求理解和规划，不能伪造淘宝候选。
- 加购是高风险动作，网页和服务端都要求用户逐件显式确认；SceneCart 不会自动下单、提交订单或支付。
- `local_executor` 失败会保留为可重试失败。`ALLOW_DEMO_CART_FALLBACK` 不会把正式异步任务改写成演示成功。
- `/api/mcp/status` 展示当前账号可用的本地执行器能力；`/hosted` 是运行与任务控制台，不代表使用 Codex hosted 执行。

## 旧 experimental bridge（仅开发兼容）

仓库仍保留：

- `scripts/taobao-native-bridge.mjs`
- `lib/mcp/live.ts`
- `npm run bridge:taobao`
- `TAOBAO_MCP_BASE_URL=http://127.0.0.1:8787`

它对应旧的 `experimental_local` provider：Next.js 通过 bridge 的 `GET /health` 和 `POST /run` 适配 `search_taobao_products`、`open_product_detail`、`extract_product_info`、`add_to_cart`。这套协议只用于迁移、适配器开发或隔离调试，不是正式产品或面试主链路。

使用它必须同时满足：

```dotenv
SCENECART_PRODUCT_MODE=development
TAOBAO_EXECUTION_BACKEND=experimental_local
SCENECART_ENABLE_MCP_DEBUG=true
TAOBAO_MCP_BASE_URL=http://127.0.0.1:8787
```

正式产品模式会阻断 `experimental_local` 并安全收敛到 `local_executor`，readiness 同时报告误配置。旧 bridge 不提供“真实 MCP 不可达就自动回退 mock”的正式语义；若开发者另外启用 mock，必须在界面和讲解中明确披露，不能把结果说成实时淘宝搜索。

面试、真实设备验收和生产部署请始终使用 `TAOBAO_NATIVE_MCP_URL`，不要启动 `bridge:taobao`，也不要设置 `TAOBAO_EXECUTION_BACKEND=experimental_local`。
