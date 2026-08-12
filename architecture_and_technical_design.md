# SceneCart AI 产品架构与技术方案

> 2026-08 Runtime 2.0 更新：当前正式架构已增加 PostgreSQL、用户认证、持久 Job Queue、执行事件/SSE、本地执行器直连淘宝桌面版官方 HTTP MCP，以及模型驱动 `decide_next_action`。文档中关于内存 Session、同步 Qoder 请求或 Codex hosted 主路径的描述仅代表历史兼容代码；正式推荐路径以本节、`docs/production-runtime.md` 和 `docs/interview-demo.md` 为准。

## 0. 当前正式运行架构

```text
Browser / React workflow
  -> Authenticated Next.js API
  -> Agent Orchestrator
     -> Scene template + DeepSeek structured tasks
     -> Agent Runtime 2.0 (model proposal + guardrail + policy fallback)
     -> Workflow Runner (durable state + one-module-at-a-time continuation)
  -> PostgreSQL
     -> shopping_sessions
     -> agent_jobs
     -> execution_events
  -> SSE -> Browser

Local Executor on user's device
  -> device token + heartbeat
  -> claim leased job
  -> Taobao desktop official HTTP MCP (127.0.0.1:3654/mcp)
  -> local result ledger
  -> idempotent resolve API
```

正式实现的关键变化：

- Session 不再只依赖 Next.js 进程内 Map 或本地 JSON；`RUNTIME_STORE=postgres` 时按用户持久化到 PostgreSQL。
- 淘宝桌面自动化不在 `/api/modules/search` 或 `/api/cart/add` 的长请求内运行；API 只创建任务并立即返回，本地执行器再通过官方 HTTP MCP 完成动作。
- 本地执行器使用一次性设备令牌、15 秒心跳、任务租约、最大重试次数和结果账本。
- 默认开发入口 `npm run dev` 同时管理网页与本地执行器：先确定唯一可用端口并启动 Web，再从受保护的 `.env.local` 热发现设备令牌，Web 健康后启动 Worker；`dev:web` 保留给测试和纯 UI 排障，避免 E2E 意外领取真实淘宝任务。
- 搜索、失败重试、Agent 状态转换和加购结果以执行事件写入，并通过 SSE 自动刷新当前浏览器会话。
- 用户确认规划后只启动一次服务端工作流；本地执行器每次回填后，服务端自动决定并排队下一模块，浏览器关闭不会中断搜索。
- PostgreSQL 正式运行时使用按 Session ID 派生的事务级 advisory lock，防止多个服务实例并发推进同一购物工作流。
- DeepSeek 可以在平衡/探索档位提议下一动作，但只能在动作白名单中选择；后端验证模块、重复任务、置信度和工具预算后才执行。
- Agent 生成的预算安全组合可由用户显式采纳为 `bundle_adoption` 待处理清单；服务端从当前报告重建商品白名单，逐件加购仍复用原有高风险确认和异步回填链路。
- 保守档位、模型失败、低置信度、越界动作或预算耗尽时，确定性策略始终可接管。
- 旧 Qoder 直连、Codex hosted 与 experimental bridge 仅保留为开发兼容路径；production 强制使用 `local_executor`，并以 `410 legacy_hosted_disabled` 关闭旧 hosted Worker API。

当前生产边界：服务端运行时已具备正式架构，但真实淘宝能力仍依赖用户本机淘宝桌面版、官方 HTTP MCP、登录态与淘宝侧开放权限，不依赖 Qoder。系统不承诺绕过这些外部限制；交易能力止于用户显式确认后的淘宝购物车，不会自动下单、提交订单或支付。

## 1. 产品架构总览

### 1.1 产品整体由哪些层组成

当前产品可以拆分为八个核心层：

1. **前端交互层**
2. **后端 API 层**
3. **Agent orchestration 层**
4. **场景配置 / 模板层**
5. **DeepSeek 模型层**
6. **MCP / 工具调用层**
7. **Session / context 状态管理层**
8. **Mock / Live 执行模式层**

这八层共同组成一个“场景化购物 Agent”系统，而不是一个单纯的电商页面或聊天界面。

### 1.2 各层分别解决什么问题

#### 前端交互层

解决用户如何进入场景、确认需求、查看规划、执行搜索、浏览推荐结果和完成购物决策的问题。

#### 后端 API 层

解决前端与核心 Agent 逻辑之间的调用边界问题，把不同阶段的动作变成明确的 HTTP 接口。

#### Agent orchestration 层

解决整个购物工作流如何推进的问题，负责在不同阶段选择调用模板、模型、工具，并统一维护状态。

#### 场景配置 / 模板层

解决不同场景的差异化表达问题，包括：

- 场景名称
- 输入文案
- Scene Brief 字段标签
- 模块模板
- 快捷调整项
- 推荐文案风格

#### DeepSeek 模型层

解决“自然语言理解、结构化补充和个性化微调”的问题，而不是承担全部系统决策。

#### MCP / 工具调用层

解决真实商品搜索、详情提取、加购执行等外部能力接入问题。

#### Session / context 状态管理层

解决多阶段流程中上下文如何持续、如何在前后端之间保持一致的问题。

#### Mock / Live 执行模式层

解决在真实外部能力不可用时，系统如何保持完整演示路径的问题。

### 1.3 为什么要这样分层

之所以采用分层架构，是因为这个产品本身同时具有三种不同性质的能力：

1. **产品流程能力**
   - 用户交互
   - 页面状态
   - 多阶段推进

2. **智能理解能力**
   - 场景解析
   - 模板个性化
   - 快捷调整后的重算
   - 推荐解释

3. **真实执行能力**
   - 淘宝商品搜索
   - 商品详情读取
   - 加入购物车

如果不分层，而是直接把所有逻辑堆到前端或直接交给模型，就会出现：

- 流程不可控
- 工具调用失序
- 代码无法维护
- 无法扩展到多场景

所以分层本质上是为了实现：

- 稳定性
- 可控性
- 可维护性
- 可扩展性

### 1.4 产品整体调用链路是什么

整体调用链路可以概括为：

**前端页面**
-> **API route**
-> **Agent orchestration**
-> **场景模板 / DeepSeek / 工具执行层**
-> **Session 状态写回**
-> **前端重新渲染**

以“确认需求 -> 生成规划”为例：

1. 前端点击“确认需求，开始生成购物规划”
2. 调用 `/api/scene/plan`
3. API 进入 `orchestrator`
4. `orchestrator` 调用：
   - `runTemplatePlanner`
   - `runDeepSeekPlanner`
   - `reviewPlanWithAgent`
5. 生成 `shopping_plan` 与 `plan_review`
6. 后端归一化模块优先级、预算分配和搜索关键词，保留 DeepSeek 的比例意图，但保证模块预算加总等于用户预算，并让不同模块的检索意图明显区分
7. Agent 对规划做轻量自检，检查预算、模块覆盖、关键词差异化与执行风险
8. 写入 `SessionState`
9. 返回给前端
10. 前端进入 `confirm_plan` 页面展示

这个模式贯穿整个系统。

---

## 2. 核心架构分层

## 2.1 前端交互层

### 主要职责

- 呈现多阶段购物流程
- 接收用户输入
- 展示 Scene Brief
- 展示规划结果
- 展示推荐商品
- 展示执行摘要和购买确认页
- 提供快捷调整入口

### 输入输出

#### 输入

- 用户输入需求
- API 返回的 session state
- 工具执行结果和日志摘要

#### 输出

- API 请求
- 本地 UI 状态变化
- 用户确认动作

### 和其他层如何协作

- 通过 API route 调用后端
- 不直接调用 DeepSeek
- 不直接调用淘宝工具
- 所有业务状态以 session 为核心

### 当前实现状态

**已实现**

关键文件：

- [app/page.tsx](./app/page.tsx)
- [components/dashboard.tsx](./components/dashboard.tsx)
- [components/hosted-console.tsx](./components/hosted-console.tsx)

---

## 2.2 后端 API 层

### 主要职责

- 为前端暴露阶段性接口
- 作为前端与 Agent orchestration 层之间的边界
- 做请求参数解析与错误兜底

