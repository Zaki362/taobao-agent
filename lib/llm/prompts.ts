import { AgentDecisionProposal, ModuleCandidateReview, PlanningModule, ProductCandidate, QuickAction, SceneBrief, SessionState, ShoppingPlan, ShoppingPlanModule } from "@/lib/session/types";
import { getScenarioConfig } from "@/lib/scenarios";

function dataBoundaryNotice() {
  return [
    "数据边界：只可使用用户场景描述、预算、偏好、已有物品、不想买的类别、基础模板、模块定义和候选商品摘要。",
    "禁止使用或索取订单历史、收货地址、手机号、联系人信息、旺旺聊天记录、账号昵称头像等身份信息、购物车原始敏感数据、浏览记录原始明细。"
  ].join("\n");
}

export function parseScenePrompt(input: string, scenarioId: SceneBrief["scenario_id"]) {
  const scenario = getScenarioConfig(scenarioId);
  return [
    `你是“${scenario.name}”场景化购物 Agent 的场景理解器。`,
    "请把用户输入解析为结构化 Scene Brief，缺失字段使用合理默认值。",
    "输出只允许 JSON，必须返回完整对象，不要只返回局部字段。",
    "JSON 字段必须包含：scenario_id、scene_type、vehicle_type、user_stage、budget、priority_style、already_have、avoid_items、optional_notes。",
    `scenario_id 固定为：${scenario.id}`,
    dataBoundaryNotice(),
    `场景字段标签：${JSON.stringify(scenario.field_labels, null, 2)}`,
    `可选项集合：${JSON.stringify(scenario.field_option_sets, null, 2)}`,
    `用户输入：${input}`
  ].join("\n");
}

