# SceneCart AI

SceneCart AI 是一个正在按正式产品架构推进的“场景化购物 Agent”。首页当前开放 **新车选购、露营准备、房间装饰、宿舍入学、搬家置办** 五个配置驱动场景；它们共享需求理解、规划、搜索、推荐与购买确认工作流。真实设备验收和面试演示仍以 **新车选购 / 新车用品首购** 为基准场景。

这个项目不是普通商品搜索页，也不是纯聊天机器人。它的重点是把用户原本需要自己完成的“买什么、先买什么、预算怎么分、每类商品怎么选”这套决策过程产品化。

## 当前能力

- 阶段式 Agent workflow：需求输入 -> 场景理解 -> 用户确认 -> 购物规划 -> 用户确认 -> 串行搜索 -> 推荐结果 -> 快捷调整 -> 购物清单确认
- 后端 Agent orchestration：前端不直接拼数据，核心流程由 `lib/agent` 统一编排
- DeepSeek 接入层：用于 `parse_scene`、`personalize_template`、`review_plan`、`refine_plan`、候选池复盘与商品适配说明；缺少 key、超时或结构异常时自动走 mock / heuristic fallback
- 场景模板 + LLM 补充：模板提供稳定结构，模型负责裁剪、排序、预算策略和模块级 `search_strategy`，后端会做预算归一化、关键词差异化修复与搜索策略兜底，保证模块预算加总等于用户预算，并尽量避免不同模块搜索同一批商品
- 受控自适应模块：当用户明确提出儿童同行、宠物、长途出行或专属装载等模板未覆盖的需求时，DeepSeek 可在基础模板之外新增最多 2 个模块；服务端会校验模块前缀、预算比例、可选性和业务禁区，并在用户确认规划后才允许进入搜索
- Agent 方案自检：规划生成后会产出 `plan_review`，在用户确认前检查预算分配、模块覆盖、关键词差异化和风险点
- AI 执行档位：用户可在规划确认页选择保守 / 平衡 / 探索，服务端会写回 `agent_directives`，影响后续搜索深度、补搜策略和恢复边界
- AI 搜索策略 + 增量候选排序：搜索结果会经过 Candidate Ranker，根据 AI 生成的主搜索词、备用搜索词、包含词、排除词、排序关注点、验收信号、拒绝信号、预算、偏好、已有/排除项和店铺信号选出稳妥 / 性价比 / 升级三档；Agent 补搜时会按商品 ID 合并新旧证据并重新分档，不会用第二轮结果覆盖首轮有效候选。规划词、候选复盘建议、运行时改写和用户手动编辑统一经过模块语义与指令安全校验，旧会话异常词安全回退，新提交异常词返回明确 400
- 首选商品真实详情证据：每个模块完成候选重排与 AI 复盘后，只为最终第一名创建只读 `product_detail` Job；当前 Worker 打开其可信淘宝/天猫链接并读取可见详情，服务端校验 search Job、workflow、模块、商品 ID、URL 和采集时间后生成简短依据。页面原始正文不落盘，只保存正文哈希和在服务端白名单中实际命中的少量事实；读取失败会明确降级为搜索摘要判断，绝不伪造“详情已验证”，也不会触发加购
- 搜索后 Agent 复盘：每个模块搜索后会生成 `module_reviews`，并在同一次短超时 DeepSeek 调用中批量生成最多三条、与候选商品一一对应的适配理由；商品 ID 和理由长度经过严格校验，无 key、超时或结构异常时完整保留启发式评估与规则理由，不增加逐商品模型请求
- Agent 搜索决策轨迹：每个模块搜索会写入 `module_search_traces`，记录首轮词、备用词、补搜原因、每次返回数、候选池复盘和下一步建议，让 AI 的执行判断可解释、可恢复
- Agent 完成报告：自动搜索结束时基于必需模块覆盖、候选质量、真实价格压力、容错跳过和最终停止决策生成方案级验收结论；推荐页与执行台都能查看为什么停止、当前缺口和下一步，用户还可显式授权补齐空白模块或增量优化候选偏薄模块
- 预算安全购买组合：搜索完成后，Agent 会在真实候选中给出一套不超过用户总预算、每模块最多一件并优先覆盖必需模块的建议组合；常规组合由 chat 提案，存在预算压力或必需覆盖缺口时可升级 reasoner，后端会拒绝伪造商品、越预算和降低安全覆盖的输出，且绝不会自动加购或下单
- 上下文感知调整建议：同一次购买组合决策会结合真实价格压力、候选薄弱模块和当前取舍，从场景允许的快捷操作中挑选最多 3 个下一步建议；前端展示理由与预计影响模块，模型不能发明动作、引用规划外模块或自动执行调整，旧会话仍兼容原有固定操作入口
- 服务端 Agent 决策循环：用户确认规划后只需启动一次，后端会消费 AI 规划顺序、执行档位、候选池复盘和工具状态，逐轮决定搜索、补搜、容错跳过、等待工具或结束，并把动作写入 `agent_decisions`
- 浏览器断线续跑：`workflow-runner` 持久化运行 ID、当前模块、自动续跑开关和状态转换；本地执行器每次回填后由服务端自动排队下一模块，关闭或切换页面不会中断整轮搜索
- 账号级任务续接：首页读取隐私收敛的服务端会话摘要，展示最近购物任务的预算、模块覆盖和执行状态；用户可跨浏览器恢复任意任务，完整 Agent context 只在点击继续后按所有权校验加载
- 安全任务归档：首页可将旧购物任务移入折叠归档区并随时恢复；归档会停止 Agent 自动推进、取消尚未领取的执行器任务，并阻止 Worker 继续领取或创建该会话的新任务，已经被领取的动作则保留真实状态而不伪装成已取消
- 会话所有权 fail-closed：PostgreSQL 与本地认证运行时都要求 `owner_id` 精确匹配；早期无 owner 的匿名会话不会向任意登录账号暴露，只在显式匿名开发模式中保留兼容读取
- 多实例并发保护：PostgreSQL 正式运行时使用事务级 advisory lock，同一 Session 同一时刻只允许一个 Web 实例计算下一动作、回填工具结果并入队
- 服务端中断恢复：独立 `worker:recovery` 或云端 Cron 会扫描持久化 Job/Session，重放已提交结果并补排下一模块，不依赖浏览器或某台执行器恰好空闲
- Agent Runtime 2.0：平衡/探索档位可由 DeepSeek `decide_next_action` 提议下一步动作；常规模块调度使用低延迟 chat，只有补搜、失败恢复或市场预算压力出现时才升级 reasoner。模型可以自主改写品牌、功能和价格带搜索词；若模型只遗漏品类词但所有筛选词均能由当前模块策略解释，后端会补齐品类锚点后继续执行，跨品类词、URL、工具名、命令参数和提示词控制语句仍会被拒绝。动作白名单、模块合法性、首搜前置条件、置信度、工具预算和重复调用继续由 guardrail 校验
- Agent 建议补搜：当候选偏少或质量不足时，推荐页会展示建议搜索词，用户可以一键按 Agent 建议补搜当前模块
- 快捷调整影响说明：用户点击快捷调整后，系统会生成 `last_refinement`，说明哪些模块需要重搜、哪些候选可复用、哪些模块被移除以及原因
- 生产运行时：支持 PostgreSQL 持久化、邮箱登录、HttpOnly 会话、按用户隔离的购物 Session、持久 Job Queue 和执行事件
- 本地执行器：商品搜索与显式确认后的真实加购由独立 Worker 优先直连淘宝桌面版官方 HTTP MCP，不再经过 Qoder 或 Next.js 长请求；若 HTTP MCP 对只读搜索误报内测限制或传输中断，搜索可安全降级到同一桌面客户端自带的官方 CLI。加购不会走 CLI 自动兜底，也不会因传输恢复而重放
- 启动待命：Worker 每次启动都会先让云端仍在自动推进的历史搜索进入安全暂停，待处理 Job 保留但不可领取；必须回到网页点击“继续搜索”才会从断点执行。Worker 在线后由用户新开始的搜索正常直接运行
- 本地链路自愈：`npm run dev` 会监督唯一的正式 Worker，异常退出时按上限 30 秒的指数退避自动重启；淘宝 MCP 暂不可达或工具层未加载时，Worker 保持 `mcp_unavailable` 心跳、停止领取任务并持续探测，网页会显示“正在等待淘宝桌面版工具恢复”。同一 Worker 内工具恢复后会继续已经网页确认的队列；若 Worker 进程重新启动，历史搜索会进入待命并等待网页再次确认
- 实时回填：搜索、重试、Agent 状态转换和加购事件通过 SSE 推送到当前会话，并以短轮询作为断线恢复兜底；页面不占用淘宝执行长请求
- 可恢复事件流：SSE 使用事件游标与 `Last-Event-ID` 续传，浏览器短暂断线后不会重复丢失执行进度
- 运行时可观测性：执行台展示队列积压、在线设备、失败/取消任务、最久等待时间与模型 guardrail fallback；发布就绪页会进一步区分 DeepSeek“已配置”与“本进程最近真实调用成功”。每个购物 Session 还会持久化隐私安全的 `llm_calls`，只记录任务、模型、真实/降级模式、耗时、原因和时间，不保存 Prompt、用户原文或模型原始输出；结构化模型提案若在后续业务 Guardrail 被拒绝，对应凭证也会被精确改写为 fallback，避免把“模型有返回”误报成“模型结果已采用”
- 可操作运行告警：执行台根据队列等待、执行器在线状态、任务失败率、模型 fallback 和 guardrail 拒绝率生成分级告警与修复建议
- 能力感知执行器：设备默认只获得 `module_search`，`add_to_cart` 必须注册时显式开启；任务只会被匹配设备领取，就绪度、MCP 状态和执行台会分别显示真实搜索与真实加购是否可用
- 执行器协议握手：Worker、Doctor 与服务端共享协议版本，版本缺失或不兼容时在领取任务前返回明确错误，避免旧执行器运行到一半才失败
- 设备权限审计：设备注册、真实加购权限开关和令牌撤销都会生成用户隔离的审计事件，并在设置页和后端执行台中可见
- 失败任务恢复：完成任务继续幂等去重；失败或取消的搜索/加购只有在用户再次确认后才会重置并重新入队，执行台提供明确的“重新入队”入口
- 发布就绪检查：`/api/runtime/readiness` 将开发态与正式可发布状态分开，逐项检查 PostgreSQL、认证、HTTPS Origin、安全 Cookie、DeepSeek、本地执行器和旧 Mock 配置
- Agent 质量门槛：`npm run eval:agent` 离线检查多组新车需求的预算守恒、模块覆盖、优先级层次、搜索词差异化和安全边界；`npm run eval:agent:live` 通过专用启动器读取本地 Key 并显式调用 DeepSeek，缺少 Key 或全部降级时会直接失败，避免产生“在线评测实际未调用模型”的假阳性
- 生产安全基线：异步 scrypt 密码哈希、认证限流、同源写请求校验、HttpOnly Cookie 和安全响应头
- 淘宝桌面版工具层：正式路径为 `local_executor -> 淘宝桌面版官方 HTTP MCP`，只读搜索保留 `taobao-native` 官方 CLI 安全兜底；原有 Qoder 直连、Codex hosted 和 experimental bridge 仅保留为开发兼容路径，不属于正式演示链路
- 商品搜索链路：当前主流程可串行搜索规划中的各个模块，并生成推荐商品卡片
- 加购结果分级：高风险动作必须显式确认，服务端和 MCP executor 会双重校验；demo cart 只覆盖 development 中同步兼容 provider 的失败，正式 `local_executor` 任务失败会明确保留为可重试失败
- 预算组合采纳：用户可把 Agent 的预算安全购买组合采纳为产品内待处理清单，再逐件显式确认真实加购；采纳不等于淘宝加购，也不会触发批量交易
- 购物车来源隔离：确认页允许用户移除明确标记的产品内演示项，并同步预算组合进度；真实淘宝项只提供淘宝购物车管理入口，服务端拒绝伪装删除或改动来源不明的历史条目
- 后端执行台：可查看当前 session、执行进度、工具日志、规划和购物清单
- 文档材料：包含产品复盘与技术架构文档，适合面试汇报和架构图整理

