import { NextRequest, NextResponse } from "next/server";
import { addToCart } from "@/lib/agent/orchestrator";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const result = await addToCart(body.session_id as string, body.product_id as string);
  const payload = result.result as { success?: boolean; message?: string; task_id?: string; demo_fallback?: boolean } | undefined;
  return NextResponse.json({
    result: result.result,
    async: Boolean(payload?.task_id),
    demo_fallback: Boolean(payload?.demo_fallback),
    hosted_tasks: result.state.hosted_tasks,
    selected_items: result.state.selected_items,
    tool_logs: result.state.tool_logs
  });
}
