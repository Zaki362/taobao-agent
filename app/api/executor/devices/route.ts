import { NextRequest } from "next/server";
import { requireAuthenticatedIdentity } from "@/lib/auth/request";
import { ApiRouteError, apiOk, apiRouteError, requireString } from "@/lib/api/responses";
import { getRuntimeRepository } from "@/lib/runtime";
import { executorAuditSessionId, registerExecutorDevice } from "@/lib/runtime/jobs";
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
    const repository = getRuntimeRepository();
    const [devices, auditEvents] = await Promise.all([
      repository.listDevices(identity.userId),
      repository.listAuditEvents(identity.userId, 20)
    ]);
    return apiOk({
      devices: devices.map(({ token_hash: _tokenHash, ...device }) => device),
      audit_events: auditEvents
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

export async function PATCH(request: NextRequest) {
  try {
    const identity = await requireAuthenticatedIdentity();
    const body = await request.json().catch(() => ({}));
    const repository = getRuntimeRepository();
    const deviceId = requireString(body.device_id, "device_id");
    const previous = (await repository.listDevices(identity.userId)).find((device) => device.id === deviceId);
    const updated = await repository.updateDeviceCapabilities(
      deviceId,
      identity.userId,
      capabilities(body.capabilities)
    );
    if (!updated) throw new ApiRouteError("executor device not found", 404, "not_found");
    const previousCapabilities = previous?.capabilities ?? [];
    await repository.appendEvent({
      user_id: identity.userId,
      session_id: executorAuditSessionId(updated.id),
      event_type: "executor.capabilities_updated",
      payload: {
        device_id: updated.id,
        device_name: updated.name,
        previous_capabilities: previousCapabilities,
        current_capabilities: updated.capabilities,
        added: updated.capabilities.filter((item) => !previousCapabilities.includes(item)),
        removed: previousCapabilities.filter((item) => !updated.capabilities.includes(item))
      }
    });
    const { token_hash: _tokenHash, ...device } = updated;
    return apiOk({ device });
  } catch (error) {
    return apiRouteError(error, "failed to update executor capabilities");
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const identity = await requireAuthenticatedIdentity();
    const body = await request.json().catch(() => ({}));
    const repository = getRuntimeRepository();
    const deviceId = requireString(body.device_id, "device_id");
    const previous = (await repository.listDevices(identity.userId)).find((device) => device.id === deviceId);
    const revoked = await repository.revokeDevice(
      deviceId,
      identity.userId
    );
    if (revoked && previous) {
      await repository.appendEvent({
        user_id: identity.userId,
        session_id: executorAuditSessionId(previous.id),
        event_type: "executor.device_revoked",
        payload: {
          device_id: previous.id,
          device_name: previous.name,
          capabilities: previous.capabilities
        }
      });
    }
    return apiOk({ revoked });
  } catch (error) {
    return apiRouteError(error, "failed to revoke executor device");
  }
}
