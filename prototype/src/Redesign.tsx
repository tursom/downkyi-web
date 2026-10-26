import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ChevronDown, ChevronRight, CircleAlert, Download, Film, FolderOpen, HardDrive, LayoutGrid, Layers3, List,
  LogOut, MoreHorizontal, Pause, Play, Plus, RefreshCw, Search, Settings2, Trash2, X,
} from 'lucide-react';
import './redesign.css';

// Two layout directions over one shared visual system. Data is fixture-only and resets on reload.
type Variant = 'A' | 'B';
type View = 'downloads' | 'library' | 'settings';
type Status = 'queued' | 'resolving' | 'downloading' | 'merging' | 'paused' | 'failed' | 'completed';
type Filter = 'all' | 'active' | 'waiting' | 'paused' | 'failed';
type Task = {
  id: string; title: string; group?: string; cover: string; status: Status; progress: number;
  size: number; speed?: number; eta?: number; quality: string; codec: string; audio?: boolean;
  created: string; error?: string; duration: number; watched?: number; attachments: string[];
};

const cover = (name: string) => `/covers/${name}.jpg`;
const MB = 1024 * 1024;
const fixtures: Task[] = [
  { id: 'a2', title: 'P2 · 折多山垭口，海拔 4298', group: '【4K】川西自驾十日全记录', cover: 'mountain', status: 'downloading', progress: 62, size: 1340 * MB, speed: 3.4 * MB, eta: 100, quality: '2160P', codec: 'HEVC', created: '10-26 09:12', duration: 1420, attachments: ['封面', '字幕', '弹幕'] },
  { id: 'a3', title: 'P3 · 新都桥的光', group: '【4K】川西自驾十日全记录', cover: 'mountain', status: 'queued', progress: 0, size: 1120 * MB, quality: '2160P', codec: 'HEVC', created: '10-26 09:12', duration: 1210, attachments: ['封面', '字幕', '弹幕'] },
  { id: 'a4', title: 'P4 · 稻城亚丁徒步', group: '【4K】川西自驾十日全记录', cover: 'mountain', status: 'queued', progress: 0, size: 1580 * MB, quality: '2160P', codec: 'HEVC', created: '10-26 09:12', duration: 1690, attachments: ['封面', '字幕', '弹幕'] },
  { id: 'n1', title: '家用 NAS 从零搭建：硬盘、系统与备份策略', cover: 'tech', status: 'merging', progress: 100, size: 820 * MB, quality: '1080P', codec: 'AVC', created: '10-26 08:40', duration: 1936, attachments: ['封面'] },
  { id: 'c1', title: '城市夜景延时摄影，从构图到后期', cover: 'city', status: 'paused', progress: 35, size: 640 * MB, quality: '1080P', codec: 'AVC', created: '10-25 22:03', duration: 845, attachments: ['封面', '字幕'] },
  { id: 's1', title: '星空摄影入门：赤道仪到底怎么选', cover: 'sky', status: 'failed', progress: 21, size: 910 * MB, quality: '1080P', codec: 'AV1', created: '10-25 21:47', duration: 1112, error: '网络连接中断，已自动重试 3 次', attachments: ['封面', '弹幕'] },
  { id: 'k1', title: '第 3 期 · 一锅出的番茄牛腩', group: '周末厨房', cover: 'city', status: 'downloading', progress: 18, size: 380 * MB, speed: 1.1 * MB, eta: 290, quality: '1080P', codec: 'AVC', created: '10-26 09:30', duration: 612, attachments: ['封面'] },
  { id: 'k4', title: '第 4 期 · 十分钟葱油拌面', group: '周末厨房', cover: 'city', status: 'queued', progress: 0, size: 240 * MB, quality: '1080P', codec: 'AVC', created: '10-26 09:30', duration: 433, attachments: ['封面'] },
  { id: 'l1', title: 'Linux 内核调度器漫谈', cover: 'tech', status: 'resolving', progress: 0, size: 0, quality: '最佳', codec: '自动', created: '10-26 09:41', duration: 2710, attachments: [] },
  // Completed tasks live in the library.
  { id: 'a1', title: 'P1 · 成都出发，雅康高速一路向西', group: '【4K】川西自驾十日全记录', cover: 'mountain', status: 'completed', progress: 100, size: 1460 * MB, quality: '2160P', codec: 'HEVC', created: '10-26 09:12', duration: 1505, watched: 0.4, attachments: ['封面', '字幕', '弹幕'] },
  { id: 'k1d', title: '第 1 期 · 可乐鸡翅不翻车', group: '周末厨房', cover: 'city', status: 'completed', progress: 100, size: 300 * MB, quality: '1080P', codec: 'AVC', created: '10-24 19:02', duration: 520, watched: 1, attachments: ['封面'] },
  { id: 'k2d', title: '第 2 期 · 电饭煲焖饭', group: '周末厨房', cover: 'city', status: 'completed', progress: 100, size: 280 * MB, quality: '1080P', codec: 'AVC', created: '10-24 19:02', duration: 498, attachments: ['封面'] },
  { id: 'sky', title: '抬头之后，一整夜的银河', cover: 'sky', status: 'completed', progress: 100, size: 760 * MB, quality: '1080P', codec: 'AVC', created: '10-22 23:15', duration: 728, attachments: ['封面', '字幕'] },
  { id: 'tk', title: '桌面改造：开发板的十种用法', cover: 'tech', status: 'completed', progress: 100, size: 540 * MB, quality: '1080P', codec: 'HEVC', created: '10-20 12:30', duration: 1288, watched: 0.75, attachments: ['封面', '弹幕'] },
  { id: 'pod', title: '播客 · 慢慢变老的城市', cover: 'city', status: 'completed', progress: 100, size: 62 * MB, quality: '音频', codec: 'AAC', audio: true, created: '10-18 08:00', duration: 3605, attachments: [] },
];

