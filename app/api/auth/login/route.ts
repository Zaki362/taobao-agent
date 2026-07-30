import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME } from "@/lib/auth/request";
import { loginUser } from "@/lib/auth/service";
import { apiRouteError, requireString } from "@/lib/api/responses";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const result = await loginUser(
      requireString(body.email, "email"),
      requireString(body.password, "password")
    );
    const response = NextResponse.json({ user: { id: result.user.id, email: result.user.email } });
    response.cookies.set(AUTH_COOKIE_NAME, result.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: new Date(result.expiresAt)
    });
    return response;
  } catch (error) {
    return apiRouteError(error, "login failed");
  }
}
