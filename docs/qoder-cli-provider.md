# Qoder CLI Execution Provider

当前项目仍保留把 `qodercli` 作为执行 provider 的开发兼容能力。正式产品主路径是 `local_executor + 持久任务队列 + 设备令牌`，不要把本页配置用于生产环境。

## 适用场景

当你希望由本地后端直接调用一个“外部 AI 宿主”去执行淘宝能力，而不是走 Codex 宿主代理队列时，可以切到 `qoder_cli` 模式。

该模式必须显式配置。系统不会再因为检测到 `~/.local/bin/qodercli` 或 `QODERCLI_PATH` 就自动切换 provider，因此安装 Qoder 不会改变网页应用的执行架构。

目标链路：

`Next.js 后端 / worker -> qodercli -> Qoder 内已安装的淘宝 skill / 工具能力`

## 当前前提

在真正可用之前，至少要满足这 3 个条件：

1. 已安装 `qodercli`
2. 已完成登录
3. Qoder 内已经具备淘宝相关 skill / 工具能力

## 当前已知状态

如果出现以下任意一种情况，`/api/mcp/status` 可能返回不可用：

- `Qoder CLI 尚未登录`
- `Qoder CLI 不可用`

## 启用方式

在 `.env.local` 中设置：

```bash
TAOBAO_EXECUTION_BACKEND=qoder_cli
QODERCLI_PATH=~/.local/bin/qodercli
```

然后重启应用：

```bash
npm run dev
```

`SCENECART_PRODUCT_MODE=production` 时该配置会被运行时阻断并安全收敛为 `local_executor`；readiness 仍会报告配置错误。需要手动调试 MCP 路由时，还必须在 development 中显式设置 `SCENECART_ENABLE_MCP_DEBUG=true`。

## 当前实现方式

项目内的 `qoder_cli` provider 会：

- 通过 `qodercli -p ...` 非交互执行 prompt
- 要求 Qoder 调用其当前已安装的淘宝 skill / 工具能力
- 强制返回严格 JSON
- 将结果映射为当前产品所需的标准结构

## 当前限制

当前 provider 已经接好工程结构，并且搜索主链路已在真实 Qoder 淘宝 skill 环境中验证可用。

也就是说：

- 代码层已支持 `qoder_cli`
- 搜索能力相对稳定，适合作为当前 Demo 主执行路径
- 商品详情页与真实加购仍受淘宝桌面版权限、登录态和商品页跳转影响，因此产品保留演示购物车 fallback

## 建议的下一步

1. 完成 `qodercli` 登录
2. 确认 Qoder 已安装淘宝 skill
3. 设置 `TAOBAO_EXECUTION_BACKEND=qoder_cli`
4. 使用产品页的串行搜索流程验证各模块候选商品
