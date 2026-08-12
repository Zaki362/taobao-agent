import protocol from "@/lib/runtime/executor-protocol.json";
import { ApiRouteError } from "@/lib/api/responses";

export const EXECUTOR_PROTOCOL_HEADER = "x-scenecart-executor-protocol";
export const EXECUTOR_PROTOCOL_VERSION = protocol.version;

export function assertExecutorProtocol(request: Request) {
  const received = request.headers.get(EXECUTOR_PROTOCOL_HEADER)?.trim();
  if (received === EXECUTOR_PROTOCOL_VERSION) return;

  throw new ApiRouteError(
    received
      ? `本地执行器协议版本 ${received} 与服务端 ${EXECUTOR_PROTOCOL_VERSION} 不兼容，请更新项目代码后重启 worker。`
      : `本地执行器缺少协议版本，请更新项目代码后重启 worker。`,
    426,
    "executor_protocol_mismatch"
  );
}
