/// <reference types="vite/client" />
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Copy,
  Download,
  FileVideo,
  FolderOpen,
  HardDrive,
  ListFilter,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import NewDownload, { type DownloadDraft } from "./NewDownload";
import "./style.css";
import "./workflow.css";

// In-memory workflow prototype; no real API calls or downloads.
type Status =
  | "resolving"
  | "downloading"
  | "merging"
  | "paused"
  | "queued"
  | "completed"
  | "failed";
type Task = {
  id: number;
  title: string;
  author: string;
  cover: string;
  duration: string;
  quality: string;
  size: string;
  status: Status;
  progress: number;
  speed?: string;
  date: string;
  createdAt?: number;
  part?: string;
  mode?: "video" | "audio";
  codec?: string;
  subtitles?: boolean;
  saveCover?: boolean;
  sourceKey?: string;
  sourceUrl?: string;
  filesDeleted?: boolean;
  recordRemoved?: boolean;
  resumeStatus?: Status;
};
type View = "tasks" | "completed" | "settings" | "system";
const initialTasks: Task[] = [
  {
    id: 1,
    title: "在阿尔卑斯山，记录一场迟来的日出",
    author: "山野之间",
    cover: "mountain",
    duration: "18:42",
    quality: "4K",
    size: "1.24 GB",
    status: "downloading",
    progress: 68,
    speed: "12.8 MB/s",
    date: "今天 14:32",
    part: "P1 · 完整影片",
  },
  {
    id: 2,
    title: "从零搭建我的家庭服务器｜NAS 实践手记",
    author: "不只是数码",
    cover: "tech",
    duration: "32:16",
    quality: "1080P",
    size: "846 MB",
    status: "merging",
    progress: 100,
    speed: "8.6 MB/s",
    date: "今天 14:30",
    part: "P2 · 系统安装与配置",
  },
  {
    id: 3,
    title: "抬头之后：一整夜的星空与银河",
    author: "星空来信",
    cover: "sky",
    duration: "12:08",
    quality: "4K",
    size: "928 MB",
    status: "resolving",
    progress: 0,
    date: "今天 14:28",
  },
  {
    id: 4,
    title: "东京漫步｜把日常拍成电影",
    author: "散步记录员",
    cover: "city",
    duration: "24:50",
    quality: "1080P",
    size: "652 MB",
    status: "paused",
    progress: 45,
    date: "今天 14:25",
  },
  {
    id: 5,
    title: "一块开发板的可能性：我的桌面小项目",
    author: "不只是数码",
    cover: "tech",
    duration: "16:35",
    quality: "1080P",
    size: "426 MB",
    status: "failed",
    progress: 19,
    date: "今天 13:56",
  },
  {
    id: 6,
    title: "远山与湖泊，留住这一刻的宁静",
    author: "山野之间",
    cover: "mountain",
    duration: "08:24",
    quality: "4K",
    size: "768 MB",
    status: "completed",
    progress: 100,
    date: "今天 11:42",
  },
  {
    id: 7,
    title: "城市醒来之前｜清晨影像日记",
    author: "散步记录员",
    cover: "city",
    duration: "06:18",
    quality: "1080P",
    size: "312 MB",
    status: "completed",
    progress: 100,
    date: "昨天 21:08",
  },
  {
    id: 8,
    title: "星空摄影入门：第一次拍到银河",
    author: "星空来信",
    cover: "sky",
    duration: "28:16",
    quality: "1080P",
    size: "593 MB",
    status: "completed",
    progress: 100,
    date: "昨天 18:26",
  },
];
const statusLabel: Record<Status, string> = {
  downloading: "下载中",
  resolving: "解析资源",
  merging: "合并校验",
  queued: "等待中",
  paused: "已暂停",
  completed: "已完成",
  failed: "下载失败",
};
const navItems = [
  { id: "tasks", name: "下载队列", icon: Download },
  { id: "completed", name: "已完成", icon: FolderOpen },
  { id: "settings", name: "偏好设置", icon: Settings2 },
  { id: "system", name: "服务器", icon: Server },
] as const;
function IconButton({
  label,
  children,
  onClick,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  className?: string;
}) {
  return (
    <button
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
function Badge({ status }: { status: Status }) {
  return (
    <span className={`badge ${status}`}>
      <span className="status-dot" />
      {statusLabel[status]}
    </span>
  );
}
function Cover({ task }: { task: Task }) {
  return (
    <div className="cover">
      <img src={`/covers/${task.cover}.jpg`} alt="" />
      <span>{task.duration}</span>
    </div>
  );
}
function App() {
  const [tasks, setTasks] = useState<Task[]>(() =>
    initialTasks.map((task, index) => ({
      ...task,
      createdAt: initialTasks.length - index,
    })),
  );
  const [view, setView] = useState<View>("tasks");
  const [filter, setFilter] = useState("active");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [modal, setModal] = useState(false);
  const [detail, setDetail] = useState<number | null>(null);
  const [toast, setToast] = useState("");
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [deleteMode, setDeleteMode] = useState<"record" | "files">("record");
  const [confirmFiles, setConfirmFiles] = useState(false);
  const [sort, setSort] = useState("newest");
  const active = tasks.filter((t) => t.status !== "completed");
  const done = tasks.filter((t) => t.status === "completed");
  function notify(text: string) {
    setToast(text);
  }
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!modal && detail === null && deleteId === null) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setModal(false);
        setDetail(null);
        setDeleteId(null);
      }
      if (e.key === "Tab") {
        const dialog = document.querySelector('[role="dialog"]');
        const nodes = dialog?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea,a[href]",
        );
        if (!nodes?.length) return;
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    const frame = requestAnimationFrame(() =>
      document.querySelector<HTMLElement>('[role="dialog"] button')?.focus(),
    );
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [modal, detail, deleteId]);
  function action(task: Task) {
    setTasks((ts) =>
      ts.map((t) =>
        t.id === task.id
          ? {
              ...t,
              resumeStatus:
                t.status === "paused" || t.status === "failed"
                  ? undefined
                  : t.status,
              status:
                t.status === "failed"
                  ? "resolving"
                  : t.status === "paused"
                    ? t.resumeStatus || "queued"
                    : "paused",
            }
          : t,
      ),
    );
  }
  function go(next: View) {
    setView(next);
    setSearch("");
    setSelected([]);
    setFilter("active");
  }
  const displayed = tasks
    .filter((t) =>
      view === "completed"
        ? t.status === "completed"
        : filter === "all"
          ? true
          : filter === "active"
            ? t.status !== "completed"
            : t.status === filter,
    )
    .filter((t) =>
      `${t.title}${t.author}`.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.title.localeCompare(b.title, "zh")
        : (b.createdAt || 0) - (a.createdAt || 0),
    );
  function requestDelete(task: Task, mode: "record" | "files") {
    setDeleteMode(mode);
    setConfirmFiles(false);
    setDeleteId(task.id);
    setDetail(null);
  }
  function advanceDemo(task: Task) {
    const next: Partial<Record<Status, Status>> = {
      queued: "resolving",
      resolving: "downloading",
      downloading: "merging",
      merging: "completed",
    };
    const status = next[task.status];
    if (!status) return;
    setTasks((ts) =>
      ts.map((t) =>
        t.id === task.id
          ? {
              ...t,
              status,
              progress:
                status === "downloading"
                  ? 35
                  : status === "merging" || status === "completed"
                    ? 100
                    : 0,
              size: status === "resolving" ? "待获取" : "128 MB",
            }
          : t,
      ),
    );
  }
  const taskDetail = tasks.find((t) => t.id === detail);
  const renderActions = (task: Task) => (
    <div className="row-actions">
      {task.status === "completed" ? (
        <IconButton label="查看文件" onClick={() => setDetail(task.id)}>
          <FolderOpen size={17} />
        </IconButton>
      ) : (
        <IconButton
          label={
            task.status !== "paused" && task.status !== "failed"
              ? "暂停任务"
              : task.status === "failed"
                ? "重试下载"
                : "继续下载"
          }
          onClick={() => action(task)}
        >
          {task.status !== "paused" && task.status !== "failed" ? (
            <Pause size={17} />
          ) : task.status === "failed" ? (
            <RefreshCw size={17} />
          ) : (
            <Play size={17} />
          )}
        </IconButton>
      )}
      <IconButton label="任务详情" onClick={() => setDetail(task.id)}>
        <MoreHorizontal size={19} />
      </IconButton>
    </div>
  );
  const listProps = {
    tasks: displayed,
    selected,
    toggle: (id: number) =>
      setSelected((s) =>
        s.includes(id) ? s.filter((n) => n !== id) : [...s, id],
      ),
    actions: renderActions,
    open: (t: Task) => setDetail(t.id),
  };
  return (
    <div className="app variant-B">
      <aside className="sidebar">
        <a
          href="/"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            go("tasks");
          }}
        >
          <div className="brand-symbol">
            <ArrowDownToLine size={23} strokeWidth={2.5} />
          </div>
          <span>
            DownKyi <small>WEB</small>
          </span>
        </a>
        <div className="workspace">
          <div className="workspace-icon">
            <Server size={17} />
          </div>
          <div>
            <strong>我的下载空间</strong>
            <small>home-server</small>
          </div>
          <ChevronDown size={14} />
        </div>
        <span className="nav-heading">工作空间</span>
        <nav>
          {navItems.map(({ id, name, icon: Icon }, i) => (
            <button
              key={id}
              title={name}
              onClick={() => go(id)}
              className={`${view === id ? "active" : ""} ${i === 2 ? "nav-divider" : ""}`}
            >
              <Icon size={18} />
              <span>{name}</span>
              {i < 2 && <em>{i === 0 ? active.length : done.length}</em>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="storage-title">
            <HardDrive size={16} />
            <span>存储空间</span>
            <span>24%</span>
          </div>
          <div className="storage-track">
            <i />
          </div>
          <p>
            <b>120.4 GB</b> / 500 GB
          </p>
          <div className="node-state">
            <span className="status-dot" />
            服务器在线 <span>v0.1.0</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span>工作空间</span>
            <ChevronRight size={14} />
            <strong>{navItems.find((n) => n.id === view)?.name}</strong>
          </div>
          <div className="topbar-right">
            <span className="prototype-mark">前端原型 · 演示数据</span>
            <span className="topbar-server">
              <span className="status-dot" /> home-server
            </span>
            <button
              className="avatar"
              title="本地管理员"
              onClick={() => notify("当前为本地管理员演示账户")}
            >
              AD
            </button>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {view === "tasks"
                  ? "DOWNLOADS"
                  : view === "completed"
                    ? "LIBRARY"
                    : view === "settings"
                      ? "PREFERENCES"
                      : "SERVER STATUS"}
              </div>
              <h1>
                {view === "tasks"
                  ? "下载队列"
                  : view === "completed"
                    ? "我的媒体库"
                    : view === "settings"
                      ? "偏好设置"
                      : "服务器状态"}
                <span className="title-count">
                  {view === "tasks"
                    ? active.length
                    : view === "completed"
                      ? done.length
                      : ""}
                </span>
              </h1>
              <p>
                {view === "tasks"
                  ? "每一份喜欢，都值得好好收藏。"
                  : view === "completed"
                    ? "已保存到服务器的全部文件。"
                    : view === "settings"
                      ? "下载、存储与账户。"
                      : "home-server / Linux x86_64"}
              </p>
            </div>
            <div className="heading-actions">
              {view === "tasks" || view === "completed" ? (
                <>
                  <button
                    className="button secondary heading-folder"
                    onClick={() => go(view === "tasks" ? "completed" : "tasks")}
                  >
                    <FolderOpen size={16} />
                    {view === "tasks" ? "浏览文件" : "下载队列"}
                  </button>
                  <button
                    className="button primary"
                    onClick={() => setModal(true)}
                  >
                    <Plus size={18} />
                    新建下载
                  </button>
                </>
              ) : (
                <span className="badge completed">
                  <ShieldCheck size={14} />
                  本地工作空间
                </span>
              )}
            </div>
          </div>
          {(view === "tasks" || view === "completed") && (
            <>
              {view === "tasks" && (
                <section className="metrics">
                  <div className="metric">
                    <div className="metric-icon teal">
                      <ArrowDown size={20} />
                    </div>
                    <div>
                      <span>正在下载</span>
                      <strong>
                        {tasks.filter((t) => t.status === "downloading").length}
                        <small>个任务</small>
                      </strong>
                    </div>
                    <div className="mini-chart">
                      {[25, 42, 32, 65, 48, 82, 67, 96, 73, 88].map((v, i) => (
                        <i key={i} style={{ height: `${v}%` }} />
                      ))}
                    </div>
                  </div>
                  <div className="metric">
                    <div className="metric-icon pink">
                      <RefreshCw size={19} />
                    </div>
                    <div>
                      <span>总下载速度</span>
                      <strong>
                        {tasks
                          .filter((t) => t.status === "downloading")
                          .reduce((s, t) => s + parseFloat(t.speed || "8.6"), 0)
                          .toFixed(1)}
                        <small>MB/s</small>
                      </strong>
                    </div>
                    <span className="metric-note">实时传输</span>
                  </div>
                  <div className="metric">
                    <div className="metric-icon gray">
                      <CheckCheck size={21} />
                    </div>
                    <div>
                      <span>已完成</span>
                      <strong>
                        {done.length}
                        <small>个任务</small>
                      </strong>
                    </div>
                    <button
                      onClick={() => go("completed")}
                      className="text-link"
                    >
                      查看文件
                      <ArrowUpRight size={14} />
                    </button>
                  </div>
                </section>
              )}
              <div className="list-toolbar">
                <div className="tabs">
                  {(view === "completed"
                    ? [{ id: "all", name: "全部文件", count: done.length }]
                    : [
                        {
                          id: "active",
                          name: "全部任务",
                          count: active.length,
                        },
                        {
                          id: "downloading",
                          name: "下载中",
                          count: tasks.filter((t) => t.status === "downloading")
                            .length,
                        },
                        {
                          id: "merging",
                          name: "合并中",
                          count: tasks.filter((t) => t.status === "merging")
                            .length,
                        },
                        {
                          id: "paused",
                          name: "已暂停",
                          count: tasks.filter((t) => t.status === "paused")
                            .length,
                        },
                        {
                          id: "failed",
                          name: "失败",
                          count: tasks.filter((t) => t.status === "failed")
                            .length,
                        },
                      ]
                  ).map((tab) => (
                    <button
                      className={
                        filter === tab.id || view === "completed"
                          ? "active"
                          : ""
                      }
                      key={tab.id}
                      onClick={() => {
                        setFilter(tab.id);
                        setSelected([]);
                      }}
                    >
                      {tab.name}
                      <span>{tab.count}</span>
                    </button>
                  ))}
                </div>
                <label className="search">
                  <Search size={16} />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="搜索名称或 UP 主"
                    aria-label="搜索任务"
                  />
                  <span>⌕</span>
                </label>
              </div>
              <div className="list-subbar">
                <label className="check-label">
                  <input
                    type="checkbox"
                    aria-label="全选任务"
                    checked={
                      displayed.length > 0 &&
                      displayed.every((t) => selected.includes(t.id))
                    }
                    onChange={(e) =>
                      setSelected(
                        e.target.checked ? displayed.map((t) => t.id) : [],
                      )
                    }
                  />
                  <span>
                    {selected.length
                      ? `已选 ${selected.length} 项`
                      : `${displayed.length} 个${view === "completed" ? "文件" : "任务"}`}
                  </span>
                </label>
                {selected.length > 0 && view !== "completed" ? (
                  <div className="batch-actions">
                    <button
                      onClick={() => {
                        setTasks((ts) =>
                          ts.map((t) =>
                            selected.includes(t.id) &&
                            !["completed", "paused", "failed"].includes(
                              t.status,
                            )
                              ? {
                                  ...t,
                                  resumeStatus: t.status,
                                  status: "paused",
                                }
                              : t,
                          ),
                        );
                        setSelected([]);
                      }}
                    >
                      <Pause size={14} />
                      暂停
                    </button>
                    <button
                      onClick={() => {
                        setTasks((ts) =>
                          ts.map((t) =>
                            selected.includes(t.id) &&
                            ["paused", "failed"].includes(t.status)
                              ? {
                                  ...t,
                                  status:
                                    t.status === "failed"
                                      ? "resolving"
                                      : t.resumeStatus || "queued",
                                }
                              : t,
                          ),
                        );
                        setSelected([]);
                      }}
                    >
                      <Play size={14} />
                      继续
                    </button>
                  </div>
                ) : (
                  <div className="sort-control">
                    <ListFilter size={14} />
                    <select
                      aria-label="排序方式"
                      value={sort}
                      onChange={(e) => setSort(e.target.value)}
                    >
                      <option value="newest">按添加时间</option>
                      <option value="name">按名称排序</option>
                    </select>
                  </div>
                )}
              </div>
              {displayed.length === 0 ? (
                <div className="empty">
                  <Search size={30} />
                  <h3>没有找到相关任务</h3>
                  <button
                    className="button secondary"
                    onClick={() => {
                      setSearch("");
                      setFilter("active");
                    }}
                  >
                    重置筛选
                  </button>
                </div>
              ) : (
                <TaskTable {...listProps} />
              )}
              <div className="list-footer">
                <span>
                  <ShieldCheck size={14} />
                  文件保存在 /downloads
                </span>
                <span>
                  同时下载 2 个任务
                  <ChevronRight size={13} />
                </span>
              </div>
            </>
          )}
          {view === "settings" && <Settings notify={notify} />}
          {view === "system" && <System />}
        </main>
        <footer className="app-footer">
          <span>
            <span className="status-dot" /> 所有服务正常
          </span>
          <span>
            DownKyi Web<span className="footer-dot">·</span>让收藏有迹可循
          </span>
          <button onClick={() => notify("此页面为样式原型，尚未连接下载服务")}>
            <CircleHelp size={14} />
            帮助与反馈
            <ArrowUpRight size={12} />
          </button>
        </footer>
      </div>
      {modal && (
        <NewDownload
          existingKeys={tasks
            .filter((t) => !t.filesDeleted)
            .flatMap((t) => (t.sourceKey ? [t.sourceKey] : []))}
          onClose={() => setModal(false)}
          onAdd={(drafts: DownloadDraft[]) => {
            const now = Date.now();
            setTasks((ts) => [
              ...drafts.map((draft, i) => ({
                ...draft,
                id: now + i,
                status: "queued" as Status,
                progress: 0,
                size: "待获取",
                date: "刚刚",
                createdAt: now + i,
              })),
              ...ts,
            ]);
            setModal(false);
            go("tasks");
            notify(`已加入 ${drafts.length} 个演示任务`);
          }}
        />
      )}
      {taskDetail && (
        <div className="overlay" onClick={() => setDetail(null)}>
          <section
            className="dialog detail-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="detail-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dialog-heading">
              <h2 id="detail-title">任务详情</h2>
              <IconButton label="关闭" onClick={() => setDetail(null)}>
                <X size={19} />
              </IconButton>
            </div>
            <img
              className="detail-cover"
              src={`/covers/${taskDetail.cover}.jpg`}
              alt=""
            />
            <h3>{taskDetail.title}</h3>
            <Badge status={taskDetail.status} />
            {taskDetail.status !== "failed" && (
              <ol className="stage-timeline" aria-label="任务处理阶段">
                {(
                  [
                    "queued",
                    "resolving",
                    "downloading",
                    "merging",
                    "completed",
                  ] as Status[]
                ).map((phase, i, phases) => {
                  const index = phases.indexOf(
                    taskDetail.status === "paused"
                      ? taskDetail.resumeStatus || "queued"
                      : taskDetail.status,
                  );
                  return (
                    <li
                      key={phase}
                      className={
                        i === index ? "current" : i < index ? "done" : ""
                      }
                    >
                      <span>{i < index ? <Check size={12} /> : i + 1}</span>
                      {statusLabel[phase]}
                    </li>
                  );
                })}
              </ol>
            )}
            {taskDetail.status !== "completed" && (
              <div className="demo-stage">
                <span>
                  演示任务 ·{" "}
                  {taskDetail.status === "merging"
                    ? "媒体已下载，合并校验尚未完成"
                    : "不产生真实下载"}
                </span>
                <button
                  className="button secondary"
                  disabled={
                    taskDetail.status === "failed" ||
                    taskDetail.status === "paused"
                  }
                  onClick={() => advanceDemo(taskDetail)}
                >
                  推进演示阶段
                  <ArrowRight size={14} />
                </button>
              </div>
            )}
            <dl className="detail-info">
              <div>
                <dt>UP 主</dt>
                <dd>{taskDetail.author}</dd>
              </div>
              <div>
                <dt>下载规格</dt>
                <dd>
                  {taskDetail.mode === "audio" ? "仅音频 · M4A" : "视频 · MP4"}{" "}
                  · {taskDetail.quality} · {taskDetail.codec || "AVC"}
                </dd>
              </div>
              <div>
                <dt>文件大小</dt>
                <dd>{taskDetail.size}</dd>
              </div>
              <div>
                <dt>添加时间</dt>
                <dd>{taskDetail.date}</dd>
              </div>
              <div>
                <dt>保存目录</dt>
                <dd className="path-value">
                  /downloads/{taskDetail.id}/
                  <IconButton
                    label="复制保存路径"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(
                          `/downloads/${taskDetail.id}/`,
                        );
                        notify("保存路径已复制");
                      } catch {
                        notify("当前浏览器不允许自动复制，请从详情中选取路径");
                      }
                    }}
                  >
                    <Copy size={14} />
                  </IconButton>
                </dd>
              </div>
            </dl>
            {taskDetail.status === "failed" && (
              <div className="error-note">
                <XCircle size={16} />
                视频地址已过期，请重新解析后重试。
              </div>
            )}
            {taskDetail.status === "completed" && (
              <>
                <div className="files-heading">
                  <h4>输出文件</h4>
                  {taskDetail.recordRemoved && (
                    <span className="muted">下载记录已移除</span>
                  )}
                </div>
                {taskDetail.filesDeleted ? (
                  <p className="file-missing">文件已删除，下载记录仍保留。</p>
                ) : (
                  [
                    {
                      name: `${taskDetail.title}.${taskDetail.mode === "audio" ? "m4a" : "mp4"}`,
                      size: taskDetail.size,
                    },
                    ...((taskDetail.saveCover ?? true)
                      ? [{ name: "cover.jpg", size: "186 KB" }]
                      : []),
                    ...(taskDetail.subtitles
                      ? [{ name: "zh-CN.srt", size: "24 KB" }]
                      : []),
                  ].map((file) => (
                    <div className="file-row" key={file.name}>
                      <FileVideo size={20} />
                      <div>
                        <strong>{file.name}</strong>
                        <span>{file.size}</span>
                      </div>
                      <IconButton
                        label={`下载 ${file.name}（演示）`}
                        onClick={() => notify("这是演示文件，未产生真实下载")}
                      >
                        <ArrowDownToLine size={17} />
                      </IconButton>
                    </div>
                  ))
                )}
              </>
            )}
            <div className="dialog-footer">
              {!taskDetail.recordRemoved && (
                <button
                  className="button secondary"
                  onClick={() => requestDelete(taskDetail, "record")}
                >
                  <Trash2 size={15} />
                  移除记录
                </button>
              )}
              {taskDetail.status === "completed" &&
                !taskDetail.filesDeleted && (
                  <button
                    className="button danger"
                    onClick={() => requestDelete(taskDetail, "files")}
                  >
                    <Trash2 size={15} />
                    删除文件
                  </button>
                )}
              {taskDetail.status !== "completed" && (
                <button
                  className="button secondary"
                  onClick={() => action(taskDetail)}
                >
                  {taskDetail.status === "failed"
                    ? "重新解析并重试"
                    : taskDetail.status === "paused"
                      ? "继续任务"
                      : "暂停任务"}
                </button>
              )}
              <button
                className="button secondary"
                onClick={() => setDetail(null)}
              >
                关闭
              </button>
            </div>
          </section>
        </div>
      )}
      {deleteId !== null && (
        <div className="overlay" onClick={() => setDeleteId(null)}>
          <section
            className="dialog confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="delete-title">
              {deleteMode === "files"
                ? "删除服务器上的文件？"
                : "移除这条下载记录？"}
            </h2>
            <p>
              {deleteMode === "files"
                ? "视频、音频、封面和字幕将一起删除，下载记录会保留。此操作不可撤销。"
                : "任务将停止。已完成的输出文件仍保留在文件库中，不会删除服务器文件。"}
            </p>
            {deleteMode === "files" && (
              <label className="file-delete-confirm">
                <input
                  type="checkbox"
                  checked={confirmFiles}
                  onChange={(e) => setConfirmFiles(e.target.checked)}
                />
                我确认删除该任务的全部文件
              </label>
            )}
            <div className="dialog-footer">
              <button
                className="button secondary"
                onClick={() => setDeleteId(null)}
              >
                取消
              </button>
              <button
                className="button danger-solid"
                disabled={deleteMode === "files" && !confirmFiles}
                onClick={() => {
                  setTasks((ts) =>
                    ts.flatMap((t) =>
                      t.id !== deleteId
                        ? [t]
                        : deleteMode === "files"
                          ? t.recordRemoved
                            ? []
                            : [{ ...t, filesDeleted: true }]
                          : t.status === "completed" && !t.filesDeleted
                            ? [{ ...t, recordRemoved: true }]
                            : [],
                    ),
                  );
                  setSelected((ids) => ids.filter((id) => id !== deleteId));
                  setDeleteId(null);
                  notify(
                    deleteMode === "files"
                      ? "演示文件已删除，未触及真实文件"
                      : "演示记录已移除，输出文件保留",
                  );
                }}
              >
                {deleteMode === "files" ? "永久删除文件" : "移除记录"}
              </button>
            </div>
          </section>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={17} />
          {toast}
        </div>
      )}
    </div>
  );
}

