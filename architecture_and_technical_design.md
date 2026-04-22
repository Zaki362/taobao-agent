# SceneCart AI 产品架构与技术方案

## 1. 产品架构总览

### 1.1 产品整体由哪些层组成

当前产品可以拆分为八个核心层：

1. **前端交互层**
2. **后端 API 层**
3. **Agent orchestration 层**
4. **场景配置 / 模板层**
5. **DeepSeek 模型层**
6. **MCP / skill / 工具调用层**
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

#### MCP / skill / 工具调用层

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
5. 生成 `shopping_plan`
6. 写入 `SessionState`
7. 返回给前端
8. 前端进入 `confirm_plan` 页面展示

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
- 展示执行摘要和下单确认页
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

- [app/page.tsx](/Users/guohuaz/Taobao-agent/app/page.tsx)
- [components/dashboard.tsx](/Users/guohuaz/Taobao-agent/components/dashboard.tsx)
- [components/hosted-console.tsx](/Users/guohuaz/Taobao-agent/components/hosted-console.tsx)

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
- `/api/session/state`
- `/api/mcp/status`
- `/api/hosted/*`

关键文件：

- [app/api/scene/parse/route.ts](/Users/guohuaz/Taobao-agent/app/api/scene/parse/route.ts)
- [app/api/scene/plan/route.ts](/Users/guohuaz/Taobao-agent/app/api/scene/plan/route.ts)
- [app/api/scene/refine/route.ts](/Users/guohuaz/Taobao-agent/app/api/scene/refine/route.ts)
- [app/api/modules/search/route.ts](/Users/guohuaz/Taobao-agent/app/api/modules/search/route.ts)
- [app/api/cart/add/route.ts](/Users/guohuaz/Taobao-agent/app/api/cart/add/route.ts)
- [app/api/session/state/route.ts](/Users/guohuaz/Taobao-agent/app/api/session/state/route.ts)

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
- Selected Items
- Tool Logs
- 更新后的 SessionState

### 和其他层如何协作

- 调用场景模板层提供基础结构
- 调用 DeepSeek 层做结构化补充
- 调用工具层做搜索与加购
- 通过 session/store 持久化状态

### 当前实现状态

**已实现**

关键文件：

- [lib/agent/orchestrator.ts](/Users/guohuaz/Taobao-agent/lib/agent/orchestrator.ts)
- [lib/agent/scene.ts](/Users/guohuaz/Taobao-agent/lib/agent/scene.ts)
- [lib/agent/planner.ts](/Users/guohuaz/Taobao-agent/lib/agent/planner.ts)
- [lib/agent/refiner.ts](/Users/guohuaz/Taobao-agent/lib/agent/refiner.ts)
- [lib/agent/product-matcher.ts](/Users/guohuaz/Taobao-agent/lib/agent/product-matcher.ts)
- [lib/agent/cart.ts](/Users/guohuaz/Taobao-agent/lib/agent/cart.ts)

---

## 2.4 场景配置 / 模板层

### 主要职责

- 定义每个购物场景的基础模块结构
- 提供场景文案、输入提示、字段标签、快捷操作等配置
- 为未来多场景扩展提供统一抽象

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

**部分实现**

已建立的配置层文件：

- [lib/scenarios/index.ts](/Users/guohuaz/Taobao-agent/lib/scenarios/index.ts)
- [lib/scenarios/types.ts](/Users/guohuaz/Taobao-agent/lib/scenarios/types.ts)
- [lib/scenarios/new-car.ts](/Users/guohuaz/Taobao-agent/lib/scenarios/new-car.ts)
- [lib/scenarios/camping.ts](/Users/guohuaz/Taobao-agent/lib/scenarios/camping.ts)
- [lib/scenarios/room-decor.ts](/Users/guohuaz/Taobao-agent/lib/scenarios/room-decor.ts)
- [lib/scenarios/dorm-move-in.ts](/Users/guohuaz/Taobao-agent/lib/scenarios/dorm-move-in.ts)
- [lib/scenarios/moving-setup.ts](/Users/guohuaz/Taobao-agent/lib/scenarios/moving-setup.ts)

但当前产品稳定运行版本仍主要围绕“新车选购”。

---

## 2.5 DeepSeek 模型层

### 主要职责

DeepSeek 在系统中不做“自由 Agent”，而做“受约束的结构化补充器”。

主要任务：

- parse_scene
- personalize_template
- refine_plan
- explain_product_fit

### 输入输出

#### 输入

- 用户原始需求
- Scene Brief
- 模板模块
- 快捷操作
- 商品信息

#### 输出