## 技术栈

- Next.js App Router
- React
- TypeScript
- Tailwind CSS
- shadcn 风格基础组件
- Framer Motion
- DeepSeek API
- 淘宝桌面版官方本地 HTTP MCP adapter

## 公开体验：自动演示 + 手动探索

仓库采用“同一共享实现、两个独立应用”的结构：正式产品仍从仓库根目录构建；公开体验由 `apps/public-demo` 独立静态构建，只导出 `/`、`/demo`、`/product-guide` 和 404。Demo 直接复用正式产品的需求确认、购物规划、搜索进度、推荐、加购、购物清单与产品说明组件，不维护第二套产品交互；正式产品本身不再暴露 `/demo` 路由。

线上长期保留两个职责明确的固定域名：正式产品使用 `https://scenecart-ai.vercel.app/`，公开体验使用 `https://scenecart-public-demo.vercel.app/`。正式产品的登录页和已登录顶部导航都提供“观看 Demo”入口，并在新标签页打开 `https://scenecart-public-demo.vercel.app/demo?autoplay=1`；这样不会中断正在填写的需求或购物任务。公开 Demo 仍是完全独立的冻结应用，不会继承正式站登录态，也不会连接正式数据库、DeepSeek、淘宝账户或本地执行器。

区别只在数据与执行层：新车主场景使用 2026-08-08 的脱敏历史快照，其余已开放场景使用明确标注的本地冻结样本；这些样本不代表实时淘宝商品。Demo 不要求登录，也不会调用模型、数据库、淘宝 MCP、真实购物车、订单或支付能力。访问者可以按正式产品流程手动修改预算、查看规划、展开备选、加入演示清单和移除商品；右上角“启动自动演示”会用可见鼠标逐步点击同一批真实控件，播放中点击页面任意位置会暂停，点击“继续演示”会从中断步骤恢复。

