import { ApiRouteError } from "@/lib/api/responses";
import {
  inspectSingleUserExposureConfiguration
} from "@/lib/auth/outer-protection";
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
  const exposure = inspectSingleUserExposureConfiguration();
  if (!exposure.valid) {
    throw new ApiRouteError(
      `固定单用户访问边界配置无效：${exposure.issues.join("；")}`,
      503,
      "single_user_access_boundary_required"
    );
  }
  const userId = process.env.SCENECART_SINGLE_USER_ID?.trim() ?? "";
  if (!UUID_PATTERN.test(userId)) {
    throw new ApiRouteError(
      "固定单用户模式缺少有效的 SCENECART_SINGLE_USER_ID",
      503,
      "single_user_owner_misconfigured"
    );
  }
  return userId.toLowerCase();
}

function configuredSingleUserIdForInspection() {
  if (!isSingleUserAccessMode()) return null;
  const userId = process.env.SCENECART_SINGLE_USER_ID?.trim() ?? "";
  return UUID_PATTERN.test(userId) ? userId.toLowerCase() : null;
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

export async function inspectConfiguredSingleUserOwner() {
  const userId = configuredSingleUserIdForInspection();
  if (!userId) return null;
  return getRuntimeRepository().findUserById(userId);
}

export function assertInteractiveAuthenticationEnabled() {
  throw new ApiRouteError(
    "场景购使用固定单用户访问，不开放账号登录或注册",
    410,
    "interactive_authentication_disabled"
  );
}
