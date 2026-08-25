import type { NextConfig } from "next";
import path from "node:path";

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://alicdn.com https://*.alicdn.com",
  "font-src 'self' data:",
  `connect-src 'self'${process.env.NODE_ENV === "production" ? "" : " ws: wss:"}`,
  "worker-src 'self' blob:",
  "manifest-src 'self'"
].join("; ");

const nextConfig: NextConfig = {
  ...(process.env.NEXT_DIST_DIR?.trim()
    ? { distDir: process.env.NEXT_DIST_DIR.trim() }
    : {}),
  typedRoutes: false,
  ...(process.env.NEXT_TSCONFIG_PATH?.trim()
    ? { typescript: { tsconfigPath: process.env.NEXT_TSCONFIG_PATH.trim() } }
    : {}),
  output: "standalone",
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "alicdn.com" },
      { protocol: "https", hostname: "**.alicdn.com" }
    ]
  },
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  outputFileTracingRoot: path.join(__dirname),
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }
        ]
      }
    ];
  }
};

export default nextConfig;
