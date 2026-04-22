# Codex Hosted Worker

当前项目已经切换到 `Codex 宿主执行` 模式：

- 网页产品负责场景理解、购物规划、任务编排、结果展示
- Codex 宿主负责真正执行淘宝搜索 / 详情提取 / 加购

注意：

- 当前默认路径不是“本地 Node 进程自动调用淘宝”
- 而是“网页把任务交给 Codex 宿主，再由宿主执行并回填结果”

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

## 当前限制

当前默认模式下：

- worker 只负责消费队列、生成任务包、记录状态
- 真正的淘宝执行仍由 Codex 宿主完成
- 网页应用不能直接远程调用当前 Codex 会话的工具能力

因此，“自动推进到 running”可以做到，但“自动完成淘宝执行”取决于宿主是否已经实际接手当前任务。
