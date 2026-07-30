# SceneCart AI

SceneCart AI 是一个“场景化购物 Agent”全栈 Demo。当前稳定场景聚焦 **新车选购 / 新车用品首购**：用户先输入真实场景目标，系统再逐步完成需求理解、购物规划、模块化搜索、推荐展示和下单前清单确认。

这个项目不是普通商品搜索页，也不是纯聊天机器人。它的重点是把用户原本需要自己完成的“买什么、先买什么、预算怎么分、每类商品怎么选”这套决策过程产品化。

## 当前能力

- 阶段式 Agent workflow：需求输入 -> 场景理解 -> 用户确认 -> 购物规划 -> 用户确认 -> 串行搜索 -> 推荐结果 -> 快捷调整 -> 购物清单确认
- 后端 Agent orchestration：前端不直接拼数据，核心流程由 `lib/agent` 统一编排
- DeepSeek 接入层：用于 `parse_scene`、`personalize_template`、`review_plan`、`refine_plan`、候选池复盘与商品适配说明；缺少 key、超时或结构异常时自动走 mock / heuristic fallback
- 场景模板 + LLM 补充：模板提供稳定结构，模型负责裁剪、排序、预算策略和模块级 `search_strategy`，后端会做预算归一化、关键词差异化修复与搜索策略兜底，保证模块预算加总等于用户预算，并尽量避免不同模块搜索同一批商品
- Agent 方案自检：规划生成后会产出 `plan_review`，在用户确认前检查预算分配、模块覆盖、关键词差异化和风险点
- AI 执行档位：用户可在规划确认页选择保守 / 平衡 / 探索，服务端会写回 `agent_directives`，影响后续搜索深度、补搜策略和恢复边界
- AI 搜索策略 + 候选排序：搜索结果会经过 Candidate Ranker，根据 AI 生成的主搜索词、备用搜索词、包含词、排除词、排序关注点、验收信号、拒绝信号、预算、偏好、已有/排除项和店铺信号选出稳妥 / 性价比 / 升级三档
- 搜索后 Agent 复盘：每个模块搜索后会生成 `module_reviews`，评估候选池是否足够、风险点是什么、下一步建议是什么；有 DeepSeek 时会尝试短超时复盘，无 key 或失败时使用启发式规则评估
- Agent 搜索决策轨迹：每个模块搜索会写入 `module_search_traces`，记录首轮词、备用词、补搜原因、每次返回数、候选池复盘和下一步建议，让 AI 的执行判断可解释、可恢复
- 服务端 Agent 决策循环：搜索阶段不再由前端硬编码遍历模块，后端会消费 AI 规划顺序、执行档位、候选池复盘和工具状态，逐轮决定搜索、补搜、容错跳过、等待工具或结束，并把动作写入 `agent_decisions`
- Agent 建议补搜：当候选偏少或质量不足时，推荐页会展示建议搜索词，用户可以一键按 Agent 建议补搜当前模块
- 快捷调整影响说明：用户点击快捷调整后，系统会生成 `last_refinement`，说明哪些模块需要重搜、哪些候选可复用、哪些模块被移除以及原因
- 淘宝 skill / MCP 工具层：支持通过 Qoder CLI、Codex hosted worker、experimental local bridge、mock adapter 等方式接入；adapter 输出会统一清洗、去重和类型归一后再进入推荐链路
- 商品搜索链路：当前主流程可串行搜索规划中的各个模块，并生成推荐商品卡片
- 加购保守策略：高风险动作必须显式确认，服务端和 MCP executor 会双重校验；真实加购失败后回退到产品内演示购物车，保证 Demo 流程完整
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
- Qoder CLI / Taobao skill / MCP adapter

## 快速开始

```bash
npm install
npm run dev
```

打开：

```text
http://localhost:3000
```

生产构建检查：

```bash
npm run check
```

`npm run check` 会依次执行项目预检、TypeScript 检查和生产构建。预检会拦截本地密钥、硬编码用户路径、旧 MCP 环境变量、关键 Agent 架构文件缺失，以及 DeepSeek 校验、AI 搜索/执行策略、候选排序、候选池复盘、MCP 输入输出校验、高风险确认、错误脱敏、workflow 恢复等核心契约被破坏的情况。

或分别执行：

```bash
npm run preflight
npm run typecheck
npm run build
```

## 环境变量

复制 `.env.example` 为 `.env.local`，按需配置：

```bash
DEEPSEEK_API_KEY=
DEEPSEEK_CHAT_MODEL=deepseek-chat
DEEPSEEK_REASONER_MODEL=deepseek-reasoner
TAOBAO_EXECUTION_BACKEND=qoder_cli
QODERCLI_PATH=
TAOBAO_NATIVE_BIN=
TAOBAO_MCP_BASE_URL=
```

说明：

