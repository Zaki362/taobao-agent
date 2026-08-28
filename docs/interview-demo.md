# SceneCart AI 面试演示 Runbook

> 当前是单仓库双应用：正式产品使用服务端固定 owner 的 `single_user` 运行时，公开 Demo 使用完全冻结、无 API 的静态运行时。发布与凭据边界见 [双应用运行时合同](./dual-app-runtime-matrix.md)。

这份 runbook 的主目标是在 SceneCart 网页中一步步操作，并真实触发淘宝桌面版官方 HTTP MCP：从需求输入、规划确认、持久任务、真实搜索，一路展示到部分结果或完整推荐与购买确认。固定演示场景是“新车选购”；首页另外开放露营准备、房间装饰、宿舍入学和搬家置办，但不要在一次面试里分散主线。历史快照、mock 和演示购物车不属于这条主路径。

## 1. 成功标准与安全边界

首选的真实淘宝演示标准是：

1. 从自然语言需求生成 Scene Brief 和预算守恒的购物规划。
2. 用户在网页确认 Scene Brief 和规划后，只点击一次开始搜索；服务端创建持久 Agent workflow 并逐模块排队。
3. `local_executor` 优先直连淘宝桌面版官方 HTTP MCP；若 HTTP 搜索层失效则安全降级官方 CLI，至少回填一个当前可用的真实商品候选。
4. 展示候选复盘、搜索轨迹、完成报告和预算安全购买组合。
5. 展示组合采纳、逐件显式加购入口和购买确认页。
6. 说明系统止于淘宝购物车，不会自动下单、提交订单或支付。

真实加购成功是增强项，不是本次演示的阻断项。若淘宝登录态在搜索中失效，应在当前网页展示“安全暂停”，再演示“重新登录后用户确认继续”或“用已有部分结果进入选购”中的一个真实分支。

正式演示链路只有：

```text
Browser -> Next.js Agent workflow -> durable Job Queue
        -> local executor -> 淘宝桌面版官方 HTTP MCP
        -> idempotent result callback -> Session -> Browser
```

Qoder、Codex hosted、experimental bridge 和 mock adapter 都不属于正式演示链路。

### 次级可选：隔离演示模式

它不属于面试主路径。只有官方 MCP 现场无法恢复、且已经向面试官明确结束真实链路讲解时，才考虑另起隔离进程运行：

```bash
npm run demo:interview
```

这条命令会同时启动隔离的 SceneCart Server 与专用演示 Worker，自动走完产品 UI 流程并把可见浏览器停在最终页；按 `Ctrl+C` 退出。Server 和 Worker 都显式设置 `SCENECART_INTERVIEW_DEMO=true`，同时保持 `ALLOW_DEMO_CART_FALLBACK=false`。它不依赖淘宝登录或本地 MCP，也不能证明当前网页触发了真实淘宝搜索。

演示数据边界必须主动说明：

- 已覆盖的新车模块来自 **2026-08-08** 淘宝历史搜索快照，价格、库存、规格和链接状态均未实时校验。
- `adaptive-child-safety`、`decor-ambience` 以及其他快照未覆盖模块使用明确写有“固定演示候选”“非淘宝实时商品”的确定性数据。
- 淘宝 `search`、`add`、`order`、`payment` 调用全部为 **0**。
- 显式确认加购后只写入 SceneCart 产品内“演示购物车”；不会写入真实淘宝购物车，不会提交订单或支付。

仅在需要维护这个次级模式时，才用下列命令做无界面验收：

```bash
npm run demo:interview:verify
```

成功时命令退出码为 0，并在 `.data/interview-demo/latest-report.json` 与 `.data/interview-demo/latest-final.png` 写入报告和最终页截图。该验收只证明隔离演示流程可重复跑通；它不是面试主路径的必过项，不能替代 Doctor、正式 Worker、持久 Job 或当前淘宝工具结果。

## 2. 固定演示输入

每次彩排和现场都使用同一句输入，便于比较规划和商品结果：

> 刚提新能源 SUV，预算 3000，经常带 3 岁孩子长途出行，已有行车记录仪。

讲解时重点观察：

- 预算为 3000 元，模块预算加总不超过总预算。
- “已有行车记录仪”不会被当作仍需重复购买的缺口。
- 儿童同行、长途出行会进入规划依据，并可能触发受控自适应模块。
- 搜索关键词必须属于各自模块，不能包含 URL、工具名或控制指令。

## 3. 面试前一天：代码与自动化预检

项目要求 Node 22。先确认版本和工作区：

```bash
node --version
git status --short
```

