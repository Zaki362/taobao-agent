import { createHash, timingSafeEqual } from "node:crypto";
import { ApiRouteError } from "@/lib/api/responses";
import { getRequestIdentity } from "@/lib/auth/request";
import { isFormalProductMode } from "@/lib/runtime/product-mode";

function digest(value: string) {
  return createHash("sha256").update(value).digest();
}

function workerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

export function assertLegacyHostedWorkerAvailable() {
  if (isFormalProductMode()) {
    throw new ApiRouteError(
      "正式产品模式已关闭旧 Codex hosted 执行通道，请使用本地执行器设备协议",
      410,
      "legacy_hosted_disabled"
    );
  }
}

export async function getLegacyHostedAccess(request: Request) {
  assertLegacyHostedWorkerAvailable();
  const configuredToken = process.env.HOSTED_WORKER_TOKEN?.trim();
  const suppliedToken = workerToken(request);
  if (
    configuredToken &&
    suppliedToken &&
    timingSafeEqual(digest(configuredToken), digest(suppliedToken))
  ) {
    return { userId: undefined, worker: true as const };
  }

  const identity = await getRequestIdentity();
  return { userId: identity.userId, worker: false as const };
}
