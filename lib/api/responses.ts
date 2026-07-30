import { NextResponse } from "next/server";

const MAX_PUBLIC_ERROR_LENGTH = 520;

export class ApiRouteError extends Error {
  constructor(
    message: string,
    public readonly status = 500,
    public readonly code = "internal_error"
  ) {
    super(message);
  }
}

export function apiOk<T>(payload: T, status = 200) {
  return NextResponse.json(payload, { status });
}

export function apiError(message: string, status = 500, code = "internal_error") {
  return NextResponse.json(
    {
      error: message,
      code
    },
    { status }
  );
}

export function badRequest(message: string) {
  return apiError(message, 400, "bad_request");
}

export function notFound(message: string) {
  return apiError(message, 404, "not_found");
}

export function conflict(message: string) {
  return apiError(message, 409, "conflict");
}

export function requireString(value: unknown, fieldName: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiRouteError(`${fieldName} is required`, 400, "bad_request");
  }
  return value.trim();
}

function redactSensitiveText(message: string) {
  return message
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted-api-key]")
    .replace(/\/Users\/[^'"`\s]+/g, "[local-path]")
    .replace(/\/var\/folders\/[^'"`\s]+/g, "[temp-path]")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeKnownError(message: string) {
  if (/Qoder CLI 执行超时|ETIMEDOUT|signal=SIGPIPE/.test(message)) {
    return {
      message: "Qoder CLI 执行超时。淘宝搜索或详情提取未在限定时间内完成，请稍后重试，或减少本轮搜索范围。",
      code: "external_tool_timeout",
      status: 504
    };
  }

  if (/Qoder CLI 未返回内容|返回不是有效 JSON/.test(message)) {
    return {
      message: "Qoder CLI 未返回可解析结果。请确认 Qoder 与淘宝 skill 当前可用后重试。",
      code: "external_tool_empty_result",
      status: 502
    };
  }

  if (/未登录|已打开登录页面/.test(message)) {
    return {
      message: "淘宝当前未登录或登录态失效。请在淘宝桌面版完成登录后重试。",
      code: "taobao_login_required",
      status: 409
    };
  }

  if (/未授权|AI 应用|mcpAiAppsAuthorized|订单\/加购权限|mcpOrderEnabled/.test(message)) {
    return {
      message: "淘宝桌面版当前未开放所需 AI 代理权限。请检查 AI 设置与订单/加购授权后重试。",
      code: "taobao_permission_required",
      status: 409
    };
  }

  if (/Tool 执行层未就绪|应用已加载完成/.test(message)) {
    return {
      message: "淘宝工具执行层尚未就绪。请等待淘宝桌面版完全加载并停留在主界面后重试。",
      code: "taobao_tool_not_ready",
      status: 503
    };
  }

  if (/内测期间仅开放部分用户/.test(message)) {
    return {
      message: "当前淘宝工具能力处于内测限制，暂时无法完成该动作。",
      code: "taobao_limited_beta",
      status: 503
    };
  }

  if (/Command failed/.test(message)) {
    return {
      message: "外部购物工具执行失败。请查看服务端控制台或后端执行台获取完整细节。",
      code: "external_tool_failed",
      status: 502
    };
  }

  return null;
}

function toPublicError(message: string, fallbackMessage: string) {
  const redacted = redactSensitiveText(message || fallbackMessage);
  const known = summarizeKnownError(redacted);
  if (known) {
    return known;
  }

  if (redacted.length <= MAX_PUBLIC_ERROR_LENGTH) {
    return {
      message: redacted || fallbackMessage,
      code: "internal_error",
      status: 500
    };
  }

  return {
    message: `${redacted.slice(0, MAX_PUBLIC_ERROR_LENGTH)}...（错误信息已截断，完整日志请查看服务端控制台）`,
    code: "internal_error",
    status: 500
  };
}

export function apiRouteError(error: unknown, fallbackMessage: string) {
  if (error instanceof ApiRouteError) {
    return apiError(redactSensitiveText(error.message), error.status, error.code);
  }

  const message = error instanceof Error && error.message ? error.message : fallbackMessage;
  const normalized = message.toLowerCase();

  if (normalized.includes("session not found") || normalized.includes("task not found")) {
    return notFound(redactSensitiveText(message));
  }

  console.error(
    `[api] ${fallbackMessage}: ${redactSensitiveText(
      error instanceof Error && error.message ? error.message : String(error)
    )}`
  );

  const publicError = toPublicError(message, fallbackMessage);
  return apiError(publicError.message, publicError.status, publicError.code);
}