首次安装或 lockfile 变化后运行 `npm ci`，随后执行：

```bash
npm run test:unit
npm run eval:agent
npm run test:e2e
npm run check
```

四项都应通过。若要维护次级隔离模式，可另外运行 `npm run demo:interview:verify`；它不会检查淘宝登录态，也不会产生真实淘宝调用，不能替代下面的本机真实搜索验收。使用 PostgreSQL 作为演示运行时或准备展示生产部署时，再额外执行 migration、schema 和集成检查：

```bash
npm run db:migrate
npm run db:check
npm run test:integration
```

`npm run release:audit` 面向正式生产配置；本地演示采用 development、local runtime 或不安全 Cookie 时，它报告生产项未满足是预期现象，不能把它的失败说成应用功能失败。

## 4. 面试前一小时：本机运行预检

如果本次展示采用“受保护 Vercel Preview + Neon PostgreSQL + 本机淘宝 Worker”，不要运行本地网页。当前 Hobby 无法保护固定 Production 域名，所以不得用固定 Production owner 做这条演示。先确保 Preview 完成 migration、固定 owner 和 Vercel 外层保护验证；再在受控终端加载正式 PostgreSQL/TLS/固定 owner 配置，为当前电脑签发设备 Token。首次配置依次运行：

```bash
npm run executor:provision -- --capabilities module_search,add_to_cart
npm run demo:cloud:prepare -- --url https://受保护的内部验收地址
SCENECART_API_URL=https://受保护的内部验收地址 npm run executor:configure
npm run demo:cloud:configure
npm run demo:cloud -- --url https://受保护的内部验收地址
```

`executor:provision` 先把 SceneCart 设备 Token 安全写入本机；`executor:configure` 再隐藏保存精确的 `SCENECART_VERCEL_PROTECTED_ORIGIN` 和 `SCENECART_VERCEL_PROTECTION_BYPASS_SECRET`，`demo:cloud:configure` 将已签发设备 Token 复制到云端演示配置。Bypass 只穿过 Vercel Protection，不能替代设备鉴权；缺任一凭据都必须失败。它们只保存在本机 `0600` 环境文件，不进入日志、仓库、浏览器或公开 Demo。淘宝桌面版尚未就绪时启动器会退避探测，恢复后再继续；它不是部署命令，也不能代替 migration 和保护验证。

下方 4.1–4.3 是纯本地网页演示路径。云端演示仍需执行 Doctor，但不需要再运行 `npm run dev`。

### 4.1 配置演示环境

`.env.local` 至少确认以下值，不要在录屏或投屏中展示令牌和 Key：

```dotenv
SCENECART_PRODUCT_MODE=development
ALLOW_DEMO_CART_FALLBACK=false
TAOBAO_EXECUTION_BACKEND=local_executor
TAOBAO_NATIVE_MCP_URL=http://127.0.0.1:3654/mcp
TAOBAO_SOURCE_APP=SceneCartAI
SCENECART_ENABLE_MCP_DEBUG=false
RUNTIME_STORE=local
SCENECART_LOCAL_RUNTIME_PERSIST=true
```

这里显式关闭 demo cart，是为了让面试中的失败保持真实。DeepSeek Key 可以配置；没有 Key 时，需求理解和规划会使用透明的确定性 fallback，不影响真实淘宝搜索的来源。

### 4.2 启动淘宝和 SceneCart

1. 启动淘宝桌面版。
2. 在客户端开启 AI 应用授权 / 官方本地 MCP，并尽量提前登录淘宝。
3. 在项目目录运行 `npm run dev`。
4. 记下终端打印的实际“页面地址”和“执行器设置”地址。端口被占用时不要继续使用旧书签。

首次配置设备时：

1. 使用服务端测试夹具或受控运维流程，为固定 owner 预置设备；至少保留“商品搜索”能力，只有确认淘宝 MCP 暴露 `add_to_cart` 时才开启真实加购。
2. 将原始设备 Token 直接交付到本机安全配置流程；正式网页不签发 Token，也不要求 SceneCart 登录。
3. 在交互式终端运行 `npm run executor:configure`，按提示写入实际地址和隐藏凭据。

默认 `npm run dev` 会热发现新令牌并启动 `worker:local`，同时监督唯一的 Worker；异常退出后会按最多 30 秒的指数退避自动重启，无需另开终端。每次 Worker 进程启动都会暂停启动前遗留的 Agent 搜索，必须回网页确认继续；若淘宝 MCP 尚未加载，Worker 会保持 `mcp_unavailable` 状态、停止领取任务并自动探测。网页会区分“等待启动确认”和“等待淘宝工具恢复”，不会把队列误报成正在真实搜索。

