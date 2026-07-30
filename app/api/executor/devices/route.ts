import { NextRequest } from "next/server";
import { requireAuthenticatedIdentity } from "@/lib/auth/request";
import { apiOk, apiRouteError, requireString } from "@/lib/api/responses";
import { getRuntimeRepository } from "@/lib/runtime";
import { registerExecutorDevice } from "@/lib/runtime/jobs";
import type { RuntimeJobType } from "@/lib/runtime/types";

const ALLOWED_CAPABILITIES: RuntimeJobType[] = ["module_search", "add_to_cart"];
const DEFAULT_CAPABILITIES: RuntimeJobType[] = ["module_search"];

function capabilities(value: unknown) {
  if (!Array.isArray(value)) return DEFAULT_CAPABILITIES;
  const filtered = value.filter((item): item is RuntimeJobType => ALLOWED_CAPABILITIES.includes(item as RuntimeJobType));
  return filtered.length ? [...new Set(filtered)] : DEFAULT_CAPABILITIES;
}

export async function GET() {
  try {
    const identity = await requireAuthenticatedIdentity();
    const devices = await getRuntimeRepository().listDevices(identity.userId);
    return apiOk({
      devices: devices.map(({ token_hash: _tokenHash, ...device }) => device)
    });
  } catch (error) {
    return apiRouteError(error, "failed to list executor devices");
  }
}

export async function POST(request: NextRequest) {
  try {
    const identity = await requireAuthenticatedIdentity();
    const body = await request.json().catch(() => ({}));
    const result = await registerExecutorDevice(
      identity.userId,
      requireString(body.name, "name"),
      capabilities(body.capabilities)
    );
    const { token_hash: _tokenHash, ...device } = result.device;
    return apiOk({
      device,
      device_token: result.token,
      warning: "设备令牌只会展示一次，请保存在本机安全环境变量中。"
    }, 201);
  } catch (error) {
    return apiRouteError(error, "failed to register executor device");
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const identity = await requireAuthenticatedIdentity();
    const body = await request.json().catch(() => ({}));
    const revoked = await getRuntimeRepository().revokeDevice(
      requireString(body.device_id, "device_id"),
      identity.userId
    );
    return apiOk({ revoked });
  } catch (error) {
    return apiRouteError(error, "failed to revoke executor device");
  }
}
