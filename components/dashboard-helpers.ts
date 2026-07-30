import { SessionState } from "@/lib/session/types";
import { MpcStatus } from "@/components/dashboard-types";

export function buildSceneInputFromBrief(scene: SessionState["scene_brief"]) {
  const parts = [
    scene.vehicle_type,
    `预算 ${scene.budget}`,
    scene.priority_style,
    scene.user_stage
  ];
  if (scene.already_have.length > 0) {
    parts.push(`已有：${scene.already_have.join("、")}`);
  }
  if (scene.avoid_items.length > 0) {
    parts.push(`不考虑：${scene.avoid_items.join("、")}`);
  }
  if (scene.optional_notes) {
    parts.push(scene.optional_notes);
  }
  return parts.join("，");
}

export function isHostedMode(status: MpcStatus | null) {
  return status?.mode === "codex_hosted";
}

export function isQueuedExecutionMode(status: MpcStatus | null) {
  return status?.mode === "codex_hosted" || status?.mode === "local_executor";
}

export function getExecutionModeLabel(status: MpcStatus | null) {
  if (status?.mode === "qoder_cli") {
    return "Qoder CLI 直连执行";
  }
  if (status?.mode === "codex_hosted") {
    return "Codex 宿主代理执行";
  }
  if (status?.mode === "local_executor") {
    return "本地执行器后台执行";
  }
  return "实验性本地桥接";
}

export function hasRealDetailUrl(detailUrl?: string) {
  return Boolean(detailUrl && detailUrl.trim() && detailUrl !== "https://www.taobao.com/");
}
