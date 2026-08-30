# 淘宝桌面版官方 MCP 接入说明

> 本页只描述当前正式接法。旧 experimental bridge、Qoder CLI 和 MCP mock adapter 已从运行代码中删除。

## 当前正式链路

网页中的真实搜索与显式确认后的真实加购统一走：

```text
Browser -> Next.js Agent workflow -> durable Job Queue
        -> local_executor -> 淘宝桌面版官方 Streamable HTTP MCP
        -> idempotent result callback -> Session -> Browser
```

浏览器不直接调用淘宝，Next.js 请求也不等待淘宝长任务。用户在网页确认规划后，服务端持久化 `module_search` Job；本机 `worker:local` 用设备令牌领取任务，再优先直连淘宝桌面版官方 HTTP MCP，必要时仅对搜索使用桌面版官方 CLI。正式链路不经过 Qoder、Codex hosted、旧 bridge 或 mock adapter。

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
4. 运行 `npm run executor:doctor`。Doctor 检查 HTTP MCP 工具列表；若该端口不可用，则调用官方 CLI 的只读页面列表验证真实执行层。它不会执行商品搜索。
5. 保持 `npm run dev` 运行；默认启动器会在发现令牌后接入并监督唯一的 `worker:local`，异常退出时指数退避重启。Worker 启动只建立待命状态，历史搜索必须回网页确认继续。需要单独管理 Worker 时运行 `npm run worker:local`。
6. 在网页中逐步填写需求、确认 Scene Brief 和购物规划，再点击开始搜索；若是启动前遗留任务则点击“继续搜索”。第一条真实搜索才会验证淘宝当前登录态。

正式 Worker 优先使用 HTTP MCP 的官方 `search_products` 获取候选；若该只读调用返回内测误报或 HTTP 工具层失效，则在同一 Job attempt 内安全降级到桌面版自带的 `taobao-native search_products`。证据会标记 `http_mcp` 或 `native_cli`，不会把兜底伪装成 HTTP MCP。具备真实加购能力的设备仍只通过 HTTP MCP 使用 `get_product_skus` 和 `add_to_cart`，CLI 兜底绝不触发加购。`get_current_tab` 只在真实调用已经明确报告登录失效后，用于低频检测登录是否恢复，不作为每次任务的预探针。

## MCP 暂不可用时

淘宝桌面版尚未加载工具层时，Worker 会先检查 HTTP MCP `tools/list`，再检查官方 CLI 的真实工具执行层。只要 CLI 仍能执行只读工具，搜索队列可以继续；HTTP 详情与加购保持关闭。只有两条搜索传输都不可用时，Worker 才保持 `mcp_unavailable` 心跳并按上限 30 秒指数退避。未领取搜索仍留在持久队列，不增加尝试次数，也不会回退 mock。

这条自动恢复只适用于“工具尚不可用”。如果一次真实调用已经明确返回登录失效，必须进入下面的 `authentication_required` 分支；如果 MCP 在真实加购期间断开，恢复后也不会自动重放加购。

## 淘宝掉登录时

真实搜索报告登录失效后，系统不会自动回退到 mock，也不会伪造成功：

1. Worker 停止领取新的淘宝任务，并把设备标记为等待重新登录。
2. 当前工作流暂停；已经回填的真实候选仍保存在原 Session。
3. 网页显示“搜索已暂停，已有结果不会丢失”，并提供两个显式选择：
   - 在淘宝桌面版重新登录后，点击“重新登录后继续搜索”。Worker 检测到登录恢复后会恢复领取能力，用户这次确认才会重试失败模块；系统不会自动重放任务，也不会重跑已完成模块。
   - 点击“用已有部分结果进入选购”，直接查看登录失效前保存的真实候选。未完成模块会继续标明缺口；恢复登录前不会创建新的真实搜索或加购任务。

完成淘宝登录后不需要重启 Worker。若页面仍显示暂停，保持淘宝主界面和场景购打开，等待下一次恢复检查后再由用户确认继续。

## 安全与结果边界

- 搜索结果必须来自当前 `local_executor` Job 的官方 MCP 回填；模型 fallback 只可补需求理解和规划，不能伪造淘宝候选。
- 加购是高风险动作，网页和服务端都要求用户逐件显式确认；场景购不会自动下单、提交订单或支付。
- 真实加购不会因 Worker 重启、MCP 恢复或登录恢复而自动重放；回填失败时只重放本地结果账本，不重复执行淘宝动作。
- `local_executor` 失败会保留为可重试失败。`ALLOW_DEMO_CART_FALLBACK` 不会把正式异步任务改写成演示成功。
- `/api/mcp/status` 展示当前账号可用的本地执行器能力；`/hosted` 是运行与任务控制台，不代表使用 Codex hosted 执行。

## 协议与部署顺序

当前 Worker、Doctor 和服务端使用执行器协议 **v4**。PostgreSQL 部署必须先执行包含 `db/migrations/007_executor_mcp_availability_state.sql` 的 `npm run db:migrate && npm run db:check`，之后部署 v4 服务端，最后更新本机 Worker。v4 新增只读 `product_detail` 证据任务；v3 的新任务领取一律返回 `426 executor_protocol_mismatch`。发布切换前已经被同一 v3 设备领取的旧搜索/加购任务可继续心跳和回填至终态，既不会误领详情任务，也避免真实加购结果在升级窗口中丢失。

## 已退役路径

仓库不再提供 8787 experimental bridge、Qoder CLI provider 或 MCP mock adapter。若旧环境仍配置 `TAOBAO_EXECUTION_BACKEND=qoder_cli` 或 `experimental_local`，运行时会安全回到 `local_executor`，readiness 同时报告误配置，直到配置被改正。