本地查看：

```bash
npm run demo:dev
```

然后打开终端打印地址；根路径和 `/demo` 都进入同一冻结体验。访问 `/demo?autoplay=1` 会在首次加载后自动启动现有演示，普通 `/demo` 仍保持手动探索；用户重置后不会因为查询参数再次自动启动。每个分类默认只展示一个主推荐及推荐理由，点击后才展开传统商品列表样式的备选。公开 Demo 中真实产品按钮“加入购物车”的结果会明确标记为“演示清单”，只改变当前浏览器内存状态，不代表真实淘宝加购。设置、执行详情和淘宝购物车入口在冻结模式中只给出本地说明；商品详情保留正式产品的链接行为，可由体验者主动打开对应淘宝商品页，自动演示不会代为打开。

独立 Demo 构建使用 `npm run demo:build`；它会同步冻结素材、执行静态导出并验证没有登录、设置或 API 路由泄漏。Vercel 项目 `scenecart-public-demo` 的 Root Directory 固定为 `apps/public-demo`、不配置任何正式环境变量，并从完整仓库提交构建，以便继续复用共享组件。

## 面试演示：从网页触发真实淘宝全流程

面试主路径是在 SceneCart 网页上逐步输入需求、确认 Scene Brief、确认规划并开始搜索。网页把任务写入持久 Job Queue，本机 `local_executor` 领取任务后优先直连淘宝桌面版官方 HTTP MCP，再把真实候选回填到同一个 Session；若桌面版 HTTP MCP 端口失效但官方 CLI 执行层仍可用，只读搜索会在同一次 Job 内安全降级，不消耗额外业务重试。面试前先运行 `npm run executor:doctor`，再用 `npm run dev` 启动网页和正式 Worker；不要切换到 Qoder、Codex hosted、experimental bridge 或 mock provider。

淘宝 MCP 暂不可达和淘宝掉登录是两种不同状态。前者会显示工具恢复提示，Worker 不领取新任务并自动退避探测；同一 Worker 内连接恢复后，已经网页确认的搜索队列会继续。若 Worker 进程重新启动，历史搜索会等待用户点击“继续搜索”。真实调用明确发现淘宝掉登录时，网站则显示“搜索已暂停，已有结果不会丢失”：此时必须先在淘宝桌面版重新登录，再由用户点击“重新登录后继续搜索”才会重试失败模块，登录恢复本身不会自动重放；也可点击“用已有部分结果进入选购”。已完成模块不会重跑，真实加购也不会因 MCP 或登录恢复而自动重放。

### 次级可选：隔离演示模式

只有现场 MCP 无法恢复、且已经明确结束真实链路讲解时，才可运行隔离模式：

```bash
npm run demo:interview
```

