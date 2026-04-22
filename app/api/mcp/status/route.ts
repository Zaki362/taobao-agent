import { NextResponse } from "next/server";
import { getMcpClient } from "@/lib/mcp/client";

export async function GET() {
  const { client, status } = await getMcpClient();
  return NextResponse.json({
    mode: client.mode,
    available: status.available,
    message: status.message,
    permissions_scope: status.permissions_scope
  });
}