export function personalizeTemplatePrompt(scene: SceneBrief, template: PlanningModule[]) {
  const scenario = getScenarioConfig(scene.scenario_id);
  const adaptivePolicy = scenario.adaptive_module_policy;
  const adaptiveInstructions = adaptivePolicy
    ? [
        `如果用户描述中存在基础模板无法明确覆盖的特殊需求，可以新增最多 ${adaptivePolicy.max_modules} 个自适应模块。没有清晰特殊需求时不要新增。`,
        `自适应 module_id 必须以 ${adaptivePolicy.id_prefix} 开头，只能使用小写字母、数字和连字符；optional 必须为 true。`,
        "自适应模块必须完整返回 module_name、description、default_priority、default_budget_ratio、typical_item_types，以及普通规划模块要求的全部字段。",
        `可考虑的触发方向：${adaptivePolicy.activation_hints.join("；")}`,
        "当用户需求明确命中上述方向，且基础模板的 typical_item_types 没有覆盖对应品类时，应新增自适应模块，不要把独立专项需求硬塞进宽泛模块。",
        `禁止新增涉及以下服务或高风险领域的模块：${adaptivePolicy.prohibited_terms.join("、")}`,
        "自适应模块仍只是购物规划提案，必须进入用户确认页，不能直接调用工具。"
      ]
    : ["当前场景不允许新增基础模板之外的模块。"];
  return [
    `你是“${scenario.name}”场景化购物 Agent 的规划大脑。`,
    "你必须以基础模板为骨架，但可以在模板范围内做更主动的策略判断：裁剪可选模块、重排模块、调整预算、生成更贴合用户语境的搜索关键词。",
    "重要边界：除下述受限自适应模块外，不要新增 template 中不存在的 module_id；不要直接调用工具，不要编造真实商品。",
    ...adaptiveInstructions,
    "每个保留模块都必须给出：priority、budget_allocation、rationale、recommendation_strategy、search_keyword、search_strategy、status。",
    "还必须给出计划级 execution_strategy，用来指导后端 Agent 如何执行这个规划，但它不能直接调用工具。",
    "execution_strategy 结构必须包含 module_sequence、budget_guardrails、tradeoffs、search_notes、stop_rules。",
    "module_sequence 必须使用 module_id 数组，表示建议的串行搜索顺序；budget_guardrails 表示预算纪律；tradeoffs 表示本轮放弃或后置的原因；search_notes 表示给工具层的搜索注意事项；stop_rules 表示什么时候不继续扩大搜索。",
    "还必须给出 agent_directives，表示 AI 给后端 Agent 的操作空间与边界。结构必须包含 autonomy_level、search_depth、detail_policy、recovery_policy、rerank_rules、user_confirmation_points、safety_boundaries。",
    "agent_directives.autonomy_level 只能是 保守执行、平衡执行、探索执行 之一；search_depth 只能是 轻量搜索、标准搜索、深度搜索 之一。",
    "agent_directives.detail_policy 用一句话说明是否需要自动打开详情页；recovery_policy 用一句话说明模块搜索失败时如何继续；rerank_rules 给 2-4 条候选排序规则；user_confirmation_points 给 1-3 条需要用户确认后再执行的动作；safety_boundaries 给 2-4 条工具和隐私边界。",
    "search_keyword 应该是可直接用于淘宝搜索的短词组，包含场景约束、品类词和关键偏好，避免空泛词。",
    "不同模块的 search_keyword 必须明显不同，不能把同一组商品词复制到多个模块。",
    "search_strategy 是 AI 给工具执行层的安全策略包，不直接调用工具。结构必须包含 primary_keyword、alternate_keywords、include_terms、exclude_terms、ranking_focus、must_have_signals、reject_signals、quality_checks、price_band、reasoning、failure_recovery。",
    "search_strategy.primary_keyword 应该比 search_keyword 更适合首次检索；alternate_keywords 必须给 2-3 个与 primary 明显不同的备用淘宝搜索词，用于换一批或首轮无结果时恢复；include_terms 用于提升候选相关性；exclude_terms 用于规避用户不想买/已有物品；ranking_focus 用于说明排序时优先看哪些信号。",
    "must_have_signals 给 2-4 个“好候选必须尽量满足”的可观察信号，例如适配性、规格、安装方式、预算段或核心功能；reject_signals 给 2-4 个应明显降权的信号；quality_checks 给 2-4 个进入推荐前要核查的信息完整性或可信度指标，例如图片、详情链接、店铺类型、规格明确度。",
    "failure_recovery 用一句话说明搜索失败、候选质量薄或验收信号不足时如何收缩/改写搜索。",
    "输出必须是严格 JSON，不要附加解释性文本。JSON 结构必须包含 overall_rationale、personalization_summary、execution_strategy、agent_directives、modules。",
    `基础模板 module_id：${template.map((module) => module.module_id).join("、")}`,
    dataBoundaryNotice(),
    `Scene Brief: ${JSON.stringify(scene, null, 2)}`,
    `Template: ${JSON.stringify(template, null, 2)}`
  ].join("\n");
}

export function reviewShoppingPlanPrompt(scene: SceneBrief, plan: ShoppingPlan) {
  const compactPlan = {
    overall_rationale: plan.overall_rationale,
    personalization_summary: plan.personalization_summary,
    execution_strategy: plan.execution_strategy,
    agent_directives: plan.agent_directives,
    modules: plan.modules.map((module) => ({
      module_id: module.module_id,
      module_name: module.module_name,
      origin: module.origin ?? "base_template",
      priority: module.priority,
      budget_allocation: module.budget_allocation,
      search_keyword: module.search_keyword,
      recommendation_strategy: module.recommendation_strategy,
      search_strategy: module.search_strategy
    }))
  };

  return [
    "你是场景化购物 Agent 的规划质检器。",
    "请只审查已生成的购物规划是否适合用户约束，不要新增真实商品，不要决定工具调用。",
    "重点检查：预算分配是否合理、模块是否覆盖高频需求、搜索关键词是否差异化、AI 验收/拒绝信号是否足够明确、哪些地方需要用户确认。",
    "输出必须是严格 JSON，字段必须包含：status、summary、strengths、risks、improvement_suggestions、budget_comment、keyword_comment、module_comment。",
    "status 只能是 ready、needs_attention、risky 之一。",
    "strengths、risks、improvement_suggestions 每项 1-4 条，要求短句，面向用户可读。",
    dataBoundaryNotice(),
    `Scene Brief: ${JSON.stringify(scene, null, 2)}`,
    `Shopping Plan: ${JSON.stringify(compactPlan, null, 2)}`
  ].join("\n");
}