该命令会启动隔离的 SceneCart 服务和专用演示 Worker，自动走完产品 UI 流程，并让浏览器停在最终“购买确认清单”；按 `Ctrl+C` 关闭。它不要求淘宝登录，也不会连接淘宝 MCP。已覆盖的新车模块使用 **2026-08-08** 采集的淘宝历史搜索快照；快照未覆盖模块使用醒目标注的固定演示候选。它只能作为明确披露的数据演示，不能作为面试主路径，也不能证明网页当前触发了真实淘宝搜索。

演示模式中的淘宝 `search`、`add`、`order`、`payment` 调用均为 **0**。用户确认“加入购物车”后，商品只进入 SceneCart 产品内的“演示购物车”，不会进入真实淘宝购物车，更不会下单或支付。它也显式关闭通用 `ALLOW_DEMO_CART_FALLBACK`，只接受专用演示 Worker 的隔离结果。

如需维护这条次级隔离模式，可用无界面命令验收：

```bash
npm run demo:interview:verify
```

验收成功会退出码为 0，并在被 Git 忽略的 `.data/interview-demo/` 写入最终页面截图和结构化报告。这个结果只证明隔离演示可重复，不属于真实淘宝验收；真实能力仍以 Doctor、正式 Worker、当前 Job 和官方 MCP 回填为准。

## 快速开始

```bash
npm install
npm run dev
```

启动器会同时检查 IPv4 loopback 和 Next.js 的 IPv6 默认监听地址。若 3000 被其他应用占用，会自动选择下一个真正可用的端口，并在终端打印准确的首页与执行器设置地址；不要继续使用旧的固定书签。需要固定端口时设置 `SCENECART_DEV_PORT`，或运行 `npm run dev -- --port 3001`。

`npm run dev` 现在是一命令开发入口：它先启动网页；如果 `.env.local` 已配置 `SCENECART_DEVICE_TOKEN`，会在网页健康后自动启动正式 `worker:local`。首次使用时可以保持该命令运行，完成设备注册和 `executor:configure` 后，启动器会热发现新令牌并自动接入 Worker，不需要重启网页或再开第二个终端。Worker 异常退出时，启动器会按 1 秒起、最多 30 秒的指数退避自动重启；同一时间只保留一个 Worker，令牌更新时会安全切换。每次 Worker 进程启动都会先暂停历史搜索并等待网页点击“继续搜索”；淘宝 MCP 尚未就绪时也不会领取任务。开发编译默认写入独立的 `.next-dev`，因此运行中的本地演示不会再与 `npm run build` 的 `.next` 产物互相覆盖。`npm run dev:web` 只启动 Next.js，供 E2E、纯 UI 调试或需要手动管理 Worker 时使用；`dev:auto` 保留为 `dev` 的兼容别名。若 `3000` 已被其他应用占用，启动器会选择下一个可用端口并在终端打印准确地址；配置脚本和 Doctor 会自动识别该 SceneCart 实例。

网页部署在 Vercel、运行时使用 Neon PostgreSQL，而淘宝仍由面试电脑执行时，使用云端面试启动器：

```bash
npm run demo:cloud:prepare -- --url https://你的正式域名
npm run demo:cloud:configure
npm run demo:cloud -- --url https://你的正式域名
```

`prepare` 只需在首次接入或更换云端地址时运行：它保留本地 `SCENECART_API_URL` 和本地设备令牌，只新增云端地址，并把恢复密钥保存到 Git 忽略、权限 0600 的本机文件。云端 `/settings/executor` 注册设备后运行 `demo:cloud:configure`，隐藏保存独立的 `SCENECART_CLOUD_DEVICE_TOKEN`；它不会覆盖本地令牌。`demo:cloud` 用于面试开始前约 10–15 分钟到面试结束这段时间：先校验 HTTPS、production、PostgreSQL、执行器协议、淘宝 MCP、云端设备令牌和恢复密钥，再持续监督本机真实淘宝 Worker；在没有外部分钟级调度的 Hobby 环境中，还会同时维持恢复心跳。淘宝客户端暂未启动、未解锁或工具尚未加载时，启动器不会退出，而会按 2 秒起、最多 30 秒退避探测，恢复后自动继续启动；启动前遗留的搜索工作流会保持暂停，必须在云端页面点击“继续搜索”才会执行。云端契约、设备令牌、协议或恢复密钥错误仍会立即失败。它不会部署网页，也不会启动本地 Next.js。演示结束按 `Ctrl+C`，不要为了常驻而持续消耗免费额度。只做无常驻进程的单次快速预检可加 `--check`，它遇到 MCP 未就绪会立即退出；只有已经配置外部分钟级恢复调度时才加 `--skip-recovery`。

首次连接本地执行器时，在 `/settings/executor` 注册设备并复制一次性令牌。设备始终需要绑定 SceneCart 账号；即使主购物流程处于本地匿名开发模式，设置页也会先引导登录/注册，并在成功后自动返回。然后在项目目录运行：

```bash
npm run executor:configure
```

设置页复制的命令会显式携带当前 SceneCart 页面地址，即使 `3000` 被其他项目占用，也不会误用 `.env.local` 中的旧端口。配置脚本会隐藏令牌输入、保留其他配置、强制使用 `local_executor`，并将文件权限设为仅当前用户可读写。令牌不会进入 shell history。配置完成后可运行 `npm run executor:doctor` 做无副作用诊断；正在运行的默认 `npm run dev` 会自动启动 Worker。

打开终端实际打印的地址，例如：

```text
http://localhost:3000
```

开发模式默认可使用本地文件会话；正式运行请先完成下文的 PostgreSQL 和本地执行器配置。生产构建检查：

```bash
npm run check
```

`npm run check` 会依次执行项目预检、正式版与 Demo TypeScript 检查、正式产品构建和 Demo-only 静态导出门禁。预检会拦截本地密钥、硬编码用户路径、旧 MCP 环境变量、关键 Agent 架构文件缺失，以及 DeepSeek 校验、AI 搜索/执行策略、候选排序、候选池复盘、MCP 输入输出校验、高风险确认、错误脱敏、workflow 恢复等核心契约被破坏的情况。

