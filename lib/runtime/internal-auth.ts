import { timingSafeEqual } from "node:crypto";
import { ApiRouteError } from "@/lib/api/responses";

function bearerToken(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function assertInternalOperationsAccess(request: Request) {
  const expected = process.env.SCENECART_CRON_SECRET?.trim() ?? "";
  if (expected.length < 32) {
    throw new ApiRouteError(
      "workflow recovery endpoint is not configured",
      503,
      "recovery_not_configured"
    );
  }
  if (!safeEqual(bearerToken(request), expected)) {
    throw new ApiRouteError("invalid recovery token", 401, "invalid_recovery_token");
  }
}

export const assertWorkflowRecoveryAccess = assertInternalOperationsAccess;