const statusLabel: Record<Status, string> = {
  queued: '等待中', resolving: '解析中', downloading: '下载中', merging: '合并中', paused: '已暂停', failed: '失败', completed: '已完成',
};
const tone = (s: Status) =>
  s === 'downloading' || s === 'resolving' || s === 'merging' ? 'active' : s === 'failed' ? 'fail' : s === 'paused' ? 'pause' : s === 'completed' ? 'done' : 'wait';
const filters: { id: Filter; label: string; match: (s: Status) => boolean }[] = [
  { id: 'all', label: '全部', match: () => true },
  { id: 'active', label: '进行中', match: s => tone(s) === 'active' },
  { id: 'waiting', label: '等待中', match: s => s === 'queued' },
  { id: 'paused', label: '已暂停', match: s => s === 'paused' },
  { id: 'failed', label: '失败', match: s => s === 'failed' },
];
const isRunning = (t: Task) => ['queued', 'resolving', 'downloading', 'merging'].includes(t.status);

function bytes(n: number) {
  if (!n) return '—';
  return n >= 1024 * MB ? `${(n / 1024 / MB).toFixed(2)} GB` : `${Math.round(n / MB)} MB`;
}
const speed = (n: number) => `${(n / MB).toFixed(1)} MB/s`;
function clock(seconds: number) {
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, s = Math.floor(seconds % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
const remaining = (s: number) => (s < 60 ? `剩 ${s} 秒` : `剩 ${Math.ceil(s / 60)} 分钟`);

function groupBy(tasks: Task[]) {
  const out: { name?: string; items: Task[] }[] = [];
  for (const task of tasks) {
    const bucket = task.group ? out.find(g => g.name === task.group) : undefined;
    if (bucket) bucket.items.push(task);
    else out.push({ name: task.group, items: [task] });
  }
  return out;
}

function Thumb({ task, wide = false }: { task: Task; wide?: boolean }) {
  return (
    <span className={`thumb ${wide ? 'wide' : ''}`}>
      <img src={cover(task.cover)} alt="" loading="lazy" />
      {wide && <em>{clock(task.duration)}</em>}
      {wide && task.watched !== undefined && <i style={{ width: `${task.watched * 100}%` }} />}
    </span>
  );
}

function StatusCell({ task }: { task: Task }) {
  const t = tone(task.status);
  const detail =
    task.status === 'downloading' && task.speed ? `${speed(task.speed)} · ${remaining(task.eta ?? 0)}`
      : task.status === 'merging' ? '正在合并音视频'
      : task.status === 'resolving' ? '获取可用画质'
      : task.status === 'queued' ? '排队等待空闲下载位'
      : task.status === 'paused' ? `已下载 ${bytes(task.size * task.progress / 100)}`
      : task.status === 'failed' ? '可重试，进度会保留' : '';
  return (
    <div className={`status ${t}`}>
      <div className="status-line">
        <strong>{statusLabel[task.status]}</strong>
        {task.status !== 'queued' && task.status !== 'resolving' && <span>{Math.floor(task.progress)}%</span>}
      </div>
      <div className={`bar ${task.status === 'resolving' || task.status === 'merging' ? 'busy' : ''}`}>
        <i style={{ width: `${task.status === 'resolving' ? 100 : task.progress}%` }} />
      </div>
      <small>{detail}</small>
    </div>
  );
}

function Icon({ label, onClick, children, danger = false }: { label: string; onClick: () => void; children: ReactNode; danger?: boolean }) {
  return (
    <button className={`icon ${danger ? 'danger' : ''}`} aria-label={label} title={label} onClick={e => { e.stopPropagation(); onClick(); }}>
      {children}
    </button>
  );
}

function Downloads({ tasks, update, openDetail }: {
  tasks: Task[]; update: (ids: string[], patch: (t: Task) => Partial<Task>) => void; openDetail: (id: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [grouped, setGrouped] = useState(true);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const queue = tasks.filter(t => t.status !== 'completed');
  const visible = queue.filter(t => filters.find(f => f.id === filter)!.match(t.status) && `${t.title} ${t.group ?? ''}`.includes(query.trim()));
  const running = queue.filter(t => t.status === 'downloading');
  const total = running.reduce((n, t) => n + (t.speed ?? 0), 0);
  const toggle = (id: string) => setSelected(s => (s.includes(id) ? s.filter(x => x !== id) : [...s, id]));
  const pause = (t: Task) => update([t.id], x => (isRunning(x) ? { status: 'paused', speed: undefined } : { status: 'queued', error: undefined }));

  const row = (t: Task, nested = false) => (
    <div key={t.id} className={`row ${nested ? 'nested' : ''} ${selected.includes(t.id) ? 'picked' : ''}`} onClick={() => openDetail(t.id)}>
      <label className="check" onClick={e => e.stopPropagation()}>
        <input type="checkbox" checked={selected.includes(t.id)} onChange={() => toggle(t.id)} aria-label={`选择 ${t.title}`} />
      </label>
      <Thumb task={t} />
      <div className="title">
        <strong title={t.title}>{t.title}</strong>
        <span className="meta">
          {t.error ? <em className="error"><CircleAlert size={13} />{t.error}</em> : <>
            {!nested && t.group && <><span className="group-tag">{t.group}</span>·</>}
            <span>{t.quality}</span>·<span>{t.codec}</span>{t.size > 0 && <>·<span>{bytes(t.size)}</span></>}
          </>}
        </span>
      </div>
      <StatusCell task={t} />
      <div className="actions">
        {t.status === 'failed'
          ? <Icon label="重试" onClick={() => pause(t)}><RefreshCw size={17} /></Icon>
          : isRunning(t)
            ? <Icon label="暂停" onClick={() => pause(t)}><Pause size={17} /></Icon>
            : <Icon label="继续" onClick={() => pause(t)}><Play size={17} /></Icon>}
        <Icon label="更多" onClick={() => openDetail(t.id)}><MoreHorizontal size={18} /></Icon>
      </div>
    </div>
  );

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>下载</h1>
          <p className="summary">
            {running.length ? <><b>{running.length}</b> 个正在下载 · 总速度 <b>{speed(total)}</b></> : '当前没有正在下载的任务'}
            {' · '}{queue.filter(t => t.status === 'queued').length} 个排队
          </p>
        </div>
      </header>

      {selected.length ? (
        <div className="toolbar selecting">
          <span>已选 <b>{selected.length}</b> 项</span>
          <button className="btn" onClick={() => { update(selected, x => (isRunning(x) ? { status: 'paused', speed: undefined } : {})); setSelected([]); }}><Pause size={15} />暂停</button>
          <button className="btn" onClick={() => { update(selected, x => (x.status === 'paused' || x.status === 'failed' ? { status: 'queued', error: undefined } : {})); setSelected([]); }}><Play size={15} />继续</button>
          <span className="spacer" />
          <button className="btn ghost" onClick={() => setSelected([])}>取消选择</button>
        </div>
      ) : (
        <div className="toolbar">
          <div className="chips" role="tablist">
            {filters.map(f => {
              const n = queue.filter(t => f.match(t.status)).length;
              if (f.id !== 'all' && !n) return null;
              return (
                <button key={f.id} role="tab" aria-selected={filter === f.id} className={`chip ${filter === f.id ? 'on' : ''} ${f.id === 'failed' ? 'warn' : ''}`} onClick={() => setFilter(f.id)}>
                  {f.label}<span>{n}</span>
                </button>
              );
            })}
          </div>
          <span className="spacer" />
          <label className="search">
            <Search size={15} />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索标题或合集" />
          </label>
          <button className={`btn ghost toggle ${grouped ? 'on' : ''}`} onClick={() => setGrouped(g => !g)} title="按合集分组">
            <Layers3 size={15} /><span>按合集</span>
          </button>
        </div>
      )}

      <div className="list">
        {!visible.length && <div className="empty">没有符合条件的任务</div>}
        {grouped
          ? groupBy(visible).map(g => {
              if (!g.name || g.items.length < 2) return g.items.map(t => row(t));
              const open = !collapsed.includes(g.name);
              const done = tasks.filter(t => t.group === g.name && t.status === 'completed').length;
              const all = tasks.filter(t => t.group === g.name).length;
              const ids = g.items.map(t => t.id);
              const allPicked = ids.every(id => selected.includes(id));
              return (
                <Fragment key={g.name}>
                  <div className="group-row" onClick={() => setCollapsed(c => (open ? [...c, g.name!] : c.filter(x => x !== g.name)))}>
                    <label className="check" onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={allPicked} aria-label={`选择合集 ${g.name}`}
                        onChange={() => setSelected(s => (allPicked ? s.filter(id => !ids.includes(id)) : [...new Set([...s, ...ids])]))} />
                    </label>
                    <span className="chev">{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
                    <strong>{g.name}</strong>
                    <span className="meta">{g.items.length} 项未完成 · 已完成 {done}/{all}</span>
                    <span className="group-bar"><i style={{ width: `${(done / all) * 100}%` }} /></span>
                  </div>
                  {open && g.items.map(t => row(t, true))}
                </Fragment>
              );
            })
          : visible.map(t => row(t))}
      </div>
      <p className="foot-note"><FolderOpen size={14} />保存到 <code>/downloads/bilibili</code></p>
    </section>
  );
}

function Library({ tasks, variant, openDetail, toast }: { tasks: Task[]; variant: Variant; openDetail: (id: string) => void; toast: (m: string) => void }) {
  const [mode, setMode] = useState<'grid' | 'list'>(variant === 'B' ? 'grid' : 'list');
  const [query, setQuery] = useState('');
  useEffect(() => setMode(variant === 'B' ? 'grid' : 'list'), [variant]);
  const done = tasks.filter(t => t.status === 'completed' && `${t.title} ${t.group ?? ''}`.includes(query.trim()));
  const resume = done.filter(t => t.watched !== undefined && t.watched < 1);
  const play = (t: Task) => toast(`播放「${t.title}」——沿用现有 ArtPlayer 播放器`);
  const total = done.reduce((n, t) => n + t.size, 0);

  const card = (t: Task, nested = false) => (
    <article key={t.id} className="card" onClick={() => openDetail(t.id)}>
      <button className="cover" onClick={e => { e.stopPropagation(); play(t); }} aria-label={`播放 ${t.title}`}>
        <Thumb task={t} wide />
        <span className="play"><Play size={20} fill="currentColor" /></span>
      </button>
      <strong title={t.title}>{t.title}</strong>
      <span className="meta">
        {!nested && t.group && <><span className="group-tag">{t.group}</span>·</>}
        {t.audio ? '音频' : t.quality} · {bytes(t.size)}{t.watched === 1 ? ' · 已看完' : ''}
      </span>
    </article>
  );
  const line = (t: Task, nested = false) => (
    <div key={t.id} className={`row lib ${nested ? 'nested' : ''}`} onClick={() => openDetail(t.id)}>
      <Thumb task={t} />
      <div className="title">
        <strong title={t.title}>{t.title}</strong>
        <span className="meta">
          {!nested && t.group && <><span className="group-tag">{t.group}</span>·</>}
          <span>{t.audio ? '音频' : `${t.quality} ${t.codec}`}</span>·<span>{clock(t.duration)}</span>·<span>{bytes(t.size)}</span>
        </span>
      </div>
      <span className="watch">
        {t.watched === 1 ? '已看完' : t.watched ? `看到 ${Math.round(t.watched * 100)}%` : <span className="new">未观看</span>}
      </span>
      <span className="date">{t.created}</span>
      <div className="actions">
        <Icon label="播放" onClick={() => play(t)}><Play size={17} /></Icon>
        <Icon label="更多" onClick={() => openDetail(t.id)}><MoreHorizontal size={18} /></Icon>
      </div>
    </div>
  );

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>媒体库</h1>
          <p className="summary">{done.length} 个视频 · 共 {bytes(total)}</p>
        </div>
      </header>
      <div className="toolbar">
        <label className="search grow">
          <Search size={15} />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索已下载的视频" />
        </label>
        <span className="spacer" />
        <div className="seg" role="group" aria-label="显示方式">
          <button className={mode === 'grid' ? 'on' : ''} onClick={() => setMode('grid')} aria-label="封面"><LayoutGrid size={15} /></button>
          <button className={mode === 'list' ? 'on' : ''} onClick={() => setMode('list')} aria-label="列表"><List size={15} /></button>
        </div>
      </div>

      {mode === 'grid' && resume.length > 0 && !query && (
        <>
          <h2 className="section-title">继续观看</h2>
          <div className="grid">{resume.map(t => card(t))}</div>
        </>
      )}
      {groupBy(done).map(g =>
        g.name && g.items.length > 1 ? (
          <div key={g.name} className="collection">
            <div className="collection-head">
              <h2 className="section-title">{g.name}<span>{g.items.length} 集</span></h2>
              <button className="btn ghost small" onClick={() => toast(`正在检查「${g.name}」是否有新视频…`)}><RefreshCw size={14} />检查更新</button>
            </div>
            {mode === 'grid' ? <div className="grid">{g.items.map(t => card(t, true))}</div> : <div className="list">{g.items.map(t => line(t, true))}</div>}
          </div>
        ) : null,
      )}
      <h2 className="section-title">单个视频</h2>
      {mode === 'grid'
        ? <div className="grid">{done.filter(t => !t.group || done.filter(x => x.group === t.group).length < 2).map(t => card(t))}</div>
        : <div className="list">{done.filter(t => !t.group || done.filter(x => x.group === t.group).length < 2).map(t => line(t))}</div>}
    </section>
  );
}

function Settings({ toast }: { toast: (m: string) => void }) {
  const initial = { workers: 2, dir: '/downloads/bilibili' };
  const [form, setForm] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const dirty = form.workers !== saved.workers || form.dir !== saved.dir;
  return (
    <section className="page narrow">
      <header className="page-head"><div><h1>设置</h1></div></header>

      <div className="panel">
        <h2>下载</h2>
        <div className="field inline">
          <div><label>同时下载</label><p>更多并发不一定更快，B 站会限制单账号速度。</p></div>
          <div className="stepper">
            <button onClick={() => setForm(f => ({ ...f, workers: Math.max(1, f.workers - 1) }))} aria-label="减少">−</button>
            <span>{form.workers}</span>
            <button onClick={() => setForm(f => ({ ...f, workers: Math.min(5, f.workers + 1) }))} aria-label="增加">+</button>
          </div>
        </div>
        <div className="field">
          <label htmlFor="dir">保存位置</label>
          <input id="dir" className="input mono" value={form.dir} onChange={e => setForm(f => ({ ...f, dir: e.target.value }))} />
          <p>服务器上已存在且可写的目录。只影响之后新建的任务。</p>
        </div>
      </div>

      <div className="panel">
        <h2>哔哩哔哩账号</h2>
        <div className="account">
          <span className="avatar">K</span>
          <div><strong>kyi_user</strong><p>已登录 · 大会员 · 可下载 4K 与 1080P 高码率</p></div>
          <button className="btn ghost" onClick={() => toast('已退出 B 站账号（演示）')}>退出</button>
        </div>
      </div>

      <div className="panel">
        <h2>服务器</h2>
        <div className="disk">
          <div className="status-line"><span><HardDrive size={15} />下载目录所在磁盘</span><span><b>70.0 GB</b> 可用 / 100 GB</span></div>
          <div className="bar"><i style={{ width: '30%' }} /></div>
        </div>
        <dl className="kv">
          <dt>DownKyi Web</dt><dd>1.4.0</dd>
          <dt>yt-dlp</dt><dd>2026.09.18</dd>
          <dt>FFmpeg</dt><dd className="ok">可用</dd>
          <dt>访问保护</dt><dd>令牌登录</dd>
        </dl>
      </div>

      {dirty && (
        <div className="save-bar">
          <span>有未保存的修改</span>
          <button className="btn ghost" onClick={() => setForm(saved)}>撤销</button>
          <button className="btn primary" onClick={() => { setSaved(form); toast('设置已保存'); }}>保存</button>
        </div>
      )}
    </section>
  );
}

function Detail({ task, onClose, update, remove, toast }: {
  task: Task; onClose: () => void; update: (ids: string[], p: (t: Task) => Partial<Task>) => void; remove: (id: string) => void; toast: (m: string) => void;
}) {
  const steps: Status[] = ['queued', 'resolving', 'downloading', 'merging', 'completed'];
  const at = task.status === 'paused' || task.status === 'failed' ? 2 : steps.indexOf(task.status);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="scrim" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-label="任务详情" onClick={e => e.stopPropagation()}>
        <header>
          <span>{task.status === 'completed' ? '视频详情' : '任务详情'}</span>
          <Icon label="关闭" onClick={onClose}><X size={18} /></Icon>
        </header>
        <div className="drawer-body">
          <Thumb task={task} wide />
          <h2>{task.title}</h2>
          {task.group && <p className="muted">{task.group}</p>}
          {task.status !== 'completed' && (
            <>
              <ol className="steps">
                {steps.map((s, i) => (
                  <li key={s} className={i < at ? 'past' : i === at ? `now ${tone(task.status)}` : ''}>{i === at ? statusLabel[task.status] : statusLabel[s]}</li>
                ))}
              </ol>
              <StatusCell task={task} />
            </>
          )}
          <dl className="kv">
            <dt>规格</dt><dd>{task.audio ? '仅音频' : `${task.quality} · ${task.codec}`}</dd>
            <dt>大小</dt><dd>{bytes(task.size)}</dd>
            <dt>时长</dt><dd>{clock(task.duration)}</dd>
            <dt>附件</dt><dd>{task.attachments.join('、') || '无'}</dd>
            <dt>添加时间</dt><dd>{task.created}</dd>
            <dt>保存位置</dt><dd className="mono">/downloads/bilibili/{task.group ?? ''}</dd>
          </dl>
          {task.status === 'completed' && (
            <div className="files">
              <h3>文件</h3>
              {[`${task.title}.mp4`, ...task.attachments.map(a => `${task.title}.${a === '封面' ? 'jpg' : a === '字幕' ? 'srt' : 'ass'}`)].map(f => (
                <a key={f} href="#" onClick={e => { e.preventDefault(); toast(`下载 ${f}`); }}><Download size={14} /><span>{f}</span></a>
              ))}
            </div>
          )}
        </div>
        <footer>
          {task.status === 'completed'
            ? <button className="btn primary" onClick={() => toast('打开播放器')}><Play size={15} />播放</button>
            : task.status === 'failed'
              ? <button className="btn primary" onClick={() => update([task.id], () => ({ status: 'queued', error: undefined }))}><RefreshCw size={15} />重试</button>
              : isRunning(task)
                ? <button className="btn" onClick={() => update([task.id], () => ({ status: 'paused', speed: undefined }))}><Pause size={15} />暂停</button>
                : <button className="btn primary" onClick={() => update([task.id], () => ({ status: 'queued' }))}><Play size={15} />继续</button>}
          <span className="spacer" />
          {confirm ? (
            <span className="confirm">
              <span>{task.status === 'completed' ? '同时删除文件？' : '移除任务并清理临时文件？'}</span>
              <button className="btn ghost" onClick={() => setConfirm(false)}>取消</button>
              <button className="btn danger" onClick={() => { remove(task.id); onClose(); toast('已删除'); }}>删除</button>
            </span>
          ) : (
            <button className="btn ghost danger-text" onClick={() => setConfirm(true)}><Trash2 size={15} />{task.status === 'completed' ? '删除' : '移除'}</button>
          )}
        </footer>
      </aside>
    </div>
  );
}

function NewDownload({ onClose, toast }: { onClose: () => void; toast: (m: string) => void }) {
  const [url, setUrl] = useState('');
  return (
    <div className="scrim center" onClick={onClose}>
      <div className="dialog" role="dialog" aria-label="新建下载" onClick={e => e.stopPropagation()}>
        <header><h2>新建下载</h2><Icon label="关闭" onClick={onClose}><X size={18} /></Icon></header>
        <label htmlFor="url">视频、合集、收藏夹或番剧链接</label>
        <textarea id="url" autoFocus rows={3} value={url} onChange={e => setUrl(e.target.value)} placeholder="https://www.bilibili.com/video/BV… 或 BV 号，可一次粘贴多行" />
        <p className="muted">下一步选择分 P 与画质。后续步骤沿用现有流程，仅更新视觉。</p>
        <footer>
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={!url.trim()} onClick={() => { toast('开始解析（演示）'); onClose(); }}>解析</button>
        </footer>
      </div>
    </div>
  );
}

const nav = [
  { id: 'downloads', label: '下载', icon: Download },
  { id: 'library', label: '媒体库', icon: Film },
  { id: 'settings', label: '设置', icon: Settings2 },
] as const;

function App() {
  const params = new URLSearchParams(location.search);
  const [variant, setVariant] = useState<Variant>(params.get('variant') === 'B' ? 'B' : 'A');
  const [view, setView] = useState<View>((params.get('view') as View) || 'downloads');
  const [tasks, setTasks] = useState(fixtures);
  const [detail, setDetail] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState('');
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set('variant', variant);
    url.searchParams.set('view', view);
    history.replaceState(null, '', url);
  }, [variant, view]);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), 3200);
    return () => clearTimeout(timer);
  }, [message]);
  // Gentle progress so the page feels alive during review.
  useEffect(() => {
    const timer = setInterval(() => setTasks(ts => ts.map(t =>
      t.status === 'downloading' ? { ...t, progress: Math.min(99, t.progress + 0.3), eta: Math.max(1, (t.eta ?? 1) - 1) } : t)), 1000);
    return () => clearInterval(timer);
  }, []);

  const update = (ids: string[], patch: (t: Task) => Partial<Task>) => setTasks(ts => ts.map(t => (ids.includes(t.id) ? { ...t, ...patch(t) } : t)));
  const counts = useMemo(() => ({
    downloads: tasks.filter(t => t.status !== 'completed').length,
    library: tasks.filter(t => t.status === 'completed').length,
    failed: tasks.filter(t => t.status === 'failed').length,
  }), [tasks]);
  const current = tasks.find(t => t.id === detail);

  const navItems = (
    <nav aria-label="主导航">
      {nav.map(({ id, label, icon: I }) => (
        <button key={id} className={view === id ? 'on' : ''} aria-current={view === id ? 'page' : undefined} onClick={() => setView(id)}>
          <I size={18} /><span>{label}</span>
          {id !== 'settings' && <em className={id === 'downloads' && counts.failed ? 'alert' : ''}>{counts[id]}</em>}
        </button>
      ))}
    </nav>
  );
  const brand = <div className="brand"><span className="logo"><Download size={16} strokeWidth={2.5} /></span>DownKyi</div>;

  return (
    <div className={`rd rd-${variant}`}>
      {variant === 'A' ? (
        <header className="topbar">
          {brand}
          <div className="top-nav">{navItems}</div>
          <span className="spacer" />
          <button className="btn primary only-wide" onClick={() => setCreating(true)}><Plus size={16} />新建下载</button>
          <button className="btn primary only-narrow round" aria-label="新建下载" onClick={() => setCreating(true)}><Plus size={18} /></button>
          <Icon label="退出登录" onClick={() => setMessage('已退出（演示）')}><LogOut size={17} /></Icon>
        </header>
      ) : (
        <>
          <aside className="sidebar">
            {brand}
            <button className="btn primary block" onClick={() => setCreating(true)}><Plus size={16} />新建下载</button>
            {navItems}
            <div className="side-foot">
              <div className="disk mini">
                <div className="status-line"><span>磁盘</span><span>70 GB 可用</span></div>
                <div className="bar"><i style={{ width: '30%' }} /></div>
              </div>
              <button className="side-link" onClick={() => setMessage('已退出（演示）')}><LogOut size={15} />退出登录</button>
            </div>
          </aside>
          <header className="topbar mobile-only">
            {brand}
            <span className="spacer" />
            <button className="btn primary round" aria-label="新建下载" onClick={() => setCreating(true)}><Plus size={18} /></button>
          </header>
        </>
      )}

      <main>
        {offline && (
          <div className="banner"><CircleAlert size={16} />与服务器的连接中断，正在重试…<button className="btn ghost small" onClick={() => setOffline(false)}>立即重试</button></div>
        )}
        {view === 'downloads' && <Downloads tasks={tasks} update={update} openDetail={setDetail} />}
        {view === 'library' && <Library tasks={tasks} variant={variant} openDetail={setDetail} toast={setMessage} />}
        {view === 'settings' && <Settings toast={setMessage} />}
      </main>

      <div className="tabbar">{navItems}</div>

      {current && <Detail task={current} onClose={() => setDetail(undefined)} update={update} remove={id => setTasks(ts => ts.filter(t => t.id !== id))} toast={setMessage} />}
      {creating && <NewDownload onClose={() => setCreating(false)} toast={setMessage} />}
      {message && <div className="toast" role="status">{message}</div>}

      <div className="review" aria-label="方案切换">
        {(['A', 'B'] as const).map(v => (
          <button key={v} className={variant === v ? 'on' : ''} onClick={() => setVariant(v)}>
            {v} · {v === 'A' ? '顶栏 + 列表' : '侧栏 + 封面'}
          </button>
        ))}
        <button onClick={() => setOffline(o => !o)} title="演示连接中断时的提示">{offline ? '恢复连接' : '模拟断线'}</button>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