### 输入输出

#### 输入

- 前端请求参数
- 当前 session_id

#### 输出

- 结构化 JSON
- 新的 session state
- 错误信息

### 和其他层如何协作

- API route 调用 `lib/agent/*`
- 不直接持有复杂业务逻辑
- 只做路由层控制和转发

### 当前实现状态

**已实现**

当前关键 API：

- `/api/scene/parse`
- `/api/scene/plan`
- `/api/scene/refine`
- `/api/modules/search`
- `/api/cart/add`
- `/api/session/agent-directives`
- `/api/session/search-strategy`
- `/api/session/state`
- `/api/mcp/status`
- `/api/hosted/*`

核心 API 错误响应已统一为 `{ error, code }` JSON 结构，便于前端稳定展示错误信息，也便于后续埋点和排障。

关键文件：

- [app/api/scene/parse/route.ts](./app/api/scene/parse/route.ts)
- [app/api/scene/plan/route.ts](./app/api/scene/plan/route.ts)
- [app/api/scene/refine/route.ts](./app/api/scene/refine/route.ts)
- [app/api/modules/search/route.ts](./app/api/modules/search/route.ts)
- [app/api/cart/add/route.ts](./app/api/cart/add/route.ts)
- [app/api/session/state/route.ts](./app/api/session/state/route.ts)
- [lib/api/responses.ts](./lib/api/responses.ts)

---

## 2.3 Agent orchestration 层

### 主要职责

这是整个系统的核心。

它负责：

- 工作流推进
- session 创建与恢复
- 场景解析
- 模板规划
- DeepSeek 个性化补充
- 模块搜索调度
- 搜索后候选池评估
- Agent 建议补搜
- 快捷调整后的重算
- 加购物车执行
- 状态写回

### 输入输出

#### 输入

- 原始需求
- session_id
- quick action
- module_id
- product_id

#### 输出

- Scene Brief
- Shopping Plan
- Module Candidates
- Module Reviews
- Selected Items
- Tool Logs
- 更新后的 SessionState

### 和其他层如何协作

- 调用场景模板层提供基础结构
- 调用 DeepSeek 层做结构化补充
- 调用工具层做搜索与加购
- 调用候选排序器和候选池复盘器，把搜索结果转成可决策推荐
- 通过 session/store 持久化状态

### 当前实现状态

**已实现**

关键文件：

- [lib/agent/orchestrator.ts](./lib/agent/orchestrator.ts)
- [lib/agent/scene.ts](./lib/agent/scene.ts)
- [lib/agent/planner.ts](./lib/agent/planner.ts)
- [lib/agent/search-strategy.ts](./lib/agent/search-strategy.ts)
- [lib/agent/refiner.ts](./lib/agent/refiner.ts)
- [lib/agent/candidate-ranker.ts](./lib/agent/candidate-ranker.ts)
- [lib/agent/candidate-reviewer.ts](./lib/agent/candidate-reviewer.ts)
- [lib/agent/product-matcher.ts](./lib/agent/product-matcher.ts)
- [lib/agent/cart.ts](./lib/agent/cart.ts)

其中 `search-strategy.ts` 是一个纯策略归一化模块，用来修复跨模块关键词重复、补齐备用搜索词和验收信号。它不依赖 DeepSeek 调用层，因此规划生成和旧 session 恢复都可以复用同一套搜索策略修复逻辑，而不会让 session/store 间接拉入模型规划器。

---

## 2.4 场景配置 / 模板层

### 主要职责

- 定义每个购物场景的基础模块结构
- 提供场景文案、输入提示、字段标签、快捷操作等配置
- 为多场景共享工作流提供统一抽象

### 输入输出

#### 输入

- 当前场景 ID

#### 输出

- `ScenarioConfig`
- `base_template_modules`
- 场景字段标签和选项集

### 和其他层如何协作

- 被前端用于渲染不同场景 UI
- 被 DeepSeek prompt 层用于注入场景 schema
- 被 planner 层用于加载基础模板

### 当前实现状态

**已实现，真实设备回归以新车场景为基线**

已建立的配置层文件：

- [lib/scenarios/index.ts](./lib/scenarios/index.ts)
- [lib/scenarios/types.ts](./lib/scenarios/types.ts)
- [lib/scenarios/new-car.ts](./lib/scenarios/new-car.ts)
- [lib/scenarios/camping.ts](./lib/scenarios/camping.ts)
- [lib/scenarios/room-decor.ts](./lib/scenarios/room-decor.ts)
- [lib/scenarios/dorm-move-in.ts](./lib/scenarios/dorm-move-in.ts)
- [lib/scenarios/moving-setup.ts](./lib/scenarios/moving-setup.ts)

首页已开放新车选购、露营准备、房间装饰、宿舍入学和搬家置办五个场景。它们的文案、字段、规划模板、搜索策略与快捷动作均从 `ScenarioConfig` 读取并复用统一工作流；当前真实淘宝设备的持续回归和面试脚本固定使用“新车选购”，不表示其他四个入口仍处于未开放状态。

---

## 2.5 DeepSeek 模型层

### 主要职责

DeepSeek 在系统中不做“自由 Agent”，而做“受约束的结构化补充器”。

主要任务：

- parse_scene
- personalize_template
- refine_plan
- review_candidates
- explain_product_fit

### 输入输出

#### 输入

- 用户原始需求
- Scene Brief
- 模板模块
- 快捷操作
- 商品信息
- 候选商品摘要

#### 输出

- 严格 JSON
- 结构化 Scene Brief
- 结构化 Shopping Plan
- 调整后的 Scene Brief
- 候选池质量评估
- 商品推荐理由

### 和其他层如何协作

- 由 Agent orchestration 层调用
- 不直接与前端交互
- 不直接调用工具

### 当前实现状态

**已实现**

关键文件：

- [lib/llm/deepseek.ts](./lib/llm/deepseek.ts)
- [lib/llm/prompts.ts](./lib/llm/prompts.ts)
- [lib/llm/mock.ts](./lib/llm/mock.ts)

模型运行证据分成两层：`telemetry.ts` 提供当前服务进程级成功率、P95 延迟和最近 fallback 原因；`session-evidence.ts` 把当前购物链路内的能力调用写入 `SessionState.llm_calls`。后者只保存 `task / model / mode / duration_ms / reason / created_at`，不保存 Prompt、Scene Brief 原文、候选商品摘要或模型原始输出。规划、规划复核、方案调整、候选池复盘、Runtime 下一动作和购买组合均会追加凭证；如果模型结构化提案随后被业务 Guardrail 拒绝，系统会按 call id 把该次会话凭证精确降级为 fallback，并记录泛化后的拒绝原因。执行台因此可以回答“这次购物的哪些步骤真实采用了 DeepSeek，哪些步骤使用了规则 fallback”，而不是只展示一个静态模型标签。

---

## 2.6 MCP / 工具调用层

### 主要职责

- 接入淘宝搜索能力
- 接入详情提取能力
- 接入加购能力
- 记录工具日志
- 抽象正式 `local_executor` 与显式开发兼容 provider 的执行差异
- 对高风险动作做服务端确认校验

### 输入输出

#### 输入

- 工具名
- 工具参数
- 当前 module_id / product_id

#### 输出

- 标准化工具返回结果
- 工具执行日志

### 和其他层如何协作

- 被 product-matcher / cart 层调用
- executor 统一写入 `tool_logs`
- client 决定当前走哪个 backend

### 当前实现状态

**已实现，外部能力受淘宝客户端状态约束**

正式链路已经收敛为持久任务队列、本地执行器和淘宝桌面版官方 HTTP MCP。搜索可以回填真实候选；详情与加购仍会受到登录态、商品规格和淘宝侧授权影响。旧 Qoder、hosted、experimental 与 mock adapter 只作为显式开发兼容代码保留。

关键文件：

