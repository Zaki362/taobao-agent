import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import nextEnv from "@next/env";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function validPort(value, source) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${source} 不是有效端口：${value}`);
  }
  return port;
}

export function commandPort(args) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-p" || argument === "--port") {
      if (!args[index + 1]) throw new Error(`${argument} 缺少端口值`);
      return validPort(args[index + 1], argument);
    }
    if (argument.startsWith("--port=")) {
      return validPort(argument.slice("--port=".length), "--port");
    }
  }
  return undefined;
}

export function localApiPort(apiUrl) {
  if (!apiUrl) return undefined;
  let parsed;
  try {
    parsed = new URL(apiUrl);
  } catch {
    return undefined;
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) return undefined;
  if (parsed.port) return validPort(parsed.port, "SCENECART_API_URL");
  return parsed.protocol === "https:" ? 443 : parsed.protocol === "http:" ? 80 : undefined;
}

function probeAddress(port, host, optional = false) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      if (optional && (error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL")) {
        resolve(true);
        return;
      }
      resolve(false);
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

// Next may bind IPv6 even when the same IPv4 loopback port belongs to another
// process. Conversely, its default IPv6 wildcard listener can be invisible to
// an IPv4-only probe. The user-facing IPv4 route and Next's bind address must
// therefore both be available.
export async function probePort(port) {
  if (!(await probeAddress(port, "127.0.0.1"))) return false;
  return probeAddress(port, "::", true);
}

export async function resolveDevServer({
  args = [],
  env = {},
  defaultPort = 3000,
  maxAttempts = 20,
  isAvailable = probePort
} = {}) {
  const fromCommand = commandPort(args);
  const fromEnvironment = env.SCENECART_DEV_PORT
    ? validPort(env.SCENECART_DEV_PORT, "SCENECART_DEV_PORT")
    : undefined;
  const fromApiUrl = localApiPort(env.SCENECART_API_URL);
  const requestedPort = fromCommand ?? fromEnvironment ?? fromApiUrl;
  const source = fromCommand
    ? "command"
    : fromEnvironment
      ? "environment"
      : fromApiUrl
        ? "api_url"
        : "automatic";

  if (requestedPort) {
    if (!(await isAvailable(requestedPort))) {
      throw new Error(
        `场景购端口 ${requestedPort} 已被占用。请关闭占用进程，或设置 SCENECART_DEV_PORT/SCENECART_API_URL 使用其他端口。`
      );
    }
    return {
      port: requestedPort,
      url: `http://127.0.0.1:${requestedPort}`,
      source,
      changedFromDefault: requestedPort !== defaultPort
    };
  }

  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const port = defaultPort + offset;
    if (await isAvailable(port)) {
      return {
        port,
        url: `http://127.0.0.1:${port}`,
        source,
        changedFromDefault: port !== defaultPort
      };
    }
  }
  throw new Error(`未找到可用开发端口（已检查 ${defaultPort}-${defaultPort + maxAttempts - 1}）。`);
}

export function resolveDevDistDir(env = process.env) {
  const configured = env.NEXT_DIST_DIR?.trim();
  return configured || ".next-dev";
}

function hasPortArgument(args) {
  return args.some((argument) => argument === "-p" || argument === "--port" || argument.startsWith("--port="));
}

export async function startDevServer(args = process.argv.slice(2)) {
  const { combinedEnv } = nextEnv.loadEnvConfig(process.cwd());
  const runtimeEnv = { ...process.env, ...combinedEnv };
  const selection = await resolveDevServer({ args, env: runtimeEnv });
  const nextArgs = hasPortArgument(args) ? args : [...args, "--port", String(selection.port)];
  const nextCli = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
  const childEnv = {
    ...runtimeEnv,
    SCENECART_API_URL: selection.url,
    SCENECART_DEV_PORT: String(selection.port),
    // Keep the long-running development compiler isolated from `next build`.
    // Next otherwise lets both processes mutate `.next`, which can leave a
    // seemingly-live dev server returning missing-chunk 500s after a build.
    NEXT_DIST_DIR: resolveDevDistDir(runtimeEnv)
  };

  if (selection.changedFromDefault && selection.source === "automatic") {
    console.log(`[场景购 dev] 3000 已被占用，自动使用 ${selection.port}。`);
  }
  console.log(`[场景购 dev] 页面地址：${selection.url}`);
  console.log(`[场景购 dev] 执行器设置：${selection.url}/settings/executor`);

  const child = spawn(process.execPath, [nextCli, "dev", ...nextArgs], {
    stdio: "inherit",
    env: childEnv
  });

  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    if (!child.killed) child.kill(signal);
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  child.once("exit", (code, signal) => {
    if (!stopping && signal) {
      console.error(`[场景购 dev] Next.js 被信号 ${signal} 终止。`);
    }
    process.exitCode = typeof code === "number" ? code : stopping ? 0 : 1;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startDevServer().catch((error) => {
    console.error(`[场景购 dev] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
