const DEFAULT_LOG_SUMMARY_LENGTH = 220;

function compactText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function summarizeUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    const id = url.searchParams.get("id");
    const safeQuery = id ? `?id=${id}` : url.search ? "?[query-redacted]" : "";
    return `${url.origin}${url.pathname}${safeQuery}`;
  } catch {
    return "[redacted-url]";
  }
}

export function redactLogText(text: string) {
  return compactText(text)
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted-api-key]")
    .replace(/\/Users\/[^'"`\s]+/g, "[local-path]")
    .replace(/\/var\/folders\/[^'"`\s]+/g, "[temp-path]")
    .replace(/https?:\/\/[^\s'"`<>]+/g, (url) => summarizeUrl(url));
}

export function summarizeLogText(text: string, maxLength = DEFAULT_LOG_SUMMARY_LENGTH) {
  const redacted = redactLogText(text);
  if (redacted.length <= maxLength) {
    return redacted;
  }
  return `${redacted.slice(0, maxLength)}...`;
}

export function summarizeLogValue(value: unknown, maxLength = DEFAULT_LOG_SUMMARY_LENGTH) {
  try {
    return summarizeLogText(JSON.stringify(value), maxLength);
  } catch {
    return summarizeLogText(String(value), maxLength);
  }
}