- [lib/mcp/types.ts](./lib/mcp/types.ts)
- [lib/mcp/client.ts](./lib/mcp/client.ts)
- [lib/mcp/executor.ts](./lib/mcp/executor.ts)
- [lib/mcp/local-executor.ts](./lib/mcp/local-executor.ts)
- [lib/mcp/qoder.ts](./lib/mcp/qoder.ts)
- [lib/mcp/mock.ts](./lib/mcp/mock.ts)
- [lib/mcp/hosted.ts](./lib/mcp/hosted.ts)

---

## 2.7 Session / context 状态管理层

### 主要职责

- 保存整个工作流上下文
- 支持多阶段页面恢复
- 支持搜索结果、规划结果和已选商品持续存在
- 管理账号级任务归档与恢复，并协调未领取 Job 的安全取消

### 输入输出

#### 输入

- Agent 各阶段产出的结果

#### 输出

- 当前 session state
- 前端可读取的完整状态快照

### 和其他层如何协作

- orchestrator 读取和写入
- API route 提供查询接口
- 前端以此为核心状态源

### 当前实现状态

**已实现**

关键文件：

- [lib/session/types.ts](./lib/session/types.ts)
- [lib/session/store.ts](./lib/session/store.ts)
- [lib/session/lifecycle.ts](./lib/session/lifecycle.ts)

`SessionState.archived_at` 是软归档边界。归档动作在 Session 级事务锁内完成：停止 `auto_continue`、取消 pending Job、同步 pending HostedTask、记录审计事件；leased/running Job 不会被伪装成已取消，但其回填触发的工作流续跑会因归档状态返回 paused。Local 与 PostgreSQL Repository 的 Job 创建和领取路径都会拒绝已归档 Session。恢复只清除归档标记且不会自动启动工具调用：未开始搜索的规划回到 `idle`，已完成任务保持 `completed`，其余任务以 `paused` 等待用户确认后继续。

---

## 2.8 产品模式与真实执行边界

### 主要职责

- 明确区分开发预览与正式产品
- 防止真实工具失败在正式环境中被伪装成成功

### 输入输出

#### 输入

- 当前产品模式
- 当前工具执行 backend
- 工具调用请求

#### 输出

- 本地执行器真实结果
- 明确的外部工具失败
- 仅限开发预览的 demo cart fallback

### 和其他层如何协作

- `product-mode` 负责产品运行边界
- MCP client 负责选择工具 backend
- readiness 统一检查产品模式、执行器和演示回退状态

### 当前实现状态

**已实现，真实淘宝能力仍受外部账号与客户端状态影响**

产品当前核心策略是：

- 正式路径通过 `local_executor` 持久任务执行搜索与加购
- `SCENECART_PRODUCT_MODE=production` 时强制关闭演示加购回退
- 开发预览只有在显式允许回退且使用同步兼容 provider 时可写入 demo cart，UI 必须标注来源；`local_executor` 异步失败不会自动生成演示项

---

## 3. Agent 技术方案

### 3.1 Agent 在整个系统中的位置

Agent 位于前端 API 调用和具体模型/工具执行之间，是整个系统的中枢。

它不是一个“自然语言大脑”，而是一个**流程控制器 + 状态协调器**。

### 3.2 Agent 负责哪些环节

主要负责：

- 创建 session
- 解析用户需求
- 生成 Scene Brief
- 加载模板
- 调用 DeepSeek 做个性化规划
- 执行模块搜索
- 收集候选商品
- 响应快捷调整
- 执行加购
- 汇总和写回状态

### 3.3 DeepSeek 和 Agent 如何分工

#### Agent 负责

- 工作流推进
- 状态流转
- 调用时机控制
- 工具执行决策
- 搜索顺序控制
- 候选池质量判断
- 高风险工具确认校验
- 失败处理

#### DeepSeek 负责

- 场景理解
- 模板个性化补充
- 快捷调整重算
- 候选池复盘
- 推荐理由生成

这是一种“规则编排 + 模型补充”的协作模式。

### 3.4 为什么采用“模板 + LLM 补充”

因为购物规划本质上既需要：

- **稳定结构**
- **个性化调整**

模板提供稳定结构，模型提供个性化补充。

模板保证：

- 模块稳定
- 预算有骨架
- 流程可控

模型补充保证：

- 针对当前需求做裁剪
- 调整优先级
- 做局部重算

### 3.5 为什么 MCP 调用决策主要由后端规则编排

因为工具调用涉及：

- 执行顺序
- 权限风险
- 外部系统不稳定
- session 连续性

这些都不适合完全交给模型。

后端规则编排的好处是：

- 可预测
- 可观测
- 可记录日志
- 可做 fallback

### 3.6 context / session 如何管理

整个 session 是购物流程的上下文容器。

它承载：

- 当前场景
- 当前规划
- 当前候选商品
- 当前已选商品
- 当前工具执行情况

这样可以支持：

- 页面刷新恢复
- 执行台查看当前会话
- 快捷调整后继续沿用旧上下文

### 3.7 状态如何流转

#### Scene Brief

由 `parse_scene` 生成，用户可在确认页手动修改，然后进入规划阶段。

#### Shopping Plan

由模板 + `personalize_template` 生成，用户确认后才开始搜索。

#### Plan Review

由 `plan-reviewer` 在购物规划生成后立即产出，用于在用户确认规划前做质量自检。

它包含：

- `status`：规划是否可执行，或是否需要留意/调整
- `summary`：面向用户的整体判断
- `strengths`：当前规划的优点
- `risks`：预算、模块覆盖、关键词或执行层面的风险
- `improvement_suggestions`：确认前或后续执行时的改进建议
- `budget_comment`：预算分配判断
- `keyword_comment`：搜索关键词差异化判断
- `module_comment`：模块覆盖判断

DeepSeek 可参与该自检；无 key、超时或结构不合法时，系统回退到启发式评估。这个设计让模型多承担一层“方案审阅”职责，但仍不让模型直接决定工具调用。

#### Module Candidates

由搜索阶段为每个模块逐步写入，用于推荐结果页展示。

#### Module Reviews

由 `candidate-reviewer` 在模块搜索后生成，用于判断当前候选池是否足够进入用户决策。

它包含：

- `status`：可继续、需确认、候选偏少或建议调整
- `summary`：当前候选池质量摘要
- `strengths`：候选池优点
- `caveats`：风险与不足
- `next_action`：下一步建议
- `suggested_keyword`：必要时给出可直接补搜的关键词
- `source`：标记本次评估来自启发式规则还是 DeepSeek 复盘

淘宝桌面版官方 HTTP MCP 搜索结果经本地执行器回填后，会优先尝试一次 DeepSeek 候选池复盘。该调用同时返回候选池质量判断和最多三条与 `product_id` 一一对应的商品适配理由，避免逐商品调用导致延迟线性增长。服务端要求理由覆盖且仅覆盖当前候选 ID，并限制文本长度；无 key、超时、遗漏、重复 ID 或结构不合法时，自动回退到启发式评估和原有规则理由。这样 AI 可以参与“看完商品后怎么判断”，但不会让搜索主链路被模型调用拖垮或把编造商品写入 Session。

#### Module Search Traces

由 `product-matcher` 在每个模块搜索过程中写入 `SessionState.module_search_traces`，用于记录 Agent 的真实执行判断，而不只是保留最终商品结果。

它包含：

- `primary_keyword`：本模块首轮主搜索词
- `searched_keywords`：实际尝试过的关键词
- `attempts`：每次关键词尝试的原因、状态、返回数量和错误摘要
- `ai_decision_summary`：面向用户可读的本模块搜索决策摘要
- `review_status` / `review_summary`：候选池复盘结论
- `recovery_keyword`：触发补搜时使用或建议使用的关键词
- `next_action`：下一步建议

这层的价值是把 AI 生成的 `search_strategy` 执行化：模型可以提出主搜索词、备用词、验收信号和失败恢复策略；后端 Agent 根据这些策略串行调用工具、记录尝试、在候选偏薄时补搜，并把最终决策轨迹反馈给推荐页和后端执行台。

#### Last Refinement

由快捷调整触发后写入 `SessionState.last_refinement`，用于解释本次调整对搜索执行的影响。

它包含：