### 4.3 Doctor 验证

运行：

```bash
npm run executor:doctor
```

继续彩排前必须看到以下三项全部为 `PASS`：

- `taobao_mcp`：MCP 可连接且暴露 `search_products`。
- `scenecart_api`：地址正确、服务健康、执行器协议一致。
- `device_token`：令牌有效且至少具备 `module_search`。

Doctor 不执行搜索，也不证明淘宝账号仍处于登录态；第一条真实搜索任务才是登录态验收。

如果 `taobao_mcp` 暂时失败但另外两项通过，可以保持 `npm run dev` 与淘宝桌面版打开继续排障：页面中的搜索任务会安全留在持久队列，尝试次数不会因就绪等待而增加。MCP 工具恢复后 Worker 会自动上线并领取未完成搜索；演示前仍应重新运行 Doctor，确认三项全部为 `PASS`。

## 5. 面试前预热：必须保存一次真实结果

1. 打开首页并选择“新车选购”。
2. 输入固定需求，确认 Scene Brief 中的预算、车型、儿童同行、长途出行和已有行车记录仪。
3. 生成规划，展开 Agent 自检，确认预算守恒、模块优先级和差异化搜索意图。
4. 选择“平衡”档位并确认规划，只点击一次开始搜索。
5. 打开 `/hosted`，确认设备在线，并观察每轮最多只有一个 `module_search` Job 被领取。
6. 回到主页面，等待至少一个模块显示真实候选；最好让整轮工作流完成。
7. 打开候选的淘宝详情链接，抽查标题、价格、店铺和商品 ID / 链接确实来自当前淘宝结果。
8. 查看模块复盘、搜索轨迹、完成报告与预算组合。
9. 刷新页面或返回首页，再从“最近购物任务”恢复同一 Session，确认候选仍存在。
10. 保留这个未归档 Session，作为现场掉登录或无 MCP 时的真实结果备份。

另外用一个非最终展示 Session 彩排一次登录失效分支：至少拿到一个真实候选后让一次后续搜索遇到登录失效，确认网页展示暂停文案、两个操作按钮和已有候选；恢复登录后确认无需重启 Worker，只有点击“重新登录后继续搜索”才重试失败模块。该彩排用于验证恢复机制，不要清空已经保存的正式演示 Session。

真实结果的判断依据应同时满足：Doctor 通过、`/hosted` 中对应 `module_search` Job 完成、本地执行器在线、候选具有当前淘宝商品标识或详情链接。不能只凭卡片上写着“淘宝”判断来源。

建议在预热成功后录一段最新版本的本地屏幕录像，覆盖 Doctor、Job 完成和结果页。录像只是极端故障时的证据备份，不替代现场应用，也不要使用与当前 UI 不一致的旧视频。

## 6. 现场正常路径（约 7 分钟）

### 0:00–0:40：定位产品

打开首页，简短说明五个场景共享同一套配置驱动工作流，本次选择真实设备回归最完整的新车场景。

### 0:40–1:30：需求理解

输入固定需求，展示结构化 Scene Brief 和可编辑确认点。强调模型只做结构化提案，关键状态由后端校验和持久化。

### 1:30–2:30：规划与 Guardrail

展示预算分配、模块优先级、搜索策略、已有物品排除和 Agent 自检。指出 DeepSeek 不可用时会走确定性 fallback，但不会因此伪造淘宝商品。

### 2:30–4:10：持久工作流与真实搜索

确认规划并启动一次搜索。切到 `/hosted` 展示 Job Queue、在线设备、决策轨迹和模型 fallback，再回到主页面观察 SSE 回填。说明浏览器只是观察者，关闭页面也不会中断已经持久化的工作流。

如果现场搜索等待超过可接受时间，先看当前网页是否已经进入登录暂停；若是，按第 7 节选择继续搜索或使用部分结果。普通等待再从首页恢复预热 Session，不要重复点击开始、不要切 Qoder，也不要临时打开 mock provider。

### 4:10–5:30：推荐与预算组合

展示一个真实候选的标题、价格、店铺、适配理由和风险提示，再展示候选池复盘、搜索轨迹、完成报告和预算内购买组合。强调组合只能引用当前候选，且不能越过预算和必需模块 Guardrail。

### 5:30–6:30：人机协作和购买确认

采纳建议组合，说明它只是产品内待处理清单。选择一件商品，展示逐件显式加购确认；若登录态和 `add_to_cart` 能力稳定，可完成一次真实加购。随后进入购买确认页，并打开淘宝购物车查看真实条目。

