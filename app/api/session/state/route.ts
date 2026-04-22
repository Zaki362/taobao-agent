import { NextRequest, NextResponse } from "next/server";
import { ensureSession } from "@/lib/agent/orchestrator";

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("session_id") ?? undefined;
  const state = await ensureSession(sessionId);
  if (!state) {
    return NextResponse.json(
      {
        error: "session not found"
      },
      { status: 404 }
    );
  }
  return NextResponse.json(state);
}
