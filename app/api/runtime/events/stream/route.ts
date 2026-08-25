import { NextRequest } from "next/server";
import { getRequestIdentity } from "@/lib/auth/request";
import { apiRouteError, requireString } from "@/lib/api/responses";
import { ensureSession } from "@/lib/agent/orchestrator";
import { getRuntimeRepository } from "@/lib/runtime";
import { acquireEventStreamLease, enforceEventStreamRateLimit } from "@/lib/security/rate-limit";
import { publicExecutionEvent } from "@/lib/runtime/public-dto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const encoder = new TextEncoder();

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

export async function GET(request: NextRequest) {
  try {
    const identity = await getRequestIdentity();
    await enforceEventStreamRateLimit(request, identity.userId);
    const sessionId = requireString(request.nextUrl.searchParams.get("session_id"), "session_id");
    const session = await ensureSession(sessionId, identity.userId);
    if (!session) return new Response("session not found", { status: 404 });
    const queryCursor = Number(request.nextUrl.searchParams.get("after") ?? 0) || 0;
    const headerCursor = Number(request.headers.get("last-event-id") ?? 0) || 0;
    let cursor = Math.max(queryCursor, headerCursor);
    const repository = getRuntimeRepository();
    const releaseStreamLease = await acquireEventStreamLease(request, identity.userId, sessionId);
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode("retry: 1500\n\n"));
        let heartbeatAt = Date.now();
        const streamDeadline = Date.now() + 5 * 60_000;
        let idleDelayMs = 750;
        try {
          while (!request.signal.aborted && Date.now() < streamDeadline) {
            const events = await repository.listEvents(sessionId, cursor, identity.userId, 100);
            for (const event of events) {
              cursor = event.id;
              const publicEvent = publicExecutionEvent(event);
              controller.enqueue(encoder.encode(`id: ${event.id}\nevent: ${event.event_type}\ndata: ${JSON.stringify(publicEvent)}\n\n`));
            }
            idleDelayMs = events.length > 0 ? 750 : Math.min(5_000, Math.ceil(idleDelayMs * 1.5));
            if (Date.now() - heartbeatAt > 15_000) {
              controller.enqueue(encoder.encode(`event: heartbeat\ndata: ${JSON.stringify({ cursor, timestamp: new Date().toISOString() })}\n\n`));
              heartbeatAt = Date.now();
            }
            await sleep(idleDelayMs, request.signal);
          }
          if (!request.signal.aborted) {
            controller.enqueue(encoder.encode(`event: stream_end\ndata: ${JSON.stringify({ cursor, reconnect: true })}\n\n`));
          }
        } catch (error) {
          if (!request.signal.aborted) {
            controller.enqueue(encoder.encode(`event: stream_error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : "event stream failed" })}\n\n`));
          }
        } finally {
          await releaseStreamLease().catch(() => undefined);
          try {
            controller.close();
          } catch {
            // The client may have cancelled the stream while the final query was in flight.
          }
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
