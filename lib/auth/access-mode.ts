import { ApiRouteError } from "@/lib/api/responses";
import { getRuntimeRepository } from "@/lib/runtime";

export type SceneCartAccessMode = "account" | "single_user";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function getSceneCartAccessMode(): SceneCartAccessMode {
  const configured = process.env.SCENECART_ACCESS_MODE?.trim() || "account";
  if (configured === "account" || configured === "single_user") return configured;
  throw new ApiRouteError(
    "SCENECART_ACCESS_MODE 配置无效",
    503,
    "access_mode_misconfigured"
  );
}

export function isSingleUserAccessMode() {
  return getSceneCartAccessMode() === "single_user";
}

export function configuredSingleUserId() {
  if (!isSingleUserAccessMode()) return null;
  const vercelEnvironment = process.env.VERCEL_ENV?.trim();
  const protectedPreview = vercelEnvironment === "preview";
  const localDevelopment = (
    !vercelEnvironment || vercelEnvironment === "development"
  ) && process.env.NODE_ENV !== "production";
  if (!protectedPreview && !localDevelopment) {
    throw new ApiRouteError(
      "单用户免登录模式仅允许本地或受保护的 Preview，不能用于 Production",
      503,
      "single_user_production_forbidden"
    );
  }
  const userId = process.env.SCENECART_SINGLE_USER_ID?.trim() ?? "";
  if (!UUID_PATTERN.test(userId)) {
    throw new ApiRouteError(
      "单用户免登录模式缺少有效的 SCENECART_SINGLE_USER_ID",
      503,
      "single_user_owner_misconfigured"
    );
  }
  return userId.toLowerCase();
}

export async function resolveSingleUserOwner() {
  const userId = configuredSingleUserId();
  if (!userId) return null;
  const user = await getRuntimeRepository().findUserById(userId);
  if (!user) {
    throw new ApiRouteError(
      "单用户免登录模式配置的 owner 不存在",
      503,
      "single_user_owner_not_found"
    );
  }
  return user;
}

export function assertInteractiveAuthenticationEnabled() {
  if (!isSingleUserAccessMode()) return;
  throw new ApiRouteError(
    "当前使用单用户免登录模式，不开放账号登录或注册",
    404,
    "interactive_authentication_disabled"
  );
}
