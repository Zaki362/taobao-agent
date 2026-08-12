# Qoder CLI Execution Provider（旧开发兼容）

`qoder_cli` 仍保留在代码中，供迁移和开发调试使用，但它不是正式产品、真实设备验收或面试演示的执行路径。

当前主链路是：

```text
Browser -> Agent workflow -> durable Job Queue
        -> local_executor -> 淘宝桌面版官方 HTTP MCP
```

它使用 SceneCart 设备令牌、持久任务租约、结果账本和幂等回填。淘宝掉登录时，网页会暂停当前搜索，用户可重新登录后显式确认继续，也可使用已经保存的部分真实结果进入选购。这套恢复机制不依赖 Qoder。

## 旧 provider 做什么

显式启用 `qoder_cli` 后，旧链路为：

```text
Next.js 兼容 provider -> qodercli -> Qoder 中安装的淘宝 skill / 工具
```

它通过 `qodercli -p ...` 非交互执行 prompt，要求严格 JSON，再映射为 SceneCart 需要的商品结构。使用者需要自行安装并登录 Qoder，且保证 Qoder 中存在相应淘宝 skill。

仅在本地开发、确实需要调试旧适配器时配置：

```dotenv
SCENECART_PRODUCT_MODE=development
TAOBAO_EXECUTION_BACKEND=qoder_cli
QODERCLI_PATH=/absolute/path/to/qodercli
SCENECART_ENABLE_MCP_DEBUG=true
```

然后重启开发服务。安装 `qodercli` 或设置 `QODERCLI_PATH` 本身不会让应用自动切换 provider；必须显式设置 `TAOBAO_EXECUTION_BACKEND=qoder_cli`。

## 不能用于正式演示的原因

- 它绕过当前正式的设备令牌、持久 Job Queue 与 `local_executor` 运行契约，不能证明网页触发了当前生产架构。
- Qoder 登录、Credits、已安装 skill 和输出格式是另一组外部依赖，与淘宝桌面版官方 HTTP MCP 的真实状态不同。
- 旧 provider 的历史验证不等于当前淘宝登录态或当前商品结果可用。
- 不得用演示购物车 fallback 掩盖 Qoder 或淘宝调用失败，也不得把这条兼容链路说成正式 `local_executor` 结果。

`SCENECART_PRODUCT_MODE=production` 会阻断 `qoder_cli` 并把有效执行后端安全收敛为 `local_executor`；readiness 会继续报告原始误配置，直到环境变量被修正。

## 当前建议

面试和真实设备验收不要配置 `QODERCLI_PATH`，也不要切换到 `qoder_cli`。使用：

```dotenv
TAOBAO_EXECUTION_BACKEND=local_executor
TAOBAO_NATIVE_MCP_URL=http://127.0.0.1:3654/mcp
ALLOW_DEMO_CART_FALLBACK=false
```

再依次运行 `npm run executor:configure`、`npm run executor:doctor` 和正式网页流程。若淘宝登录失效，留在同一 Session 按页面提示处理，不要临时切换 provider。