- `quick_action`：用户触发的快捷调整
- `summary`：本次调整的整体影响摘要
- `impacted_modules`：需要重新搜索的模块
- `reusable_modules`：规划变化不大、候选可复用的模块
- `removed_modules`：调整后被移除的模块
- `module_decisions`：每个模块的重搜/复用/移除原因

这个状态让快捷调整不再只是“重新生成方案”，而是显式告诉用户 Agent 如何判断哪些搜索结果还能保留、哪些必须失效重搜。

#### Tool Logs

每次工具调用统一写入，用于推荐页侧边折叠区和执行台展示。

#### Selected Items

由加购行为累积写入，用于购买确认页以及开发预览中的 demo cart。

---

## 4. DeepSeek 技术方案

### 4.1 DeepSeek 主要负责哪些任务

DeepSeek 目前承担六类结构化任务：

1. `parse_scene`
2. `personalize_template`
3. `review_plan`
4. `refine_plan`
5. `review_candidates`
6. `explain_product_fit`

### 4.2 各任务分别做什么

#### parse_scene

把自然语言需求转换成结构化 Scene Brief。

输出字段包括：

- `scene_type`
- `vehicle_type`
- `user_stage`
- `budget`
- `priority_style`
- `already_have`
- `avoid_items`
- `optional_notes`

#### personalize_template

在基础模板上做：

- 模块裁剪
- 模块重排序
- 预算分配调整
- 策略说明生成
- 模块级搜索策略生成
- 计划级执行策略生成

其中 `search_strategy` 是关键结构。它不是让模型直接调用淘宝工具，而是让模型在安全边界内给工具层提供“应该怎么搜、怎么筛”的任务包：

- `primary_keyword`：首轮搜索词
- `alternate_keywords`：换一批或首轮无结果时使用的备用搜索词
- `include_terms`：候选商品应该优先命中的关键词
- `exclude_terms`：已有物品或不想买类别对应的规避词
- `ranking_focus`：候选排序时应优先关注的信号
- `price_band`：建议价格带
- `reasoning`：该搜索策略的简短理由

规划确认页会把这个任务包外显给用户，并允许用户在搜索前调整 `primary_keyword` 与 `alternate_keywords`。前端调用 `/api/session/search-strategy`，后端通过 `orchestrator.updateModuleSearchStrategy` 写回当前 session，并失效该模块旧候选、候选池复盘和搜索轨迹。这样 AI 不是只输出静态模板，而是先生成可执行策略；用户也可以在执行前纠偏策略，再交给后端规则串行调用工具。

#### Agent Directives / AI 执行档位

`agent_directives` 是模型策略和后端执行之间的可控边界。它不让模型直接调用工具，而是描述 Agent 后续搜索可以有多主动：

- `autonomy_level`：保守执行 / 平衡执行 / 探索执行
- `search_depth`：轻量搜索 / 标准搜索 / 深度搜索
- `detail_policy`：是否主动进入详情页
- `recovery_policy`：搜索失败或候选偏薄时如何恢复
- `rerank_rules`：候选排序时的重排规则
- `user_confirmation_points`：必须由用户确认的动作
- `safety_boundaries`：隐私和交易边界

当前实现中，用户可以在规划确认页选择“保守 / 平衡 / 探索”执行档位。前端调用 `/api/session/agent-directives`，后端通过 `lib/agent/directives.ts` 写回当前 session 的 `agent_directives`。随后 `product-matcher` 会读取这些字段决定搜索尝试次数、是否使用备用词、是否按候选池复盘建议补搜。

在此基础上，`lib/agent/decision-engine.ts` 与 `lib/agent/workflow-runner.ts` 把搜索阶段升级为服务端 Agent 决策循环。前端确认规划后调用一次 `/api/agent/run`；后续每次本地执行器回填，resolve API 都会触发工作流继续推进。决策引擎会综合 `execution_strategy`、`agent_directives`、模块候选、`module_reviews`、`module_search_traces`、市场反馈与工具任务状态，输出 `search_module`、`retry_module`、`skip_module`、`wait_for_tools` 或 `complete_workflow`。

`workflow-runner` 把 `workflow_run_id`、`workflow_status`、`current_module_id`、`auto_continue`、`continuation_count` 和状态说明写入 Session。每轮最多排队一个外部工具任务；成功回填后继续下一模块，终态失败则形成失败轨迹并容错跳过，用户取消则暂停整轮自动推进。任务幂等键按会话、模块、搜索词和本轮运行 ID 构造，重复完成回执不会二次续跑。`workflow-recovery` 可由 Worker 空闲轮询、独立恢复进程或云端 Cron 触发；Repository 直接筛选无活跃工具任务或关联 Job 已终态的候选，按旧会话优先恢复，并隔离单个 Session 的恢复失败。它只重放已经持久化但尚未续跑的结果，再补排后续模块，不重新执行淘宝动作。浏览器只通过 SSE 和恢复轮询观察进度，并保留“查看推荐结果”的用户确认门槛。

用户控制采用协作式暂停而不是强杀外部进程。`/api/agent/pause` 在 Session 事务锁内把状态切到 `paused` 并关闭 `auto_continue`；已经被执行器领取的当前模块仍可安全完成与回填，回填后的续跑入口会得到 `no_op`，不会创建下一任务。`/api/agent/resume` 恢复同一 `workflow_run_id`，保留已有候选、搜索轨迹、工具预算和已完成模块：若当前任务仍在运行则等待其完成，否则立即让 Agent 选择下一个未完成模块。主搜索页和执行台都提供相同控制，且两种动作均要求用户显式确认。

同一 Session 的可变状态在两种运行时都被序列化。PostgreSQL 使用 transaction-level advisory lock，支持跨实例互斥和事务回滚；本地开发运行时使用进程内可重入锁队列，等待型写操作串行执行，Agent 推进采用非阻塞抢锁，超时等待者释放自己的队列槽位而不会误删前序持有者。后者解决单机真实验收时任务回填、暂停和加购旧快照互相覆盖的问题，但不宣称具备跨进程一致性。

补搜采用跨轮次候选池，而不是“最后一次搜索覆盖前一次”。`candidate-ranker` 将已有 `ProductCandidate` 与本轮回填按 `product_id` 去重，合并完整字段后，用当前 Scene Brief、模块预算、搜索策略和 Agent 重排规则重新选择三档候选。`runtime/jobs` 在 DeepSeek 候选复盘前完成这次合并，因此模型评估的是完整证据池；`hosted.resolve` 再执行一次幂等合并，覆盖进程恢复和旧宿主兼容路径。`module_search_traces` 保留每轮关键词和原始返回量，同时单独记录最终候选数；补搜失败只追加失败 attempt，已有候选不会被清空。

当 Runtime 决定 `complete_workflow` 时，`completion-review` 会生成方案级 `completion_report`：计算规划覆盖率、必需模块覆盖率、候选总量、薄弱候选池、预算压力、缺价模块和容错跳过，并保留最终 DeepSeek Runtime/规则停止理由。同时，`purchase-bundle` 会先通过确定性搜索得到预算安全组合，再允许 DeepSeek `compose_purchase_bundle` 在已知候选 ID 内提出更符合用户偏好的组合。后端强制校验商品白名单、每模块最多一件、总预算上限和必需模块覆盖下限；不合格输出回退为规则组合。用户可以显式把该组合采纳为 `bundle_adoption`，但它只是一份产品内待处理清单：服务端重新核对当前报告、候选模块、标题和价格，真实加购仍逐件确认。任何重搜或规划变更都会同时清除旧报告和旧清单。

为减少结果页的固定模板感，`compose_purchase_bundle` 同时生成 `refinement_suggestions`：模型结合市场价格压力、候选池质量和组合取舍，从当前场景配置允许的 `quick_actions` 中选择最多三项，并返回原因与目标模块。`validation.ts` 校验动作白名单、去重、文本长度和模块归属，`purchase-bundle.ts` 再规范化一次；任何越界都会回退到基于价格压力、薄弱模块和可选模块生成的确定性建议。前端只把这些建议作为更高优先级入口，用户确认后仍复用原有 `refine_plan -> confirm_plan -> search` 链路，不赋予模型交易权限，也不新增模型调用延迟。

