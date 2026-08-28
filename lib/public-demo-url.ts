export const DEFAULT_PUBLIC_DEMO_ORIGIN = "https://scenecart-public-demo.vercel.app";

function isLocalDevelopmentHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function resolvePublicDemoOrigin(configuredUrl?: string) {
  const candidate = configuredUrl?.trim();
  if (!candidate) return DEFAULT_PUBLIC_DEMO_ORIGIN;

  try {
    const url = new URL(candidate);
    const safeProtocol = url.protocol === "https:"
      || (url.protocol === "http:" && isLocalDevelopmentHost(url.hostname));
    const isOriginOnly = (url.pathname === "/" || url.pathname === "")
      && !url.search
      && !url.hash;

    if (!safeProtocol || !isOriginOnly || url.username || url.password) {
      return DEFAULT_PUBLIC_DEMO_ORIGIN;
    }

    return url.origin;
  } catch {
    return DEFAULT_PUBLIC_DEMO_ORIGIN;
  }
}

export function buildPublicDemoAutoplayUrl(configuredUrl?: string) {
  return new URL("/demo?autoplay=1", `${resolvePublicDemoOrigin(configuredUrl)}/`).toString();
}

export const PUBLIC_DEMO_AUTOPLAY_URL = buildPublicDemoAutoplayUrl(
  process.env.NEXT_PUBLIC_SCENECART_PUBLIC_DEMO_URL
);
