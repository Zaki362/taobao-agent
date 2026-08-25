import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, shouldUseSecureAuthCookie } from "@/lib/auth/request";
import { loginUser } from "@/lib/auth/service";
import { apiRouteError, requireString } from "@/lib/api/responses";
import { clearAuthRateLimit, enforceAuthRateLimit } from "@/lib/security/rate-limit";
import { readJsonObject } from "@/lib/api/validation";

export async function POST(request: NextRequest) {
  try {
    const body = await readJsonObject(request, 16 * 1024);
    const email = requireString(body.email, "email");
    await enforceAuthRateLimit(request, { action: "login", subject: email });
    const result = await loginUser(
      email,
      requireString(body.password, "password")
    );
    await clearAuthRateLimit(request, "login", email).catch(() => undefined);
    const response = NextResponse.json({ user: { id: result.user.id, email: result.user.email } });
    response.cookies.set(AUTH_COOKIE_NAME, result.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: shouldUseSecureAuthCookie(),
      path: "/",
      expires: new Date(result.expiresAt)
    });
    return response;
  } catch (error) {
    return apiRouteError(error, "login failed");
  }
}