若真实加购失败，保留失败状态并说明需要恢复登录、授权或规格后重试。不要为了画面完整临时启用通用 demo cart；若决定改走隔离演示，应结束真实链路讲解后单独运行 `npm run demo:interview`，并明确切换了数据来源。

### 6:30–7:00：收束安全边界

明确说明：SceneCart 负责“理解需求、规划、搜索、推荐、组合和显式加购”，边界止于购买确认页与淘宝购物车；它不会自动提交订单、结算或支付，也不会伪装删除真实淘宝购物车商品。

## 7. 淘宝掉登录时怎么处理

### 搜索前或搜索中掉登录

1. 保留当前网页。真实工具返回登录错误后，Worker 会停止领取新任务，当前工作流进入暂停；它不会自动回退 mock，也不会自动跳过失败模块。
2. 网页应显示“搜索已暂停，已有结果不会丢失”，并说明登录失效前已经回填的候选数量。必要时打开 `/hosted` 展示设备处于等待淘宝登录、当前 Job 失败且同一 Session 仍被持久化。
3. 选择恢复搜索时，在淘宝桌面版完成登录并保持主界面打开。Worker 会低频检测登录恢复，无需重启；恢复在线也不会自动重放失败任务。
4. 回到原 Session，点击“重新登录后继续搜索”。这次显式确认会重试同一个失败模块，并从原工作流继续；已完成模块不会重跑，也不会创建一轮假的替代结果。
5. 不想等待重新登录时，点击“用已有部分结果进入选购”。结果页只展示登录失效前已经保存的真实候选，未完成模块继续标出缺口；恢复登录前，新的搜索、补搜和真实加购保持禁用。
6. 若进入部分结果后又决定恢复搜索，点击“返回暂停页”，完成登录后再按第 3–4 步继续。
7. 只有当前 Session 尚未取得任何候选时，才从首页“最近购物任务”恢复预热 Session。主动说明那是预热时由同一正式链路持久化的真实结果，不是本次失败后生成的 mock。

### 拿到候选后、加购前掉登录

直接点击“用已有部分结果进入选购”，继续展示推荐、组合采纳和购买确认；恢复登录前，加购按钮会保持禁用或真实失败状态。本次搜索来源已经得到证明，不需要为了补齐画面重新搜索。

## 8. 无 MCP 时怎么兜底

先运行 `npm run executor:doctor` 确认是 MCP 故障，而不是页面端口或设备令牌错误：

- `taobao_mcp` 失败：检查淘宝桌面版是否启动、AI 应用授权 / MCP 是否开启，以及 `TAOBAO_NATIVE_MCP_URL`。
- `scenecart_api` 失败：使用 `npm run dev` 打印的实际页面地址重新运行 `executor:configure`。
- `device_token` 失败：通过受控服务端运维流程撤销并轮换固定 owner 的设备 Token；不要尝试从网页签发。

当已通过启动确认的 Worker 心跳仍正常、但淘宝工具临时不可达时，购物进度页和 `/settings/executor` 会把设备显示为 `mcp_unavailable` / 等待淘宝桌面版工具恢复。此时 Worker 不领取 Job；尚未领取的搜索保持 `pending` 且不消耗尝试次数。同一 Worker 内工具列表恢复后会切回在线并继续这轮已确认队列。若 Worker 进程重新启动，则历史工作流会重新进入启动待命，必须回网页点击“继续搜索”。这与 `authentication_required` 不同：真实调用已经报告掉登录后，系统仍必须等待用户登录并明确点击“重新登录后继续搜索”，也允许直接使用已有部分结果。

若 MCP 在一次真实加购期间断开，不要把恢复连接理解为自动重试：加购动作不会自动重放，失败状态保留，必须由用户确认实际购物车状态后再显式决定是否重新加购。

若现场无法恢复 MCP，按以下顺序降级：

1. 当前 Session 已有候选时，点击“用已有部分结果进入选购”，继续使用本次真实搜索已经保存的结果。
2. 当前 Session 没有候选时，恢复面试前保存的真实结果 Session，展示持久候选和完整决策证据。
3. 展示 `/hosted` 中相应 Session 的已完成 Job、设备和执行轨迹。
4. 必要时播放预热时录制的当前版本短视频，保留真实链路证据优先级。
5. 只有前三种真实证据路径都不适合继续操作时，才结束当前真实链路并运行 `npm run demo:interview`。开场必须说明它使用 2026-08-08 历史快照，未覆盖模块为固定演示候选，淘宝 search / add / order / payment 调用均为 0。
6. 在隔离演示中，“加入购物车”只会进入 SceneCart 演示购物车，不能展示成淘宝加购成功。