type ListProps = {
  tasks: Task[];
  selected: number[];
  toggle: (id: number) => void;
  actions: (t: Task) => React.ReactNode;
  open: (t: Task) => void;
};
function Progress({ task }: { task: Task }) {
  return (
    <div className={`progress-cell ${task.status}`}>
      <div className="progress-caption">
        {task.status === "downloading" ? (
          <>
            <span>{task.speed || "8.6 MB/s"}</span>
            <strong>{task.progress}%</strong>
          </>
        ) : (
          <>
            <span>
              {task.status === "failed"
                ? "地址已过期"
                : task.status === "queued"
                  ? "等待可用下载位"
                  : task.status === "resolving"
                    ? "重新获取播放地址"
                    : task.status === "merging"
                      ? "媒体 100% · 等待校验"
                      : task.status === "completed"
                        ? task.filesDeleted
                          ? "文件已删除"
                          : "校验完成"
                        : `已下载 ${task.progress}%`}
            </span>
            {task.status === "completed" && <Check size={14} />}
          </>
        )}
      </div>
      <div className="progress-track">
        <i style={{ width: `${task.progress}%` }} />
      </div>
    </div>
  );
}
function TaskTable({ tasks, selected, toggle, actions, open }: ListProps) {
  return (
    <div className="table-scroll">
      <table className="task-table">
        <thead>
          <tr>
            <th />
            <th>视频名称</th>
            <th>规格</th>
            <th>大小</th>
            <th>状态</th>
            <th>下载进度</th>
            <th>添加时间</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id}>
              <td>
                <input
                  aria-label={`选择 ${t.title}`}
                  type="checkbox"
                  checked={selected.includes(t.id)}
                  onChange={() => toggle(t.id)}
                />
              </td>
              <td>
                <div className="table-title">
                  <Cover task={t} />
                  <div>
                    <button className="task-title" onClick={() => open(t)}>
                      {t.title}
                    </button>
                    <span>
                      {t.author}
                      {t.mode === "audio" ? " · 仅音频" : ""}
                    </span>
                    {(t.recordRemoved || t.filesDeleted) && (
                      <span className="record-state">
                        {t.filesDeleted
                          ? "文件已删除"
                          : "记录已移除 · 文件保留"}
                      </span>
                    )}
                  </div>
                </div>
              </td>
              <td>
                <span className="quality">{t.quality}</span>
              </td>
              <td>{t.size}</td>
              <td>
                <Badge status={t.status} />
              </td>
              <td>
                <Progress task={t} />
              </td>
              <td className="time-cell">{t.date}</td>
              <td>{actions(t)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Settings({ notify }: { notify: (s: string) => void }) {
  const [concurrency, setConcurrency] = useState(2);
  const [cookie, setCookie] = useState("");
  const [cookieSet, setCookieSet] = useState(false);
  const [tab, setTab] = useState("download");
  return (
    <section className="settings-layout">
      <nav className="settings-nav">
        {[
          { id: "download", name: "下载设置", icon: Download },
          { id: "storage", name: "存储与文件", icon: HardDrive },
          { id: "account", name: "哔哩哔哩账户", icon: ShieldCheck },
        ].map(({ id, name, icon: Icon }) => (
          <button
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
            key={id}
          >
            <Icon size={16} />
            {name}
            <ChevronRight size={14} />
          </button>
        ))}
      </nav>
      <div className="settings-content">
        {tab === "download" ? (
          <>
            <h2>下载设置</h2>
            <div className="setting-row">
              <div>
                <strong>同时下载任务数</strong>
                <span>超过数量的任务将进入等待队列</span>
              </div>
              <div className="stepper">
                <button
                  aria-label="减少并发"
                  disabled={concurrency <= 1}
                  onClick={() => setConcurrency((v) => v - 1)}
                >
                  −
                </button>
                <output>{concurrency}</output>
                <button
                  aria-label="增加并发"
                  disabled={concurrency >= 4}
                  onClick={() => setConcurrency((v) => v + 1)}
                >
                  +
                </button>
              </div>
            </div>
            <div className="setting-row">
              <div>
                <strong>默认视频画质</strong>
                <span>以账户可用画质为准</span>
              </div>
              <select defaultValue="best">
                <option value="best">最佳画质</option>
                <option>1080P</option>
                <option>720P</option>
              </select>
            </div>
            <div className="setting-row">
              <div>
                <strong>同时下载封面</strong>
                <span>将视频封面保存在相同目录</span>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  aria-label="同时下载封面"
                  defaultChecked
                />
                <span />
              </label>
            </div>
            <div className="setting-row">
              <div>
                <strong>同时下载字幕</strong>
                <span>保存视频提供的字幕文件</span>
              </div>
              <label className="toggle">
                <input type="checkbox" aria-label="同时下载字幕" />
                <span />
              </label>
            </div>
            <div className="setting-row">
              <div>
                <strong>自动开始新任务</strong>
                <span>添加后直接进入下载队列</span>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  aria-label="自动开始新任务"
                  defaultChecked
                />
                <span />
              </label>
            </div>
          </>
        ) : tab === "storage" ? (
          <>
            <h2>存储与文件</h2>
            <div className="setting-row">
              <div>
                <strong>下载目录</strong>
                <span>服务器挂载目录</span>
              </div>
              <code>/downloads</code>
            </div>
            <div className="setting-row">
              <div>
                <strong>文件命名</strong>
                <span>视频名称与分 P 编号</span>
              </div>
              <code>标题_P序号.mp4</code>
            </div>
            <div className="setting-row">
              <div>
                <strong>可用空间</strong>
                <span>home-server</span>
              </div>
              <strong>379.6 GB</strong>
            </div>
          </>
        ) : (
          <>
            <h2>哔哩哔哩账户</h2>
            <div className="setting-row">
              <div>
                <strong>登录凭据</strong>
                <span>Cookie 不会在界面中回显</span>
              </div>
              <Badge status={cookieSet ? "completed" : "paused"} />
            </div>
            <label className="field-label" htmlFor="cookies">
              Netscape Cookie
            </label>
            <textarea
              id="cookies"
              value={cookie}
              onChange={(e) => setCookie(e.target.value)}
              placeholder="# Netscape HTTP Cookie File"
              rows={7}
            />
            <div className="cookie-buttons">
              <button
                className="button secondary"
                onClick={() => {
                  setCookieSet(false);
                  setCookie("");
                  notify("已清除演示凭据");
                }}
              >
                清除凭据
              </button>
              <button
                className="button primary"
                disabled={!cookie.trim()}
                onClick={() => {
                  setCookieSet(true);
                  setCookie("");
                  notify("演示凭据已导入，未发送到服务器");
                }}
              >
                导入 Cookie
              </button>
            </div>
          </>
        )}
        <div className="settings-save">
          <button
            className="button primary"
            onClick={() => notify("偏好设置已在当前演示中保存")}
          >
            <Check size={16} />
            保存更改
          </button>
        </div>
      </div>
    </section>
  );
}
function System() {
  return (
    <section className="system-content">
      <div className="server-identity">
        <div className="server-identity-icon">
          <Server size={32} />
        </div>
        <div>
          <h2>home-server</h2>
          <p>Linux · x86_64 · Docker</p>
        </div>
        <span className="badge completed">运行中</span>
      </div>
      <div className="system-metrics">
        <div>
          <span>可用磁盘空间</span>
          <strong>
            379.6 <small>GB</small>
          </strong>
          <div className="storage-track">
            <i />
          </div>
          <p>总容量 500 GB</p>
        </div>
        <div>
          <span>下载服务</span>
          <strong>正常</strong>
          <p>已运行 3 天 12 小时</p>
        </div>
        <div>
          <span>活跃任务</span>
          <strong>
            2 <small>/ 2</small>
          </strong>
          <p>1 个任务等待中</p>
        </div>
      </div>
      <h3>运行环境</h3>
      <dl className="environment">
        <div>
          <dt>应用版本</dt>
          <dd>DownKyi Web 0.1.0</dd>
        </div>
        <div>
          <dt>下载引擎</dt>
          <dd>
            yt-dlp<span className="badge completed">就绪</span>
          </dd>
        </div>
        <div>
          <dt>媒体处理</dt>
          <dd>
            FFmpeg<span className="badge completed">就绪</span>
          </dd>
        </div>
        <div>
          <dt>数据库</dt>
          <dd>SQLite</dd>
        </div>
        <div>
          <dt>下载目录</dt>
          <dd>/downloads</dd>
        </div>
        <div>
          <dt>数据目录</dt>
          <dd>/data</dd>
        </div>
      </dl>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
