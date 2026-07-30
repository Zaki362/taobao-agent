import { apiOk, apiRouteError } from "@/lib/api/responses";
import { getMcpClient } from "@/lib/mcp/client";

export async function GET() {
  try {
    const { client, status } = await getMcpClient();
    return apiOk({
      mode: client.mode,
      available: status.available,
      message: status.message,
      permissions_scope: status.permissions_scope
    });
  } catch (error) {
    return apiRouteError(error, "failed to read mcp status");
  }
}