禁止把以下内容当作真实搜索兜底：

- 把历史 `codex_hosted` 任务或已经退役的 Qoder / experimental bridge 说成当前正式链路。
- 把模型 fallback 生成的规划等同于淘宝商品结果。
- 把 demo cart 条目说成真实淘宝购物车成功。
- 为了通过页面而开启 production 中禁止的 Mock 或调试端点。

## 9. 附录：开发回退与次级隔离演示的区别

通用开发回退中的 demo cart 只在以下条件同时满足时生效：

1. `SCENECART_PRODUCT_MODE=development`。
2. `ALLOW_DEMO_CART_FALLBACK=true`。
3. 加购走同步开发兼容 provider，并在该次真实调用中抛出异常。

正式产品模式无条件关闭回退。正式演示使用的 `local_executor` 是异步 Job 链路；它失败时会保留为可重试失败，不会自动生成 demo item。因此，面试彩排建议设置 `ALLOW_DEMO_CART_FALLBACK=false`，让画面和口径保持一致。

`npm run demo:interview` 的隔离演示购物车是另一条显式路径：Launcher 同时为 Server 与专用 Worker 设置 `SCENECART_INTERVIEW_DEMO=true`，并保持 `ALLOW_DEMO_CART_FALLBACK=false`。专用 Worker 不调用淘宝，而是把带有 `execution_mode=interview_demo` 的结果写回；服务端只在该隔离开关存在时把条目标为 `cart_source=demo`。因此这条路径可以安全展示购买确认，但绝不能被描述成真实加购失败后的自动回退或淘宝购物车成功。

## 10. 最终核对清单

代码与自动化：

- [ ] Node 为 22.x。
- [ ] `npm run test:unit`、`npm run eval:agent`、`npm run test:e2e`、`npm run check` 全部通过。
- [ ] 面试使用的提交已推送，工作区没有意外修改或敏感文件。

本机运行：

- [ ] 淘宝桌面版已启动，官方本地 MCP 已开启。
- [ ] `TAOBAO_EXECUTION_BACKEND=local_executor`，未启用 Qoder / hosted / experimental provider。
- [ ] `npm run executor:doctor` 三项全绿。
- [ ] `/hosted` 显示设备在线且具备 `module_search`。
- [ ] 已验证只启动 `demo:cloud` 不会领取历史搜索，网页点击“继续搜索”后才执行。
- [ ] 已验证同一 Worker 内 MCP 暂不可达时网页显示等待恢复、Worker 不领取任务，工具恢复后继续已确认队列。
- [ ] 固定输入至少成功获得一个真实候选。
- [ ] 真实结果 Session 可从首页恢复，且没有被归档。
- [ ] 已彩排掉登录后的安全暂停；网页能展示“重新登录后继续搜索”和“用已有部分结果进入选购”两个分支。
- [ ] 已确认恢复登录不需要重启 Worker，且登录恢复本身不会自动重放失败任务。
- [ ] 已确认真实加购不会因 Worker、MCP 或登录恢复而自动重放。
- [ ] 已准备当前版本的本地短视频备份。

次级隔离模式（仅计划使用时检查）：

- [ ] 已明确告知面试官这不是面试主路径，也不证明当前淘宝能力。
- [ ] `npm run demo:interview:verify` 退出码为 0，报告显示 5/5 模块、`cart_source=demo` 和淘宝四类调用均为 0。
- [ ] 知道 `npm run demo:interview` 会自动走完整流程并停在购买确认页，结束时按 `Ctrl+C`。
- [ ] 能主动说明数据采集于 2026-08-08，未覆盖模块是固定演示候选，不是实时淘宝结果。
- [ ] 能指出页面中的“非实时结果”“历史快照”“固定演示候选”和“演示购物车”标识。
- [ ] 明确淘宝 search / add / order / payment 调用为 0，演示项只存在 SceneCart 内部。

现场表达：

- [ ] 能解释模板、DeepSeek、Guardrail、Job Queue、本地执行器和淘宝 MCP 的职责边界。
- [ ] 能展示一个候选为何适合当前场景和预算。
- [ ] 能说明掉登录后的暂停 / 恢复路径。
- [ ] 能区分模型 fallback、真实工具失败和 demo cart。
- [ ] 明确系统不会自动下单、提交订单或支付。
- [ ] 投屏前关闭含设备令牌、DeepSeek Key、Cookie 或淘宝隐私信息的页面。
