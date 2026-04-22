import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  typedRoutes: false,
  outputFileTracingRoot: path.join(__dirname)
};

export default nextConfig;
