import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowDownToLine, ArrowRight, Bell, Check, CheckCheck, ChevronRight, Clock3, Download, Film, HardDrive, Layers3, LayoutDashboard, Pause, Play, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, Trash2, TriangleAlert, X } from 'lucide-react';
import './optimization.css';
import PlayerReview from './PlayerReview';
type Variant = 'A' | 'B' | 'C';
type Page = 'tasks' | 'collection' | 'subscriptions' | 'storage' | 'library' | 'settings';
type Status = '下载中' | '已暂停' | '等待重试' | '需要处理' | '附件待补' | '已完成' | '等待中';
type Task = { id: string; title: string; cover: string; status: Status; progress: number; path?: string; error?: string; seconds?: number; attempts?: number };
type Preferences = { retries: number; threshold: number; policy: '严格完整' | '媒体优先' };
const covers = ['mountain', 'city', 'sky', 'tech'];
const media = [
  { title: '在阿尔卑斯山，等一场日出', author: '山野之间', duration: '18:42', cover: 'mountain' },
  { title: '东京漫步，把日常拍成电影', author: '散步记录员', duration: '24:50', cover: 'city' },
  { title: '抬头之后，一整夜的银河', author: '星空来信', duration: '12:08', cover: 'sky' },
  { title: '我的家庭服务器搭建手记', author: '不只是数码', duration: '32:16', cover: 'tech' },
];
const initialTasks: Task[] = [
  { id: 't1', title: media[0].title, cover: 'mountain', status: '下载中', progress: 68 },
  { id: 't2', title: media[1].title, cover: 'city', status: '已暂停', progress: 42 },
  { id: 't3', title: '星空摄影 · 延时拍摄入门', cover: 'sky', status: '等待重试', progress: 21, error: '网络超时', seconds: 45, attempts: 0 },
  { id: 't4', title: '桌面改造 · 开发板的可能性', cover: 'tech', status: '等待重试', progress: 12, error: '上游限流 429', seconds: 90, attempts: 0 },
  { id: 't5', title: '会员课堂 · 光影的语言', cover: 'city', status: '需要处理', progress: 0, error: '登录或权限失效' },
  { id: 't6', title: media[2].title, cover: 'sky', status: '附件待补', progress: 100 },
];
const collection = Array.from({ length: 250 }, (_, i) => ({ id: `c${i + 1}`, title: `影像手记 ${String(i + 1).padStart(3, '0')} · ${['山野旅行', '城市漫步', '星空摄影', '数码生活'][i % 4]}`, cover: covers[i % 4] }));
const nav = [
  { id: 'tasks', label: '任务', icon: Download, description: '让每一份收藏，稳稳抵达。' },
  { id: 'collection', label: '大合集', icon: Layers3, description: '先选喜欢的，再解析需要的。' },
  { id: 'subscriptions', label: '订阅', icon: Bell, description: '喜欢的创作者，更新时再相见。' },
  { id: 'storage', label: '空间', icon: HardDrive, description: '看清每块磁盘，再为新收藏腾出位置。' },
  { id: 'library', label: '媒体库', icon: Film, description: '把时间留给值得重看的片刻。' },
  { id: 'settings', label: '偏好设置', icon: Settings2, description: '用适合自己的方式，照料收藏。' },
] as const;
const variants = { A: ['轻盈队列', '顶部导航 · 紧凑表格'], B: ['运维工作台', '全局概览 · 待处理卡片'], C: ['私人放映室', '侧边导航 · 封面优先'] };
const initialVariant = (): Variant => { const v = new URLSearchParams(location.search).get('variant'); return v === 'A' || v === 'B' ? v : 'C'; };
const toggle = <T,>(values: T[], value: T) => values.includes(value) ? values.filter(v => v !== value) : [...values, value];
function Button({ children, onClick, disabled = false, primary = false, className = '' }: { children: ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean; className?: string }) {
  return <button className={`button ${primary ? 'primary' : ''} ${className}`} onClick={onClick} disabled={disabled}>{children}</button>;
}
function Badge({ children, warning = false }: { children: ReactNode; warning?: boolean }) { return <span className={`badge ${warning ? 'warning' : ''}`}>{children}</span>; }
function Cover({ name, className = '' }: { name: string; className?: string }) { return <img className={`cover ${className}`} src={`/covers/${name}.jpg`} alt="" />; }
function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    ref.current?.showModal(); document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  return <dialog ref={ref} className="dialog" aria-modal="true" aria-labelledby="dialog-title" onCancel={e => { e.preventDefault(); onClose(); }} onKeyDown={e => {
    if (e.key !== 'Tab') return;
    const nodes = e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)');
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }}>
    <header className="dialog-heading">
      <h2 id="dialog-title">{title}</h2>
      <button className="button" onClick={onClose}>
      <X size={16} />关闭</button>
      </header>{children}
  </dialog>;
}
function Optimization() {
  const [variant, setVariant] = useState<Variant>(initialVariant);
  const [page, setPage] = useState<Page>(() => initialVariant() === 'C' ? 'library' : 'tasks');
  const [tasks, setTasks] = useState(initialTasks);
  const [selectedTasks, setSelectedTasks] = useState<string[]>([]);
  const [taskFilter, setTaskFilter] = useState('全部');
  const [taskSearch, setTaskSearch] = useState('');
  const [taskPage, setTaskPage] = useState(1);
  const [query, setQuery] = useState('');
  const [loaded, setLoaded] = useState(50);
  const [selected, setSelected] = useState<string[]>([]);
  const [parsed, setParsed] = useState<string[]>([]);
  const [queued, setQueued] = useState<string[]>([]);
  const [subscriptions, setSubscriptions] = useState([
    { id: 1, title: '山野之间 · 旅行影像', cover: 'mountain', enabled: true, mode: '只提示新内容', checks: 0, pending: 0 },
    { id: 2, title: '不只是数码 · 家庭实验室', cover: 'tech', enabled: false, mode: '只提示新内容', checks: 0, pending: 0 },
  ]);
  const [free, setFree] = useState([3.2, 286]);
  const [cleanup, setCleanup] = useState<string[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [watched, setWatched] = useState<number[]>([]);
  const [watchProgress, setWatchProgress] = useState([38, 0, 0, 0]);
  const [player, setPlayer] = useState(0);
  const [preferences, setPreferences] = useState<Preferences>({ retries: 3, threshold: 5, policy: '严格完整' });
  const [draft, setDraft] = useState(preferences);
  const [modal, setModal] = useState<'queue' | 'cleanup' | 'player' | null>(() => new URLSearchParams(location.search).get('watch') === '1' ? 'player' : null);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(''), 6000);
    return () => window.clearTimeout(timer);
  }, [message]);
  const cleanupItems = [
    { id: 'cache', title: '过期临时片段', path: '/downloads/.temp/demo', size: 8.4, disk: 0 },
    { id: 'old', title: '已看完的演示副本', path: '/downloads/archive/demo', size: 12.6, disk: 0 },
    { id: 'backup', title: '重复的封面缓存', path: '/media/cache/demo', size: 1.2, disk: 1 },
  ];
  useEffect(() => {
    const timer = window.setInterval(() => setTasks(current => current.map(t => {
      if (t.status !== '等待重试' || t.seconds === undefined) return t;
      if (preferences.retries <= (t.attempts ?? 0)) return { ...t, status: '需要处理', seconds: undefined };
      if (t.seconds > 1) return { ...t, seconds: t.seconds - 1 };
      return { ...t, status: '下载中', error: undefined, seconds: undefined, attempts: (t.attempts ?? 0) + 1 };
    })), 1000);
    return () => clearInterval(timer);
  }, [preferences.retries]);
  function changeVariant(v: Variant) {
    setVariant(v); const url = new URL(location.href); url.searchParams.set('variant', v); history.replaceState(null, '', url);
    setMessage(`已切换方案 ${v} · ${variants[v][0]}，当前页面和操作状态已保留。`);
  }
  function updateTasks(ids: string[], action: 'pause' | 'resume' | 'retry' | 'attach') {
    setTasks(current => current.map(t => {
      if (!ids.includes(t.id)) return t;
      if (action === 'pause' && ['下载中', '等待中', '等待重试'].includes(t.status)) return { ...t, status: '已暂停', seconds: undefined };
      if (action === 'resume' && t.status === '已暂停') return { ...t, status: '下载中', error: undefined };
      if (action === 'retry' && ['等待重试', '需要处理'].includes(t.status)) return { ...t, status: '下载中', error: undefined, seconds: undefined, attempts: (t.attempts ?? 0) + 1 };
      if (action === 'attach' && t.status === '附件待补') return { ...t, status: '已完成' };
      return t;
    }));
    setMessage(action === 'attach' ? '演示附件已补齐，媒体文件保持不变。' : '演示任务状态已更新；重试按条件已恢复模拟，不发起真实请求。');
  }
  function addTasks(items: { id: string; title: string; cover: string }[]) {
    setTasks(current => [...items.filter(item => !current.some(t => t.id === item.id)).map(item => ({ ...item, path: '/media', status: '等待中' as Status, progress: 0 })), ...current]);
  }
  function checkSubscription(id: number) {
    const sub = subscriptions.find(s => s.id === id)!;
    const automatic = sub.mode === '自动入队';
    const items = Array.from({ length: 2 }, (_, i) => ({ id: `sub${id}-${sub.checks + 1}-${i}`, title: `${sub.title} · 新内容 ${sub.checks * 2 + i + 1}`, cover: sub.cover }));
    if (automatic) addTasks(items);
    setSubscriptions(current => current.map(s => s.id === id ? { ...s, checks: s.checks + 1, pending: s.pending + (automatic ? 0 : 2) } : s));
    setMessage(automatic ? '模拟发现 2 条新内容，已加入 /media 所在磁盘的演示队列。' : '模拟发现 2 条新内容，仅提示，未加入队列。');
  }
  const needsAttention = tasks.filter(t => ['需要处理', '等待重试', '附件待补'].includes(t.status));
  const visibleTasks = tasks.filter(t => (taskFilter === '全部' || (taskFilter === '待处理' ? needsAttention.includes(t) : t.status === taskFilter)) && t.title.includes(taskSearch.trim()));
  const taskPages = Math.max(1, Math.ceil(visibleTasks.length / 10));
  const currentTaskPage = Math.min(taskPage, taskPages);
  const pageTasks = visibleTasks.slice((currentTaskPage - 1) * 10, currentTaskPage * 10);
  const matches = collection.filter(item => item.title.includes(query.trim()));
  const visibleCollection = matches.slice(0, loaded);
  const selectable = visibleCollection.filter(item => !queued.includes(item.id));
  const cleanSelected = cleanupItems.filter(item => cleanup.includes(item.id) && !removed.includes(item.id));
  const release = cleanSelected.reduce((sum, item) => sum + item.size, 0);
  const pageInfo = nav.find(item => item.id === page)!;
  const running = tasks.filter(t => t.status === '下载中').length;
  const canBatch = (statuses: Status[]) => tasks.some(t => selectedTasks.includes(t.id) && statuses.includes(t.status));
  const navigation = <nav className="navigation" aria-label="场景导航">{nav.map(({ id, label, icon: Icon }) => <button key={id} aria-current={page === id ? 'page' : undefined} className={page === id ? 'active' : ''} onClick={() => setPage(id)}>
    <Icon size={18} />
    <span>{label}</span>{id === 'tasks' && <em>{tasks.length}</em>}</button>)}</nav>;
  const metrics = <div className="metrics">
    <div>
      <span>
      <Download size={16} />进行中</span>
      <strong>{running}<small>个任务</small>
      </strong>
      <p>进度为演示快照</p>
      </div>
    <div>
      <span>
      <TriangleAlert size={16} />需要留意</span>
      <strong>{needsAttention.length}<small>个任务</small>
      </strong>
      <p>错误恢复与附件补齐</p>
      </div>
    <div>
      <span>
      <HardDrive size={16} />下载盘可用</span>
      <strong>{free[0].toFixed(1)}<small>GiB</small>
      </strong>
      <p>{free[0] < preferences.threshold ? '低于保留阈值 · 新任务等待空间' : '空间充足 · 可接收新任务'}</p>
      </div>
    <div>
      <span>
      <CheckCheck size={16} />个人媒体库</span>
      <strong>{media.length}<small>部影片</small>
      </strong>
      <p>{watched.length} 部已看 · 随时继续</p>
      </div>
  </div>;
  function taskActions(t: Task) {
    return <div className="actions">
      {['下载中', '等待中', '等待重试'].includes(t.status) && <Button onClick={() => updateTasks([t.id], 'pause')}>
        <Pause size={14} />{t.status === '等待重试' ? '取消等待' : '暂停'}</Button>}
      {t.status === '已暂停' && <Button onClick={() => updateTasks([t.id], 'resume')}>
        <Play size={14} />恢复</Button>}
      {['等待重试', '需要处理'].includes(t.status) && <Button onClick={() => updateTasks([t.id], 'retry')}>
        <RefreshCw size={14} />重试</Button>}
      {t.status === '附件待补' && <Button onClick={() => updateTasks([t.id], 'attach')}>
        <ArrowDownToLine size={14} />补下载附件</Button>}
      {t.status === '已完成' && <Badge>
        <Check size={13} />全部完成</Badge>}
    </div>;
  }
  function taskState(t: Task) {
    return <div className="task-state">
      <Badge warning={!!t.error || t.status === '附件待补'}>{t.status}</Badge>
      <small>{t.error ? `${t.error}${t.seconds !== undefined ? ` · ${t.seconds} 秒后自动重试` : ' · 请处理后重试'}` : t.status === '附件待补' ? `媒体已验证 · 字幕待补 · ${preferences.policy}` : t.status === '下载中' ? '演示下载 · 进度快照' : `已下载 ${t.progress}%`}</small>
      {t.attempts !== undefined && <small>已重试 {t.attempts} 次 / 自动上限 {preferences.retries} 次</small>}
      <progress aria-label={`${t.title} 下载进度`} value={t.progress} max={100} />
    </div>;
  }
  return <div className={`optimization variant-${variant}`}>
    <a className="skip-link" href="#main">跳到主要内容</a>
    <div className="proposal-bar">
      <div>
      <Sparkles size={17} />
      <strong>交互设计提案</strong>
      <span>同一份收藏，三种打开方式</span>
      </div>
      <Button onClick={() => location.reload()}>
      <RefreshCw size={14} />重置演示</Button>
      </div>
    <section className="variant-picker" aria-label="选择布局方案">{(['A', 'B', 'C'] as Variant[]).map(v => <button key={v} aria-pressed={variant === v} onClick={() => changeVariant(v)} className={variant === v ? 'selected' : ''}>
      <b>{v}</b>
      <span>
      <strong>{variants[v][0]}</strong>
      <small>{variants[v][1]}</small>
      </span>{variant === v && <Check size={18} />}</button>)}</section>
    <div className="demo-notice">
      <ShieldCheck size={15} />
      <span>本地交互演示 · 不连接后端 · 任务数据刷新复位，观看模式记在本浏览器。参数均为建议默认值。</span>
      </div>
    <div className="app-frame">
      <header className="app-header">
        <div className="brand">
        <span className="brand-icon">
        <ArrowDownToLine size={24} />
        </span>
        <strong>DownKyi <small>WEB / {variant}</small>
        </strong>
        </div>{variant !== 'C' && navigation}<span className="local-label">
        <i />本地演示空间</span>
        </header>
      {variant === 'C' && <aside className="library-sidebar">
        <span className="eyebrow">YOUR COLLECTION</span>{navigation}<div className="sidebar-note">
        <Film size={25} />
        <h3>收藏，是为了重逢。</h3>
        <p>4 部本地封面示例<br />观看记录仅保留于本次演示</p>
        <Button onClick={() => setPage(page === 'library' ? 'collection' : 'library')}>{page === 'library' ? '发现大合集' : '回到媒体库'}<ArrowRight size={14} />
        </Button>
        </div>
        </aside>}
      <main id="main" tabIndex={-1}>
        <div className="page-heading">
          <div>
          <span className="eyebrow">{variant === 'B' ? 'OPERATIONS / 工作台' : variant === 'C' ? 'CURATED / 私人收藏' : 'WORKSPACE / 我的下载空间'}</span>
          <h1>{page === 'tasks' ? (variant === 'B' ? '今日运行概览' : '下载任务') : pageInfo.label}<span className="heading-dot" aria-hidden="true">/</span>
          </h1>
          <p>{pageInfo.description}</p>
          </div>
          <Button primary onClick={() => setPage(page === 'collection' ? 'tasks' : 'collection')}>{page === 'collection' ? '查看下载任务' : '从合集添加'}<ArrowRight size={16} />
          </Button>
          </div>
        {(page === 'tasks' || variant === 'B') && metrics}
        <div className="workspace-grid">
          <div className="page-content">
          {page === 'tasks' && <section className="panel task-panel" aria-label="任务列表">
            <div className="panel-heading">
              <div>
              <h2>{variant === 'B' ? '任务调度' : '全部下载'}</h2>
              <p>媒体与附件分别显示，处理进度一目了然。</p>
              </div>
              <Badge>{tasks.length} 个任务</Badge>
              </div>
            <div className="toolbar">
              <div className="filters">{['全部', '下载中', '已暂停', '待处理'].map(filter => <button key={filter} aria-pressed={taskFilter === filter} className={taskFilter === filter ? 'active' : ''} onClick={() => { setTaskFilter(filter); setTaskPage(1); }}>{filter}</button>)}</div>
              <label className="search">
              <Search size={16} />
              <input aria-label="搜索任务" placeholder="搜索任务名称" value={taskSearch} onChange={e => { setTaskSearch(e.target.value); setTaskPage(1); }} />
              </label>
              </div>
            <div className="batch-bar">
              <label>
              <input type="checkbox" aria-label="全选当前页任务" checked={pageTasks.length > 0 && pageTasks.every(t => selectedTasks.includes(t.id))} onChange={e => setSelectedTasks(current => e.target.checked ? [...new Set([...current, ...pageTasks.map(t => t.id)])] : current.filter(id => !pageTasks.some(t => t.id === id)))} />选择当前页 · 已选 {selectedTasks.length} 项</label>
              <div className="actions">
              <Button disabled={!canBatch(['下载中', '等待中', '等待重试'])} onClick={() => updateTasks(selectedTasks, 'pause')}>批量暂停</Button>
              <Button disabled={!canBatch(['已暂停'])} onClick={() => updateTasks(selectedTasks, 'resume')}>批量恢复</Button>
              <Button disabled={!canBatch(['等待重试', '需要处理'])} onClick={() => updateTasks(selectedTasks, 'retry')}>批量重试</Button>
              </div>
              </div>
            {visibleTasks.length === 0 && <p className="empty">没有匹配的任务，试试其他名称或筛选。</p>}
            <div className={`task-list ${variant === 'A' ? 'compact' : 'cards'}`}>
              {variant === 'A' && <div className="table-heading">
                <span />
                <span>视频 / 内容</span>
                <span>状态与进度</span>
                <span>操作</span>
                </div>}
              {pageTasks.map(t => <article className="task" key={t.id} aria-label={`任务：${t.title}`}>
                <input type="checkbox" aria-label={`选择任务 ${t.title}`} checked={selectedTasks.includes(t.id)} onChange={() => setSelectedTasks(current => toggle(current, t.id))} />
                <div className="task-title">
                <Cover name={t.cover} />
                <div>
                <h3>{t.title}</h3>
                <small>1080P · MP4 · {t.path ?? '/downloads'}</small>
                </div>
                </div>{taskState(t)}{taskActions(t)}</article>)}
            </div>
              <div className="batch-bar" aria-label="任务分页">
              <span>共 {visibleTasks.length} 项 · 第 {currentTaskPage} / {taskPages} 页 · 每页 10 项（演示）</span>
              <div className="actions">
              <Button disabled={currentTaskPage === 1} onClick={() => setTaskPage(currentTaskPage - 1)}>上一页</Button>
              <Button disabled={currentTaskPage === taskPages} onClick={() => setTaskPage(currentTaskPage + 1)}>下一页</Button>
              </div>
              </div>
              <div className="panel-footer">
              <Clock3 size={14} />倒计时真实递减；归零后模拟恢复。登录问题需处理后手动重试。</div>
          </section>}
          {page === 'collection' && <section className="panel">
            <div className="collection-banner">
              <div>
              <span className="eyebrow">THE VISUAL JOURNAL</span>
              <h2>250 个值得收藏的瞬间</h2>
              <p>影像手记 · 本地生成的完整合集</p>
              <Badge>每批 50 条 · 仅解析所选</Badge>
              </div>
              <Cover name="mountain" />
              </div>
            <div className="toolbar">
              <label className="search">
              <Search size={17} />
              <input aria-label="搜索合集" placeholder="搜索全部 250 条，如 250、星空" value={query} onChange={e => { setQuery(e.target.value); setLoaded(50); }} />
              </label>
              <span className="muted">已显示 {visibleCollection.length} / {matches.length} 条{query && '匹配结果'} · 总计 250 条</span>
              </div>
            <div className="batch-bar">
              <label>
              <input type="checkbox" aria-label="全选已显示合集条目" checked={selectable.length > 0 && selectable.every(item => selected.includes(item.id))} onChange={e => setSelected(current => e.target.checked ? [...new Set([...current, ...selectable.map(item => item.id)])] : current.filter(id => !selectable.some(item => item.id === id)))} />选择已显示条目</label>
              <span>已选 {selected.length} · 已入队 {queued.length}</span>
              <Button primary disabled={!selected.length} onClick={() => { setParsed([...selected]); setModal('queue'); }}>仅解析所选（{selected.length}）</Button>
              <Button disabled={!selected.length} onClick={() => setSelected([])}>清空选择</Button>
              </div>
            <p className="inline-note">选择跨搜索与批次保留。解析为即时本地模拟，取消确认不会丢失选择。</p>
            <div className="collection-list">{visibleCollection.map(item => <label className={`collection-item ${selected.includes(item.id) ? 'chosen' : ''}`} key={item.id}>
              <input type="checkbox" aria-label={`选择 ${item.title}`} checked={selected.includes(item.id)} disabled={queued.includes(item.id)} onChange={() => setSelected(current => toggle(current, item.id))} />
              <Cover name={item.cover} />
              <span>
              <strong>{item.title}</strong>
              <small>12:08 · 1080P · {queued.includes(item.id) ? '已加入演示队列' : parsed.includes(item.id) ? '所选资源已解析' : '尚未解析资源'}</small>
              </span>{queued.includes(item.id) && <Check size={17} />}</label>)}</div>
            {!matches.length && <p className="empty">没有匹配内容，请调整搜索关键词。</p>}
            <div className="load-more">
              <Button disabled={visibleCollection.length >= matches.length} onClick={() => setLoaded(n => n + 50)}>{visibleCollection.length >= matches.length ? '已加载全部结果' : '加载下一批（50 条）'}</Button>
              <small>只为选中的内容解析资源</small>
              </div>
          </section>}

          {page === 'subscriptions' && <>
            <div className="info-banner">
            <Bell size={20} />
            <div>
            <strong>让更新轻轻提醒你</strong>
            <p>建议每 24 小时检查、默认只提示。此处用手动检查模拟，每次产生 2 条不同的新内容；历史内容不自动下载。</p>
            </div>
            </div>
            <div className="subscription-grid">{subscriptions.map(sub => <article className="panel subscription" key={sub.id}>
            <Cover name={sub.cover} />
            <div className="subscription-body">
            <div className="section-line">
            <Badge warning={!sub.enabled}>{sub.enabled ? '订阅已启用' : '订阅已暂停'}</Badge>
            <Button onClick={() => setSubscriptions(current => current.map(s => s.id === sub.id ? { ...s, enabled: !s.enabled } : s))}>{sub.enabled ? '暂停订阅' : '启用订阅'}</Button>
            </div>
            <h2>{sub.title}</h2>
            <p>最近检查：{sub.checks ? `本次演示第 ${sub.checks} 次检查` : '尚未检查'}<br />{sub.enabled ? '建议下次检查：24 小时后（无后台定时器）' : '已暂停检查'}</p>
            <label className="field">发现新内容时<select aria-label={`${sub.title} 处理模式`} value={sub.mode} onChange={e => setSubscriptions(current => current.map(s => s.id === sub.id ? { ...s, mode: e.target.value } : s))}>
            <option>只提示新内容</option>
            <option>自动入队</option>
            </select>
            </label>
            <div className="subscription-result">
            <strong>{sub.pending}</strong>
            <span>条新内容待查看</span>
            </div>
            <div className="actions">
            <Button primary disabled={!sub.enabled} onClick={() => checkSubscription(sub.id)}>
            <RefreshCw size={15} />手动检查</Button>
            <Button disabled={!sub.pending} onClick={() => { setSubscriptions(current => current.map(s => s.id === sub.id ? { ...s, pending: 0 } : s)); setMessage('新内容提醒已标记为已阅，未创建下载任务。'); }}>标记提醒已阅</Button>
            </div>
            <small className="muted">自动入队演示保存到空间充足的 /media。</small>
            </div>
            </article>)}</div>
            </>}

          {page === 'storage' && <>
            <div className={`info-banner ${free[0] < preferences.threshold ? 'caution' : ''}`}>
              <HardDrive size={21} />
              <div>
              <strong>{free[0] < preferences.threshold ? '下载盘空间偏低，新任务等待空间' : '下载盘空间已恢复，可接收新任务'}</strong>
              <p>建议保留 {preferences.threshold} GiB。两块独立文件系统分别统计；此处清理只更新演示数字。</p>
              </div>
              </div>
            <div className="disk-grid">{['下载盘', '媒体归档盘'].map((name, i) => <article className="panel disk" key={name}>
              <div className="section-line">
              <span className="disk-icon">
              <HardDrive size={23} />
              </span>
              <Badge warning={free[i] < preferences.threshold}>{free[i] < preferences.threshold ? '低空间' : '空间充足'}</Badge>
              </div>
              <h2>{name}</h2>
              <p>{i === 0 ? '/downloads · ext4 · /dev/sda1' : '/media · btrfs · /dev/sdb1'}</p>
              <strong className="disk-number">{free[i].toFixed(1)} <small>GiB 可用</small>
              </strong>
              <progress aria-label={`${name}已用空间`} value={(i === 0 ? 500 : 1000) - free[i]} max={i === 0 ? 500 : 1000} />
              <p>总容量 {i === 0 ? 500 : 1000} GiB · 本地模拟统计</p>
              </article>)}</div>
            <section className="panel">
              <div className="panel-heading">
              <div>
              <h2>有选择地腾出空间</h2>
              <p>先勾选对象，再核对路径与释放空间。</p>
              </div>
              <Trash2 size={20} />
              </div>{cleanupItems.map(item => <label className="cleanup-item" key={item.id}>
              <input type="checkbox" aria-label={`清理 ${item.title}`} disabled={removed.includes(item.id)} checked={cleanup.includes(item.id)} onChange={() => setCleanup(current => toggle(current, item.id))} />
              <span>
              <strong>{item.title}</strong>
              <small>{item.path}</small>
              </span>
              <b>{removed.includes(item.id) ? '已清理' : `${item.size} GiB`}</b>
              </label>)}<div className="batch-bar">
              <span>预计释放 <strong>{release.toFixed(1)} GiB</strong>
              </span>
              <Button primary disabled={!cleanSelected.length} onClick={() => { setConfirmed(false); setModal('cleanup'); }}>预览清理（{cleanSelected.length} 项）</Button>
              </div>
              </section>
          </>}

          {page === 'library' && <>
            <section className="watch-hero">
              <Cover name={media[player].cover} />
              <div className="watch-hero-content">
              <span className="eyebrow">A MOMENT WORTH KEEPING</span>
              <Badge>继续观看 · 第 {player + 1} 部</Badge>
              <h2>{media[player].title}</h2>
              <p>{media[player].author} · {watched.includes(player) ? '已看完' : `上次进度 ${watchProgress[player]}%`} · 1080P</p>
              <Button primary onClick={() => setModal('player')}>
              <Play size={17} />继续观看</Button>
              <small>播放器双方案预览 · 使用本地无声样片</small>
              </div>
              </section>
            <div className="section-line library-heading">
              <h2>我的片单 <span className="muted">04</span>
              </h2>
              <span className="muted">按片单顺序 · {watched.length} 部已看</span>
              </div>
              <div className="media-grid">{media.map((item, i) => <article className="media-card" key={item.title}>
              <button className="media-cover-button" aria-label={`打开播放器 ${item.title}`} onClick={() => { setPlayer(i); setModal('player'); }}>
              <Cover name={item.cover} />
              <span className="play-circle">
              <Play size={24} />
              </span>
              <span className="duration">{item.duration}</span>
              </button>
              <div className="media-body">
              <small>{item.author} / 1080P</small>
              <h3>{item.title}</h3>
              <progress aria-label={`${item.title} 观看进度`} value={watchProgress[i]} max={100} />
              <div className="section-line">
              <span className="muted">{watched.includes(i) ? '已看完' : watchProgress[i] ? `已看 ${watchProgress[i]}%` : '尚未观看'}</span>
              <button className="text-button" onClick={() => { setWatched(current => toggle(current, i)); setWatchProgress(current => current.map((value, n) => n === i ? (watched.includes(i) ? 0 : 100) : value)); }}>{watched.includes(i) ? '清除已看' : '标记已看'}</button>
              </div>
              </div>
              </article>)}</div>
          </>}

          {page === 'settings' && <section className="panel settings-panel">
            <div className="panel-heading">
            <div>
            <h2>让收藏按你的习惯运行</h2>
            <p>以下均为建议默认值，保存后仅在本次演示中生效。</p>
            </div>
            <Settings2 size={22} />
            </div>
            <form onSubmit={e => { e.preventDefault(); setPreferences({ ...draft }); setMessage('偏好设置已保存，仅当前演示有效。'); }}>
            <label className="setting-row">
              <span>
              <strong>自动重试次数</strong>
              <small>仅用于可恢复错误，建议 3 次；0 表示关闭。</small>
              </span>
              <input aria-label="自动重试次数" type="number" min={0} max={10} required value={draft.retries} onChange={e => setDraft(d => ({ ...d, retries: Number(e.target.value) }))} />
              </label>
            <label className="setting-row">
              <span>
              <strong>磁盘保留阈值（GiB）</strong>
              <small>建议 5 GiB；保存后更新空间页的低空间提示。</small>
              </span>
              <input aria-label="磁盘保留阈值（GiB）" type="number" min={1} max={100} step={1} required value={draft.threshold} onChange={e => setDraft(d => ({ ...d, threshold: Number(e.target.value) }))} />
              </label>
            <fieldset>
              <legend>附件完成策略</legend>
              <p className="muted">建议保持严格完整，也可以体验媒体优先。</p>{(['严格完整', '媒体优先'] as const).map(policy => <label key={policy} className={`policy ${draft.policy === policy ? 'chosen' : ''}`}>
              <input type="radio" name="policy" value={policy} checked={draft.policy === policy} onChange={() => setDraft(d => ({ ...d, policy }))} />
              <span>
              <strong>{policy}</strong>
              <small>{policy === '严格完整' ? '所选附件全部成功才算完成，媒体与附件进度分别显示。' : '媒体验证成功即可使用，附件失败继续显示待补。'}</small>
              </span>
              </label>)}</fieldset>
            <div className="settings-footer">
              <p>当前生效：{preferences.retries} 次重试 / {preferences.threshold} GiB / {preferences.policy}</p>
              <button type="submit" className="button primary">
              <Check size={16} />保存偏好设置</button>
              </div>
          </form>
            </section>}
        </div>
        {variant === 'B' && <aside className="attention-sidebar">
          <div className="panel">
          <div className="panel-heading">
          <h2>
          <LayoutDashboard size={18} />待处理</h2>
          <Badge warning>{needsAttention.length}</Badge>
          </div>
          <p>先处理阻塞，再放心离开。</p>
          <button className="attention-link" onClick={() => { setTaskFilter('待处理'); setTaskSearch(''); setPage('tasks'); }}>
          <TriangleAlert size={19} />
          <span>
          <strong>{needsAttention.length} 个任务需要留意</strong>
          <small>重试、权限与附件</small>
          </span>
          <ChevronRight size={16} />
          </button>
          <button className="attention-link" onClick={() => setPage('storage')}>
          <HardDrive size={19} />
          <span>
          <strong>{free[0] < preferences.threshold ? '下载盘空间不足' : '下载盘空间正常'}</strong>
          <small>{free[0].toFixed(1)} GiB 可用 · 查看清理</small>
          </span>
          <ChevronRight size={16} />
          </button>
          <button className="attention-link" onClick={() => setPage('subscriptions')}>
          <Bell size={19} />
          <span>
          <strong>{subscriptions.reduce((sum, s) => sum + s.pending, 0)} 条订阅提醒</strong>
          <small>查看更新与检查策略</small>
          </span>
          <ChevronRight size={16} />
          </button>
          </div>
          <div className="work-note">
          <span className="eyebrow">WORKSPACE NOTE</span>
          <h3>少一点等待，<br />多一点确定。</h3>
          <p>所有异常都有下一步。演示状态随页面切换保留。</p>
          </div>
          </aside>}
        </div>
          <footer className="app-footer">
          <span>DownKyi Web · 为喜欢的内容留个位置</span>
          <span>方案 {variant} / 本地原型</span>
          </footer>
      </main>
    </div>
    {message && <div className="feedback" role="status">
      <Check size={16} />
      <span>{message}</span>
      </div>}
    {modal === 'queue' && <Modal title="确认加入演示队列" onClose={() => setModal(null)}>
      <p>已仅解析所选 <strong>{parsed.length}</strong> 条，未选择的内容不会解析。建议规格：1080P / AVC / {preferences.policy}。</p>
      <div className="review-list">{collection.filter(item => parsed.includes(item.id)).map(item => <div key={item.id}>
      <Check size={14} />{item.title}</div>)}</div>
      <div className="info-banner">
      <HardDrive size={18} />
      <p>演示目标：/media，剩余 {free[1].toFixed(1)} GiB。确认后仅创建本地任务。</p>
      </div>
      <div className="dialog-actions">
      <Button onClick={() => { setModal(null); setMessage('已取消入队确认，合集选择与解析结果保留。'); }}>取消确认，保留选择</Button>
      <Button primary onClick={() => { addTasks(collection.filter(item => parsed.includes(item.id))); setQueued(current => [...new Set([...current, ...parsed])]); setSelected(current => current.filter(id => !parsed.includes(id))); setModal(null); setMessage(`已加入 ${parsed.length} 条演示任务，可切换到任务页查看。`); }}>确认入队（{parsed.length} 条）</Button>
      </div>
      </Modal>}
    {modal === 'cleanup' && <Modal title="确认清理这些演示对象？" onClose={() => setModal(null)}>
      <p>预计释放 <strong>{release.toFixed(1)} GiB</strong>。请再次核对对象与路径；不会删除真实文件。</p>
      <div className="review-list">{cleanSelected.map(item => <div key={item.id}>
      <span>
      <strong>{item.title} · {item.size} GiB</strong>
      <small>{item.path}</small>
      </span>
      </div>)}</div>
      <label className="confirm-check">
      <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我已核对清理对象和路径</label>
      <div className="dialog-actions">
      <Button onClick={() => setModal(null)}>取消清理</Button>
      <Button primary disabled={!confirmed} onClick={() => { setFree(current => current.map((value, disk) => value + cleanSelected.filter(item => item.disk === disk).reduce((sum, item) => sum + item.size, 0))); setRemoved(current => [...current, ...cleanSelected.map(item => item.id)]); setCleanup([]); setModal(null); setMessage(`演示清理完成，释放 ${release.toFixed(1)} GiB，磁盘状态已更新。`); }}>确认清理</Button>
      </div>
      </Modal>}
    {modal === 'player' && <PlayerReview initialIndex={player} initialWatched={watched} onCurrentChange={setPlayer} onClose={() => {
      setModal(null);
      const url = new URL(location.href);
      url.searchParams.delete('watch');
      url.searchParams.delete('player');
      history.replaceState(history.state, '', url);
    }} onWatched={index => {
      setWatched(current => [...new Set([...current, index])]);
      setWatchProgress(current => current.map((value, i) => i === index ? 100 : value));
    }} />}
  </div>;
}
createRoot(document.getElementById('root')!).render(<Optimization />);
