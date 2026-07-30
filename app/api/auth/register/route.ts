import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME } from "@/lib/auth/request";
import { registerUser } from "@/lib/auth/service";
import { apiRouteError, requireString } from "@/lib/api/responses";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const email = requireString(body.email, "email");
    const password = requireString(body.password, "password");
    const result = await registerUser(email, password);
    const response = NextResponse.json({ user: { id: result.user.id, email: result.user.email } }, { status: 201 });
    response.cookies.set(AUTH_COOKIE_NAME, result.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: new Date(result.expiresAt)
    });
    return response;
  } catch (error) {
    return apiRouteError(error, "registration failed");
  }
}
