import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpenText,
  BrainCircuit,
  CircleDollarSign,
  Cloud,
  Database,
  FileSearch,
  Layers3,
  ListChecks,
  PackageSearch,
  RefreshCcw,
  Search,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  SlidersHorizontal,
  Sparkles,
  Target,
  UserRound,
  Waypoints
} from "lucide-react";

type ProductGuideMode = "formal" | "demo";

type GuideSection = {
  id: string;
  label: string;
};

type Capability = {
  icon: LucideIcon;
  title: string;
  description: string;
};

const guideSections: GuideSection[] = [
  { id: "positioning", label: "产品定位" },
  { id: "commerce-gap", label: "传统电商缺口" },
  { id: "new-car-example", label: "新车首购示例" },
  { id: "solution", label: "解决方案" },
  { id: "capabilities", label: "当前能力" },
  { id: "architecture", label: "技术架构" },
  { id: "product-and-demo", label: "正式产品与 Demo" },
  { id: "boundaries", label: "产品边界" }
];

const productCapabilities: Capability[] = [
  {
    icon: BrainCircuit,
    title: "场景理解",
    description: "把自然语言中的生活场景、预算、偏好、已有物品和排除项整理成可确认的结构化需求。"
  },
  {
    icon: Layers3,
    title: "购物规划",
    description: "拆分购物模块，安排优先级和预算，并在搜索前检查模块覆盖、预算守恒与搜索策略。"
  },
  {
    icon: PackageSearch,
    title: "分模块搜索",
    description: "按规划顺序搜索真实候选，每个模块先给出一个主推荐及理由，需要比较时再展开备选。"
  },
  {
    icon: FileSearch,
    title: "商品证据",
    description: "结合价格、店铺、搜索摘要与可读取的详情证据解释适配性，详情不可用时明确降级。"
  },
  {
    icon: SlidersHorizontal,
    title: "动态调整",
    description: "允许修改需求、规划、搜索词和执行偏好，并在价格压力出现时重新分配预算或补搜。"
  },
  {
    icon: ShoppingCart,
    title: "组合与清单",
    description: "从候选中生成预算内的建议组合，优先覆盖必要模块，再由用户逐件查看和确认。"
  },
  {
    icon: RefreshCcw,
    title: "可恢复执行",
    description: "保存购物 Session、任务和结果，页面关闭或短暂断线后仍可继续，不需要重新开始。"
  }
];

const architectureLayers: Array<{ icon: LucideIcon; title: string; detail: string }> = [
  {
    icon: UserRound,
    title: "产品交互层",
    detail: "Next.js、React 与 TypeScript 构建需求录入、规划确认、搜索进度、推荐结果和购物清单。"
  },
  {
    icon: BrainCircuit,
    title: "Agent 决策层",
    detail: "DeepSeek Chat / Reasoner 按任务复杂度负责场景结构化、规划、复盘和决策提案，规则守卫负责校验与安全降级。"
  },
  {
    icon: Database,
    title: "状态与任务层",
    detail: "PostgreSQL 保存账户、购物 Session、规划、候选、任务队列和执行事件，支持隔离、恢复与幂等回填。"
  },
  {
    icon: Cloud,
    title: "云端编排层",
    detail: "服务端把确认后的搜索和加购动作写入持久任务队列，并持续接收本地执行结果。"
  },
  {
    icon: PackageSearch,
    title: "本地执行层",
    detail: "用户电脑上的 SceneCart Worker 连接淘宝桌面版官方 MCP，执行真实搜索、只读详情和用户确认后的加购。"
  }
];

const comparisonRows = [
  ["主要用途", "个人真实体验与购物执行", "项目展示与公开流程体验"],
  ["登录", "需要账户登录", "无需登录"],
  ["需求与规划", "DeepSeek + 安全规则", "冻结样本流程"],
  ["商品数据", "本地执行器连接淘宝工具", "脱敏历史快照或固定样本"],
  ["价格与库存", "以当次真实搜索为准", "不代表实时价格和库存"],
  ["加购", "本地执行器在线且用户确认后执行", "仅加入浏览器内演示清单"],
  ["下单与支付", "不会自动执行", "不支持"],
  ["自动演示", "不提供", "支持自动演示和手动探索"]
] as const;

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <ShoppingBag className="h-4 w-4" strokeWidth={2.2} />
    </span>
  );
}