- 严格 JSON
- 结构化 Scene Brief
- 结构化 Shopping Plan
- 调整后的 Scene Brief
- 商品推荐理由

### 和其他层如何协作

- 由 Agent orchestration 层调用
- 不直接与前端交互
- 不直接调用工具

### 当前实现状态

**已实现**

关键文件：

- [lib/llm/deepseek.ts](/Users/guohuaz/Taobao-agent/lib/llm/deepseek.ts)
- [lib/llm/prompts.ts](/Users/guohuaz/Taobao-agent/lib/llm/prompts.ts)
- [lib/llm/mock.ts](/Users/guohuaz/Taobao-agent/lib/llm/mock.ts)

---

## 2.6 MCP / skill / 工具调用层

### 主要职责

- 接入淘宝搜索能力
- 接入详情提取能力
- 接入加购物能力
- 记录工具日志
- 抽象 live / mock / qoder 执行差异

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

**部分实现**

工具抽象已建立，真实淘宝执行具备一定能力，但不稳定。

关键文件：

- [lib/mcp/types.ts](/Users/guohuaz/Taobao-agent/lib/mcp/types.ts)
- [lib/mcp/client.ts](/Users/guohuaz/Taobao-agent/lib/mcp/client.ts)
- [lib/mcp/executor.ts](/Users/guohuaz/Taobao-agent/lib/mcp/executor.ts)
- [lib/mcp/qoder.ts](/Users/guohuaz/Taobao-agent/lib/mcp/qoder.ts)
- [lib/mcp/mock.ts](/Users/guohuaz/Taobao-agent/lib/mcp/mock.ts)
- [lib/mcp/hosted.ts](/Users/guohuaz/Taobao-agent/lib/mcp/hosted.ts)

---

## 2.7 Session / context 状态管理层

### 主要职责

- 保存整个工作流上下文
- 支持多阶段页面恢复
- 支持搜索结果、规划结果和已选商品持续存在

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

- [lib/session/types.ts](/Users/guohuaz/Taobao-agent/lib/session/types.ts)
- [lib/session/store.ts](/Users/guohuaz/Taobao-agent/lib/session/store.ts)

---

## 2.8 Mock / Live 执行模式层

### 主要职责

- 让系统在真实外部能力不稳定时仍然完整可演示
- 在真实链路失败时维持前端体验不崩溃

### 输入输出

#### 输入

- 当前执行模式
- 工具调用请求

#### 输出

- live 真实结果
- mock 商品结果
- demo cart fallback

### 和其他层如何协作

- client 层负责决策
- mock adapter 与 qoder adapter 提供统一接口

### 当前实现状态

**已实现，但真实模式不稳定**

产品当前核心策略是：

- 搜索尽可能走真实能力
- 加购先尝试真实执行
- 失败则回退到产品内 demo 购物车

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
- 失败处理

#### DeepSeek 负责

- 场景理解
- 模板个性化补充
- 快捷调整重算
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

#### Module Candidates

由搜索阶段为每个模块逐步写入，用于推荐结果页展示。

#### Tool Logs

每次工具调用统一写入，用于推荐页侧边折叠区和执行台展示。

#### Selected Items

由加购行为累积写入，用于下单确认页和 demo cart。

---

## 4. DeepSeek 技术方案

### 4.1 DeepSeek 主要负责哪些任务

DeepSeek 目前承担四类结构化任务：

1. `parse_scene`
2. `personalize_template`
3. `refine_plan`
4. `explain_product_fit`

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

#### refine_plan

响应快捷操作，例如：

- 压缩预算
- 只看必买
- 更偏实用
- 我已有某物品

输出新的 Scene Brief。

#### explain_product_fit

为商品卡片生成简洁的适配理由。

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

### 4.5 mock fallback 如何设计

当没有 `DEEPSEEK_API_KEY`，或模型调用失败时：

- `mockParseScene`
- `mockPersonalizeTemplate`
- `mockRefineScene`
- `mockExplainProductFit`

会提供一个稳定的 mock 结果。

这样做的目的不是伪装真实模型，而是：

- 确保整个产品链路始终可演示
- 让架构随时可切换到真实模型

---

## 5. MCP / 淘宝 skill 技术方案

### 5.1 MCP 工具层如何抽象

系统逻辑上定义了统一工具接口：

- `search_taobao_products`
- `open_product_detail`
- `extract_product_info`
- `add_to_cart`

这些工具不直接暴露给前端，而由后端通过 executor 调用。

### 5.2 search / open detail / extract info / add to cart 如何组织

#### search