export function refinePlanPrompt(scene: SceneBrief, action: QuickAction) {
  const scenario = getScenarioConfig(scene.scenario_id);
  return [
    `你负责响应快捷操作，对既有“${scenario.name}”方案做轻量重算。`,
    "请返回更新后的完整 Scene Brief JSON，不要只返回局部 patch。",
    "JSON 字段必须包含：scenario_id、scene_type、vehicle_type、user_stage、budget、priority_style、already_have、avoid_items、optional_notes。",
    "不要在这里生成购物规划或商品推荐；后端 Agent 会基于完整 Scene Brief 重新规划。",
    "输出必须是严格 JSON，不要附加解释性文本。",
    dataBoundaryNotice(),
    `可选项集合：${JSON.stringify(scenario.field_option_sets, null, 2)}`,
    `Scene Brief: ${JSON.stringify(scene, null, 2)}`,
    `Quick Action: ${action}`
  ].join("\n");
}

export function explainProductFitPrompt(moduleName: string, title: string) {
  return [
    "你负责生成商品适配理由。",
    "请给出一句简洁中文说明，解释商品为什么适合当前模块和场景。",
    dataBoundaryNotice(),
    `模块：${moduleName}`,
    `商品标题：${title}`
  ].join("\n");
}

export function reviewCandidatePoolPrompt({
  scene,
  module,
  candidates,
  fallbackReview
}: {
  scene: SceneBrief;
  module: ShoppingPlanModule;
  candidates: ProductCandidate[];
  fallbackReview: ModuleCandidateReview;
}) {
  const candidateSummaries = candidates.map((candidate) => ({
    product_id: candidate.product_id,
    title: candidate.title,
    price: candidate.price,
    shop_name: candidate.shop_name,
    shop_badges: candidate.shop_badges,
    highlights: candidate.highlights,
    risk_notes: candidate.risk_notes,
    recommendation_type: candidate.recommendation_type
  }));

  return [
    "你是场景化购物 Agent 的候选池复盘器。",
    "请只基于候选商品摘要、模块策略和用户约束，判断当前候选池是否足够进入用户决策。",
    "不要编造商品详情，不要要求读取订单/地址/账号/聊天/浏览历史。",
    "输出必须是严格 JSON，字段必须包含：module_id、status、summary、strengths、caveats、next_action、suggested_keyword。",
    "status 只能是 ready、needs_detail_check、thin、needs_refine 之一。",
    "suggested_keyword 如果不需要补搜可返回空字符串；如果候选偏少或偏离预算，请返回一个可直接用于淘宝搜索的短词组。",
    dataBoundaryNotice(),
    `Scene Brief: ${JSON.stringify(scene, null, 2)}`,
    `Module: ${JSON.stringify({
      module_id: module.module_id,
      module_name: module.module_name,
      budget_allocation: module.budget_allocation,
      recommendation_strategy: module.recommendation_strategy,
      search_strategy: module.search_strategy
    }, null, 2)}`,
    `候选商品摘要: ${JSON.stringify(candidateSummaries, null, 2)}`,
    `规则评估参考: ${JSON.stringify(fallbackReview, null, 2)}`
  ].join("\n");
}

