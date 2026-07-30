import { NextRequest } from "next/server";
import { getRequestIdentity } from "@/lib/auth/request";
import { apiRouteError, requireString } from "@/lib/api/responses";
import { ensureSession } from "@/lib/agent/orchestrator";
import { getRuntimeRepository } from "@/lib/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const encoder = new TextEncoder();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: NextRequest) {
  try {
    const identity = await getRequestIdentity();
    const sessionId = requireString(request.nextUrl.searchParams.get("session_id"), "session_id");
    const session = await ensureSession(sessionId, identity.userId);
    if (!session) return new Response("session not found", { status: 404 });
    let cursor = Number(request.nextUrl.searchParams.get("after") ?? 0) || 0;
    const repository = getRuntimeRepository();
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode("retry: 1500\n\n"));
        let heartbeatAt = Date.now();
        try {
          while (!request.signal.aborted) {
            const events = await repository.listEvents(sessionId, cursor, identity.userId, 100);
            for (const event of events) {
              cursor = event.id;
              controller.enqueue(encoder.encode(`id: ${event.id}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`));
            }
            if (Date.now() - heartbeatAt > 15_000) {
              controller.enqueue(encoder.encode(`event: heartbeat\ndata: ${JSON.stringify({ cursor, timestamp: new Date().toISOString() })}\n\n`));
              heartbeatAt = Date.now();
            }
            await sleep(750);
          }
        } catch (error) {
          controller.enqueue(encoder.encode(`event: stream_error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : "event stream failed" })}\n\n`));
        } finally {
          controller.close();
        }
      }
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      }
    });
  } catch (error) {
    return apiRouteError(error, "failed to open execution event stream");
  }
}
