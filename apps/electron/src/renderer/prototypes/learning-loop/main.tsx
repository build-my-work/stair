/**
 * THROWAWAY PROTOTYPE — not production code.
 *
 * Three structural variants of the returning learner experience, switchable
 * through `?variant=A|B|C` and the floating bottom bar on this one route.
 * The question: can a returning learner resume, learn first, cross an explicit
 * handoff into independent output, repair a gap, and understand the evidence?
 */
import React, { useEffect, useMemo, useState } from 'react'
import ReactDOM from 'react-dom/client'
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  BrainCircuit,
  ChartNoAxesCombined as Growth,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileText,
  FolderKanban,
  Home,
  Layers3,
  Library,
  Menu,
  MessageCircleQuestion,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  Target,
  X,
  type LucideIcon,
} from 'lucide-react'
import './prototype.css'

type VariantKey = 'A' | 'B' | 'C'
type NavKey = 'home' | 'learn' | 'practice' | 'project' | 'sources' | 'growth'
type JourneyView =
  | 'learn-write'
  | 'learn-recall'
  | 'guided'
  | 'handoff'
  | 'attempt'
  | 'feedback'
  | 'repair'
  | 'evidence'
type OverviewView =
  | 'home'
  | 'learn-overview'
  | 'practice-overview'
  | 'project-overview'
  | 'sources-overview'
  | 'growth-overview'
type View = JourneyView | OverviewView

type IconComponent = LucideIcon

type NavItem = {
  key: NavKey
  label: string
  hint: string
  icon: IconComponent
}

type AppState = {
  view: View
  lastJourneyView: JourneyView
  guidedChoice: string | null
  hintUsed: boolean
  sourcePeeked: boolean
  draft: string
  repairDraft: string
  completed: boolean
}

const NAV_ITEMS: NavItem[] = [
  { key: 'home', label: '首页', hint: '从这里继续', icon: Home },
  { key: 'learn', label: '学习', hint: '理解新知识', icon: BookOpen },
  { key: 'practice', label: '练习', hint: '巩固与修正', icon: BrainCircuit },
  { key: 'project', label: '项目', hint: '用它做成事', icon: FolderKanban },
  { key: 'sources', label: '资料', hint: '管理来源', icon: Library },
  { key: 'growth', label: '成长', hint: '查看能力证据', icon: Growth },
]

const VARIANTS: Record<VariantKey, { name: string; note: string }> = {
  A: { name: '学习工作台', note: '稳定导航、单一主舞台、右侧上下文' },
  B: { name: '连续时间线', note: '把学习、尝试与修正放在一条连续轨迹上' },
  C: { name: '能力地图', note: '用空间位置表达能力路径，续学 Dock 始终可见' },
}

const INITIAL_DRAFT = '把用户偏好保存到长期记忆；新会话时检索相关内容，然后用来回答。'

const INITIAL_STATE: AppState = {
  view: 'home',
  lastJourneyView: 'learn-write',
  guidedChoice: null,
  hintUsed: false,
  sourcePeeked: false,
  draft: INITIAL_DRAFT,
  repairDraft: `${INITIAL_DRAFT}\n\n补充：`,
  completed: false,
}

const JOURNEY_VIEWS = new Set<View>([
  'learn-write',
  'learn-recall',
  'guided',
  'handoff',
  'attempt',
  'feedback',
  'repair',
  'evidence',
])

const PRACTICE_VIEWS = new Set<View>(['guided', 'handoff', 'attempt', 'feedback', 'repair'])

const VIEW_TO_NAV: Record<View, NavKey> = {
  home: 'home',
  'learn-overview': 'learn',
  'practice-overview': 'practice',
  'project-overview': 'project',
  'sources-overview': 'sources',
  'growth-overview': 'growth',
  'learn-write': 'learn',
  'learn-recall': 'learn',
  guided: 'practice',
  handoff: 'practice',
  attempt: 'practice',
  feedback: 'practice',
  repair: 'practice',
  evidence: 'growth',
}

const VIEW_LABELS: Record<View, string> = {
  home: '首页',
  'learn-overview': '学习总览',
  'practice-overview': '练习总览',
  'project-overview': '项目',
  'sources-overview': '资料',
  'growth-overview': '成长',
  'learn-write': 'Learn · 写入',
  'learn-recall': 'Learn · 召回',
  guided: '引导练习',
  handoff: '交棒',
  attempt: '独立输出',
  feedback: '反馈',
  repair: '修正',
  evidence: '成长证据',
}

const journeyOrder: JourneyView[] = [
  'learn-write',
  'learn-recall',
  'guided',
  'handoff',
  'attempt',
  'feedback',
  'repair',
  'evidence',
]

function getVariantFromUrl(): VariantKey {
  const value = new URLSearchParams(window.location.search).get('variant')?.toUpperCase()
  return value === 'B' || value === 'C' ? value : 'A'
}

function getResumeMeta(state: AppState) {
  if (state.completed) {
    return {
      eyebrow: '今天到这里',
      title: '“写入与召回”已完成当场独立验证',
      description: '两天后会换一个场景，再确认是否记得牢。',
      action: '查看这次成长',
      view: 'evidence' as JourneyView,
      duration: '已完成',
    }
  }

  const meta: Record<JourneyView, { eyebrow: string; title: string; description: string; action: string; duration: string }> = {
    'learn-write': {
      eyebrow: '继续上次 · 学习',
      title: '理解“写入”和“召回”为什么要分开',
      description: '上次你已经分清 Context 与 Persistent Memory。',
      action: '继续上次',
      duration: '约 6 分钟',
    },
    'learn-recall': {
      eyebrow: '继续上次 · 学习',
      title: '写入之后，记忆怎样在新会话里被想起',
      description: '已读完“写入判断”，从召回继续。',
      action: '接着学',
      duration: '约 5 分钟',
    },
    guided: {
      eyebrow: '继续上次 · 练习',
      title: '补全一次 Memory Lifecycle',
      description: '学习位置已经保存；现在在支架下练一次。',
      action: '继续练习',
      duration: '约 4 分钟',
    },
    handoff: {
      eyebrow: '继续上次 · 练习',
      title: '支架已经完成，准备自己来一次',
      description: '你可以选择收起资料，或带着参考开始。',
      action: '继续交棒',
      duration: '约 3 分钟',
    },
    attempt: {
      eyebrow: '继续上次 · 独立输出',
      title: '客服 Agent 的 Memory Lifecycle 草稿',
      description: '你的文字和提示状态都还在。',
      action: '继续草稿',
      duration: '草稿已保存',
    },
    feedback: {
      eyebrow: '继续上次 · 反馈',
      title: '核心结构已经成立，还缺一个使用判断',
      description: '回到你的原方案上看具体差异。',
      action: '查看反馈',
      duration: '约 2 分钟',
    },
    repair: {
      eyebrow: '继续上次 · 修正',
      title: '补上“召回后是否应该使用”的判断',
      description: '原始方案和反馈都已保留。',
      action: '继续修正',
      duration: '约 1 分钟',
    },
    evidence: {
      eyebrow: '继续上次 · 成长',
      title: '查看这次尝试证明了什么',
      description: '不是分数，而是一条可回看的能力证据。',
      action: '查看证据',
      duration: '已完成',
    },
  }

  return { ...meta[state.lastJourneyView], view: state.lastJourneyView }
}

