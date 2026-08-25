import type { NextRequest } from "next/server";
import { ApiRouteError } from "@/lib/api/responses";
import { API_INPUT_LIMITS } from "@/lib/api/input-limits";

export { API_INPUT_LIMITS } from "@/lib/api/input-limits";

function payloadTooLarge(maxBytes: number): never {
  throw new ApiRouteError(
    `请求体不能超过 ${maxBytes} 字节`,
    413,
    "payload_too_large"
  );
}

export async function readJsonObject(
  request: NextRequest,
  maxBytes = API_INPUT_LIMITS.defaultBodyBytes
): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) payloadTooLarge(maxBytes);
  if (!request.body) return {};

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      payloadTooLarge(maxBytes);
    }
    chunks.push(value);
  }

  if (totalBytes === 0) return {};
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(combined));
  } catch {
    throw new ApiRouteError("请求体必须是有效 JSON", 400, "invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiRouteError("请求体必须是 JSON 对象", 400, "invalid_json");
  }
  return parsed as Record<string, unknown>;
}

export function boundedString(
  value: unknown,
  fieldName: string,
  options: { maxLength: number; required?: boolean; fallback?: string }
) {
  if (value === undefined || value === null || value === "") {
    if (options.required) {
      throw new ApiRouteError(`${fieldName} is required`, 400, "bad_request");
    }
    return options.fallback ?? "";
  }
  if (typeof value !== "string") {
    throw new ApiRouteError(`${fieldName} must be a string`, 400, "bad_request");
  }
  const normalized = value.trim();
  if (options.required && !normalized) {
    throw new ApiRouteError(`${fieldName} is required`, 400, "bad_request");
  }
  if (normalized.length > options.maxLength) {
    throw new ApiRouteError(`${fieldName} must be at most ${options.maxLength} characters`, 400, "input_too_long");
  }
  return normalized || options.fallback || "";
}

export function boundedStringArray(
  value: unknown,
  fieldName: string,
  options: { maxItems: number; maxItemLength: number; fallback?: string[] }
) {
  if (value === undefined || value === null) return options.fallback ?? [];
  if (!Array.isArray(value)) {
    throw new ApiRouteError(`${fieldName} must be an array`, 400, "bad_request");
  }
  if (value.length > options.maxItems) {
    throw new ApiRouteError(`${fieldName} must contain at most ${options.maxItems} items`, 400, "too_many_items");
  }
  return value.map((item, index) => boundedString(item, `${fieldName}[${index}]`, {
    maxLength: options.maxItemLength,
    required: true
  }));
}

export function boundedNumber(
  value: unknown,
  fieldName: string,
  options: { min: number; max: number; fallback: number }
) {
  if (value === undefined || value === null) return options.fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < options.min || value > options.max) {
    throw new ApiRouteError(
      `${fieldName} must be between ${options.min} and ${options.max}`,
      400,
      "invalid_number"
    );
  }
  return value;
}
