import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, shouldUseSecureAuthCookie } from "@/lib/auth/request";
import { registerUser } from "@/lib/auth/service";
import { apiRouteError, requireString } from "@/lib/api/responses";
import { clearAuthRateLimit, enforceAuthRateLimit } from "@/lib/security/rate-limit";
import { readJsonObject } from "@/lib/api/validation";

export async function POST(request: NextRequest) {
  try {
    const body = await readJsonObject(request, 16 * 1024);
    const email = requireString(body.email, "email");
    const password = requireString(body.password, "password");
    await enforceAuthRateLimit(request, { action: "register", subject: email });
    const result = await registerUser(email, password);
    await clearAuthRateLimit(request, "register", email).catch(() => undefined);
    const response = NextResponse.json({ user: { id: result.user.id, email: result.user.email } }, { status: 201 });
    response.cookies.set(AUTH_COOKIE_NAME, result.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: shouldUseSecureAuthCookie(),
      path: "/",
      expires: new Date(result.expiresAt)
    });
    return response;
  } catch (error) {
    return apiRouteError(error, "registration failed");
  }
}