或分别执行：

```bash
npm run preflight
npm run release:audit
npm run release:verify -- --static
npm run typecheck
npm run build
```

仓库包含 GitHub Actions 质量门禁，会在 PostgreSQL 16 服务上执行 migration、schema checksum 检查、真实 repository 集成测试、单元测试、生产构建和 Playwright E2E。

## 环境变量

复制 `.env.example` 为 `.env.local`，按需配置：

```bash
DEEPSEEK_API_KEY=
DEEPSEEK_CHAT_MODEL=deepseek-chat
DEEPSEEK_REASONER_MODEL=deepseek-reasoner
SCENECART_PRODUCT_MODE=production
ALLOW_DEMO_CART_FALLBACK=false
TAOBAO_EXECUTION_BACKEND=local_executor
TAOBAO_NATIVE_MCP_URL=http://127.0.0.1:3654/mcp
TAOBAO_SOURCE_APP=SceneCartAI
EXECUTOR_TAOBAO_SEARCH_TIMEOUT_MS=60000
EXECUTOR_TAOBAO_CART_TIMEOUT_MS=60000
EXECUTOR_TAOBAO_AUTH_RECOVERY_POLL_MS=10000
EXECUTOR_TAOBAO_AUTH_PROBE_TIMEOUT_MS=10000
EXECUTOR_TAOBAO_READINESS_PROBE_TIMEOUT_MS=10000
EXECUTOR_TAOBAO_READINESS_BACKOFF_BASE_MS=2000
EXECUTOR_TAOBAO_READINESS_BACKOFF_MAX_MS=30000
SCENECART_ENABLE_MCP_DEBUG=false
RUNTIME_STORE=postgres
DATABASE_URL=postgresql://...
DATABASE_SSL=true
DATABASE_SSL_REJECT_UNAUTHORIZED=true
AUTH_REQUIRED=true
SCENECART_ACCESS_MODE=account
SCENECART_SINGLE_USER_ID=
APP_ORIGIN=https://your-scenecart.example.com
NEXT_PUBLIC_SCENECART_PUBLIC_DEMO_URL=https://scenecart-public-demo.vercel.app
SCENECART_API_URL=http://127.0.0.1:3000
SCENECART_DEMO_CLOUD_URL=https://your-scenecart.example.com
SCENECART_CLOUD_DEVICE_TOKEN=
SCENECART_DEVICE_TOKEN=
SCENECART_CRON_SECRET=
```

说明：