完成报告不是只读终点。若存在未覆盖模块，用户可显式确认 `/api/agent/remediate`；服务端只重置报告列出的缺口模块及其旧失败决策，在 Session 锁保护下保留其他候选与购物清单，再交给同一 `workflow-runner` 续跑。这样恢复动作仍由用户授权，但后续模块选择、排队和停止判断继续由 Agent 完成。

同一恢复入口还支持 `scope=thin`：它不删除薄弱模块已有候选，而是基于搜索轨迹选择一个未尝试关键词，在候选复盘上签发一次性 `user_confirmed_retry`。该授权只绕过本轮保守/轻量档位对自动补搜的限制，不修改用户长期 Agent 档位；工具回填后的新复盘不继承授权。结合跨轮次候选池，这使用户能够把更多搜索空间交给 Agent，同时仍保持明确确认、有限工具预算和可审计轨迹。

在 PostgreSQL 模式下，`withWorkflowSessionLock` 使用 `pg_try_advisory_xact_lock` 对同一 Session 的一次推进加互斥；Executor 结果回填使用有超时的 blocking advisory lock，保证重复完成、失败和取消回执串行写入。数据库层通过 `AsyncLocalStorage` 将锁内所有 repository 查询绑定到同一个 `PoolClient`，因此状态读取、决策记录、任务幂等创建、回填和事件写入随事务一起提交或回滚。锁不包住淘宝工具执行；平衡/探索档位下只可能包含一次上限 8 秒的 DeepSeek 下一动作判断，避免数据库连接被桌面自动化长期占用。

每次动作都会写入 session 的 `agent_decisions`，保存来源、置信度、理由和证据。规划顺序与候选复盘可以来自 DeepSeek，后端负责动作白名单、重复调用抑制、失败跳过和高风险确认，因此模型获得了真实的执行选择空间，但不能越过交易和隐私边界。

模型自主搜索词采用“语义包络”而不是固定词表。`search-strategy.ts` 从模块名、典型品类、包含词和验收信号生成 `allowed_category_anchors`；DeepSeek 可以在保留至少一个完整品类锚点的前提下自由增加品牌、功能、价格带与店铺方向。若模型遗漏品类词，但短词组中至少一个筛选词能在当前模块的推荐/搜索策略中找到依据，且其余内容都属于整词匹配的常见商品筛选修饰语或价格表达，`normalizeModelSearchKeyword` 会补齐该模块的首个典型品类并留下修复说明；无模块依据、跨品类或包含不安全控制内容的提案不会被修复。`runtime-v2.ts` 在决策阶段统一压缩空白、限制长度，并拒绝 URL、Qoder/淘宝工具名、命令行参数、脚本控制符和提示词控制语句。`product-matcher.ts` 在实际任务入队前仍再次应用严格校验，覆盖规划主词、备用词、候选复盘建议和直接 override；用户在规划页手动保存的搜索词也保持严格校验，不享受模型修复。旧会话中的异常规划词会回退到模块默认搜索意图，模型异常建议会被忽略，新提交的异常手动词则返回稳定的 `400 invalid_search_keyword`。无首轮轨迹的 `retry_module`、重复关键词和跨模块关键词都会回退到确定性策略。这避免了“纯模板搜索”和“模型任意把字符串送入工具”两个极端。

模块候选回填后，`lib/agent/market-feedback.ts` 会增加一层跨模块市场反馈。它只使用商品价格摘要，计算 `module_signals`、预算压力、预算余量和最多 15% 的总额守恒调拨建议。`decide_next_action` 会读取这些聚合信号，在平衡/探索档位中决定是否以未尝试过的性价比关键词补搜。预算建议默认只读；用户在推荐页显式确认后，`/api/session/budget-reallocation` 才会按服务器当前建议执行一次调配。客户端不能提交金额，后端再次校验供给/承压信号、单次上限、活跃任务和预算总额，只失效调出与调入模块的候选，并回到规划确认页等待用户重新开始搜索。这让 Agent 可以基于真实市场反馈修正方案，但不能静默改变用户约束。

这相当于给 AI 更多操作空间，但仍然保持三层约束：

- 用户确认执行档位
- 后端规则决定工具调用
- 高风险动作仍需显式确认
- `failure_recovery`：首轮结果不佳时如何收缩或改写搜索

这样 AI 的操作空间从“补文案”扩大到“定义检索策略”，但工具调用顺序、权限控制和高风险动作仍由后端 Agent 编排。

此外，`personalize_template` 还会输出计划级 `execution_strategy`：

- `module_sequence`：建议的串行模块搜索顺序
- `budget_guardrails`：预算纪律
- `tradeoffs`：本轮取舍和后置原因
- `search_notes`：给工具层的检索注意事项
- `stop_rules`：什么时候停止扩搜

后端 planner 会吸收这个策略，但仍会做预算归一化、模块 ID 白名单校验、关键词兜底和跨模块关键词差异化修复。即使模型给出过于泛化或相似的搜索词，planner 也会补充模块名和典型品类锚点，避免多个模块搜到同一批商品。

#### review_plan

在 `personalize_template` 生成 Shopping Plan 后，对规划做轻量质检。

它不生成商品、不调用工具，只检查：

- 预算分配是否贴近用户约束
- 模块是否覆盖当前阶段高频需求
- 搜索关键词是否足够差异化
- AI 验收信号、拒绝信号和质量检查项是否清晰
- 哪些风险需要用户在确认规划前知道

输出写入 `SessionState.plan_review`，并显示在规划确认页。

#### refine_plan

响应快捷操作，例如：

- 压缩预算
- 只看必买
- 更偏实用
- 我已有某物品

输出新的 Scene Brief。

#### explain_product_fit

为单个商品生成简洁适配理由的预留能力。正式搜索热路径不逐商品调用，而是由 `review_candidates` 一次批量生成当前模块最多三条理由，避免模型耗时随商品数线性增长。

#### review_candidates

搜索完成后，DeepSeek 可以基于候选商品摘要做候选池复盘。

输入只包含：

- Scene Brief
- 当前模块策略
- 候选商品摘要，包括标题、价格、店铺、标签、卖点和风险摘要
- 启发式规则评估结果

输出候选池复盘字段以及与当前候选 `product_id` 一一对应的 `fit_reasons`，用于说明：

- 当前候选池是否足够进入用户决策
- 有哪些优点和风险
- 是否需要查看详情
- 是否需要按建议关键词补搜
- 每个商品为什么适合当前场景、预算和推荐档位

该任务使用较短超时和严格 JSON。服务端校验模块 ID、候选 ID 全量覆盖、无重复和理由长度；失败时直接保留启发式评估及规则理由，不阻断搜索流程。

### 4.3 为什么要求严格 JSON 输出

因为这些结果不是给人直接阅读的，而是要进入下游流程：

- 渲染确认页
- 生成规划卡片
- 触发重算
- 写回 session

如果不要求严格 JSON，就会导致：

- 难以解析
- 结构不稳定
- 前端逻辑变复杂

### 4.4 schema 校验如何设计

当前方案采用：

- prompt 中明确要求结构
- 后端对返回值做 normalize/sanitize
- fallback 到 mock 数据

例如：

- `normalizeSceneBrief`
- `normalizeShoppingPlan`

这意味着即便模型输出不完全规范，系统也会尽量归一化到可用格式。

### 4.5 模型 fallback 如何设计

当没有 `DEEPSEEK_API_KEY`，或模型调用失败时：

- `mockParseScene`
- `mockPersonalizeTemplate`
- `mockRefineScene`
- `mockExplainProductFit`
- 启发式 `reviewModuleCandidates`

会提供一个稳定、经过校验的确定性结果。

这样做的目的不是伪装真实模型，而是：

- 确保需求理解、规划、自检、推荐解释与组合计算在模型不可用时仍可演示
- 让架构随时可切换到真实模型
- 保持状态透明：只有 DeepSeek API 实际返回可解析 JSON 时才标记为 `connected`，否则 session 会标记为 `mock`

