import { HostedExecutionTask } from "@/lib/session/types";

function pretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}

export function buildHostedTaskInstruction(task: HostedExecutionTask) {
  const commonHeader = [
    "你正在作为 Codex 宿主执行淘宝任务。",
    "请使用你可用的淘宝能力完成任务，并在完成后调用产品的 resolve API 回填结果。",
    `任务类型：${task.task_type}`,
    `任务标题：${task.title}`,
    `任务描述：${task.description}`
  ].join("\n");

  if (task.task_type === "module_search") {
    return [
      commonHeader,
      "",
      "执行要求：",
      "1. 围绕 payload.search_intent 在淘宝中搜索。",
      "2. 选择与当前模块最相关的商品。",
      "3. 尽量整理出 3 个候选商品，覆盖稳妥推荐 / 性价比推荐 / 升级推荐。",
      "4. 每个商品至少回填：product_id、title、price、shop_name、image_url、detail_url、shop_badges、highlights、risk_notes、fit_reason、recommendation_type、module_id。",
      "",
      "任务 payload：",
      pretty(task.payload),
      "",
      "完成后调用：",
      "POST /api/hosted/tasks/resolve",
      pretty({
        session_id: task.session_id,
        task_id: task.task_id,
        status: "completed",
        result_summary: "已完成淘宝搜索并回填 3 个候选商品。",
        candidates: [
          {
            product_id: "taobao-item-1",
            title: "示例商品标题",
            price: 129,
            source: "淘宝",
            shop_name: "示例店铺",
            image_url: "https://...",
            detail_url: "https://...",
            shop_badges: ["旗舰店"],
            highlights: ["稳固", "适配新能源车"],
            risk_notes: ["注意确认中控兼容性"],
            fit_reason: "适合当前场景",
            recommendation_type: "稳妥推荐",
            module_id: task.module_id ?? ""
          }
        ]
      }),
      "",
      "如果失败，则调用：",
      pretty({
        session_id: task.session_id,
        task_id: task.task_id,
        status: "failed",
        error_message: "失败原因"
      })
    ].join("\n");
  }

  return [
    commonHeader,
    "",
    "执行要求：",
    "1. 打开商品详情页。",
    "2. 在用户已确认的前提下执行加入购物车。",
    "3. 完成后回填加购结果摘要。",
    "",
    "任务 payload：",
    pretty(task.payload),
    "",
    "完成后调用：",
    "POST /api/hosted/tasks/resolve",
    pretty({
      session_id: task.session_id,
      task_id: task.task_id,
      status: "completed",
      result_summary: "已完成加购"
    }),
    "",
    "如果失败，则调用：",
    pretty({
      session_id: task.session_id,
      task_id: task.task_id,
      status: "failed",
      error_message: "失败原因"
    })
  ].join("\n");
}