- `DEEPSEEK_API_KEY`：填写后会尝试启用真实 DeepSeek 能力；只有实际调用成功才标记为 connected。无 key、超时、非 JSON 或接口失败都会走 mock fallback。
- `SCENECART_PRODUCT_MODE`：本地开发使用 `development`；正式部署必须设为 `production`，此时系统强制禁止演示加购伪成功。
- `ALLOW_DEMO_CART_FALLBACK`：只可能在开发预览的同步兼容 provider 加购异常时生效；正式 `local_executor` 异步失败不会自动写入 demo item。设为 `false` 可在本地保持与正式失败语义一致。
- `DEEPSEEK_DISABLED=true`：仅用于自动化测试或离线诊断，显式禁止读取 `.env.local` 中的真实 Key，保证测试不会产生模型调用和费用。
- `DEEPSEEK_*_TIMEOUT_MS`：可按解析、规划、调整、方案复核、候选复核、Agent 决策、购买组合和推荐解释分别设置完整响应超时；计时覆盖响应头和正文读取，失败后使用经过校验的确定性方案继续流程。`DEEPSEEK_AGENT_CHAT_TIMEOUT_MS` 与 `DEEPSEEK_AGENT_REASONER_TIMEOUT_MS` 分别约束常规调度和复杂恢复决策，`DEEPSEEK_BUNDLE_TIMEOUT_MS` 约束最终预算组合提案，`DEEPSEEK_REQUEST_TIMEOUT_MS` 可作为其他未单独配置任务的统一覆盖值。
- `TAOBAO_EXECUTION_BACKEND`：真实淘宝路径固定使用 `local_executor`。未配置时同样默认走持久任务队列；历史 `qoder_cli`、`experimental_local` 配置只用于 readiness 识别误配置，已经不能执行。
- `codex_hosted` 仅保留为开发期任务兼容与历史数据读取；正式产品模式会阻断它。生产与面试的搜索、详情和显式加购都由 `local_executor` 执行。
- `SCENECART_ENABLE_MCP_DEBUG`：默认 `false`。仅开发环境显式设为 `true` 时开放手动 MCP 调试端点；production 始终返回 404，正常购物流程不依赖该接口。
- `HOSTED_WORKER_TOKEN`：只保留给旧 Codex hosted 开发兼容流程。正式产品模式会以 `410 legacy_hosted_disabled` 拒绝旧任务 API，生产环境必须删除该令牌并停止 `worker:codex`。
- `RUNTIME_STORE=postgres`：启用 PostgreSQL 用户、Session、任务与事件持久化；`local` 只适合开发和自动化测试。
- `SCENECART_LOCAL_RUNTIME_PERSIST`：本地开发默认为 `true`，把设备令牌摘要、登录会话和任务队列原子写入被 Git 忽略的 `.data/runtime/local-runtime.json`，完整重启后无需重新注册设备；自动化测试会显式关闭。正式环境仍必须使用 PostgreSQL。
- `DATABASE_URL`：PostgreSQL 连接串。配置后先运行 `npm run db:migrate`。
- `AUTH_REQUIRED=true`：正式部署必须开启，确保 Session、设备与任务按用户隔离。
- `SCENECART_ACCESS_MODE=single_user`：仅用于本地或受 Vercel Deployment Protection 保护的 Preview。配合既有 `app_users` 的 `SCENECART_SINGLE_USER_ID` 后不再显示应用登录页，但 Session、设备和任务仍固定绑定该 owner；Vercel Production 会直接拒绝该模式。
- `APP_ORIGIN`：正式产品允许发起写请求的网页 Origin；多个地址使用逗号分隔。
- `NEXT_PUBLIC_SCENECART_PUBLIC_DEMO_URL`：正式站顶部“观看 Demo”入口使用的独立公开 Demo HTTPS origin。留空时安全回退到 `https://scenecart-public-demo.vercel.app`；正式站会固定打开 `/demo?autoplay=1`，不会把正式账户或运行环境参数传给 Demo。
- `SCENECART_RELEASE_VERIFY_URL`：可选的正式发布探测地址；`npm run release:verify` 未显式传 `--url` 时优先使用它，否则使用 `APP_ORIGIN` 的第一个地址。
- `SCENECART_DEMO_CLOUD_URL`：可选的云端面试网页根地址；`npm run demo:cloud` 未传 `--url` 时优先读取它。该命令只接受非本地 HTTPS 地址。
- `SCENECART_CLOUD_DEVICE_TOKEN`：只保存在面试电脑 `.env.local` 的云端设备令牌；与纯本地 `SCENECART_DEVICE_TOKEN` 分离，不能上传 Vercel。
- `SCENECART_DEVICE_TOKEN`：在 `/settings/executor` 注册设备后一次性获得，配置在运行淘宝桌面版与本地执行器的机器，不应写入仓库。
- `SCENECART_CRON_SECRET`：至少 32 字符的独立高熵密钥，只用于保护服务端恢复扫描端点；不能复用设备 Token、DeepSeek Key 或用户密码。
- `SCENECART_RECOVERY_STALE_MS`：恢复调度失联阈值，默认 180000ms；readiness 会校验持久心跳，而不是只检查 Secret 是否存在。
- `executor:doctor` 和 `worker:local` 会直接读取 `.env.local`；也可以使用临时环境变量覆盖本地配置。Token 生成后无需把它写入命令历史。
- `worker:local` 在执行淘宝工具期间每 15 秒续租；服务端拒绝续租或连续心跳失败达到 `EXECUTOR_LEASE_FAILURE_LIMIT`（默认 3）时，会终止本地子进程且不使用失效租约回填。
- 执行器 API 请求默认 20 秒超时，可通过 `EXECUTOR_API_TIMEOUT_MS` 调整；进程收到退出信号时会中止当前外部工具调用，任务随后由服务端租约恢复。
- `TAOBAO_NATIVE_MCP_URL`：淘宝桌面版官方 Streamable HTTP MCP 地址，默认 `http://127.0.0.1:3654/mcp`。
- `TAOBAO_NATIVE_CLI_PATH`：可选的淘宝桌面版官方 CLI 路径。macOS 默认自动发现应用内置 CLI；仅用于只读搜索安全兜底，不用于加购。
- `TAOBAO_SOURCE_APP`：写入 MCP 工具参数的真实调用来源标识，默认 `SceneCartAI`。
- `EXECUTOR_TAOBAO_SEARCH_TIMEOUT_MS`：单次本地淘宝搜索上限，默认 60000ms，最低 15000ms。
- `EXECUTOR_TAOBAO_CART_TIMEOUT_MS`：单次真实加购上限，默认 60000ms。执行器不会在搜索或加购前后用页面导航工具预探测登录态，避免探针本身改变淘宝页面。
- `EXECUTOR_TAOBAO_AUTH_RECOVERY_POLL_MS`：只有真实调用已报告登录失败后，Worker 才会按此间隔检查淘宝登录是否恢复，默认 10000ms、最低 5000ms。
- `EXECUTOR_TAOBAO_READINESS_PROBE_TIMEOUT_MS`：每次无副作用 `tools/list` 就绪探测的超时，默认 10000ms、最低 3000ms。
- `EXECUTOR_TAOBAO_READINESS_BACKOFF_BASE_MS` / `EXECUTOR_TAOBAO_READINESS_BACKOFF_MAX_MS`：MCP 不可用时的指数退避起点与上限，默认 2000ms / 30000ms；探测成功后重置。
- `EXECUTOR_TAOBAO_AUTH_PROBE_TIMEOUT_MS`：鉴权恢复检查的单次超时，默认 10000ms、最低 5000ms。检测恢复后只恢复领取能力，不会自动重放失败任务。
- `TAOBAO_MCP_BASE_URL`：experimental local bridge 使用的淘宝 MCP bridge 地址。

不要提交 `.env.local`。项目 `.gitignore` 已默认忽略本地密钥、缓存、搜索结果 JSON、`.data`、`.next` 和 `node_modules`。

## 主要目录