搜索阶段最稳定，所以当前是整个真实执行链路的核心。

流程：

- product-matcher 生成 search intent
- 调用 `search_taobao_products`
- 返回若干候选商品
- 转换成 `ProductCandidate`

#### open detail / extract info

这部分能力逻辑上存在，但目前为了稳定性，在搜索阶段默认不自动进入详情页，只返回搜索摘要。

#### add to cart

逻辑上支持，但真实链路不稳定，所以采用了：

- 先尝试真实加购
- 若失败，则回退到 demo cart

### 5.3 live-first / mock fallback 如何设计

设计上曾尝试：

- live-first
- 失败 fallback mock

但由于淘宝真实能力存在会话问题，目前更实际的策略是：

- 搜索尽量真实
- 加购失败 fallback demo
- 整个系统始终保持完整演示闭环

### 5.4 为什么不能假设宿主一定开放能力

因为这个项目真实踩到了：

- 本地 bridge 不稳定
- 宿主权限不透明
- Qoder CLI 和桌面端能力不完全一致
- 商品详情页导航会影响淘宝登录态

所以产品架构不能默认：

- 工具一定可用
- 宿主一定授权
- 详情页一定安全

必须始终保留 fallback 设计。

### 5.5 当前产品和宿主 / 本地 bridge / 淘宝 MCP 的关系

当前真实关系是：

- 产品本体是一个本地 Web 应用
- 它不能直接复用 Qoder 桌面 GUI 内部状态
- 当前主要通过 `qodercli` 调起淘宝 skill
- 也保留了 mock 和 hosted 的抽象结构

换句话说，当前是：

**产品后端 -> qodercli / skill -> taobao-native / 淘宝客户端**

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

- [app/page.tsx](/Users/guohuaz/Taobao-agent/app/page.tsx)
- [app/hosted/page.tsx](/Users/guohuaz/Taobao-agent/app/hosted/page.tsx)

### 核心组件

- [components/dashboard.tsx](/Users/guohuaz/Taobao-agent/components/dashboard.tsx)
  - 主购物流程页面
- [components/hosted-console.tsx](/Users/guohuaz/Taobao-agent/components/hosted-console.tsx)
  - 后端执行台

### UI 基础组件

- [components/ui/button.tsx](/Users/guohuaz/Taobao-agent/components/ui/button.tsx)
- [components/ui/card.tsx](/Users/guohuaz/Taobao-agent/components/ui/card.tsx)
- [components/ui/badge.tsx](/Users/guohuaz/Taobao-agent/components/ui/badge.tsx)
- [components/ui/textarea.tsx](/Users/guohuaz/Taobao-agent/components/ui/textarea.tsx)

## 7.2 关键 API route

- `scene/parse`
- `scene/plan`
- `scene/refine`
- `modules/search`
- `cart/add`
- `session/state`
- `mcp/status`
- `hosted/tasks`

## 7.3 关键 lib 目录模块

### Agent

- [lib/agent/orchestrator.ts](/Users/guohuaz/Taobao-agent/lib/agent/orchestrator.ts)
- [lib/agent/scene.ts](/Users/guohuaz/Taobao-agent/lib/agent/scene.ts)
- [lib/agent/planner.ts](/Users/guohuaz/Taobao-agent/lib/agent/planner.ts)
- [lib/agent/refiner.ts](/Users/guohuaz/Taobao-agent/lib/agent/refiner.ts)
- [lib/agent/product-matcher.ts](/Users/guohuaz/Taobao-agent/lib/agent/product-matcher.ts)
- [lib/agent/cart.ts](/Users/guohuaz/Taobao-agent/lib/agent/cart.ts)

### 模型

- [lib/llm/deepseek.ts](/Users/guohuaz/Taobao-agent/lib/llm/deepseek.ts)
- [lib/llm/prompts.ts](/Users/guohuaz/Taobao-agent/lib/llm/prompts.ts)
- [lib/llm/mock.ts](/Users/guohuaz/Taobao-agent/lib/llm/mock.ts)

### 工具

- [lib/mcp/client.ts](/Users/guohuaz/Taobao-agent/lib/mcp/client.ts)
- [lib/mcp/executor.ts](/Users/guohuaz/Taobao-agent/lib/mcp/executor.ts)
- [lib/mcp/qoder.ts](/Users/guohuaz/Taobao-agent/lib/mcp/qoder.ts)
- [lib/mcp/mock.ts](/Users/guohuaz/Taobao-agent/lib/mcp/mock.ts)
- [lib/mcp/hosted.ts](/Users/guohuaz/Taobao-agent/lib/mcp/hosted.ts)