function SectionHeading({ title, description }: { title: string; description?: string }) {
  return (
    <div className="product-guide-section-heading">
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
    </div>
  );
}

function GuideNavigation({ className = "" }: { className?: string }) {
  return (
    <nav className={className} aria-label="产品说明目录">
      {guideSections.map((section) => (
        <a key={section.id} href={`#${section.id}`}>{section.label}</a>
      ))}
    </nav>
  );
}

function ProcessLine({
  label,
  highlighted = false,
  steps
}: {
  label: string;
  highlighted?: boolean;
  steps: string[];
}) {
  return (
    <div className={`product-guide-process ${highlighted ? "product-guide-process-highlighted" : ""}`}>
      <strong>{label}</strong>
      <ol>
        {steps.map((step, index) => (
          <li key={step}>
            <span>{step}</span>
            {index < steps.length - 1 ? <ArrowRight aria-hidden="true" /> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function ProductGuide({ mode }: { mode: ProductGuideMode }) {
  const isDemo = mode === "demo";
  const homeHref = isDemo ? "/demo/" : "/";
  const homeLabel = isDemo ? "返回公开 Demo" : "返回 SceneCart";

  return (
    <main className="product-guide-shell">
      <header className="product-guide-header">
        <a href={homeHref} className="flex min-w-0 items-center gap-3" aria-label={homeLabel}>
          <BrandMark />
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-semibold tracking-tight">SceneCart</span>
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">场景化购物助手</span>
          </span>
        </a>
        <a href={homeHref} className="product-guide-back-link">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          <span>{homeLabel}</span>
        </a>
      </header>

      <div className="product-guide-layout">
        <aside className="product-guide-sidebar">
          <div className="product-guide-sidebar-title">
            <BookOpenText className="h-4 w-4" aria-hidden="true" />
            本文目录
          </div>
          <GuideNavigation className="product-guide-toc" />
          <p className="product-guide-sidebar-note">
            这份说明描述产品的真实能力、运行方式与安全边界。
          </p>
        </aside>

        <article className="product-guide-document">
          <section className="product-guide-hero" aria-labelledby="product-guide-title">
            <div className="product-guide-hero-icon" aria-hidden="true">
              <Waypoints className="h-6 w-6" />
            </div>
            <p className="product-guide-kicker">SceneCart AI 产品说明</p>
            <h1 id="product-guide-title">把模糊的购物目标，变成可执行的购物方案</h1>
            <p className="product-guide-hero-summary">
              SceneCart AI 是一个场景化购物 Agent。它先理解用户正在完成什么生活任务，再拆分购物模块、安排优先级、分配预算、搜索商品并组织成可调整的购物清单。
            </p>
            <blockquote>
              AI 在这里不是替代搜索，而是在搜索与交易之前，增加一层“任务理解与决策组织”。
            </blockquote>
            <div className={`product-guide-context ${isDemo ? "product-guide-context-demo" : ""}`}>
              <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
              <p>
                {isDemo
                  ? "你正在查看公开 Demo：它复用正式产品流程，但只读取冻结样本，不连接模型、数据库、淘宝账户或真实购物车。"
                  : "你正在查看正式产品：账户与购物 Session 相互隔离，真实淘宝操作还需要本地执行器在线，并由用户明确确认。"}
              </p>
            </div>
          </section>

          <GuideNavigation className="product-guide-mobile-toc" />

          <section id="positioning" className="product-guide-section">
            <SectionHeading
              title="产品定位"
              description="用户的问题不是找不到商品，而是无法高效完成一个购物任务。"
            />
            <div className="product-guide-definition-grid">
              <div>
                <Target className="h-5 w-5 text-primary" aria-hidden="true" />
                <h3>目标用户</h3>
                <p>
                  有明确生活或消费场景，但尚未形成具体购买清单的人。他们知道自己想完成什么，却不清楚该买什么、先买什么，以及如何在预算内组合。
                </p>
              </div>
              <div className="product-guide-definition-emphasis">
                <ListChecks className="h-5 w-5 text-primary" aria-hidden="true" />
                <h3>产品目标</h3>
                <p>
                  把用户原本需要在脑中完成的需求理解、模块拆分、优先级、预算和候选比较过程产品化、结构化并显性化。
                </p>
              </div>
            </div>
            <div className="product-guide-problem-grid">
              <div>
                <span>认知成本</span>
                <h3>有场景，没有清单</h3>
                <p>不了解该买哪些模块、哪些必须优先补齐，也不知道预算应该如何分配。</p>
              </div>
              <div>
                <span>决策成本</span>
                <h3>有信息，没有组织</h3>
                <p>需要在商品、攻略、测评和内容平台之间反复切换，容易买漏、买错或迟迟不下单。</p>
              </div>
            </div>
          </section>

          <section id="commerce-gap" className="product-guide-section">
            <SectionHeading
              title="为什么传统电商还不够"
              description="淘宝更擅长承接明确单品需求，但任务型、场景型购物仍缺少决策组织层。"
            />
            <div className="product-guide-commerce-grid">
              <div className="product-guide-commerce-strength">
                <Search className="h-5 w-5" aria-hidden="true" />
                <h3>平台已经擅长</h3>
                <p>单品搜索、商品发现、丰富供给与交易履约。</p>
              </div>
              <div>
                <BrainCircuit className="h-5 w-5" aria-hidden="true" />
                <h3>用户仍需自己完成</h3>
                <ol>
                  <li>理解当前场景</li>
                  <li>拆分购物模块</li>
                  <li>安排模块优先级</li>
                  <li>分配整体预算</li>
                  <li>寻找并比较候选商品</li>
                  <li>整理成可执行清单</li>
                </ol>
              </div>
            </div>
            <p className="product-guide-plain-note">
              信息过载并不等于决策充分。传统电商解决“已知目标商品”的查找问题，SceneCart 聚焦“尚未想清楚完整清单”的任务型购物问题。
            </p>
          </section>

          <section id="new-car-example" className="product-guide-section">
            <SectionHeading
              title="以新车用品首购为例"
              description="真实问题不是搜索一个车载手机支架，而是完成提车后的第一阶段置办。"
            />
            <div className="product-guide-scenario-grid">
              <div>
                <h3>用户真正想问</h3>
                <ul>
                  <li>第一阶段到底该买什么</li>
                  <li>有限预算下哪些必须先补齐</li>
                  <li>哪些属于体验升级，可以晚点再买</li>
                  <li>每个模块具体选什么商品更合适</li>
                  <li>如何组织成一套能继续执行的方案</li>
                </ul>
              </div>
              <div className="product-guide-scenario-output">
                <Sparkles className="h-5 w-5 text-primary" aria-hidden="true" />
                <h3>SceneCart 交付</h3>
                <p>一套按必要程度、预算和模块组织的购买方案，而不是一张无差别商品列表。</p>
                <div>
                  <span>安全必需</span>
                  <span>车内实用</span>
                  <span>清洁维护</span>
                  <span>收纳整理</span>
                </div>
              </div>
            </div>
          </section>

          <section id="solution" className="product-guide-section">
            <SectionHeading
              title="SceneCart 如何改变购物链路"
              description="把一次复杂购物任务拆成可以理解、确认和调整的连续阶段。"
            />
            <div className="product-guide-processes">
              <ProcessLine
                label="传统链路"
                steps={["模糊目标", "自己想关键词", "搜索商品", "反复比较", "下单"]}
              />
              <ProcessLine
                label="SceneCart 链路"
                highlighted
                steps={["澄清场景", "生成规划", "优先级与预算", "分模块搜索", "推荐与理由", "动态调整", "购物清单"]}
              />
            </div>
            <p className="product-guide-control-note">
              用户始终保留对需求、规划、推荐结果和加购动作的控制权。Agent 负责组织决策，不替用户自动下单。
            </p>
          </section>

          <section id="capabilities" className="product-guide-section">
            <SectionHeading
              title="当前产品能力"
              description="当前版本已开放新车选购、露营准备、房间装饰、宿舍入学和搬家置办，并以新车用品首购作为主要验证场景。"
            />
            <div className="product-guide-capability-list">
              {productCapabilities.map(({ icon: Icon, title, description }) => (
                <div key={title}>
                  <span className="product-guide-capability-icon"><Icon className="h-4 w-4" aria-hidden="true" /></span>
                  <div>
                    <h3>{title}</h3>
                    <p>{description}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="product-guide-scope-note">
              <strong>可扩展问题空间</strong>
              <p>
                礼物选购和价格决策也属于相似的非收敛问题，需要先澄清意图、组织候选，再进行推荐。当前产品首先聚焦场景化购物，不把这些方向包装成已经完成的能力。
              </p>
            </div>
          </section>

          <section id="architecture" className="product-guide-section">
            <SectionHeading
              title="技术架构"
              description="云端负责理解、决策与持久化，本地执行器持有淘宝桌面版登录环境和真实工具能力。"
            />
            <div className="product-guide-architecture">
              {architectureLayers.map(({ icon: Icon, title, detail }, index) => (
                <div key={title}>
                  <span><Icon className="h-5 w-5" aria-hidden="true" /></span>
                  <div>
                    <h3>{title}</h3>
                    <p>{detail}</p>
                  </div>
                  {index < architectureLayers.length - 1 ? <ArrowRight className="product-guide-architecture-arrow" aria-hidden="true" /> : null}
                </div>
              ))}
            </div>
            <div className="product-guide-architecture-summary">
              <BrainCircuit className="h-5 w-5" aria-hidden="true" />
              <p><strong>决策链：</strong>用户界面 → DeepSeek Agent → 持久任务队列 → 本地执行器 → 淘宝 MCP</p>
              <p><strong>结果链：</strong>淘宝结果 → 本地执行器 → 购物 Session → 推荐与购物清单</p>
            </div>
          </section>

          <section id="product-and-demo" className="product-guide-section">
            <SectionHeading
              title="正式产品与公开 Demo"
              description="两端共享核心界面和购物流程，但运行数据、账户、模型与淘宝执行能力严格隔离。"
            />
            <div className="product-guide-comparison-table" role="region" aria-label="正式产品与公开 Demo 对比">
              <table>
                <thead>
                  <tr>
                    <th scope="col">对比项</th>
                    <th scope="col">正式产品</th>
                    <th scope="col">公开 Demo</th>
                  </tr>
                </thead>
                <tbody>
                  {comparisonRows.map(([label, formal, demo]) => (
                    <tr key={label}>
                      <th scope="row">{label}</th>
                      <td>{formal}</td>
                      <td>{demo}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="product-guide-comparison-mobile">
              <div>
                <h3>正式产品</h3>
                {comparisonRows.map(([label, formal]) => <p key={label}><strong>{label}</strong><span>{formal}</span></p>)}
              </div>
              <div>
                <h3>公开 Demo</h3>
                {comparisonRows.map(([label, , demo]) => <p key={label}><strong>{label}</strong><span>{demo}</span></p>)}
              </div>
            </div>
          </section>

          <section id="boundaries" className="product-guide-section">
            <SectionHeading
              title="产品边界"
              description="SceneCart 是购物决策与执行协作工具，不绕过平台规则，也不替用户完成不可逆交易。"
            />
            <div className="product-guide-boundary-list">
              <p><ShieldCheck aria-hidden="true" />不会接管用户的淘宝网页账号。</p>
              <p><ShieldCheck aria-hidden="true" />真实搜索依赖用户电脑上的本地执行器、淘宝桌面版工具和有效登录状态。</p>
              <p><ShieldCheck aria-hidden="true" />任何真实加购都需要用户明确确认，不会在工具恢复或页面重连后自动执行。</p>
              <p><ShieldCheck aria-hidden="true" />不会自动下单或支付。</p>
              <p><ShieldCheck aria-hidden="true" />商品规格、价格、库存和适配性仍以商品详情页与实际交易页面为准。</p>
              <p><ShieldCheck aria-hidden="true" />Demo 商品和价格只用于流程体验，不代表实时淘宝数据。</p>
            </div>
          </section>

          <section className="product-guide-footer-cta">
            <CircleDollarSign className="h-6 w-6" aria-hidden="true" />
            <div>
              <h2>从“搜一个商品”，升级为“完成一次购物任务”</h2>
              <p>先把需求、优先级和预算想明白，再进入商品搜索与交易。</p>
            </div>
            <a href={homeHref}>
              {homeLabel}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </a>
          </section>
        </article>
      </div>
    </main>
  );
}
