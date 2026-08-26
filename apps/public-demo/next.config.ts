import type { NextConfig } from "next";
import path from "node:path";

const repositoryRoot = path.resolve(__dirname, "../..");
const appNodeModules = path.resolve(__dirname, "node_modules");

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: {
    unoptimized: true
  },
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  outputFileTracingRoot: repositoryRoot,
  experimental: {
    externalDir: true
  },
  webpack(config) {
    config.resolve.modules = [appNodeModules, ...(config.resolve.modules ?? [])];
    return config;
  }
};

export default nextConfig;