### Session

- [lib/session/types.ts](/Users/guohuaz/Taobao-agent/lib/session/types.ts)
- [lib/session/store.ts](/Users/guohuaz/Taobao-agent/lib/session/store.ts)

### 场景配置

- [lib/scenarios/index.ts](/Users/guohuaz/Taobao-agent/lib/scenarios/index.ts)
- [lib/scenarios/types.ts](/Users/guohuaz/Taobao-agent/lib/scenarios/types.ts)

## 7.4 关键状态对象

最重要的状态对象是 `SessionState`，它连接了整个系统。

其次还有：

- `SceneBrief`
- `ShoppingPlan`
- `ShoppingPlanModule`
- `ProductCandidate`
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
-> `saveSession`
-> 返回 session state

前端随后进入 `confirm_plan`

---

### Step 5：用户确认规划

#### 调用层

- 前端交互层

#### 产出数据

- 用户确认动作

#### 数据流向

- 点击“开始搜索推荐商品”
- 前端对每个模块依次调用 `/api/modules/search`

---

### Step 6：搜索候选商品

#### 调用层

- API route
- Agent product-matcher
- MCP / skill 工具层

#### 产出数据

- `module_candidates[module_id]`
- `tool_logs`

#### 数据流向

- `/api/modules/search`
-> `searchModule`
-> `runModuleSearch`
-> `searchIntentForModule`
-> `executeMcpTool("search_taobao_products")`
-> 转换为 `ProductCandidate[]`
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

### Step 9：加入购物车

#### 调用层

- 前端交互层
- API route
- Agent cart
- MCP / skill 工具层

#### 产出数据

- 真实加购成功：写入 `selected_items`
- 真实加购失败：写入 demo cart item

#### 数据流向

- `/api/cart/add`
-> `addToCart`
-> `runCartExecutor`
-> 尝试 `executeMcpTool("add_to_cart")`
-> 若成功：写入真实加购结果
-> 若失败：回退到 demo cart
-> 前端进入购物确认页

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

### 9.5 工具层具备真实连接能力

尽管不稳定，但系统已经不是纯 mock 页面，而是真实尝试接入了淘宝执行能力。

---

## 10. 当前架构的不足与后续可演进方向

### 10.1 最大不足：真实执行层不稳定

当前最薄弱的环节是淘宝执行层，尤其是：

- 商品详情页导航
- 加购物
- Qoder stdout 稳定性

### 10.2 场景泛化尚未完全落地

场景配置层已经开始建立，但前端与搜索层还未完全切换到配置驱动。

### 10.3 前端大组件仍然偏重

`dashboard.tsx` 承担了过多页面状态和渲染职责，未来应继续拆分。

### 10.4 执行方案并存导致复杂度高

当前同时存在：

- qoder_cli
- hosted
- mock

未来需要明确主路径。

### 10.5 下一步理想演进方向

从架构角度看，下一步更理想的演进路径应该是：

1. 完成 scenario config 全链路接入
2. 统一执行策略，收敛主工具通道
3. 增加真正稳定的商品详情 / SKU / 购物车能力
4. 拆分 dashboard 的页面级状态
5. 增加更完整的类型校验和集成测试

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
- `GET /api/session/state`
- `GET /api/mcp/status`

#### Agent 层

- `orchestrator`
- `scene`
- `planner`
- `refiner`
- `product-matcher`
- `cart`

#### 配置 / 模板层

- `ScenarioConfig`
- `base_template_modules`

#### 模型层

- DeepSeek API
- mock LLM fallback

#### 工具层

- MCP client
- MCP executor
- Qoder / taobao skill
- mock MCP adapter

#### 状态层

- Session Store
- SessionState

### 11.2 必须画出的连接关系

1. 用户 -> 前端页面
2. 前端页面 -> API route
3. API route -> orchestrator
4. orchestrator -> 场景模板层
5. orchestrator -> DeepSeek
6. orchestrator -> MCP executor
7. MCP executor -> qoder skill / mock adapter
8. orchestrator -> Session Store
9. Session Store -> API route -> 前端
10. 推荐页 / 执行台 -> 同一个 SessionState

### 11.3 建议在图中强调的关键数据对象

- `raw_input`
- `SceneBrief`
- `ShoppingPlan`
- `module_candidates`
- `selected_items`
- `tool_logs`
- `SessionState`

### 11.4 建议在图中标注的关键设计取舍

- “模板 + LLM 补充”
- “工具调用由后端规则编排”
- “搜索尽量真实执行”
- “加购失败回退 demo cart”
- “统一 workflow，场景配置驱动”