- `DEEPSEEK_API_KEY`：填写后会尝试启用真实 DeepSeek 能力；只有实际调用成功才标记为 connected。无 key、超时、非 JSON 或接口失败都会走 mock fallback。
- `TAOBAO_EXECUTION_BACKEND`：可选 `qoder_cli`、`codex_hosted`、`experimental_local`。当前推荐演示路径是 `qoder_cli` 搜索 + 加购失败 demo fallback。
- `QODERCLI_PATH`：可选，指定本机 qodercli 路径；默认会尝试读取当前用户目录下的 `~/.local/bin/qodercli`。
- `TAOBAO_NATIVE_BIN`：仅 experimental local bridge 使用，可选，指定 `taobao-native` 命令名或可执行文件路径。
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
  decision-engine.ts               Agent 下一步动作决策与审计记录
  scene.ts                         场景解析入口
  planner.ts                       模板规划 + DeepSeek 规划接入
  search-strategy.ts               纯搜索关键词与搜索策略归一化，供规划和旧会话恢复复用
  plan-reviewer.ts                 规划质量自检
  refiner.ts                       快捷调整重算
  candidate-ranker.ts              候选商品排序与三档推荐选择
  candidate-reviewer.ts            搜索后候选池质量评估与 DeepSeek 复盘 fallback
  product-matcher.ts               模块搜索与候选商品构造
  cart.ts                          加购与 demo cart fallback

lib/llm/
  deepseek.ts                      DeepSeek 调用、结构归一化与候选池复盘
  prompts.ts                       Prompt 模板
  mock.ts                          无 key / 调用失败时的 mock fallback

lib/mcp/
  client.ts                        执行 backend 选择
  executor.ts                      工具调用与日志记录
  qoder.ts                         Qoder CLI / 淘宝 skill provider
  hosted.ts                        Codex hosted worker 任务模式
  live.ts                          experimental local bridge adapter
  mock.ts                          演示商品池

lib/session/
  types.ts                         核心状态类型
  store.ts                         服务端 session store

lib/scenarios/
  当前保留多场景配置雏形，稳定产品入口暂以新车选购为主
```

## 核心 API

- `POST /api/scene/parse`：解析用户需求为 Scene Brief
- `POST /api/scene/plan`：基于场景模板和 DeepSeek 生成 Shopping Plan
- `POST /api/scene/refine`：根据快捷操作重算方案
- `POST /api/modules/search`：为指定模块搜索候选商品；可选 `keyword_override` 用于按 Agent 建议补搜
- `POST /api/agent/next-action`：根据当前 session 决定搜索、补搜、跳过、等待或结束
- `POST /api/cart/add`：尝试加购，要求 `confirmed: true`；失败后进入 demo cart fallback
- `POST /api/session/agent-directives`：用户确认规划前切换 AI 执行档位，写回当前 session 的 `agent_directives`
- `POST /api/session/search-strategy`：用户确认规划前微调模块搜索任务包，写回当前 session 的主搜索词和备用词
- `GET /api/session/state`：读取当前 session 完整状态
- `GET /api/mcp/status`：读取当前工具执行模式状态
- `POST /api/mcp/run`：调试 MCP 工具；高风险工具必须同时传 `confirm_high_risk=true` 与 `input.confirmed=true`
- `GET /api/sessions`：执行台读取会话列表

错误响应统一为 JSON：

```json
{
  "error": "human readable message",
  "code": "bad_request | not_found | conflict | internal_error"
}
```

## 当前实现边界

- 当前稳定主场景是“新车选购”。`lib/scenarios` 中已有多场景配置雏形，但前端入口暂未完全开放。
- 淘宝搜索能力相对稳定；商品详情页和真实加购受淘宝客户端、授权和登录态影响较大。
- 加购失败时会自动进入产品内演示购物车，这是为了保证 Demo 可完整演示，不代表真实淘宝购物车一定成功。
- Qoder CLI / 淘宝 skill 是实验性执行路径，不应当视为生产级电商执行 API。

## 项目文档

- [产品创作复盘](./product_creation_recap.md)
- [产品架构与技术方案](./architecture_and_technical_design.md)
- [Qoder CLI Provider 说明](./docs/qoder-cli-provider.md)
- [淘宝 MCP Bridge 说明](./docs/taobao-mcp-bridge.md)
- [Codex Hosted Worker 说明](./docs/codex-hosted-worker.md)

## 推荐演示路径

1. 打开首页，进入“新车选购”。
2. 使用默认示例需求或输入自己的预算和偏好。
3. 确认 Scene Brief，可手动调整车型、预算、阶段、偏好、已有物品和排除项。
4. 查看购物规划，重点观察 AI 规划模式、Agent 方案自检、差异化搜索意图、AI 取舍、预算说明和模块优先级；也可以选择保守 / 平衡 / 探索执行档位。
5. 确认规划后开始搜索，系统会串行搜索各模块。
6. 在推荐页查看模块化商品结果，右侧会展示当前模块的 AI 推荐逻辑、搜索决策轨迹、候选池复盘、风险提醒和下一步建议；如果候选偏少，可以按 Agent 建议补搜。
7. 使用快捷调整回到规划页重新确认。
8. 点击加入购物车；若真实加购失败，会进入演示购物车。
9. 进入下单购买页查看已选商品清单和总价。
