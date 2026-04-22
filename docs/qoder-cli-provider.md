# Qoder CLI Execution Provider

当前项目已经支持把 `qodercli` 作为执行 provider。

## 适用场景

当你希望由本地后端直接调用一个“外部 AI 宿主”去执行淘宝能力，而不是走 Codex 宿主代理队列时，可以切到 `qoder_cli` 模式。

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
QODERCLI_PATH=/Users/guohuaz/.local/bin/qodercli
```

然后重启应用：

```bash
npm run dev
```

## 当前实现方式

项目内的 `qoder_cli` provider 会：

- 通过 `qodercli -p ...` 非交互执行 prompt
- 要求 Qoder 调用其当前已安装的淘宝 skill / 工具能力
- 强制返回严格 JSON
- 将结果映射为当前产品所需的标准结构

## 当前限制

当前 provider 已经接好工程结构，但还没有在你的真实 Qoder 淘宝 skill 环境下跑通端到端联调。

也就是说：

- 代码层已支持 `qoder_cli`
- 但要真正执行成功，仍需你先完成：
  - `qodercli /login`
  - 确认 Qoder 当前会话或非交互模式下也能调用淘宝 skill

## 建议的下一步

1. 完成 `qodercli` 登录
2. 确认 `qodercli -p ...` 非交互模式也能使用这项淘宝能力
3. 再切换 `TAOBAO_EXECUTION_BACKEND=qoder_cli` 做联调