这里的 fallback 只替代模型产出，不会伪造淘宝搜索结果。正式 `local_executor` 无法连接淘宝桌面版 MCP 时，工具任务会失败或暂停；面试现场只能恢复预演时持久化的真实候选，或明确切换到不含真实搜索的讲解路径。

---

## 5. 淘宝桌面版 HTTP MCP 技术方案

### 5.1 MCP 工具层如何抽象

系统逻辑上定义了统一工具接口：

- `search_taobao_products`
- `open_product_detail`
- `extract_product_info`
- `add_to_cart`

这些工具不直接暴露给前端，而由后端通过 executor 调用。

executor 不只负责转发工具调用，也负责把 adapter 输出归一化成统一结构：搜索结果会过滤缺少商品 ID 或标题的脏数据、按商品 ID 去重、价格转成数字、店铺/标签/卖点裁剪到可展示范围；详情与加购输出也会补齐必要字段并校验高风险结果。这层防线让淘宝桌面版官方 HTTP MCP 与显式开发兼容 adapter 的返回差异不会直接污染推荐链路和前端页面。

### 5.2 search / open detail / extract info / add to cart 如何组织

#### search

搜索阶段最稳定，所以当前是整个真实执行链路的核心。

流程：

- `search-strategy` 先读取 DeepSeek 生成的 `search_strategy.primary_keyword`，缺失时回退到 `search_keyword`，再由 `searchIntentForModule` 兜底
- `search-strategy` 对重复、相似或过于泛化的关键词做模块化锚点补强，避免多个模块搜索同一批商品
- product-matcher 读取归一化后的 `search_strategy.primary_keyword`
- 调用 `search_taobao_products`
- 如果用户点击“按 Agent 建议补搜”，API 会传入 `keyword_override`，product-matcher 会把该词放到搜索队列第一位
- 如果首轮搜索结果为空，product-matcher 可以安全尝试一个备用搜索词
- 返回若干候选商品
- Candidate Ranker 根据 `search_strategy.include_terms / exclude_terms / ranking_focus`、模块预算、用户偏好、已有/排除项、标题卖点和店铺信号重排结果
- 选择稳妥推荐 / 性价比推荐 / 升级推荐三档
- 转换成 `ProductCandidate`
- Candidate Reviewer 生成 `ModuleCandidateReview`，必要时给出 `suggested_keyword`

这里的 Candidate Ranker 不额外调用慢模型，而是把 DeepSeek 在规划阶段产出的策略信号落到商品层，避免推荐页退化成“淘宝搜索前三条”。

#### open detail / extract info

这部分能力逻辑上存在，但目前为了稳定性，在搜索阶段默认不自动进入详情页，只返回搜索摘要。

#### add to cart

逻辑上支持，但真实链路不稳定，所以采用了：

- 前端弹窗确认
- `/api/cart/add` 服务端要求 `confirmed: true`
- MCP executor 根据 `schema.requires_confirmation` 再次校验高风险工具参数
- 先尝试真实加购
- 正式产品模式失败时明确返回错误并保留重试能力
- 只有 development、显式开启回退且走同步兼容 provider 时，异常才可写入明确标记的 demo cart

购物车确认页进一步采用来源隔离：`selected_items.cart_source` 明确区分 `taobao` 与 `demo`。`/api/cart/remove` 只允许删除经过用户确认的 `demo` 条目，并在 Session 锁内同步 `bundle_adoption`；真实淘宝条目和缺少来源的历史条目全部 fail-closed，只提供前往淘宝购物车管理的入口。这样不会把“删除产品内账本记录”伪装成“删除淘宝购物车商品”，也不会误伤用户原有购物车。

`/api/cart/add` 的 Session 读取、幂等 Job 创建、任务挂接、状态保存和审计事件也位于同一 Session 事务锁中。多个商品的并发确认会被短暂串行化，但淘宝实际执行仍在本地 Worker 后台完成，不占用数据库锁；这样可以防止并发请求或执行器回填使用旧快照覆盖另一件商品的待执行状态。

调试接口 `/api/mcp/run` 也不能绕过这套机制。它默认关闭，仅在 development 显式配置 `SCENECART_ENABLE_MCP_DEBUG=true` 后存在；production 始终返回 404。即使在调试模式，高风险工具仍必须同时满足：

- 请求体 `confirm_high_risk=true`
- 工具输入 `input.confirmed=true`

这样即使前端被绕过，高风险购物动作仍需要服务端显式确认。

### 5.3 正式执行与开发回退如何设计

当前将两种产品目标显式拆开：

- 正式产品使用 `local_executor`，只接受真实工具结果
- 正式加购失败不会修改 `selected_items`，由用户修复登录/权限后重试
- demo cart fallback 只有在 `SCENECART_PRODUCT_MODE=development`、`ALLOW_DEMO_CART_FALLBACK=true` 且加购走同步开发兼容 provider 时才会生效，结果必须标注为“演示购物车”
- 正式主路径 `local_executor` 使用异步 Job；Job 失败会保留为可重试失败，不会因为开发开关而自动写入 demo item
- `/api/runtime/readiness` 会把开发模式或开启演示回退视为不满足发布条件

### 5.4 为什么不能假设宿主一定开放能力

因为这个项目真实踩到了：

- 淘宝桌面版 MCP 可能未开启或未暴露所需工具
- 账号登录态和淘宝侧授权可能变化
- 本地执行器、设备令牌与服务端协议可能不一致
- 商品详情页导航会影响淘宝登录态

所以产品架构不能默认：

- 工具一定可用
- 宿主一定授权
- 详情页一定安全

必须始终保留可恢复状态和明确失败边界。模型可以走确定性 fallback；真实工具结果不能用 mock 冒充。

### 5.5 当前产品和淘宝桌面版 MCP 的关系

当前真实关系是：

- Web 服务负责编排、持久化和鉴权，不在请求内操作淘宝客户端
- 用户设备上的 `worker:local` 使用设备令牌领取持久任务
- `worker:local` 直连淘宝桌面版官方 Streamable HTTP MCP，默认地址为 `http://127.0.0.1:3654/mcp`
- 搜索或加购结果通过幂等 resolve API 回填，浏览器通过 SSE 与恢复轮询观察状态
- 旧 Qoder、hosted、experimental bridge 和 mock adapter 只在开发环境显式启用

换句话说，当前是：

**产品后端 -> 持久 Job Queue -> local executor -> 淘宝桌面版官方 HTTP MCP**

而不是：

**前端直接调用淘宝**

---

## 6. 场景泛化技术方案

### 6.1 核心能力层和场景模板层如何拆分

#### 核心能力层

跨场景通用：

- 统一 workflow
- session 管理
- DeepSeek 职责边界
- 模块搜索机制
- 推荐页结构
- 快捷调整机制

#### 场景模板层

按场景变化：

- 输入文案
- Scene Brief 字段标签
- 模块模板
- 快捷按钮
- 推荐理由文案

### 6.2 ScenarioConfig 里包含哪些内容

设计上的 `ScenarioConfig` 包括：

- 基础信息
  - `id`
  - `name`
  - `landing_title`
  - `landing_subtitle`
- 输入阶段
  - `input_placeholder`
  - `example_prompts`
  - `start_button_text`
- Scene Brief 阶段
  - `scene_brief_fields`
  - `field_labels`
  - `field_option_sets`
- 规划阶段
  - `base_template_modules`
  - `planning_summary_template`
- 推荐阶段
  - `results_page_title`
  - `product_reason_style`
  - `product_risk_style`
- 调整阶段
  - `quick_actions`
  - `refine_summary_template`

### 6.3 为什么流程统一、场景配置化是合理方案

因为不同购物场景的流程本质一致：

- 都要先理解需求
- 都要生成规划
- 都要搜索商品
- 都要查看推荐
- 都可能局部调整

如果为每个场景重写一套页面和流程，会导致：

- 工程重复
- 逻辑难维护
- 扩展成本高

而统一 workflow + 场景配置化的好处是：

- 结构稳定
- 易于新增场景
- 产品认知统一

### 6.4 不同场景如何映射到同一 workflow

例如：

#### 新车选购

