import { AgentDirectives, SessionState } from "@/lib/session/types";
import { invalidateAgentCompletionArtifacts } from "@/lib/session/bundle-adoption";

export type AgentDirectiveProfile = "conservative" | "balanced" | "exploratory";

export function isAgentDirectiveProfile(value: unknown): value is AgentDirectiveProfile {
  return value === "conservative" || value === "balanced" || value === "exploratory";
}

function profileDirectives(profile: AgentDirectiveProfile): AgentDirectives {
  if (profile === "conservative") {
    return {
      autonomy_level: "保守执行",
      search_depth: "轻量搜索",
      detail_policy: "默认只读取搜索摘要，不主动打开商品详情页，降低等待和账号侧干扰。",
      recovery_policy: "每个模块最多使用首轮关键词；失败或候选偏薄时记录原因，由用户确认后再补搜。",
      rerank_rules: ["优先匹配模块意图", "优先价格贴近预算", "优先信息完整的店铺"],
      user_confirmation_points: ["补搜前由用户确认", "加入购物车前必须由用户确认"],
      safety_boundaries: ["不读取订单、地址、手机号、聊天记录等敏感数据", "不自动下单或支付", "不主动扩大到模板外模块"]
    };
  }

  if (profile === "exploratory") {
    return {
      autonomy_level: "探索执行",
      search_depth: "深度搜索",
      detail_policy: "先读取搜索摘要，候选偏薄时允许使用备用关键词多轮补搜；详情页仍由用户点击确认。",
      recovery_policy: "模块首轮结果不足时，自动尝试备用词和候选池复盘建议词，仍失败则跳过并继续后续模块。",
      rerank_rules: ["优先覆盖稳妥、性价比、升级三档", "优先命中 AI 验收信号", "优先避开已有/排除项", "优先旗舰店或信息完整商品"],
      user_confirmation_points: ["加入购物车前必须由用户确认", "真实购物车异常时回退到演示清单"],
      safety_boundaries: ["不读取订单、地址、手机号、聊天记录等敏感数据", "不自动下单或支付", "不伪装真实加购成功"]
    };
  }

  return {
    autonomy_level: "平衡执行",
    search_depth: "标准搜索",
    detail_policy: "默认先读取搜索摘要，不主动打开大量详情页；候选风险较高时提示用户查看详情。",
    recovery_policy: "首轮候选不足时自动使用备用关键词补搜一次；仍失败则跳过该模块继续后续模块。",
    rerank_rules: ["标题匹配模块意图", "价格贴近模块预算", "店铺可信度更高", "命中 AI 验收信号"],
    user_confirmation_points: ["加入购物车前必须由用户确认"],
    safety_boundaries: ["不读取订单、地址、手机号、聊天记录等敏感数据", "不自动下单或支付"]
  };
}

export function applyAgentDirectiveProfile(state: SessionState, profile: AgentDirectiveProfile) {
  const directives = profileDirectives(profile);
  state.shopping_plan.agent_directives = directives;
  invalidateAgentCompletionArtifacts(state);
  const moduleCount = Math.max(1, state.shopping_plan.modules.length);
  state.agent_runtime.max_tool_calls = profile === "conservative"
    ? Math.max(moduleCount, 6)
    : profile === "exploratory"
      ? Math.min(24, moduleCount * 3 + 2)
      : Math.min(16, moduleCount * 2 + 2);
  state.last_action = `AI执行档位：${profile}`;
  return directives;
}
