"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  BrainCircuit,
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
  X
} from "lucide-react";

export type ProductGuideMode = "formal" | "demo";

type GuideSectionId =
  | "positioning"
  | "commerce-gap"
  | "new-car-example"
  | "solution"
  | "capabilities"
  | "architecture"
  | "product-and-demo"
  | "boundaries";

type GuideSection = {
  id: GuideSectionId;
  label: string;
  group: "产品认知" | "产品运行" | "版本与边界";
};

type Capability = {
  icon: LucideIcon;
  title: string;
  description: string;
};

const guideSections: GuideSection[] = [
  { id: "positioning", label: "产品定位", group: "产品认知" },
  { id: "commerce-gap", label: "电商为何不够", group: "产品认知" },
  { id: "new-car-example", label: "新车首购示例", group: "产品认知" },
  { id: "solution", label: "工作流程", group: "产品运行" },
  { id: "capabilities", label: "当前能力", group: "产品运行" },
  { id: "architecture", label: "技术方案", group: "产品运行" },
  { id: "product-and-demo", label: "正式产品与 Demo", group: "版本与边界" },
  { id: "boundaries", label: "安全边界", group: "版本与边界" }
];

const productCapabilities: Capability[] = [
  {
    icon: BrainCircuit,
    title: "场景理解",
    description: "把生活场景、预算、偏好、已有物品和排除项整理成可确认的结构化需求。"
  },
  {
    icon: Layers3,
    title: "购物规划",
    description: "拆分购物模块，安排优先级和预算，并检查模块覆盖、预算守恒与搜索策略。"
  },
  {
    icon: PackageSearch,
    title: "分模块搜索",
    description: "按规划顺序搜索真实候选，每个模块先给一个主推荐及理由，需要时再展开备选。"
  },
  {
    icon: FileSearch,
    title: "商品证据",
    description: "结合价格、店铺、搜索摘要与详情证据解释适配性，详情不可用时明确降级。"
  },
  {
    icon: SlidersHorizontal,
    title: "动态调整",
    description: "允许修改需求、规划、搜索词和执行偏好，并在价格压力出现时补搜或调整预算。"
  },
  {
    icon: ShoppingCart,
    title: "组合与清单",
    description: "从候选中生成预算内的建议组合，优先覆盖必要模块，再由用户逐件确认。"
  },
  {
    icon: RefreshCcw,
    title: "可恢复执行",
    description: "保存购物 Session、任务和结果，页面关闭或短暂断线后仍可继续。"
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
  ["访问", "固定域名直接进入并绑定固定 owner；当前 Production 未启用 Vercel 外层保护", "完全公开，无需登录"],
  ["需求与规划", "DeepSeek + 安全规则", "冻结样本流程"],
  ["商品数据", "本地执行器连接淘宝工具", "脱敏历史快照或固定样本"],
  ["价格与库存", "以当次真实搜索为准", "不代表实时价格和库存"],
  ["加购", "本地执行器在线且用户确认后执行", "仅加入浏览器内演示清单"],
  ["下单与支付", "不会自动执行", "不支持"],
  ["自动演示", "提供独立公开 Demo 入口", "支持自动演示和手动探索"]
] as const;

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <ShoppingBag className="h-4 w-4" strokeWidth={2.2} />
    </span>
  );
}

function SectionHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description?: string }) {
  return (
    <div className="product-guide-section-heading">
      <p className="product-guide-section-kicker">{eyebrow}</p>
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
    </div>
  );
}

