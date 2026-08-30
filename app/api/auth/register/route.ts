import { apiError } from "@/lib/api/responses";

export async function POST() {
  return apiError(
    "场景购使用固定单用户访问，不开放账号注册",
    410,
    "interactive_authentication_disabled"
  );
}
