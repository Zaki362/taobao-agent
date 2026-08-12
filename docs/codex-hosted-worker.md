# Codex Hosted Worker（旧开发兼容）

本页记录历史 `codex_hosted` 工作流，仅用于维护旧任务文件和开发迁移。当前正式产品与面试主路径已经切换为：

```text
Browser -> Agent workflow -> durable Job Queue
        -> local_executor -> 淘宝桌面版官方 HTTP MCP
```

Codex 宿主不再负责正式链路中的淘宝搜索、详情提取或加购。生产模式会以 `410 legacy_hosted_disabled` 拒绝旧 Hosted Worker 任务接口；`/hosted` 现在是 Session、Job 和本地执行器的运行控制台，其名称不代表淘宝任务由 Codex 执行。

以下命令和任务文件格式只适用于显式启用的旧开发兼容流程。不要在面试中运行它，也不要把手工回填结果描述成网页实时触发的淘宝搜索。

## 启动方式

先启动网页应用：

```bash
npm run dev
```

再启动 worker：

```bash
npm run worker:codex -- watch
```

## 常用命令

拉取下一个待执行任务：

```bash
npm run worker:codex -- next
```

持续监听待执行任务：

```bash
npm run worker:codex -- watch
```

监听指定会话：

```bash
npm run worker:codex -- watch --session session-123
```

## Worker 会做什么

当拿到待执行任务后，worker 会：

1. 标记任务为 `running`
2. 生成给 Codex 宿主使用的任务文件和执行说明
3. 等待宿主执行淘宝任务
4. 宿主完成后，通过 `resolve` 回填结果到网页应用

- `<task_id>.instruction.md`
- `<task_id>.task.json`
- `<task_id>.resolve.json`

其中：

- `instruction.md` 是执行说明
- `task.json` 是原始任务数据
- `resolve.json` 是回填模板

## 回填结果

执行完淘宝任务后，编辑 `.resolve.json`，再运行：

```bash
npm run worker:codex -- resolve --file .data/hosted-worker/<task_id>.resolve.json
```

对于 `module_search` 任务，你需要至少回填：

- `session_id`
- `task_id`
- `status`
- `result_summary`
- `candidates`

对于 `add_to_cart` 任务，你需要至少回填：

- `session_id`
- `task_id`
- `status`
- `result_summary`

## 相关接口

- `GET /api/hosted/tasks`
- `GET /api/hosted/tasks/next`
- `POST /api/hosted/tasks`
- `POST /api/hosted/tasks/resolve`

## 旧模式限制

在这条旧兼容模式下：

- worker 只负责消费队列、生成任务包、记录状态
- 真正的淘宝执行仍由 Codex 宿主完成
- 网页应用不能直接远程调用当前 Codex 会话的工具能力

因此，“自动推进到 running”可以做到，但“自动完成淘宝执行”取决于宿主是否已经实际接手当前任务。这不满足当前正式演示要求；真实验收应使用 `worker:local` 和淘宝桌面版官方 HTTP MCP。
