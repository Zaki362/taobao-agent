import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME } from "@/lib/auth/constants";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function expectedOrigins(request: NextRequest) {
  const configured = (process.env.APP_ORIGIN ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (configured.length > 0) return new Set(configured);
  // A forwarded host header is transport metadata, not an origin allowlist.
  // Formal deployments must configure APP_ORIGIN; only local development may
  // derive its exact origin from Next's parsed request URL.
  return process.env.NODE_ENV === "production"
    ? new Set<string>()
    : new Set([request.nextUrl.origin]);
}

export function middleware(request: NextRequest) {
  if (SAFE_METHODS.has(request.method)) return NextResponse.next();
  const bearerAuthorization = request.headers.get("authorization")?.match(/^Bearer\s+\S+$/i);
  // Machine clients authenticate with Bearer tokens and do not use the browser
  // session. A request carrying the session cookie must still pass the Origin
  // check; otherwise an arbitrary Bearer value could disable CSRF protection
  // for cookie-authenticated API routes.
  if (bearerAuthorization && !request.cookies.has(AUTH_COOKIE_NAME)) {
    return NextResponse.next();
  }

  const enforceOrigin = process.env.NODE_ENV === "production" || process.env.AUTH_REQUIRED === "true";
  if (!enforceOrigin) return NextResponse.next();

  const origin = request.headers.get("origin");
  if (!origin || !expectedOrigins(request).has(origin)) {
    return NextResponse.json(
      { error: "请求来源校验失败", code: "invalid_origin" },
      { status: 403 }
    );
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*"
};