- Scene Brief 中的 `vehicle_type` 表示车型
- 模块是安全、清洁、车内实用等

#### 露营准备

- `vehicle_type` 可被重解释为出行人数
- 模块变成核心装备、睡眠、照明、电源等

#### 房间装饰

- 同一套确认页结构保留
- 但字段标签变成空间区域、风格偏好、目标等

这说明：

**workflow 不变，字段解释和模板内容变。**

当前代码已经开始建立这层能力，但还未完全切换到全场景驱动版本。

---

## 7. 前后端主要模块说明

## 7.1 关键页面 / 组件

### 前端页面

- [app/page.tsx](./app/page.tsx)
- [app/hosted/page.tsx](./app/hosted/page.tsx)

### 核心组件

- [components/dashboard.tsx](./components/dashboard.tsx)
  - 主购物流程页面
- [components/hosted-console.tsx](./components/hosted-console.tsx)
  - 后端执行台

### UI 基础组件

- [components/ui/button.tsx](./components/ui/button.tsx)
- [components/ui/card.tsx](./components/ui/card.tsx)
- [components/ui/badge.tsx](./components/ui/badge.tsx)
- [components/ui/textarea.tsx](./components/ui/textarea.tsx)

## 7.2 关键 API route

- `scene/parse`
- `scene/plan`
- `scene/refine`
- `modules/search`
- `cart/add`
- `session/agent-directives`
- `session/state`
- `mcp/status`
- `hosted/tasks`

## 7.3 关键 lib 目录模块

### Agent

- [lib/agent/orchestrator.ts](./lib/agent/orchestrator.ts)
- [lib/agent/scene.ts](./lib/agent/scene.ts)
- [lib/agent/planner.ts](./lib/agent/planner.ts)
- [lib/agent/search-strategy.ts](./lib/agent/search-strategy.ts)
- [lib/agent/directives.ts](./lib/agent/directives.ts)
- [lib/agent/refiner.ts](./lib/agent/refiner.ts)
- [lib/agent/product-matcher.ts](./lib/agent/product-matcher.ts)
- [lib/agent/cart.ts](./lib/agent/cart.ts)

### 模型

- [lib/llm/deepseek.ts](./lib/llm/deepseek.ts)
- [lib/llm/prompts.ts](./lib/llm/prompts.ts)
- [lib/llm/mock.ts](./lib/llm/mock.ts)

### 工具

- [lib/mcp/client.ts](./lib/mcp/client.ts)
- [lib/mcp/executor.ts](./lib/mcp/executor.ts)
- [lib/mcp/qoder.ts](./lib/mcp/qoder.ts)
- [lib/mcp/mock.ts](./lib/mcp/mock.ts)
- [lib/mcp/hosted.ts](./lib/mcp/hosted.ts)

### Session

- [lib/session/types.ts](./lib/session/types.ts)
- [lib/session/store.ts](./lib/session/store.ts)
- [lib/session/lifecycle.ts](./lib/session/lifecycle.ts)

### 场景配置

- [lib/scenarios/index.ts](./lib/scenarios/index.ts)
- [lib/scenarios/types.ts](./lib/scenarios/types.ts)

## 7.4 关键状态对象

最重要的状态对象是 `SessionState`，它连接了整个系统。

其次还有：

- `SceneBrief`
- `ShoppingPlan`
- `ShoppingPlanModule`
- `ProductCandidate`
- `ModuleCandidateReview`
- `SelectedItem`
- `MCPToolLog`
- `HostedExecutionTask`

---

## 8. 系统主流程（数据流 / 调用流）

下面按一次完整购物流程说明各层如何协作。

### Step 1：用户选择场景并输入需求

#### 调用层

- 前端交互层

#### 产出数据

- 原始文本需求 `raw_input`

#### 数据流向

- 用户点击“开始理解需求”
- 前端调用 `/api/scene/parse`

---

### Step 2：需求解析

#### 调用层

- API route
- Agent scene 层
- DeepSeek parse_scene

#### 产出数据

- `SceneBrief`

#### 数据流向

- `/api/scene/parse`
-> `orchestrator.parseOnly`
-> `runSceneParser`
-> `deepseek.parseScene`
-> 返回结构化 `scene_brief`
-> 前端进入 `confirm_scene`

---

### Step 3：用户确认需求

#### 调用层

- 前端交互层

#### 产出数据

- 用户手动修改后的 `scene_brief`

#### 数据流向

- 前端只更新本地状态
- 用户点击确认后进入 `/api/scene/plan`

---

### Step 4：生成规划

#### 调用层

- API route
- Agent orchestration
- 模板层
- DeepSeek personalize_template

#### 产出数据

- `base_template`
- `shopping_plan`
- `session_id`

#### 数据流向

- `/api/scene/plan`
-> `createSessionFromScene`
-> `runTemplatePlanner`
-> `runDeepSeekPlanner`
-> 归一化优先级与预算总和
-> `saveSession`
-> 返回 session state

前端随后进入 `confirm_plan`

---

### Step 5：用户确认规划

#### 调用层

- 前端交互层

#### 产出数据

- 用户确认动作
- 可选的模块搜索任务包调整

#### 数据流向

- 如用户调整搜索词，前端调用 `/api/session/search-strategy`
- 后端写回模块 `search_strategy` 并清理该模块旧候选
- 点击“开始搜索推荐商品”
- 前端对每个模块依次调用 `/api/modules/search`

---

### Step 6：搜索候选商品

#### 调用层

- API route
- Agent product-matcher
- MCP / 工具层

#### 产出数据

- `module_candidates[module_id]`
- `module_reviews[module_id]`
- `module_search_traces[module_id]`
- `tool_logs`

#### 数据流向

- `/api/modules/search`
-> `searchModule`
-> `runModuleSearch`
-> 读取模块 `search_strategy.primary_keyword`；缺失时由 `search-strategy` 回退到 `search_keyword` 和 `searchIntentForModule`
-> 如果是 Agent 建议补搜，则优先使用 `keyword_override`
-> `executeMcpTool("search_taobao_products")`
-> 如首轮无结果，可尝试一个备用关键词
-> `rankCandidatesForModule`
-> 转换为 `ProductCandidate[]`
-> `reviewModuleCandidatesWithAgent`
-> DeepSeek 复盘成功则写入 `source=deepseek` 的 `ModuleCandidateReview`
-> DeepSeek 不可用则写入启发式 `ModuleCandidateReview`
-> 写回 session
-> 前端刷新结果

---

### Step 7：查看推荐结果

#### 调用层

- 前端交互层

#### 产出数据

- 用户浏览候选商品
- 用户选择模块 tab

#### 数据流向

- 前端读取当前 session 中的：
  - `shopping_plan`
  - `module_candidates`
  - `tool_logs`
- 渲染模块 tab 和商品卡片

---

### Step 8：局部重算

#### 调用层

- 前端交互层
- API route
- Agent refiner
- DeepSeek refine_plan

#### 产出数据

- 新的 `scene_brief`
- 新的 `shopping_plan`
- 受影响模块列表

#### 数据流向

- 前端点击快捷按钮
- 调用 `/api/scene/refine`
- `runRefiner`
- `deepseek.refinePlan`
- 重新跑 planner
- 清空受影响模块旧结果
- 返回到 `confirm_plan`

---

### Step 9：显式加购与购买确认

#### 调用层

- 前端交互层
- API route
- Agent cart
- MCP / 工具层

#### 产出数据

- 真实加购成功：写入 `selected_items`
- 正式模式真实加购失败：不写入商品，返回可识别错误
- development + `ALLOW_DEMO_CART_FALLBACK=true` + 同步兼容 provider 失败：写入明确标记的 demo cart item

#### 数据流向

- `/api/cart/add`
-> `addToCart`
-> `runCartExecutor`
-> 正式 `local_executor` 创建异步加购 Job，由本地执行器调用淘宝桌面版官方 HTTP MCP
-> 若成功：写入真实加购结果；若失败：保留失败并允许用户修复后重试
-> 同步开发兼容 provider 失败时，仅在开发预览且显式允许回退时写入 demo cart
-> 前端进入购买确认页；真实条目可继续打开淘宝购物车，系统不会自动下单或支付