```text
app/
  page.tsx                         主产品页
  hosted/page.tsx                  后端执行台
  api/                             后端 API routes

components/
  dashboard.tsx                    主购物 Agent 工作流 UI
  hosted-console.tsx               后端执行台 UI
  ui/                              基础 UI 组件

lib/agent/
  orchestrator.ts                  Agent 主编排
  workflow-runner.ts               服务端自主续跑、状态转换与模块串行编排
  workflow-recovery.ts             Worker 空闲时恢复中断的回填与后续模块
  decision-engine.ts               Agent 下一步动作决策与审计记录
  completion-review.ts             方案级覆盖度、质量缺口与停止理由验收
  runtime-v2.ts                    模型提议 + guardrail + 规则兜底
  scene.ts                         场景解析入口
  planner.ts                       模板规划 + DeepSeek 规划接入
  search-strategy.ts               纯搜索关键词与搜索策略归一化，供规划和旧会话恢复复用
  plan-reviewer.ts                 规划质量自检
  refiner.ts                       快捷调整重算
  candidate-ranker.ts              候选商品排序与三档推荐选择
  candidate-reviewer.ts            候选池质量评估、批量商品适配理由与规则 fallback
  product-matcher.ts               模块搜索与候选商品构造
  cart.ts                          加购与 demo cart fallback

lib/llm/
  deepseek.ts                      DeepSeek 调用、结构归一化与候选池复盘
  prompts.ts                       Prompt 模板
  mock.ts                          无 key / 调用失败时的 mock fallback

lib/mcp/
  client.ts                        执行 backend 选择
  executor.ts                      工具调用与日志记录
  local-executor.ts                持久任务模式 adapter
  hosted.ts                        Codex hosted worker 任务模式

lib/session/
  types.ts                         核心状态类型
  store.ts                         服务端 session store
  repository.ts                    local / PostgreSQL 统一 Session 接口

lib/runtime/
  local-repository.ts              开发与测试运行时
  postgres-repository.ts           PostgreSQL 正式运行时
  jobs.ts                          设备、队列、回填与执行事件

scripts/
  local-executor.mjs               独立淘宝 HTTP MCP 执行进程
  db-migrate.mjs                   PostgreSQL migration runner
  db-check.mjs                     schema 完整性与 migration checksum 检查
  executor-doctor.mjs              本地执行器无副作用连接诊断

lib/scenarios/
  五个场景的文案、字段、模板模块与快捷动作配置；面试验收基线为新车选购
```

## 核心 API

- `POST /api/scene/parse`：解析用户需求为 Scene Brief
- `POST /api/scene/plan`：基于场景模板和 DeepSeek 生成 Shopping Plan
- `POST /api/scene/refine`：根据快捷操作重算方案
- `POST /api/modules/search`：为指定模块搜索候选商品；可选 `keyword_override` 用于按 Agent 建议补搜
- `POST /api/agent/next-action`：根据当前 session 决定搜索、补搜、跳过、等待或结束
- `POST /api/agent/run`：用户确认规划后启动一次服务端工作流；工具回填会自动续跑后续模块
- `POST /api/agent/pause`：用户确认后协作式暂停自动推进；已被执行器领取的当前模块可以完成，但不会继续排队下一模块
- `POST /api/agent/resume`：保留原运行 ID、候选池、工具预算和已完成模块，从暂停位置继续
- `POST /api/agent/remediate`：用户显式确认后，可补齐完成报告中的未覆盖模块，或用 `scope=thin` 增量优化候选偏薄模块；始终保留不受影响的候选和已选商品
- `POST /api/cart/add`：尝试加购，要求 `confirmed: true`；开发预览可配置演示回退，正式产品模式只接受真实淘宝执行结果
- `POST /api/cart/remove`：仅移除产品内 `cart_source=demo` 的演示项，要求 `confirmed: true`；真实或来源不明的淘宝条目返回冲突并引导到淘宝购物车管理
- `POST /api/session/purchase-bundle`：显式采纳当前完成报告中的预算安全组合；服务端校验生成时间和候选白名单，只生成待处理清单，不会自动加购
- `POST /api/session/agent-directives`：用户确认规划前切换 AI 执行档位，写回当前 session 的 `agent_directives`
- `POST /api/session/budget-reallocation`：用户确认真实候选价格生成的跨模块预算建议；金额由服务端建议决定，保持总预算不变并仅失效受影响模块
- `POST /api/session/search-strategy`：用户确认规划前微调模块搜索任务包，写回当前 session 的主搜索词和备用词
- `GET /api/session/state`：读取当前 session 完整状态
- `GET /api/sessions?view=summary&limit=6`：读取当前账号最近购物任务的轻量摘要，不返回候选池、模型凭证和工具日志
- `GET /api/sessions?view=summary&archive=archived&limit=20`：读取当前账号已归档任务摘要
- `POST /api/session/archive`：显式确认后归档或恢复购物任务，`action` 为 `archive | restore`
- `GET /api/mcp/status`：读取当前工具执行模式状态
- `POST /api/mcp/run`：仅开发调试使用；需要显式设置 `SCENECART_ENABLE_MCP_DEBUG=true`，production 始终隐藏。高风险工具仍必须同时传 `confirm_high_risk=true` 与 `input.confirmed=true`
- `GET /api/sessions`：执行台读取会话列表
- `POST /api/auth/register|login|logout`：用户认证与 HttpOnly 会话
- `POST /api/executor/devices`：注册本地执行设备并签发一次性令牌
- `POST /api/executor/jobs/claim`：本地执行器领取带租约的任务
- `POST /api/executor/jobs/:jobId/resolve`：幂等回填完成/失败结果
- `GET /api/runtime/events/stream`：按 Session 推送执行事件的 SSE
- `GET /api/runtime/health`：运行时、数据库和执行 backend 健康检查
- `GET /api/runtime/readiness`：正式发布配置与当前账号本地执行器就绪度检查
- `GET /api/internal/runtime-readiness`：只读的部署就绪探针；仅接受 `SCENECART_CRON_SECRET` Bearer，不包含用户设备能力，也不会触发任务恢复
- `GET /api/runtime/metrics`：当前 Session 的任务积压、失败率与设备在线摘要
- `POST /api/runtime/jobs/:jobId/cancel`：仅取消尚未被执行器领取的任务

错误响应统一为 JSON：

```json
{
  "error": "human readable message",
  "code": "bad_request | not_found | conflict | internal_error"
}
```

## 正式运行

完整部署和本地设备接入步骤见 [生产运行时与本地执行器](./docs/production-runtime.md)。最短路径：

