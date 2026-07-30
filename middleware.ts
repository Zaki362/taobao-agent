import { NextRequest, NextResponse } from "next/server";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function expectedOrigins(request: NextRequest) {
  const configured = (process.env.APP_ORIGIN ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const protocol = request.headers.get("x-forwarded-proto") || request.nextUrl.protocol.replace(":", "");
  if (host) configured.push(`${protocol}://${host}`);
  return new Set(configured);
}

export function middleware(request: NextRequest) {
  if (SAFE_METHODS.has(request.method)) return NextResponse.next();
  if (request.headers.get("authorization")?.startsWith("Bearer ")) return NextResponse.next();

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
