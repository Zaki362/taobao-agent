# 淘宝 MCP 接入说明

当前项目已经具备 `live-first` 的淘宝 MCP adapter。

也就是说：

1. 项目会优先尝试连接你的真实淘宝 MCP
2. 如果不可达，才自动回退到 mock
3. UI 会明确显示当前是 `已连接淘宝 MCP` 还是 `演示模式（Mock）`

## 项目内已提供 bridge 骨架

当前仓库已经新增一个本地 bridge：

- `scripts/taobao-native-bridge.mjs`

启动方式：

```bash
npm run bridge:taobao
```

默认监听：

```bash
http://127.0.0.1:8787
```

然后在 `.env.local` 中配置：

```bash
TAOBAO_MCP_BASE_URL=http://127.0.0.1:8787
```

再重启 `npm run dev`。

这样当前产品就会优先尝试连接你本地 bridge，对接 `taobao-native`。

## 你需要提供什么

你已经说明“当前可以调用淘宝 MCP 工具”。

要让这个 Next.js 产品也能调用它，最稳妥的方式不是把 Codex 内部工具直接塞进前端，而是加一个轻量 bridge，把你的淘宝 MCP 暴露成一个本地 HTTP 服务。

项目当前默认约定这个 bridge 提供 2 个接口：

### 1. 健康检查

`GET /health`

返回示例：

```json
{
  "message": "taobao mcp ready",
  "permissions_scope": [
    "搜索商品",
    "浏览商品详情",
    "提取商品信息",
    "加入购物车需显式确认"
  ]
}
```

### 2. 工具调用

`POST /run`

请求体：

```json
{
  "tool": "search_taobao_products",
  "input": {
    "keyword": "新能源车 行车记录仪",
    "module_id": "safety-essential"
  }
}
```

返回体：

```json
{
  "output": {
    "results": [
      {
        "product_id": "abc123",
        "title": "4K 超清行车记录仪",
        "price": 369,
        "shop_name": "某某旗舰店",
        "image_url": "https://...",
        "detail_url": "https://...",
        "shop_badges": ["旗舰店", "精选"],
        "highlights": ["夜视增强", "停车监控"]
      }
    ]
  }
}
```

## 当前项目支持的工具名

桥接层需要支持以下 4 个工具：

- `search_taobao_products`
- `open_product_detail`
- `extract_product_info`
- `add_to_cart`

## 每个工具的输入输出约定

### `search_taobao_products`

输入：

```json
{
  "keyword": "车载手机支架 快充",
  "module_id": "practical-interior"
}
```

输出：

```json
{
  "results": [
    {
      "product_id": "p1",
      "title": "重力联动手机支架 + 快充套装",
      "price": 128,
      "shop_name": "乐行车品",
      "image_url": "https://...",
      "detail_url": "https://...",
      "shop_badges": ["精选"],
      "highlights": ["稳固不晃", "新能源适用"]
    }
  ]
}
```

### `open_product_detail`

输入：

```json
{
  "product_id": "p1"
}
```

输出：

```json
{
  "opened": true,
  "product_id": "p1"
}
```

### `extract_product_info`

输入：

```json
{
  "product_id": "p1",
  "title": "重力联动手机支架 + 快充套装"
}
```

输出：

```json
{
  "product_id": "p1",
  "title": "重力联动手机支架 + 快充套装",
  "price": 128,
  "shop_name": "乐行车品",
  "image_url": "https://...",
  "detail_url": "https://...",
  "shop_badges": ["精选"],
  "highlights": ["稳固不晃", "新能源适用"],
  "risk_notes": ["需确认车型兼容性"]
}
```

### `add_to_cart`

输入：

```json
{
  "product_id": "p1",
  "quantity": 1,
  "confirmed": true
}
```

输出：

```json
{
  "success": true,
  "message": "已加入购物车",
  "product_id": "p1"
}
```

## 项目中的配置方式

在 `.env.local` 里加入：

```bash
TAOBAO_MCP_BASE_URL=http://127.0.0.1:8787
```

如果你直接使用仓库内的 bridge，还可以按需加这几个变量：

```bash
TAOBAO_MCP_BRIDGE_PORT=8787
TAOBAO_MCP_BRIDGE_HOST=127.0.0.1
TAOBAO_SOURCE_APP=SceneCartAI
TAOBAO_NATIVE_BIN=taobao-native
```

然后分别启动：

```bash
npm run bridge:taobao
npm run dev
```

当前 live adapter 文件：

- `lib/mcp/live.ts`

当前状态检测接口：

- `GET /api/mcp/status`

## 为什么不用直接在 Next.js 里调用 Codex 的淘宝工具

原因很简单：

- Codex 里的淘宝能力属于当前 agent 运行时工具
- 它不是浏览器端可以直接 import 的 JS SDK
- 也不是 Next.js server 默认能直接获得的 npm 包

所以工程化接法应该是：

1. 你的淘宝 MCP 继续由本地 agent / 桌面运行时调用
2. 额外起一个本地 bridge
3. 这个产品通过 `TAOBAO_MCP_BASE_URL` 调 bridge

这样产品代码和真实工具执行就解耦了，也最适合后续接入不同用户的淘宝 MCP 实现。