```bash
npm run db:migrate
npm run db:check
npm run release:audit
npm run build
npm run start
```

数据库迁移与应用构建严格分离：发布者先在独立 release 阶段显式执行 `npm run db:migrate && npm run db:check`，再构建并部署；`scripts/build.mjs` 不会连接或修改任何数据库。新 migration 先于应用部署执行，且必须保持向前兼容旧服务。

当前执行器协议为 **v5**。v5 增加启动待命登记、结构化暂停原因与 transport-aware 任务领取门，v4 增加搜索完成后的只读 `product_detail` 证据任务。发布前先停止旧 Worker并显式执行包含 migration 008 与 009 的迁移校验；若确有升级前已领取的搜索、详情或加购需要回填，可临时把 `SCENECART_EXECUTOR_V4_DRAIN_UNTIL` 设为未来不超过 2 小时的 ISO 时间，再部署 v5 服务端并立即更新本机 Worker。旧 v4 Worker 始终不能领取新任务；排空接口还会核对 Job 领取时记录的协议版本、设备和租约代次。截止时间到达或变量留空后，所有 v4 请求都会收到 `426 executor_protocol_mismatch`。migration 007 增加 `mcp_unavailable` 设备状态，migration 008 增加领取协议标记，migration 009 增加跨实例 AI 并发租约。

实例启动并收到恢复 Worker 心跳后，用一条命令完成静态配置、数据库、health 与只读 readiness 验证：

```bash
SCENECART_RELEASE_VERIFY_URL=https://你的正式域名 npm run release:verify
```

用户登录后打开 `/settings/executor` 注册本机设备，再在运行淘宝桌面版且已开启官方 HTTP MCP 的机器启动：

先将设置页只展示一次的配置写入被 Git 忽略的 `.env.local`：

```dotenv
SCENECART_API_URL=http://127.0.0.1:3000
SCENECART_DEVICE_TOKEN=一次性设备令牌
TAOBAO_NATIVE_MCP_URL=http://127.0.0.1:3654/mcp
TAOBAO_SOURCE_APP=SceneCartAI
```

然后运行：

```bash
npm run executor:configure
npm run executor:doctor
npm run worker:local
```

推荐先用 `executor:configure` 在交互式终端中粘贴设置页签发的令牌；它不会回显令牌或覆盖 DeepSeek 等无关环境变量。`worker:local` 会先校验服务端健康、设备令牌及其能力，再以 `mcp_unavailable` 状态等待淘宝桌面版官方 MCP 通过无副作用的工具检查；只有就绪后才切换在线并领取任务。Doctor 会显示令牌当前拥有的商品搜索 / 真实加购能力，避免“进程在线但任务无法匹配”的误导状态。

## 当前实现边界

- 首页已开放新车选购、露营准备、房间装饰、宿舍入学和搬家置办五个场景，场景文案、字段、规划模板、搜索策略与快捷调整均由 `ScenarioConfig` 驱动；当前真实淘宝设备的回归与面试演示基线仍是“新车选购”，这不等于其他四个入口尚未开放。
- 淘宝搜索能力相对稳定；商品详情页和真实加购受淘宝客户端、授权和登录态影响较大。
- 淘宝搜索依赖用户本机淘宝桌面版官方 HTTP MCP 和登录态；不消耗 Qoder 额度，但桌面客户端与账号策略仍是外部依赖。
- 加购具备显式确认、后台执行、重试与结果账本，但淘宝客户端权限或账号策略仍可能拒绝动作。SceneCart 的交易边界止于购买确认页和淘宝购物车：不会自动下单、提交订单或支付。
- 自动搜索支持“完成当前模块后暂停”和从原进度继续，不会通过强杀外部工具制造未知执行状态。
- 正式产品模式不会把真实加购失败写成成功。产品内演示购物车只在 `SCENECART_PRODUCT_MODE=development`、`ALLOW_DEMO_CART_FALLBACK=true` 且使用同步开发兼容 provider 时，才会承接该次真实加购异常；正式 `local_executor` 异步任务失败会保留为可重试失败，不会自动生成演示项。
- 产品不会伪装具备淘宝购物车删除能力。演示项可在产品内移除；真实淘宝项必须在淘宝购物车中管理，避免误删账号内其他商品。
- `RUNTIME_STORE=local` 会把开发状态持久化到被 Git 忽略的本地快照，并在单个 Next.js 进程内序列化同一 Session 的任务回填、暂停/继续与加购写入；它仍不支持多实例事务一致性，不能替代 PostgreSQL 正式运行时。

## 项目文档

- [产品创作复盘](./product_creation_recap.md)
- [产品架构与技术方案](./architecture_and_technical_design.md)
- [淘宝桌面版官方 MCP 接入说明](./docs/taobao-mcp-bridge.md)
- [Codex Hosted Worker（旧开发兼容）](./docs/codex-hosted-worker.md)
- [生产运行时与本地执行器](./docs/production-runtime.md)
- [正式部署指南](./docs/deployment.md)
- [面试演示 Runbook](./docs/interview-demo.md)

## 推荐演示路径

面试前必须至少完成一次真实淘宝搜索并保留该 Session。现场使用固定输入：

> 刚提新能源 SUV，预算 3000，经常带 3 岁孩子长途出行，已有行车记录仪。

从 Scene Brief、规划自检、持久队列、真实候选、预算组合一路演示到逐件显式加购和购买确认页。若淘宝掉登录，先在当前网页展示暂停状态：重新登录后由用户确认继续同一模块，或直接用已保存的部分真实结果进入选购；不要把 mock、历史快照或演示购物车切换成这条主链路的结果。完整步骤见 [面试演示 Runbook](./docs/interview-demo.md)。
