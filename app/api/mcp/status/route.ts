import { apiOk, apiRouteError } from "@/lib/api/responses";
import { getConfiguredExecutionBackend, getExecutionBackend, getMcpClient } from "@/lib/mcp/client";
import { getRequestIdentity } from "@/lib/auth/request";
import { getRuntimeRepository } from "@/lib/runtime";
import { allowDemoCartFallback, getProductMode } from "@/lib/runtime/product-mode";
import { summarizeExecutorDevices } from "@/lib/runtime/executor-status";

export async function GET() {
  try {
    if (getExecutionBackend() === "local_executor") {
      const identity = await getRequestIdentity();
      const devices = identity.userId
        ? await getRuntimeRepository().listDevices(identity.userId)
        : [];
      const executorDevices = summarizeExecutorDevices(devices);
      const searchAvailable = executorDevices.capabilities.module_search.available;
      const cartAvailable = executorDevices.capabilities.add_to_cart.available;
      const message = executorDevices.authentication_required > 0 && executorDevices.online === 0
        ? "本地执行器已暂停领取任务：淘宝账号需要重新登录。登录恢复后，搜索不会自动继续；请由你确认继续中断的搜索，或直接查看已有部分结果。"
        : executorDevices.online === 0
        ? "本地执行器队列已配置，但当前没有在线设备。请在设置页运行 Doctor 并启动 worker:local。"
        : !searchAvailable
          ? "本地执行器在线，但没有设备声明商品搜索能力；搜索任务不会被错误领取。"
          : cartAvailable
            ? `已连接 ${executorDevices.online} 台本地淘宝执行器，商品搜索与显式确认后的真实加购均可执行。`
            : `已连接 ${executorDevices.online} 台本地淘宝执行器，商品搜索可用；真实加购能力尚未连接。`;
      return apiOk({
        mode: "local_executor",
        configured_mode: getConfiguredExecutionBackend(),
        product_mode: getProductMode(),
        demo_cart_fallback: allowDemoCartFallback(),
        available: searchAvailable,
        message,
        permissions_scope: ["本地淘宝搜索", "本地商品详情", "加购需显式确认"],
        executor_devices: {
          online: executorDevices.online,
          registered: executorDevices.registered,
          authentication_required: executorDevices.authentication_required,
          capabilities: executorDevices.capabilities
        }
      });
    }
    const { client, status } = await getMcpClient();
    return apiOk({
      mode: client.mode,
      configured_mode: getConfiguredExecutionBackend(),
      product_mode: getProductMode(),
      demo_cart_fallback: allowDemoCartFallback(),
      available: status.available,
      message: status.message,
      permissions_scope: status.permissions_scope
    });
  } catch (error) {
    return apiRouteError(error, "failed to read mcp status");
  }
}
