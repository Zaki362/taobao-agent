export function normalizeTaobaoImageUrl(value: string | undefined) {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (raw.startsWith("/demo-products/") && !raw.includes("\\")) return raw;
  try {
    const normalized = raw.startsWith("//")
      ? `https:${raw}`
      : raw.replace(/^http:\/\//i, "https://");
    const url = new URL(normalized);
    const allowedHost = url.hostname === "alicdn.com" || url.hostname.endsWith(".alicdn.com");
    if (url.protocol !== "https:" || !allowedHost || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
