import { apiOk, apiRouteError } from "@/lib/api/responses";
import { getExecutionBackend, getMcpClient } from "@/lib/mcp/client";
import { getRequestIdentity } from "@/lib/auth/request";
import { getRuntimeRepository } from "@/lib/runtime";
import { allowDemoCartFallback, getProductMode } from "@/lib/runtime/product-mode";

export async function GET() {
  try {
    if (getExecutionBackend() === "local_executor") {
      const identity = await getRequestIdentity();
      const devices = identity.userId
        ? await getRuntimeRepository().listDevices(identity.userId)
        : [];
      const now = Date.now();
      const onlineDevices = devices.filter((device) =>
        device.status !== "revoked" &&
        Boolean(device.last_heartbeat_at) &&
        now - Date.parse(device.last_heartbeat_at!) < 45_000
      );
      return apiOk({
        mode: "local_executor",
        product_mode: getProductMode(),
        demo_cart_fallback: allowDemoCartFallback(),
        available: onlineDevices.length > 0,
        message: onlineDevices.length > 0
          ? `已连接 ${onlineDevices.length} 台本地淘宝执行器，任务将在后台持久执行。`
          : "本地执行器队列已配置，但当前没有在线设备。请在设置页运行 Doctor 并启动 worker:local。",
        permissions_scope: ["本地淘宝搜索", "本地商品详情", "加购需显式确认"],
        executor_devices: {
          online: onlineDevices.length,
          registered: devices.filter((device) => device.status !== "revoked").length
        }
      });
    }
    const { client, status } = await getMcpClient();
    return apiOk({
      mode: client.mode,
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