购物确认页的移除链路：

- 演示项：用户确认 -> `/api/cart/remove` -> Session 锁 -> 校验 `cart_source=demo` -> 删除产品内条目 -> 重算组合采纳进度
- 真实淘宝项：前端打开淘宝购物车；服务端若收到移除请求则返回 `409 taobao_cart_managed_externally`
- 来源不明的历史项：按真实淘宝项处理并拒绝删除，避免宽松兼容造成误操作

---

## 9. 当前架构的优点

### 9.1 分层明确

当前系统最有价值的地方，是职责分层清晰：

- 前端负责交互
- Agent 负责编排
- 模型负责结构化补充
- 工具层负责执行

这比“前端 + 大模型直连”的方案稳定很多。

### 9.2 工作流强于聊天

统一 workflow 让产品具备很强的任务感和可理解性，不是模糊聊天流，而是明确决策流。

### 9.3 模型边界合理

模型被约束在擅长的任务上，避免成为不可控的“万能黑盒”。

### 9.4 Session 设计完整

当前 session 结构已经足以支撑：

- 多阶段流程
- 搜索回填
- 快捷调整
- 执行台查看
- 账号级历史续接、安全归档和显式恢复

### 9.5 工具层具备真实连接能力

系统已经不是纯 mock 页面：正式本地执行器可通过淘宝桌面版官方 HTTP MCP 回填真实搜索与加购结果。其可用性仍取决于客户端、登录态、工具授权和具体商品规格。

---

## 10. 当前架构的不足与后续可演进方向

### 10.1 最大不足：真实执行层仍受外部宿主约束

当前最薄弱的环节是淘宝执行层，尤其是：

- 商品详情页导航
- 多规格商品的 SKU 选择
- 淘宝客户端登录态与 MCP 工具授权稳定性

### 10.2 多场景已开放，真实设备验收深度仍不一致

首页和统一工作流已经开放五个 `ScenarioConfig` 场景。新车场景覆盖了最完整的真实设备回归与面试脚本；其他场景仍需要补齐同等深度的真实搜索样本、长期回归和针对性验收数据。

### 10.3 工作流恢复调度仍需部署平台托管

跨实例推进已经由 PostgreSQL advisory lock 保护，服务端也提供恢复扫描器、独立 Worker、受保护的 Cron API 与持久化服务心跳。readiness 和执行台可以识别调度从未运行、心跳过期、扫描失败或部分会话降级。剩余边界是云端平台仍需实际托管定时触发，并把这些运行告警接入外部通知；代码无法自行保证外部调度器永远存活。

### 10.4 前端大组件仍然偏重

`dashboard.tsx` 承担了过多页面状态和渲染职责，未来应继续拆分。

### 10.5 兼容执行代码仍增加维护复杂度

正式主路径已经收敛为 `local_executor + durable job queue + device token`，且该路径也是未配置 backend 时的默认值。安装 Qoder 不会再触发隐式 provider 切换。主页面只在显式 `codex_hosted` 开发模式下读取旧 Worker 状态，production 会拒绝 legacy hosted API；`qoder_cli`、hosted、experimental bridge 和 mock adapter 仍作为显式 opt-in 的迁移、开发与测试代码存在。手动 MCP 调试端点默认关闭并由 readiness/release audit 约束。后续在真实设备验收稳定后，应按版本计划删除不再需要的旧 provider，而不是让它们重新进入正式运行时。

设备注册后签发的明文 Token 只展示一次。开发机通过 `executor:configure` 在交互式终端中隐藏输入，脚本只更新 `TAOBAO_EXECUTION_BACKEND`、`SCENECART_API_URL` 与 `SCENECART_DEVICE_TOKEN`，保留其他环境变量，使用临时文件原子替换 `.env.local` 并强制 `0600` 权限。淘宝 MCP 地址和调用来源分别由 `TAOBAO_NATIVE_MCP_URL`、`TAOBAO_SOURCE_APP` 配置。服务端始终只持久化 Token 的 SHA-256 摘要，Doctor 与 Worker 再通过 Bearer Token 和协议版本完成设备鉴权。

### 10.6 下一步理想演进方向

从架构角度看，下一步更理想的演进路径应该是：

1. 为五个已开放场景补齐同等深度的真实设备验收集
2. 增加稳定的商品详情 / SKU / 购物车能力
3. 把恢复调度失联和长时间未恢复会话接入外部通知渠道
4. 拆分 dashboard 的页面级状态
5. 增加真实设备故障注入和长时间运行测试

---

## 11. 架构图绘制依据

后续绘制架构图时，建议至少包含以下节点和连接关系。

### 11.1 必须包含的节点

#### 用户侧

- 用户
- 浏览器前端

#### 前端层

- Dashboard / 主购物流程页
- Hosted Console / 执行台

#### API 层

- `POST /api/scene/parse`
- `POST /api/scene/plan`
- `POST /api/scene/refine`
- `POST /api/modules/search`
- `POST /api/cart/add`
- `POST /api/agent/run`
- `POST /api/agent/pause`
- `POST /api/agent/resume`
- `POST /api/mcp/run`
- `GET /api/session/state`
- `GET /api/mcp/status`
- `GET /api/runtime/events/stream`
- `GET /api/runtime/metrics`
- `GET|POST /api/internal/workflow-recovery`

#### Agent 层

- `orchestrator`
- `scene`
- `planner`
- `refiner`
- `product-matcher`
- `candidate-ranker`
- `candidate-reviewer`
- `workflow-runner`
- `workflow-recovery`
- `cart`

#### 配置 / 模板层

- `ScenarioConfig`
- `base_template_modules`

#### 模型层

- DeepSeek API
- mock LLM fallback
- heuristic candidate review fallback

#### 工具层

- MCP client
- MCP executor
- MCP tool schema / risk policy
- local executor / durable job queue
- 淘宝桌面版官方 HTTP MCP
- Qoder / hosted / experimental compatibility providers
- mock MCP adapter

#### 状态层

- Session Store
- PostgreSQL Runtime Repository
- Agent Jobs / Execution Events
- SessionState

### 11.2 必须画出的连接关系

1. 用户 -> 前端页面
2. 前端页面 -> API route
3. API route -> orchestrator
4. orchestrator -> 场景模板层
5. orchestrator -> DeepSeek
6. orchestrator -> MCP executor
7. MCP executor -> local executor adapter -> Agent Job Queue
8. orchestrator -> Session Store
9. Session Store -> API route -> 前端
10. 推荐页 / 执行台 -> 同一个 SessionState
11. product-matcher -> candidate-ranker -> candidate-reviewer -> module_reviews
12. 推荐页 -> keyword_override -> `/api/modules/search` -> product-matcher
13. workflow-runner -> Agent Job Queue -> local executor -> 淘宝桌面版官方 HTTP MCP
14. local executor -> result callback -> Session advisory lock -> workflow-runner
15. recovery worker / cloud Cron -> internal recovery API -> workflow-recovery

### 11.3 建议在图中强调的关键数据对象

- `raw_input`
- `SceneBrief`
- `ShoppingPlan`
- `ModuleSearchStrategy`
- `module_candidates`
- `ModuleCandidateReview`
- `module_reviews`
- `selected_items`
- `tool_logs`
- `SessionState`

### 11.4 建议在图中标注的关键设计取舍

- “模板 + LLM 补充”
- “AI 生成搜索策略，后端规则执行工具”
- “搜索后 DeepSeek/规则复盘候选池”
- “Agent 建议补搜，但由用户确认触发”
- “工具调用由后端规则编排”
- “浏览器只观察，服务端工作流自动续跑”
- “PostgreSQL advisory lock 防止跨实例重复推进与旧快照覆盖”
- “恢复扫描只重放持久结果，不重复执行淘宝动作”
- “高风险工具动作服务端确认”
- “搜索尽量真实执行”
- “正式模式禁止演示加购伪成功”
- “开发预览可配置且必须标注 demo cart”
- “统一 workflow，场景配置驱动”
