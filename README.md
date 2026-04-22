# AutoPrep AI

场景化购物 Agent Demo，聚焦“新车用品首购”。

## 特性

- Next.js App Router 全栈项目
- 后端 Agent orchestration
- Scene Understanding / Task Planning / Product Matching / Refinement 四层结构
- DeepSeek 接入层，缺失 key 时自动 fallback mock
- 淘宝 MCP adapter 架构，支持 mock / live 切换
- 默认演示场景首次加载即自动生成

## 运行

```bash
npm install
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)

## 环境变量

复制 `.env.example` 为 `.env.local`：

```bash
DEEPSEEK_API_KEY=
DEEPSEEK_CHAT_MODEL=deepseek-chat
DEEPSEEK_REASONER_MODEL=deepseek-reasoner
TAOBAO_MCP_MODE=mock
TAOBAO_MCP_BASE_URL=
```

- `DEEPSEEK_API_KEY`：填写后将启用真实 DeepSeek 场景补充能力
- `DEEPSEEK_CHAT_MODEL`：用于轻量理解和商品适配解释
- `DEEPSEEK_REASONER_MODEL`：用于任务规划和快捷操作重算
- `TAOBAO_MCP_BASE_URL`：用户自己的淘宝 MCP bridge 地址，系统会优先尝试连接它；不可达时自动 fallback mock
- `TAOBAO_MCP_MODE`：保留兼容字段，但当前实现已改为 live-first 检测

## API

- `POST /api/scene/parse`
- `POST /api/scene/plan`
- `POST /api/scene/refine`
- `POST /api/modules/search`
- `POST /api/cart/add`
- `POST /api/mcp/run`
- `GET /api/mcp/status`
- `GET /api/session/state`

## 目录

- `app/`: 页面与 API Route
- `components/`: 操作台 UI
- `lib/agent/`: Agent orchestration 与工具节点
- `lib/llm/`: DeepSeek + mock
- `lib/mcp/`: MCP schema / client / executor / mock / live
- `lib/templates/`: 新车用品首购模板
- `lib/session/`: Session state store 与类型

## 淘宝 MCP

项目已改为 `live-first`：

1. 优先检测 `TAOBAO_MCP_BASE_URL`
2. 可用则走真实淘宝 MCP bridge
3. 不可用才 fallback 到 mock

详细接入方式见：

- [docs/taobao-mcp-bridge.md](./docs/taobao-mcp-bridge.md)
