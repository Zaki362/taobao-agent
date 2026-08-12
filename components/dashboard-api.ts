"use client";

const MAX_CLIENT_ERROR_LENGTH = 420;
const DEFAULT_CLIENT_TIMEOUT_MS = 240_000;

type JsonFetchInit = RequestInit & {
  timeoutMs?: number;
};

function safeParseJson(text: string) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function compactClientError(message: string) {
  const compact = message.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_CLIENT_ERROR_LENGTH) {
    return compact;
  }
  return `${compact.slice(0, MAX_CLIENT_ERROR_LENGTH)}...`;
}

function errorMessageFromPayload(url: string, payload: unknown, fallback: string) {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.trim()) {
      return compactClientError(`${url} - ${record.error}`);
    }
    if (typeof record.message === "string" && record.message.trim()) {
      return compactClientError(`${url} - ${record.message}`);
    }
  }

  return compactClientError(`${url} - ${fallback || "Request failed"}`);
}

function buildJsonHeaders(init?: JsonFetchInit) {
  const headers = new Headers(init?.headers);
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }
  if (!headers.has("Content-Type") && init?.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  return headers;
}

function timeoutErrorMessage(url: string, timeoutMs: number) {
  const seconds = Math.round(timeoutMs / 1000);
  return `${url} - 请求超过 ${seconds} 秒仍未完成。外部工具可能仍在执行，请稍后刷新结果或查看后端执行台。`;
}

export async function jsonFetch<T>(url: string, init?: JsonFetchInit): Promise<T> {
  const timeoutMs = init?.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
  const controller = new AbortController();
  const upstreamSignal = init?.signal;
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const abortFromUpstream = () => controller.abort();

  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      controller.abort();
    } else {
      upstreamSignal.addEventListener("abort", abortFromUpstream, { once: true });
    }
  }

  const { timeoutMs: _timeoutMs, signal: _signal, ...fetchInit } = init ?? {};

  let response: Response;
  try {
    response = await fetch(url, {
      ...fetchInit,
      headers: buildJsonHeaders(init),
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(compactClientError(timeoutErrorMessage(url, timeoutMs)));
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }

  const text = await response.text();
  const payload = safeParseJson(text);

  if (!response.ok) {
    throw new Error(errorMessageFromPayload(url, payload, response.statusText));
  }

  return (payload ?? {}) as T;
}