function App() {
  const [variant, setVariant] = useState<VariantKey>(getVariantFromUrl)
  const [state, setState] = useState<AppState>(INITIAL_STATE)
  const [aiOpen, setAiOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const activeNav = VIEW_TO_NAV[state.view]
  const resumeMeta = useMemo(() => getResumeMeta(state), [state])

  useEffect(() => {
    const handlePopState = () => setVariant(getVariantFromUrl())
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2600)
    return () => window.clearTimeout(timer)
  }, [toast])

  const switchVariant = (next: VariantKey) => {
    const url = new URL(window.location.href)
    url.searchParams.set('variant', next)
    window.history.replaceState({}, '', url)
    setVariant(next)
  }

  const cycleVariant = (direction: -1 | 1) => {
    const keys: VariantKey[] = ['A', 'B', 'C']
    const index = keys.indexOf(variant)
    switchVariant(keys[(index + direction + keys.length) % keys.length])
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, [contenteditable="true"]')) return
      if (event.key === 'ArrowLeft') cycleVariant(-1)
      if (event.key === 'ArrowRight') cycleVariant(1)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  })

  const openView = (view: View) => {
    setState(current => ({
      ...current,
      view,
      lastJourneyView: JOURNEY_VIEWS.has(view) ? (view as JourneyView) : current.lastJourneyView,
    }))
    setMobileNavOpen(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const openNav = (key: NavKey) => {
    const overview: Record<NavKey, OverviewView> = {
      home: 'home',
      learn: 'learn-overview',
      practice: 'practice-overview',
      project: 'project-overview',
      sources: 'sources-overview',
      growth: 'growth-overview',
    }
    openView(overview[key])
  }

  const updateState = (patch: Partial<AppState>) => setState(current => ({ ...current, ...patch }))

  const resetPrototype = () => {
    setState(INITIAL_STATE)
    setAiOpen(false)
    setSearchOpen(false)
    setAddOpen(false)
    setToast('体验已重置：回到老用户首页')
  }

  const shellProps: ShellProps = {
    variant,
    state,
    activeNav,
    resumeMeta,
    openView,
    openNav,
    updateState,
    openAi: () => setAiOpen(true),
    openSearch: () => setSearchOpen(true),
    openAdd: () => setAddOpen(true),
    mobileNavOpen,
    setMobileNavOpen,
    notify: setToast,
  }

  return (
    <>
      {variant === 'A' && <VariantA {...shellProps} />}
      {variant === 'B' && <VariantB {...shellProps} />}
      {variant === 'C' && <VariantC {...shellProps} />}

      {aiOpen && (
        <AiDrawer
          view={state.view}
          onClose={() => setAiOpen(false)}
          onNotify={setToast}
        />
      )}
      {searchOpen && (
        <SearchDialog
          onClose={() => setSearchOpen(false)}
          onNavigate={view => {
            setSearchOpen(false)
            openView(view)
          }}
        />
      )}
      {addOpen && (
        <AddDialog
          onClose={() => setAddOpen(false)}
          onChoose={(view, message) => {
            setAddOpen(false)
            openView(view)
            setToast(message)
          }}
        />
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
      {import.meta.env.DEV && (
        <PrototypeSwitcher
          variant={variant}
          state={state}
          onPrevious={() => cycleVariant(-1)}
          onNext={() => cycleVariant(1)}
          onReset={resetPrototype}
        />
      )}
    </>
  )
}

type ShellProps = {
  variant: VariantKey
  state: AppState
  activeNav: NavKey
  resumeMeta: ReturnType<typeof getResumeMeta>
  openView: (view: View) => void
  openNav: (key: NavKey) => void
  updateState: (patch: Partial<AppState>) => void
  openAi: () => void
  openSearch: () => void
  openAdd: () => void
  mobileNavOpen: boolean
  setMobileNavOpen: (open: boolean) => void
  notify: (message: string) => void
}

function VariantA(props: ShellProps) {
  return (
    <div className="prototype shell-a">
      <SideNavigation {...props} />
      <section className="app-column">
        <TopBar {...props} />
        <main className="main-stage">
          <CurrentView {...props} />
        </main>
      </section>
      <ContextRail state={props.state} onOpenView={props.openView} />
      <MobileNavigation {...props} />
    </div>
  )
}

function VariantB(props: ShellProps) {
  return (
    <div className="prototype shell-b">
      <TopNavigation {...props} />
      <div className="timeline-mobile-top">
        <TopBar {...props} />
      </div>
      <ResumeRibbon {...props} />
      <div className="timeline-layout">
        <TimelineRail state={props.state} onOpenView={props.openView} />
        <main className="timeline-stage">
          <CurrentView {...props} />
        </main>
      </div>
      <MobileNavigation {...props} />
    </div>
  )
}

function VariantC(props: ShellProps) {
  return (
    <div className="prototype shell-c">
      <SideNavigation {...props} compact />
      <section className="canvas-column">
        <TopBar {...props} canvas />
        <main className="canvas-stage">
          <CurrentView {...props} />
        </main>
        <ResumeDock {...props} />
      </section>
      <MobileNavigation {...props} />
    </div>
  )
}

function StairMark() {
  return (
    <div className="brand-mark" aria-label="Stair">
      <span className="stair-glyph" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>Stair</span>
      <em>Prototype</em>
    </div>
  )
}

function SideNavigation(props: ShellProps & { compact?: boolean }) {
  return (
    <aside className={`side-navigation${props.compact ? ' compact-navigation' : ''}`}>
      <StairMark />
      <nav aria-label="主要导航">
        {NAV_ITEMS.map(item => {
          const Icon = item.icon
          return (
            <button
              key={item.key}
              className={props.activeNav === item.key ? 'nav-item active' : 'nav-item'}
              onClick={() => props.openNav(item.key)}
              aria-current={props.activeNav === item.key ? 'page' : undefined}
            >
              <Icon size={18} strokeWidth={1.9} />
              <span>
                <strong>{item.label}</strong>
                {!props.compact && <small>{item.hint}</small>}
              </span>
            </button>
          )
        })}
      </nav>
      <div className="nav-tools">
        <button onClick={props.openSearch}><Search size={17} /> <span>搜索</span></button>
        <button onClick={props.openAi}><MessageCircleQuestion size={17} /> <span>问 AI</span></button>
        <button className="add-button" onClick={props.openAdd}><Plus size={17} /> <span>添加</span></button>
      </div>
    </aside>
  )
}

function TopNavigation(props: ShellProps) {
  return (
    <header className="top-navigation">
      <StairMark />
      <nav aria-label="主要导航">
        {NAV_ITEMS.map(item => (
          <button
            key={item.key}
            className={props.activeNav === item.key ? 'active' : ''}
            onClick={() => props.openNav(item.key)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="top-tools">
        <button onClick={props.openSearch}><Search size={17} /> 搜索</button>
        <button onClick={props.openAi}><MessageCircleQuestion size={17} /> 问 AI</button>
        <button className="primary-tool" onClick={props.openAdd}><Plus size={17} /> 添加</button>
      </div>
    </header>
  )
}

function TopBar(props: ShellProps & { canvas?: boolean }) {
  return (
    <header className={`top-bar${props.canvas ? ' canvas-top-bar' : ''}`}>
      <button
        className="mobile-menu-button"
        onClick={() => props.setMobileNavOpen(!props.mobileNavOpen)}
        aria-label="打开导航"
      >
        <Menu size={20} />
      </button>
      <button className="context-picker" onClick={() => props.notify('原型固定使用 Agent Memory 学习目标')}>
        <span>当前目标</span>
        <strong>设计可靠的 Agent Memory</strong>
        <ChevronDown size={15} />
      </button>
      <div className="top-actions">
        <button onClick={props.openSearch} aria-label="搜索"><Search size={18} /></button>
        <button className="ask-ai-button" onClick={props.openAi}><MessageCircleQuestion size={17} /> 问 AI</button>
        <button className="top-add-button" onClick={props.openAdd}><Plus size={17} /> 添加</button>
      </div>
    </header>
  )
}

function MobileNavigation(props: ShellProps) {
  if (!props.mobileNavOpen) return null
  return (
    <div className="mobile-navigation" role="dialog" aria-label="全部导航">
      <div className="mobile-navigation-header">
        <StairMark />
        <button onClick={() => props.setMobileNavOpen(false)} aria-label="关闭导航"><X size={20} /></button>
      </div>
      {NAV_ITEMS.map(item => {
        const Icon = item.icon
        return (
          <button key={item.key} onClick={() => props.openNav(item.key)}>
            <Icon size={20} />
            <span><strong>{item.label}</strong><small>{item.hint}</small></span>
            <ChevronRight size={17} />
          </button>
        )
      })}
    </div>
  )
}

function ContextRail({ state, onOpenView }: { state: AppState; onOpenView: (view: View) => void }) {
  const currentIndex = journeyOrder.indexOf(state.lastJourneyView)
  return (
    <aside className="context-rail">
      <div className="context-rail-head">
        <span className="utility-label">当前学习目标</span>
        <h2>Agent Memory</h2>
        <p>从“理解”走到“能独立设计”。</p>
      </div>
      <div className="mini-path">
        <span className="utility-label">这一次</span>
        {[
          { label: '理解', start: 0, end: 1 },
          { label: '引导练习', start: 2, end: 3 },
          { label: '独立输出', start: 4, end: 4 },
          { label: '反馈与修正', start: 5, end: 6 },
          { label: '成长证据', start: 7, end: 7 },
        ].map(({ label, start, end }) => {
          const status = currentIndex > end ? 'done' : currentIndex >= start ? 'current' : 'future'
          return (
            <div key={label} className={`mini-path-row ${status}`}>
              <i>{status === 'done' ? <Check size={12} /> : null}</i>
              <span>{label}</span>
            </div>
          )
        })}
      </div>
      <button className="quiet-link context-evidence" onClick={() => onOpenView('growth-overview')}>
        <Archive size={15} /> 查看已有证据 <ChevronRight size={15} />
      </button>
      <div className="next-review">
        <Clock3 size={16} />
        <span><small>下一次验证</small><strong>{state.completed ? '两天后 · 换场景' : '完成本次后安排'}</strong></span>
      </div>
    </aside>
  )
}

function TimelineRail({ state, onOpenView }: { state: AppState; onOpenView: (view: View) => void }) {
  const currentIndex = journeyOrder.indexOf(state.lastJourneyView)
  const stages: { label: string; detail: string; view: JourneyView; start: number; end: number }[] = [
    { label: '理解', detail: 'Learn', view: 'learn-write', start: 0, end: 1 },
    { label: '引导练习', detail: 'Guide', view: 'guided', start: 2, end: 3 },
    { label: '自己来', detail: 'Output', view: 'attempt', start: 4, end: 4 },
    { label: '反馈与修正', detail: 'Repair', view: 'feedback', start: 5, end: 6 },
    { label: '证据', detail: 'Evidence', view: 'evidence', start: 7, end: 7 },
  ]
  return (
    <aside className="timeline-rail">
      <span className="utility-label">Agent Memory · 本次轨迹</span>
      {stages.map(stage => {
        const status = currentIndex > stage.end ? 'done' : currentIndex >= stage.start ? 'current' : 'future'
        return (
          <button
            key={stage.label}
            className={`timeline-point ${status}`}
            disabled={status === 'future'}
            onClick={() => onOpenView(stage.view)}
          >
            <i>{status === 'done' ? <Check size={13} /> : null}</i>
            <span><strong>{stage.label}</strong><small>{stage.detail}</small></span>
          </button>
        )
      })}
      <div className="timeline-future">
        <Clock3 size={16} />
        <span><strong>两天后</strong><small>{state.completed ? '换一个场景再验证' : '完成后自动安排'}</small></span>
      </div>
    </aside>
  )
}

function ResumeRibbon(props: ShellProps) {
  return (
    <div className="resume-ribbon">
      <span><strong>{props.resumeMeta.eyebrow}</strong> · {props.resumeMeta.title}</span>
      <small>{props.resumeMeta.duration}</small>
      <button onClick={() => props.openView(props.resumeMeta.view)}>{props.resumeMeta.action} <ArrowRight size={15} /></button>
    </div>
  )
}

function ResumeDock(props: ShellProps) {
  if (props.state.view !== 'home' && JOURNEY_VIEWS.has(props.state.view)) {
    return (
      <div className="stage-dock">
        <span className="stage-dock-context"><Target size={16} /> Agent Memory</span>
        <JourneySteps compact state={props.state} />
        <button onClick={() => props.openView('home')}>退出并保存</button>
      </div>
    )
  }
  return (
    <div className="resume-dock">
      <span><small>{props.resumeMeta.eyebrow}</small><strong>{props.resumeMeta.title}</strong></span>
      <em>{props.resumeMeta.duration}</em>
      <button onClick={() => props.openView(props.resumeMeta.view)}>{props.resumeMeta.action} <ArrowRight size={16} /></button>
    </div>
  )
}

function CurrentView(props: ShellProps) {
  const common: ViewProps = {
    variant: props.variant,
    state: props.state,
    openView: props.openView,
    updateState: props.updateState,
    notify: props.notify,
  }

  switch (props.state.view) {
    case 'home': return <HomeView {...common} resumeMeta={props.resumeMeta} />
    case 'learn-overview': return <LearnOverview {...common} />
    case 'practice-overview': return <PracticeOverview {...common} />
    case 'project-overview': return <ProjectOverview {...common} />
    case 'sources-overview': return <SourcesOverview {...common} />
    case 'growth-overview': return <GrowthOverview {...common} />
    case 'learn-write': return <LearnWrite {...common} />
    case 'learn-recall': return <LearnRecall {...common} />
    case 'guided': return <GuidedPractice {...common} />
    case 'handoff': return <Handoff {...common} />
    case 'attempt': return <IndependentAttempt {...common} />
    case 'feedback': return <Feedback {...common} />
    case 'repair': return <Repair {...common} />
    case 'evidence': return <Evidence {...common} />
  }
}

type ViewProps = {
  variant: VariantKey
  state: AppState
  openView: (view: View) => void
  updateState: (patch: Partial<AppState>) => void
  notify: (message: string) => void
}

function PageHeading({ eyebrow, title, description, trailing }: { eyebrow: string; title: string; description: string; trailing?: React.ReactNode }) {
  return (
    <div className="page-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {trailing}
    </div>
  )
}

function HomeView(props: ViewProps & { resumeMeta: ReturnType<typeof getResumeMeta> }) {
  if (props.variant === 'B') return <TimelineHome {...props} />
  if (props.variant === 'C') return <MapHome {...props} />
  return <WorkbenchHome {...props} />
}

function WorkbenchHome(props: ViewProps & { resumeMeta: ReturnType<typeof getResumeMeta> }) {
  return (
    <div className="page home-page workbench-home">
      <PageHeading eyebrow="8 月 26 日 · 星期三" title="欢迎回来，接着上次的位置" description="首页只负责恢复现场和安排下一步；所有功能仍然可以从左侧直接进入。" />
      <section className="resume-card">
        <div className="resume-card-copy">
          <span className="eyebrow">{props.resumeMeta.eyebrow}</span>
          <h2>{props.resumeMeta.title}</h2>
          <p>{props.resumeMeta.description}</p>
          <div className="resume-meta"><span><BookOpen size={15} /> Agent Memory</span><span><Clock3 size={15} /> {props.resumeMeta.duration}</span></div>
          <button className="primary-button" onClick={() => props.openView(props.resumeMeta.view)}>{props.resumeMeta.action} <ArrowRight size={17} /></button>
        </div>
        <MemorySketch mode={props.state.completed ? 'complete' : 'preview'} />
      </section>
      <div className="home-lower-grid">
        <section className="today-task">
          <span className="utility-label">今天值得做</span>
          <div className="task-row">
            <span className="task-icon guide"><BrainCircuit size={18} /></span>
            <span><strong>70 秒唤醒：Context 与 Memory</strong><small>两天前学过，现在回想最划算</small></span>
            <button onClick={() => props.openView('practice-overview')}>稍后做 <ChevronRight size={15} /></button>
          </div>
        </section>
        <section className="project-glance">
          <span className="utility-label">进行中的项目</span>
          <h3>客服 Agent Memory 方案</h3>
          <p>3 / 5 个决策已有依据</p>
          <button className="quiet-link" onClick={() => props.openView('project-overview')}>打开项目 <ArrowRight size={15} /></button>
        </section>
      </div>
    </div>
  )
}

function TimelineHome(props: ViewProps & { resumeMeta: ReturnType<typeof getResumeMeta> }) {
  return (
    <div className="page home-page timeline-home">
      <PageHeading eyebrow="今天 · 学习轨迹" title="从刚才停下的地方继续" description="过去收拢成摘要，现在只展开眼前这一件事。" />
      <div className="day-timeline">
        <div className="day-event past">
          <time>上次</time><i><Check size={13} /></i>
          <div><span>已经完成</span><h3>Context 与 Persistent Memory</h3><p>建立了两者的基本差别。</p></div>
        </div>
        <div className="day-event current">
          <time>现在</time><i />
          <div className="current-event-card">
            <span>{props.resumeMeta.eyebrow}</span>
            <h2>{props.resumeMeta.title}</h2>
            <p>{props.resumeMeta.description}</p>
            <button className="primary-button" onClick={() => props.openView(props.resumeMeta.view)}>{props.resumeMeta.action} <ArrowRight size={17} /></button>
          </div>
        </div>
        <div className="day-event future">
          <time>稍后</time><i />
          <div><span>你可以自己选择</span><div className="choice-links"><button onClick={() => props.openView('practice-overview')}>自由练习</button><button onClick={() => props.openView('sources-overview')}>查看资料</button><button onClick={() => props.openView('project-overview')}>继续项目</button></div></div>
        </div>
      </div>
    </div>
  )
}

function MapHome(props: ViewProps & { resumeMeta: ReturnType<typeof getResumeMeta> }) {
  return (
    <div className="page home-page map-home">
      <PageHeading eyebrow="Agent Memory · 能力地图" title="你在这里" description="地图显示长期位置，底部 Dock 永远带你回到准确断点。" />
      <div className="capability-map" aria-label="Agent Memory 能力地图">
        <svg viewBox="0 0 840 400" role="img" aria-label="能力节点之间的路径">
          <path d="M120 205 C210 205 230 110 330 110 S470 205 560 205 S650 300 745 300" />
          <path className="secondary-path" d="M330 110 C365 205 365 285 445 300" />
        </svg>
        <button className="map-node done node-context" onClick={() => props.notify('这项能力已有一次延迟验证')}><Check size={16} /><span>Context</span><small>延迟后仍能完成</small></button>
        <button className="map-node active node-lifecycle" onClick={() => props.openView(props.resumeMeta.view)}><span className="pulse-dot" /><span>Memory Lifecycle</span><small>继续：写入与召回</small></button>
        <button className="map-node future node-retrieval" onClick={() => props.notify('建议先完成 Memory Lifecycle，仍可直接进入')}><span>Retrieval</span><small>尚未学习</small></button>
        <button className="map-node future node-conflict" onClick={() => props.notify('Conflict & Forgetting 尚未学习')}><span>Conflict & Forgetting</span><small>尚未学习</small></button>
        <button className="map-node supported node-project" onClick={() => props.openView('project-overview')}><Layers3 size={16} /><span>完整架构设计</span><small>在项目中形成</small></button>
      </div>
    </div>
  )
}

function LearnOverview(props: ViewProps) {
  return (
    <div className="page overview-page">
      <PageHeading eyebrow="学习 · 理解新知识" title="继续建立 Agent Memory 心智模型" description="教学、示例与互动探索都在这里；这一阶段用于理解，不测试。" trailing={<button className="secondary-button" onClick={() => props.notify('“开始新的学习”会进入目标创建流程')}>开始新的学习</button>} />
      <section className="overview-primary">
        <div><span className="eyebrow">继续学习 · 2 / 4</span><h2>写入与召回</h2><p>从“什么值得留下”走到“此刻该想起什么”。</p><button className="primary-button" onClick={() => props.openView(props.state.lastJourneyView.startsWith('learn') ? props.state.lastJourneyView : 'learn-write')}>继续当前学习 <ArrowRight size={16} /></button></div>
        <div className="path-preview"><span className="done">概览</span><span className="active">写入与召回</span><span>可靠性</span><span>设计实践</span></div>
      </section>
      <SectionTitle title="我的学习" action="查看全部" />
      <div className="simple-list">
        <button><span className="list-token reference">AM</span><span><strong>Agent Memory</strong><small>正在学习 · 2 / 4</small></span><ChevronRight size={17} /></button>
        <button><span className="list-token guide">DS</span><span><strong>分布式系统</strong><small>延迟验证中 · 3 项能力</small></span><ChevronRight size={17} /></button>
        <button><span className="list-token evidence">PD</span><span><strong>产品设计</strong><small>已有 2 条项目证据</small></span><ChevronRight size={17} /></button>
      </div>
    </div>
  )
}

function PracticeOverview(props: ViewProps) {
  const hasPracticeDraft = PRACTICE_VIEWS.has(props.state.lastJourneyView)
  return (
    <div className="page overview-page">
      <PageHeading eyebrow="练习 · 巩固与修正" title="把理解变成能独立完成" description="这里保存每次原始尝试、使用过的帮助与后续修正。" trailing={<button className="secondary-button" onClick={() => props.notify('可从主题、资料或题型创建练习')}>创建练习</button>} />
      {hasPracticeDraft && (
        <section className="draft-banner"><span><strong>有一项未完成</strong><small>{VIEW_LABELS[props.state.lastJourneyView]} · 草稿与提示状态已保存</small></span><button onClick={() => props.openView(props.state.lastJourneyView)}>继续 <ArrowRight size={15} /></button></section>
      )}
      <div className="practice-columns">
        <section><span className="utility-label">今天</span><h2>1 项短练习</h2><div className="practice-item"><Clock3 size={18} /><span><strong>Context 与 Memory · 快速回想</strong><small>约 70 秒 · 两天前学习</small></span><button onClick={() => props.notify('这项复习会用一个新情境重新提取')}>开始</button></div></section>
        <section><span className="utility-label">自由练习</span><div className="practice-modes"><button>闭卷解释</button><button>重新画图</button><button>案例分析</button><button>闪卡</button><button>快速测验</button><button>编码 / 操作</button></div></section>
      </div>
      <SectionTitle title="继续修正" action="历史记录" />
      <div className="simple-list"><button onClick={() => props.openView('feedback')}><span className="list-token repair">1</span><span><strong>召回后为什么不能直接使用？</strong><small>等待修正 · Agent Memory</small></span><ChevronRight size={17} /></button></div>
    </div>
  )
}

function ProjectOverview(props: ViewProps) {
  return (
    <div className="page overview-page">
      <PageHeading eyebrow="项目 · 用它做成一件事" title="把多项能力带进真实任务" description="项目是开放、有交付物的应用；练习是可重复的小环境。" trailing={<button className="secondary-button" onClick={() => props.notify('新建项目只会询问目标、完成条件和 AI 参与方式')}>新建项目</button>} />
      <section className="project-board">
        <div className="project-main"><span className="eyebrow">进行中 · 真实项目</span><h2>为客服 Agent 设计 Memory 系统</h2><p>完成条件：给出写入、检索、冲突与遗忘策略，并解释每项权衡。</p><div className="project-progress"><i style={{ width: '60%' }} /><span>3 / 5 个关键决策已有依据</span></div><button className="primary-button" onClick={() => props.notify('项目原型暂未展开；本轮重点验证学习闭环')}>打开项目 <ArrowRight size={16} /></button></div>
        <div className="ai-role"><span className="utility-label">AI 当前身份</span><strong>教练</strong><p>只提问和给提示，不直接完成方案。</p><button className="quiet-link" onClick={() => props.notify('可切换教练、搭档、审查者或模拟角色')}>更改参与方式</button></div>
      </section>
    </div>
  )
}

function SourcesOverview(props: ViewProps) {
  return (
    <div className="page overview-page">
      <PageHeading eyebrow="资料 · 管理来源" title="所有输入都有明确去处" description="资料可以用来学习、生成练习或支持项目，但不会自动变成待办。" trailing={<button className="secondary-button" onClick={() => props.notify('可以上传 PDF、网页、视频、音频与笔记')}>放入资料</button>} />
      <div className="source-summary"><span><strong>6</strong><small>用于当前学习</small></span><span><strong>3</strong><small>观点存在分歧</small></span><span><strong>4</strong><small>稍后处理</small></span></div>
      <div className="source-table">
        <div className="source-table-head"><span>来源</span><span>用于</span><span>状态</span><span /></div>
        {[
          ['MemGPT: Towards LLMs as Operating Systems', 'Agent Memory', '已核验'],
          ['LongMemEval benchmark', '召回与可靠性', '有 2 条引用'],
          ['客服 Agent Memory 访谈笔记', '项目', '我的笔记'],
        ].map(([title, usedFor, status]) => (
          <button key={title} onClick={() => props.notify('资料详情提供：用它学习 / 生成练习 / 用于项目 / 问这份资料')}><FileText size={18} /><span><strong>{title}</strong><small>最近查看</small></span><span>{usedFor}</span><em>{status}</em><MoreHorizontal size={17} /></button>
        ))}
      </div>
    </div>
  )
}

function GrowthOverview(props: ViewProps) {
  return (
    <div className="page overview-page">
      <PageHeading eyebrow="成长 · 查看能力证据" title="系统凭什么说你变强了" description="不显示模糊掌握度；每个结论都能回到原始尝试、帮助与修正。" />
      <section className="capability-evidence-card">
        <div><span className="eyebrow">Agent Memory</span><h2>写入与召回</h2><p>{props.state.completed ? '你已经在客服 Agent 场景中当场独立完成。' : '你已在支架下完成，正在等待一次独立输出。'}</p></div>
        <span className={`state-badge ${props.state.completed ? 'evidence' : 'guide'}`}>{props.state.completed ? '当前独立完成' : '在支架下完成'}</span>
        <button className="quiet-link" onClick={() => props.openView(props.state.completed ? 'evidence' : props.state.lastJourneyView)}>查看依据 <ArrowRight size={15} /></button>
      </section>
      <div className="evidence-lanes">
        <section><span className="utility-label">已经有证据</span><EvidenceRow status="done" title="区分 Context 与 Persistent Memory" detail="两天后仍能解释 · 无提示" /><EvidenceRow status={props.state.completed ? 'done' : 'current'} title="组合 Memory Lifecycle" detail={props.state.completed ? '客服 Agent 场景 · 修正后独立完成' : '当前正在形成'} /></section>
        <section><span className="utility-label">还需要验证</span><EvidenceRow status="future" title="隔一段时间后仍能完成" detail="预计两天后" /><EvidenceRow status="future" title="迁移到另一个 Agent 场景" detail="尚未安排" /></section>
      </div>
    </div>
  )
}

function SectionTitle({ title, action }: { title: string; action: string }) {
  return <div className="section-title"><h2>{title}</h2><button>{action} <ChevronRight size={15} /></button></div>
}

function JourneyHeader({ state, label, note, onBack }: { state: AppState; label: string; note: string; onBack: () => void }) {
  return (
    <div className="journey-header">
      <div><button className="back-label" onClick={onBack}><ArrowLeft size={15} /> Agent Memory</button><h1>{label}</h1><p>{note}</p></div>
      <JourneySteps state={state} />
    </div>
  )
}

function JourneySteps({ state, compact = false }: { state: AppState; compact?: boolean }) {
  const active = VIEW_TO_NAV[state.view]
  const items = [
    { key: 'learn', label: '学习' },
    { key: 'practice', label: '练习' },
    { key: 'growth', label: '成长' },
  ]
  return (
    <div className={`journey-steps${compact ? ' compact' : ''}`} aria-label="当前阶段">
      {items.map((item, index) => (
        <React.Fragment key={item.key}>
          <span className={active === item.key ? 'active' : (active === 'growth' || (active === 'practice' && item.key === 'learn')) ? 'done' : ''}>
            <i>{active === 'growth' || (active === 'practice' && item.key === 'learn') ? <Check size={11} /> : index + 1}</i>{item.label}
          </span>
          {index < items.length - 1 && <b />}
        </React.Fragment>
      ))}
    </div>
  )
}

function LearnWrite(props: ViewProps) {
  return (
    <div className="page journey-page learn-page">
      <JourneyHeader state={props.state} label="写入决定：什么值得留下" note="Learn · 1 / 2 · 这一阶段用于理解，不测试" onBack={() => props.openView('learn-overview')} />
      <div className="lesson-layout">
        <article className="lesson-copy">
          <span className="scene-label">用户说</span>
          <blockquote>“以后安排会议时，尽量避开上午。”</blockquote>
          <p>这句话进入了当前 <strong>Context</strong>，但它不会自动成为长期记忆。</p>
          <p>系统要先回答两个问题：</p>
          <ul className="lesson-questions"><li>它对未来仍有价值吗？</li><li>它适合长期保存吗？</li></ul>
          <div className="lesson-key"><span>写入不是“保存出现过的内容”</span><strong>写入是判断什么值得未来再用。</strong></div>
          <div className="lesson-actions"><button className="primary-button" onClick={() => props.openView('learn-recall')}>看看它怎样被重新想起 <ArrowRight size={17} /></button><button className="quiet-link" onClick={() => props.notify('AI 会换一个生活类例子解释，但不会记录为练习')}>换个例子</button></div>
        </article>
        <MemoryFlow nodes={['当前对话', '写入判断', '长期记忆']} activeIndex={1} />
      </div>
    </div>
  )
}

function LearnRecall(props: ViewProps) {
  return (
    <div className="page journey-page learn-page">
      <JourneyHeader state={props.state} label="召回决定：此刻该想起什么" note="Learn · 2 / 2 · 这一阶段用于理解，不测试" onBack={() => props.openView('learn-overview')} />
      <div className="lesson-layout recall-layout">
        <article className="lesson-copy">
          <span className="scene-label">第二天 · 新会话</span>
          <blockquote>“帮我安排下周的会议。”</blockquote>
          <p>长期记忆里有很多内容。系统先找出可能相关的记忆，再判断它是否适用于眼前情境。</p>
          <div className="dual-definition"><div><small>WRITE</small><strong>写入</strong><p>什么值得留下</p></div><div><small>RECALL</small><strong>召回</strong><p>此刻该想起什么</p></div></div>
          <div className="stage-transition"><span><Check size={16} /> 你已经建立了初步模型</span><p>接下来进入练习：先在支架下补全一次，再由你独立完成。</p><div><button className="primary-button" onClick={() => props.openView('guided')}>进入练习 <ArrowRight size={17} /></button><button className="secondary-button" onClick={() => props.notify('你可以继续停留在学习阶段，不会被自动切走')}>继续学习</button><button className="quiet-link" onClick={() => props.openView('home')}>今天到这里</button></div></div>
        </article>
        <MemoryFlow nodes={['当前任务', '召回相关记忆', '使用判断', '当前回答']} activeIndex={1} />
      </div>
    </div>
  )
}

function GuidedPractice(props: ViewProps) {
  const options = ['写入判断', '内容总结', '模型调用']
  return (
    <div className="page journey-page practice-page">
      <JourneyHeader state={props.state} label="先在支架下练一次" note="Guide · 有参考 · 这一步不算独立完成" onBack={() => props.openView('practice-overview')} />
      <div className="guided-layout">
        <section className="guided-task">
          <span className="scene-label">补全结构</span>
          <h2>什么应该放在“当前对话”和“长期记忆”之间？</h2>
          <div className="gap-flow"><span>当前对话</span><i /><strong className={props.state.guidedChoice === '写入判断' ? 'correct' : props.state.guidedChoice ? 'wrong' : ''}>{props.state.guidedChoice ?? '选择一个模块'}</strong><i /><span>长期记忆</span></div>
          <div className="choice-row">
            {options.map(option => <button key={option} className={props.state.guidedChoice === option ? 'selected' : ''} onClick={() => props.updateState({ guidedChoice: option })}>{option}</button>)}
          </div>
          {props.state.guidedChoice && (
            <div className={props.state.guidedChoice === '写入判断' ? 'inline-feedback correct' : 'inline-feedback try-again'}>
              {props.state.guidedChoice === '写入判断' ? <><Check size={18} /><span><strong>对。</strong> 如果没有写入判断，“出现过的信息”就会被误当成“值得长期保存的信息”。</span></> : <><CircleHelp size={18} /><span><strong>再想一下。</strong> 总结能压缩内容，却不能判断它是否值得未来使用。</span></>}
            </div>
          )}
        </section>
        <aside className="reference-panel"><span className="reference-badge">AI 参考</span><h3>刚才学过的结构</h3><MemoryFlow nodes={['当前对话', '写入判断', '长期记忆', '召回', '使用判断', '当前回答']} activeIndex={1} compact /><p>蓝色表示参考内容。下一步由你决定是否收起。</p></aside>
      </div>
      {props.state.guidedChoice === '写入判断' && <div className="handoff-callout"><span><strong>刚才是补全结构。</strong><small>现在撤掉支架，由你独立完成一次。</small></span><button className="primary-button" onClick={() => props.openView('handoff')}>自己来一次 <ArrowRight size={17} /></button></div>}
    </div>
  )
}

function Handoff(props: ViewProps) {
  const [fading, setFading] = useState(false)
  const begin = (withReference: boolean) => {
    props.updateState({ sourcePeeked: withReference })
    if (withReference) {
      props.openView('attempt')
      return
    }
    setFading(true)
    window.setTimeout(() => props.openView('attempt'), 620)
  }
  return (
    <div className={`page journey-page handoff-page${fading ? ' fading' : ''}`}>
      <JourneyHeader state={props.state} label="现在换你来" note="从有参考完成，切换到独立输出" onBack={() => props.openView('practice-overview')} />
      <div className="handoff-stage">
        <div className="reference-ink"><span>AI 参考</span><MemoryFlow nodes={['会话', '写入判断', '长期记忆', '召回', '使用判断', '回答']} activeIndex={3} compact /></div>
        <div className="handoff-copy"><span className="eyebrow">交棒画布</span><h2>参考会收起，你留下自己的结构</h2><p>你仍然可以随时看一眼资料。系统会诚实记录“使用过支架”，不会惩罚你。</p><div><button className="primary-button" onClick={() => begin(false)}>收起参考，开始 <ArrowRight size={17} /></button><button className="secondary-button" onClick={() => begin(true)}>带着参考开始</button><button className="quiet-link" onClick={() => props.openView('home')}>今天到这里</button></div></div>
      </div>
    </div>
  )
}

function IndependentAttempt(props: ViewProps) {
  return (
    <div className="page journey-page attempt-page">
      <JourneyHeader state={props.state} label="为客服 Agent 设计最小 Memory Lifecycle" note={`Independent Output · ${props.state.hintUsed || props.state.sourcePeeked ? '使用过支架' : '资料已收起'}`} onBack={() => props.openView('practice-overview')} />
      <div className="attempt-layout">
        <section className="attempt-canvas">
          <div className="attempt-prompt"><span className="scene-label">你的方案需要说明</span><ol><li>什么信息进入长期记忆</li><li>新会话怎样找到相关记忆</li><li>找到后如何决定是否使用</li></ol></div>
          <label className="draft-field"><span>你的方案 <em>草稿会保留</em></span><textarea value={props.state.draft} onChange={event => props.updateState({ draft: event.target.value })} rows={8} /></label>
          {props.state.hintUsed && <div className="hint-card"><Sparkles size={17} /><span><strong>一点线索</strong>：召回只说明“可能相关”，再想想过期或冲突的记忆。</span></div>}
          {props.state.sourcePeeked && <div className="peek-card"><BookOpen size={17} />你看过一次参考结构；这次仍可完成，但证据会标记为“使用过支架”。</div>}
          <div className="attempt-actions"><button className="primary-button" disabled={!props.state.draft.trim()} onClick={() => props.openView('feedback')}>这是我的方案 <Send size={16} /></button><button className="secondary-button" onClick={() => props.updateState({ hintUsed: true })}>给一点线索</button><button className="quiet-link" onClick={() => props.updateState({ sourcePeeked: true })}>看一眼资料</button></div>
        </section>
        <aside className="attempt-status"><span className="utility-label">这次尝试</span><div><i className="user-ink-dot" /><span><strong>你的内容</strong><small>黑色墨迹</small></span></div><div><i className="reference-dot" /><span><strong>AI 参考</strong><small>{props.state.sourcePeeked ? '已看过一次' : '已收起'}</small></span></div><div><i className="guide-dot" /><span><strong>帮助</strong><small>{props.state.hintUsed ? '使用 1 次线索' : '尚未使用'}</small></span></div><p>AI 生成内容不会被算作你的能力，只有你提交的 Attempt 才进入证据。</p></aside>
      </div>
    </div>
  )
}

function Feedback(props: ViewProps) {
  return (
    <div className="page journey-page feedback-page">
      <JourneyHeader state={props.state} label="回到你的方案上看差异" note="Feedback · 不打分 · 结论可以质疑" onBack={() => props.openView('practice-overview')} />
      <div className="feedback-summary"><span className="feedback-status">核心结构已经成立</span><h2>还缺一个关键判断</h2><p>不是“答案错了”，而是当前方案无法处理过期、冲突或不可信的记忆。</p></div>
      <div className="mirror-layout">
        <section className="user-model"><span className="model-label user">你的方案</span><div className="model-flow"><span>写入判断</span><ArrowRight size={17} /><span>长期记忆</span><ArrowRight size={17} /><span>召回</span><ArrowRight className="conflict-arrow" size={20} /><span>当前回答</span></div><p>{props.state.draft}</p></section>
        <section className="reference-model"><span className="model-label reference">参考结构 · 只显示差异</span><div className="model-flow ghost"><span>写入判断</span><ArrowRight size={17} /><span>长期记忆</span><ArrowRight size={17} /><span>召回</span><ArrowRight size={17} /><strong>使用判断</strong><ArrowRight size={17} /><span>当前回答</span></div><p>召回只证明“它可能相关”，不能证明“现在应该使用”。</p></section>
      </div>
      <div className="feedback-three">
        <div className="holds"><span><Check size={15} /> 已经成立</span><p>你明确区分了写入和召回。</p></div>
        <div className="missing"><span><Plus size={15} /> 这里缺一块</span><p>召回之后，还要判断时效、冲突与可信度。</p></div>
        <div className="conflict"><span><X size={15} /> 这里有风险</span><p>直接使用召回结果，会让旧偏好覆盖当前明确要求。</p></div>
      </div>
      <div className="feedback-actions"><button className="primary-button" onClick={() => props.openView('repair')}>修改我的方案 <ArrowRight size={17} /></button><button className="quiet-link" onClick={() => props.notify('你可以要求 AI 展示依据，或标记“我不同意”')}>我不同意这个反馈</button></div>
    </div>
  )
}

function Repair(props: ViewProps) {
  const appendRepair = () => {
    if (props.state.repairDraft.includes('使用判断')) return
    props.updateState({ repairDraft: `${props.state.repairDraft} 召回后先做使用判断，检查时效、冲突与可信度，再影响当前回答。` })
  }
  return (
    <div className="page journey-page repair-page">
      <JourneyHeader state={props.state} label="在原方案上修正" note="Repair · AI 指出缺口，但不会替你自动补上" onBack={() => props.openView('practice-overview')} />
      <div className="repair-layout">
        <section className="repair-editor"><label className="draft-field"><span>你的修正版</span><textarea rows={10} value={props.state.repairDraft} onChange={event => props.updateState({ repairDraft: event.target.value })} /></label><div className="repair-suggestion"><span className="repair-marker">缺失节点</span><strong>使用判断</strong><p>检查时效、冲突与可信度</p><button onClick={appendRepair}>把这个意思写进方案</button></div><button className="primary-button" disabled={!props.state.repairDraft.includes('使用判断')} onClick={() => { props.updateState({ completed: true }); props.openView('evidence') }}>重新提交 <Send size={16} /></button></section>
        <aside className="before-after"><span className="utility-label">认知差异</span><div><small>BEFORE</small><p>召回相关内容，然后使用。</p></div><ArrowRight size={18} /><div className="after"><small>AFTER</small><p>召回候选内容，经过使用判断，再决定是否影响回答。</p></div></aside>
      </div>
    </div>
  )
}

function Evidence(props: ViewProps) {
  const assistance = props.state.hintUsed || props.state.sourcePeeked
  return (
    <div className="page journey-page evidence-page">
      <JourneyHeader state={props.state} label="这次尝试证明了什么" note="Growth Evidence · 结论来自 Attempt 与 Repair，不来自阅读时长" onBack={() => props.openView('growth-overview')} />
      <div className="evidence-hero"><div className="evidence-seal"><Check size={26} /></div><div><span className="eyebrow">Agent Memory · 写入与召回</span><h2>从“在支架下完成”推进到“当场独立完成”</h2><p>你修正了“召回后直接使用”的缺口，并在客服 Agent 场景中组合出完整流程。</p></div></div>
      <div className="evidence-grid">
        <section><span className="utility-label">这次已经证明</span><EvidenceRow status="done" title="能区分写入与召回" detail="原始 Attempt 中已经成立" /><EvidenceRow status="done" title="能发现并修正使用判断缺口" detail="修正后重新提交" /><EvidenceRow status="done" title="能在客服 Agent 场景中组合流程" detail={assistance ? '使用过一次支架 · 修正后完成' : '无资料 · 无完整答案'} /></section>
        <section><span className="utility-label">还没有证明</span><EvidenceRow status="future" title="隔一段时间后仍能完成" detail="两天后再验证" /><EvidenceRow status="future" title="能迁移到另一个 Agent 场景" detail="将换成编程 Agent 场景" /></section>
      </div>
      <div className="evidence-source"><span><FileText size={17} /><strong>查看依据</strong></span><div><small>原始 Attempt</small><p>{props.state.draft}</p></div><div><small>Repair</small><p>{props.state.repairDraft}</p></div></div>
      <div className="evidence-actions"><button className="primary-button" onClick={() => { props.updateState({ completed: true }); props.openView('home') }}>完成，回到首页 <ArrowRight size={17} /></button><button className="secondary-button" onClick={() => props.openView('repair')}>查看我的方案</button></div>
    </div>
  )
}

function EvidenceRow({ status, title, detail }: { status: 'done' | 'current' | 'future'; title: string; detail: string }) {
  return <div className={`evidence-row ${status}`}><i>{status === 'done' ? <Check size={13} /> : null}</i><span><strong>{title}</strong><small>{detail}</small></span></div>
}

function MemoryFlow({ nodes, activeIndex, compact = false }: { nodes: string[]; activeIndex: number; compact?: boolean }) {
  return (
    <div className={`memory-flow${compact ? ' compact' : ''}`}>
      <span className="flow-caption">MEMORY LIFECYCLE</span>
      {nodes.map((node, index) => (
        <React.Fragment key={node}>
          <div className={index === activeIndex ? 'flow-node active' : index < activeIndex ? 'flow-node done' : 'flow-node'}><i>{String(index + 1).padStart(2, '0')}</i><strong>{node}</strong>{index === activeIndex && <small>当前</small>}</div>
          {index < nodes.length - 1 && <div className="flow-arrow"><span /></div>}
        </React.Fragment>
      ))}
    </div>
  )
}

function MemorySketch({ mode }: { mode: 'preview' | 'complete' }) {
  return (
    <div className={`memory-sketch ${mode}`} aria-hidden="true">
      <span className="sketch-label">{mode === 'complete' ? '你的模型' : '上次停在这里'}</span>
      <div className="sketch-line"><i /><b /><i /><b /><i /></div>
      <div className="sketch-cards"><span>写入</span><span>召回</span><span>{mode === 'complete' ? '使用判断' : '?'}</span></div>
      <small>{mode === 'complete' ? '修正后完整' : '这两个动作为什么要分开？'}</small>
    </div>
  )
}

function AiDrawer({ view, onClose, onNotify }: { view: View; onClose: () => void; onNotify: (message: string) => void }) {
  const [scope, setScope] = useState('当前页面')
  const [answer, setAnswer] = useState<string | null>(null)
  const context = VIEW_TO_NAV[view] === 'practice' ? 'Agent Memory › 当前练习' : VIEW_TO_NAV[view] === 'sources' ? '当前选中的资料' : VIEW_TO_NAV[view] === 'growth' ? 'Agent Memory › 能力证据' : 'Agent Memory › 写入与召回'
  return (
    <div className="drawer-backdrop" onMouseDown={event => event.currentTarget === event.target && onClose()}>
      <aside className="ai-drawer" role="dialog" aria-modal="true" aria-label="问 AI">
        <div className="drawer-header"><span><MessageCircleQuestion size={19} /><strong>问 AI</strong></span><button onClick={onClose} aria-label="关闭"><X size={19} /></button></div>
        <div className="ai-scope"><span className="utility-label">AI 正在基于</span><strong>{scope === '当前页面' ? context : scope}</strong><button onClick={() => setScope(scope === '当前页面' ? '全部资料' : '当前页面')}>更改范围</button></div>
        <div className="ai-modes"><button onClick={() => setAnswer('写入像门卫：决定什么能进入长期记忆；召回像图书管理员：决定眼前任务该取回什么。')}><span>换个说法</span><small>用更直白的类比</small></button><button onClick={() => setAnswer('例子：用户说“我对花生过敏”。写入时判断它值得长期保存；点餐时召回；使用前还要确认没有更新或冲突。')}><span>举个例子</span><small>换到生活场景</small></button><button onClick={() => setAnswer('我会先问你一个不计分的问题：写入和召回分别在解决哪个时间点的决策？')}><span>检查我的理解</span><small>先提问，不直接给答案</small></button></div>
        <div className="ai-conversation">{answer ? <div className="ai-answer"><span>AI</span><p>{answer}</p></div> : <div className="ai-empty"><Sparkles size={24} /><p>选择一种帮助方式，或直接提问。</p><small>在练习中默认先给线索；你仍可要求完整讲解。</small></div>}</div>
        <div className="ai-input"><textarea rows={3} placeholder="输入问题……" /><button onClick={() => onNotify('这是交互原型，未连接真实模型')} aria-label="发送"><Send size={17} /></button></div>
      </aside>
    </div>
  )
}

function SearchDialog({ onClose, onNavigate }: { onClose: () => void; onNavigate: (view: View) => void }) {
  const [query, setQuery] = useState('Memory')
  return (
    <div className="dialog-backdrop" onMouseDown={event => event.currentTarget === event.target && onClose()}>
      <div className="search-dialog" role="dialog" aria-modal="true" aria-label="搜索">
        <div className="search-input"><Search size={20} /><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="找资料、课程、练习、项目或证据" /><kbd>esc</kbd></div>
        <div className="search-results"><span className="utility-label">搜索已有内容 · “{query}”</span><button onClick={() => onNavigate('learn-overview')}><BookOpen size={18} /><span><small>学习</small><strong>Agent Memory · 写入与召回</strong></span><ChevronRight size={16} /></button><button onClick={() => onNavigate('sources-overview')}><FileText size={18} /><span><small>资料</small><strong>MemGPT: Towards LLMs as Operating Systems</strong></span><ChevronRight size={16} /></button><button onClick={() => onNavigate('feedback')}><BrainCircuit size={18} /><span><small>练习</small><strong>召回后为什么不能直接使用？</strong></span><ChevronRight size={16} /></button><button onClick={() => onNavigate('growth-overview')}><Growth size={18} /><span><small>成长证据</small><strong>Context 与 Persistent Memory</strong></span><ChevronRight size={16} /></button></div>
        <div className="search-footer">搜索只找已有内容。要综合和解释，请使用“问 AI”。</div>
      </div>
    </div>
  )
}

function AddDialog({ onClose, onChoose }: { onClose: () => void; onChoose: (view: View, message: string) => void }) {
  const options: { icon: IconComponent; title: string; note: string; view: View; message: string }[] = [
    { icon: FileText, title: '添加资料', note: 'PDF、网页、视频、音频', view: 'sources-overview', message: '原型：已打开资料入口' },
    { icon: BookOpen, title: '新建学习目标', note: '定义最后想做到什么', view: 'learn-overview', message: '原型：已打开学习目标入口' },
    { icon: BrainCircuit, title: '创建练习', note: '从主题或资料开始', view: 'practice-overview', message: '原型：已打开练习入口' },
    { icon: FolderKanban, title: '新建项目', note: '带入一个真实任务', view: 'project-overview', message: '原型：已打开项目入口' },
  ]
  return (
    <div className="dialog-backdrop" onMouseDown={event => event.currentTarget === event.target && onClose()}>
      <div className="add-dialog" role="dialog" aria-modal="true" aria-label="添加">
        <div className="dialog-title"><div><span className="eyebrow">添加</span><h2>创建一个明确的对象</h2></div><button onClick={onClose}><X size={19} /></button></div>
        <div className="add-options">{options.map(option => { const Icon = option.icon; return <button key={option.title} onClick={() => onChoose(option.view, option.message)}><Icon size={20} /><span><strong>{option.title}</strong><small>{option.note}</small></span><ChevronRight size={17} /></button> })}</div>
      </div>
    </div>
  )
}

function PrototypeSwitcher({ variant, state, onPrevious, onNext, onReset }: { variant: VariantKey; state: AppState; onPrevious: () => void; onNext: () => void; onReset: () => void }) {
  return (
    <div className="prototype-switcher" aria-label="原型方案切换器">
      <button onClick={onPrevious} aria-label="上一个方案"><ArrowLeft size={16} /></button>
      <div><span>{variant} · {VARIANTS[variant].name}</span><small>{VARIANTS[variant].note} · 当前：{VIEW_LABELS[state.view]}</small></div>
      <button onClick={onNext} aria-label="下一个方案"><ArrowRight size={16} /></button>
      <i />
      <button onClick={onReset} aria-label="重置体验"><RotateCcw size={15} /></button>
    </div>
  )
}

const root = ReactDOM.createRoot(document.getElementById('root')!)

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

if (import.meta.hot) {
  import.meta.hot.dispose(() => root.unmount())
}