export function decideNextActionPrompt(
  state: SessionState,
  policyFallback: AgentDecisionProposal
) {
  const modules = state.shopping_plan.modules.map((module) => ({
    module_id: module.module_id,
    module_name: module.module_name,
    optional: module.optional ?? false,
    priority: module.priority,
    budget_allocation: module.budget_allocation,
    primary_keyword: module.search_strategy?.primary_keyword ?? module.search_keyword,
    alternate_keywords: module.search_strategy?.alternate_keywords ?? [],
    candidate_count: state.module_candidates[module.module_id]?.length ?? 0,
    review: state.module_reviews[module.module_id]
      ? {
          status: state.module_reviews[module.module_id].status,
          summary: state.module_reviews[module.module_id].summary,
          next_action: state.module_reviews[module.module_id].next_action,
          suggested_keyword: state.module_reviews[module.module_id].suggested_keyword
        }
      : null,
    trace: state.module_search_traces[module.module_id]
      ? {
          status: state.module_search_traces[module.module_id].status,
          searched_keywords: state.module_search_traces[module.module_id].searched_keywords,
          result_count: state.module_search_traces[module.module_id].result_count,
          next_action: state.module_search_traces[module.module_id].next_action
        }
      : null
  }));
  const activeTasks = state.hosted_tasks
    .filter((task) => task.status === "pending" || task.status === "running")
    .map((task) => ({ task_id: task.task_id, task_type: task.task_type, module_id: task.module_id, status: task.status }));

  return [
    "你是 SceneCart AI Agent Runtime 2.0 的下一步决策器。",
    "你只负责从动作白名单中选择下一步，不直接执行工具，也不能执行下单、付款、读取订单、地址或聊天记录。",
    "动作白名单：search_module、retry_module、skip_module、wait_for_tools、complete_workflow。",
    "决策原则：优先完成高价值模块；已有可用候选时不要重复首搜；候选质量薄或真实价格明显高于模块预算时可以用新关键词补搜；有活跃任务时应等待；非可选模块未搜索且未失败时不能跳过；工具预算耗尽时应结束。",
    "Market Feedback 是候选价格形成的聚合证据。你可以据此调整搜索顺序或补搜词，但不能静默修改用户确认过的预算；预算重分配只能作为建议并等待用户确认。",
    "search_module/retry_module 必须填写合法 module_id；retry_module 应提供与已搜索词不同的 keyword_override。",
    "输出必须是严格 JSON，字段完整，不要输出解释文本。",
    "JSON 字段：action、confidence、module_id、keyword_override、reason、evidence、expected_gain、tool_cost。",
    "confidence 只能是 high、medium、low；evidence 为 1-4 条短句；tool_cost 对搜索/补搜填 1，其他动作填 0。",
    dataBoundaryNotice(),
    `Scene Brief: ${JSON.stringify(state.scene_brief, null, 2)}`,
    `Agent Directives: ${JSON.stringify(state.shopping_plan.agent_directives, null, 2)}`,
    `Execution Strategy: ${JSON.stringify(state.shopping_plan.execution_strategy, null, 2)}`,
    `Runtime Budget: ${JSON.stringify(state.agent_runtime, null, 2)}`,
    `Market Feedback: ${JSON.stringify({
      status: state.market_feedback.status,
      observed_modules: state.market_feedback.observed_modules,
      total_modules: state.market_feedback.total_modules,
      observed_budget_gap: state.market_feedback.observed_budget_gap,
      summary: state.market_feedback.summary,
      module_signals: Object.values(state.market_feedback.module_signals)
        .filter((signal) => signal.pressure !== "unobserved")
        .map((signal) => ({
          module_id: signal.module_id,
          pressure: signal.pressure,
          budget_allocation: signal.budget_allocation,
          minimum_price: signal.minimum_price,
          median_price: signal.median_price,
          within_budget_count: signal.within_budget_count,
          suggested_keyword: signal.suggested_keyword
        })),
      reallocation_suggestions: state.market_feedback.reallocation_suggestions
    }, null, 2)}`,
    `Modules: ${JSON.stringify(modules, null, 2)}`,
    `Active Tasks: ${JSON.stringify(activeTasks, null, 2)}`,
    `Recent Decisions: ${JSON.stringify(state.agent_decisions.slice(-5).map((decision) => ({ action: decision.action, module_id: decision.module_id, consumed_at: decision.consumed_at, reason: decision.reason })), null, 2)}`,
    `Policy Fallback Reference: ${JSON.stringify(policyFallback, null, 2)}`
  ].join("\n");
}