function ProcessLine({ label, highlighted = false, steps }: { label: string; highlighted?: boolean; steps: string[] }) {
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

function GuidePanel({ sectionId, mode }: { sectionId: GuideSectionId; mode: ProductGuideMode }) {
  if (sectionId === "positioning") {
    return (
      <section className="product-guide-section">
        <SectionHeading
          eyebrow="01 · 产品定位"
          title="把模糊的购物目标，变成可执行的购物方案"
          description="用户的问题不是找不到商品，而是无法高效完成一个购物任务。"
        />
        <p className="product-guide-lead">
          SceneCart AI 是一个场景化购物 Agent。它先理解用户正在完成什么生活任务，再拆分购物模块、安排优先级、分配预算、搜索商品并组织成可调整的购物清单。
        </p>
        <blockquote>AI 在这里不是替代搜索，而是在搜索与交易之前，增加一层“任务理解与决策组织”。</blockquote>
        <div className="product-guide-definition-grid">
          <div>
            <Target className="h-5 w-5 text-primary" aria-hidden="true" />
            <h3>目标用户</h3>
            <p>有明确生活或消费场景，但尚未形成具体购买清单的人。他们知道要完成什么，却不清楚该买什么、先买什么，以及如何在预算内组合。</p>
          </div>
          <div className="product-guide-definition-emphasis">
            <ListChecks className="h-5 w-5 text-primary" aria-hidden="true" />
            <h3>产品目标</h3>
            <p>把用户脑中的需求理解、模块拆分、优先级、预算和候选比较过程产品化、结构化并显性化。</p>
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
    );
  }

  if (sectionId === "commerce-gap") {
    return (
      <section className="product-guide-section">
        <SectionHeading
          eyebrow="02 · 电商为何不够"
          title="商品供给很丰富，任务决策仍要用户自己完成"
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
        <div className="product-guide-problem-grid" aria-label="传统电商难以充分承接的购物问题">
          <div>
            <span>场景化购物</span>
            <h3>组合需求难以被单点搜索承接</h3>
            <p>新车置办、露营、装修或搬家包含多个相互关联的模块，用户需要的是一套按阶段和预算组织的方案，而不是彼此孤立的搜索结果。</p>
          </div>
          <div>
            <span>礼物选购</span>
            <h3>需求尚未收敛，关键词也不明确</h3>
            <p>用户往往还没想清楚送什么，需要先结合对象、关系、场合、预算与偏好探索方向，再逐步收敛到合适候选。</p>
          </div>
          <div>
            <span>价格决策</span>
            <h3>信息很多，却难以形成购买判断</h3>
            <p>价格、规格、优惠、测评和风险分散在不同页面。AI 更适合统一整理这些信息，解释取舍，并帮助用户判断现在是否值得买。</p>
          </div>
        </div>
      </section>
    );
  }

  if (sectionId === "new-car-example") {
    return (
      <section className="product-guide-section">
        <SectionHeading
          eyebrow="03 · 新车首购示例"
          title="真实问题不是搜一个支架，而是完成提车后的第一阶段置办"
          description="一个看似简单的购物场景，实际包含清单、优先级、预算和具体商品四层决策。"
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
    );
  }

  if (sectionId === "solution") {
    return (
      <section className="product-guide-section">
        <SectionHeading
          eyebrow="04 · 工作流程"
          title="把一次复杂购物任务，拆成可以确认和调整的连续阶段"
          description="SceneCart 在搜索和交易之前，补上任务理解与决策组织。"
        />
        <div className="product-guide-processes">
          <ProcessLine label="传统链路" steps={["模糊目标", "自己想关键词", "搜索商品", "反复比较", "下单"]} />
          <ProcessLine
            label="SceneCart 链路"
            highlighted
            steps={["澄清场景", "生成规划", "优先级与预算", "分模块搜索", "推荐与理由", "动态调整", "购物清单"]}
          />
        </div>
        <p className="product-guide-control-note">用户始终保留对需求、规划、推荐结果和加购动作的控制权。Agent 负责组织决策，不替用户自动下单。</p>
      </section>
    );
  }

  if (sectionId === "capabilities") {
    return (
      <section className="product-guide-section">
        <SectionHeading
          eyebrow="05 · 当前能力"
          title="从一句需求，到一套可继续执行的购物清单"
          description="当前已开放新车选购、露营准备、房间装饰、宿舍入学和搬家置办，并以新车用品首购作为主要验证场景。"
        />
        <div className="product-guide-capability-list">
          {productCapabilities.map(({ icon: Icon, title, description }) => (
            <div key={title}>
              <span className="product-guide-capability-icon"><Icon className="h-4 w-4" aria-hidden="true" /></span>
              <div><h3>{title}</h3><p>{description}</p></div>
            </div>
          ))}
        </div>
        <div className="product-guide-scope-note">
          <strong>当前范围</strong>
          <p>礼物选购和价格决策也属于相似的非收敛问题。当前产品首先聚焦场景化购物，不把这些方向包装成已经完成的能力。</p>
        </div>
      </section>
    );
  }

  if (sectionId === "architecture") {
    return (
      <section className="product-guide-section">
        <SectionHeading
          eyebrow="06 · 技术方案"
          title="云端组织决策，本地执行器连接真实淘宝环境"
          description="模型、状态和任务在云端运行，淘宝桌面版登录态与真实工具能力留在用户电脑。"
        />
        <div className="product-guide-architecture">
          {architectureLayers.map(({ icon: Icon, title, detail }, index) => (
            <div key={title}>
              <span><Icon className="h-5 w-5" aria-hidden="true" /></span>
              <div><h3>{title}</h3><p>{detail}</p></div>
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
    );
  }

  if (sectionId === "product-and-demo") {
    return (
      <section className="product-guide-section">
        <SectionHeading
          eyebrow="07 · 运行方式"
          title="正式产品与公开 Demo 共享界面，但不共享运行数据"
          description="Demo 用冻结样本还原完整流程，不连接正式数据库、模型、淘宝账户或真实购物车。"
        />
        <div className="product-guide-comparison-table" role="region" aria-label="正式产品与公开 Demo 对比">
          <table>
            <thead><tr><th scope="col">对比项</th><th scope="col">正式产品</th><th scope="col">公开 Demo</th></tr></thead>
            <tbody>
              {comparisonRows.map(([label, formal, demo]) => (
                <tr key={label}><th scope="row">{label}</th><td>{formal}</td><td>{demo}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="product-guide-comparison-mobile">
          <div><h3>正式产品</h3>{comparisonRows.map(([label, formal]) => <p key={label}><strong>{label}</strong><span>{formal}</span></p>)}</div>
          <div><h3>公开 Demo</h3>{comparisonRows.map(([label, , demo]) => <p key={label}><strong>{label}</strong><span>{demo}</span></p>)}</div>
        </div>
        <div className={`product-guide-context ${mode === "demo" ? "product-guide-context-demo" : ""}`}>
          <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
          <p>{mode === "demo"
            ? "当前是公开 Demo。你可以体验完整产品流程，但其中商品与价格不代表实时淘宝数据。"
            : "当前是正式单用户产品，会直接绑定服务端配置的固定 owner；当前 Production 未启用 Vercel 外层保护，知道固定域名的人可以访问。真实搜索和加购仍需要本地执行器在线。"}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="product-guide-section">
      <SectionHeading
        eyebrow="08 · 安全边界"
        title="协助购物决策，不绕过平台规则"
        description="SceneCart 不替用户执行不可逆交易，也不会把 Demo 的冻结数据包装成实时结果。"
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
  );
}

export function ProductGuideDialog({ mode, open, onOpenChange }: { mode: ProductGuideMode; open: boolean; onOpenChange: (open: boolean) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const [activeSection, setActiveSection] = useState<GuideSectionId>("positioning");
  const isDemo = mode === "demo";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setActiveSection("positioning");
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [activeSection]);

  const closeDialog = () => onOpenChange(false);
  const groups = ["产品认知", "产品运行", "版本与边界"] as const;

  function handleNavigationKeyDown(event: KeyboardEvent<HTMLButtonElement>, sectionId: GuideSectionId) {
    const currentIndex = guideSections.findIndex((section) => section.id === sectionId);
    let nextIndex: number | null = null;

    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % guideSections.length;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + guideSections.length) % guideSections.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = guideSections.length - 1;
    }

    if (nextIndex === null) return;
    event.preventDefault();
    const nextSection = guideSections[nextIndex];
    setActiveSection(nextSection.id);
    dialogRef.current
      ?.querySelector<HTMLButtonElement>(`[data-guide-section="${nextSection.id}"]`)
      ?.focus();
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]):not([tabindex="-1"]), a[href]:not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'
    )].filter((element) => !element.hidden && element.getClientRects().length > 0);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1)!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <dialog
      id="scenecart-product-guide-dialog"
      ref={dialogRef}
      className="product-guide-modal"
      aria-labelledby="product-guide-dialog-title"
      aria-describedby="product-guide-dialog-description"
      aria-modal="true"
      onCancel={(event) => { event.preventDefault(); closeDialog(); }}
      onClose={closeDialog}
      onClick={(event) => { if (event.target === event.currentTarget) closeDialog(); }}
      onKeyDown={handleDialogKeyDown}
      data-demo-tour-control
    >
      <div className="product-guide-modal-surface">
        <header className="product-guide-modal-header">
          <div className="product-guide-modal-brand">
            <BrandMark />
            <div>
              <p>PRODUCT GUIDE</p>
              <h1 id="product-guide-dialog-title">SceneCart AI 产品说明</h1>
              <span id="product-guide-dialog-description">产品定位、当前能力、技术架构与公开 Demo 说明</span>
            </div>
          </div>
          <button type="button" className="product-guide-close" onClick={closeDialog} aria-label="关闭产品说明">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <div className="product-guide-modal-body">
          <aside className="product-guide-sidebar">
            <nav aria-label="产品说明目录" className="product-guide-toc">
              {groups.map((group) => (
                <div className="product-guide-nav-group" key={group}>
                  <p>{group}</p>
                  {guideSections.filter((section) => section.group === group).map((section) => (
                    <button
                      key={section.id}
                      id={`product-guide-tab-${section.id}`}
                      type="button"
                      className={activeSection === section.id ? "product-guide-nav-active" : undefined}
                      aria-current={activeSection === section.id ? "page" : undefined}
                      aria-controls="scenecart-product-guide-panel"
                      tabIndex={activeSection === section.id ? 0 : -1}
                      data-guide-section={section.id}
                      onClick={() => setActiveSection(section.id)}
                      onKeyDown={(event) => handleNavigationKeyDown(event, section.id)}
                    >
                      {section.label}
                    </button>
                  ))}
                </div>
              ))}
            </nav>
            <div className="product-guide-mode-cards" aria-label="当前运行版本">
              <div className={!isDemo ? "product-guide-mode-active" : undefined}><strong>正式产品</strong><span>固定 owner 与真实任务环境；当前 Production 未启用外层保护</span></div>
              <div className={isDemo ? "product-guide-mode-active" : undefined}><strong>公开 Demo</strong><span>冻结数据体验版</span></div>
            </div>
          </aside>

          <article
            id="scenecart-product-guide-panel"
            ref={contentRef}
            className="product-guide-panel"
            key={activeSection}
            role="region"
            aria-labelledby={`product-guide-tab-${activeSection}`}
          >
            <GuidePanel sectionId={activeSection} mode={mode} />
          </article>
        </div>
      </div>
    </dialog>
  );
}
