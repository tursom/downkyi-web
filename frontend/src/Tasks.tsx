import { Fragment, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Inbox,
  LayoutGrid,
  Layers,
  List,
  MonitorPlay,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { api, errorMessage, isAbort, taskPath } from "./api";
import { bytes, dateTime, percent } from "./format";
import {
  EmptyState,
  ErrorNotice,
  IconButton,
  Spinner,
  SuccessNotice,
  Thumbnail,
} from "./components";
import TaskDetail, {
  canPlay,
  DeleteConfirmation,
  isActive,
  Progress,
  type DeleteRequest,
} from "./TaskDetail";
import { collectionSource, groupSummary, groupTasks } from "./grouping";
import type { Task } from "./types";
// ArtPlayer is only needed after the user chooses to play something.
const Player = lazy(() => import("./Player"));
type Filter = "all" | "running" | "queued" | "paused" | "failed" | "completed" | "retained";
function matchesFilter(task: Task, filter: Filter) {
  switch (filter) {
    case "all":
      return true;
    case "running":
      return ["resolving", "downloading", "merging"].includes(task.status);
    case "retained":
      return task.record_removed && task.status !== "completed";
    default:
      return task.status === filter;
  }
}
const queueFilters: [Filter, string][] = [
  ["all", "全部"],
  ["running", "进行中"],
  ["queued", "等待中"],
  ["paused", "已暂停"],
  ["failed", "下载失败"],
];
const libraryFilters: [Filter, string][] = [
  ["all", "全部"],
  ["completed", "已完成"],
  ["retained", "待清理"],
];
// View preferences are per-browser conveniences; storage may be unavailable.
function loadPreference<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : (JSON.parse(value) as T);
  } catch {
    return fallback;
  }
}
function savePreference(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Ignore: the view still works for this visit. */
  }
}
const GROUP_VIEW = "downkyi:group-view";
const COLLAPSED = "downkyi:collapsed-groups";
const LIBRARY_VIEW = "downkyi:library-view";
function specification(task: Task) {
  if (task.mode === "audio") return ["仅音频"];
  return [task.quality === "best" ? "最佳画质" : `${task.quality}P`, task.codec.toUpperCase()];
}
function recordState(task: Task) {
  if (task.files_deleted) return "文件已删除";
  if (!task.record_removed) return "";
  return task.status !== "completed" ? "记录已移除 · 临时文件待清理" : "记录已移除 · 文件保留";
}
export default function Tasks({
  tasks,
  loading,
  error,
  refresh,
  onNew,
  onCheckUpdates,
  message,
  library = false,
  downloadDir,
}: {
  tasks: Task[] | undefined;
  loading: boolean;
  error: string;
  refresh: () => void;
  onNew: () => void;
  /** Re-read a collection's list to find and queue videos added since. */
  onCheckUpdates?: (group: string, url: string) => void;
  message: string;
  library?: boolean;
  downloadDir?: string;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("newest");
  const [grouped, setGrouped] = useState(() => loadPreference(GROUP_VIEW, true));
  const [layout, setLayout] = useState<"grid" | "list">(() => loadPreference(LIBRARY_VIEW, "grid"));
  const [collapsed, setCollapsed] = useState<string[]>(() => loadPreference(COLLAPSED, []));
  function toggleGroup(name: string) {
    setCollapsed((names) => {
      const next = names.includes(name) ? names.filter((item) => item !== name) : [...names, name];
      savePreference(COLLAPSED, next);
      return next;
    });
  }
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState<string[]>([]);
  const pendingRef = useRef(new Set<string>());
  const requests = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    requests.current = controller;
    return () => controller.abort();
  }, []);
  const [actionError, setActionError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [detail, setDetail] = useState<string>();
  const [deleting, setDeleting] = useState<DeleteRequest>();
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(""), 6000);
    return () => clearTimeout(timer);
  }, [feedback]);
  useEffect(() => {
    setSelected((ids) =>
      ids.filter((id) => tasks?.some((task) => task.id === id)),
    );
  }, [tasks]);
  const visible = (tasks ?? [])
    .filter(
      (task) =>
        matchesFilter(task, filter) &&
        `${task.title} ${task.group ?? ""} ${task.url}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.title.localeCompare(b.title, "zh")
        : sort === "oldest"
          ? a.created_at.localeCompare(b.created_at)
          : b.created_at.localeCompare(a.created_at),
    );
  const taskDetail = tasks?.find((task) => task.id === detail);
  const [playing, setPlaying] = useState<string>();
  const taskPlaying = tasks?.find((task) => task.id === playing);
  async function action(
    task: Task,
    operation = isActive(task) ? "pause" : "resume",
  ) {
    const request = requests.current;
    if (!request || request.signal.aborted || pendingRef.current.has(task.id))
      return;
    pendingRef.current.add(task.id);
    setPending([...pendingRef.current]);
    try {
      await api(taskPath(task.id, `/${operation}`), {
        method: "POST",
        signal: request.signal,
      });
      if (!request.signal.aborted) refresh();
    } catch (cause) {
      if (!request.signal.aborted && !isAbort(cause))
        setActionError((previous) =>
          [previous, `${task.title}：${errorMessage(cause)}`]
            .filter(Boolean)
            .join("\n"),
        );
    } finally {
      pendingRef.current.delete(task.id);
      if (!request.signal.aborted) setPending([...pendingRef.current]);
    }
  }
  function singleAction(task: Task) {
    setActionError("");
    void action(task);
  }
  async function batch(operation: "pause" | "resume") {
    setActionError("");
    const targets = visible.filter(
      (task) =>
        selected.includes(task.id) &&
        (operation === "pause"
          ? isActive(task)
          : ["paused", "failed"].includes(task.status)),
    );
    // Sequential mutations avoid flooding the single-user worker and retain individual failures.
    const request = requests.current;
    for (const task of targets) {
      if (!request || request.signal.aborted) return;
      await action(task, operation);
    }
    if (!request?.signal.aborted) setSelected([]);
  }
  function openDetail(task: Task) {
    setActionError("");
    setDetail(task.id);
  }
  const allSelected =
    visible.length > 0 && visible.every((task) => selected.includes(task.id));
  const selectedTasks = visible.filter((task) => selected.includes(task.id));
  function meta(task: Task, inGroup: boolean) {
    const parts = [
      !inGroup && task.group && task.group !== task.title ? task.group : "",
      ...specification(task),
      task.total_bytes != null ? bytes(task.total_bytes) : "",
    ].filter(Boolean);
    return (
      <span className="task-meta">
        {parts.map((part, index) => (
          <span key={index} className={index === 0 && part === task.group ? "task-group" : undefined}>
            {part}
          </span>
        ))}
      </span>
    );
  }
  function title(task: Task) {
    return (
      <button className="task-title" title={task.title} onClick={() => openDetail(task)}>
        {task.title}
      </button>
    );
  }
  function detailButton(task: Task) {
    return (
      <IconButton
        label={`${library ? "查看文件" : "任务详情"}：${task.title}`}
        onClick={() => openDetail(task)}
      >
        <MoreHorizontal size={18} />
      </IconButton>
    );
  }
  function renderRow(task: Task, inGroup = false) {
    const state = recordState(task);
    return (
      <div
        role="listitem"
        key={task.id}
        className={`task-row${inGroup ? " group-member" : ""}${library ? " library" : ""}${selected.includes(task.id) ? " selected" : ""}`}
      >
        {!library && (
          <input
            type="checkbox"
            aria-label={`选择 ${task.title}`}
            checked={selected.includes(task.id)}
            onChange={() =>
              setSelected((ids) =>
                ids.includes(task.id)
                  ? ids.filter((id) => id !== task.id)
                  : [...ids, task.id],
              )
            }
          />
        )}
        <Thumbnail src={task.thumbnail} title={task.title} />
        <div className="task-main">
          {title(task)}
          {task.error && task.status === "failed" ? (
            <span className="task-meta task-error">
              <AlertCircle size={13} />
              <span>{task.error}</span>
            </span>
          ) : (
            meta(task, inGroup)
          )}
          {state && <span className="record-state">{state}</span>}
        </div>
        {library ? (
          <span className="task-date">{dateTime(task.created_at)}</span>
        ) : (
          <Progress task={task} />
        )}
        <div className="row-actions">
          {canPlay(task) ? (
            <IconButton
              label={`播放：${task.title}`}
              onClick={() => setPlaying(task.id)}
            >
              <MonitorPlay size={17} />
            </IconButton>
          ) : (
            !library &&
            task.status !== "completed" && (
              <IconButton
                label={`${isActive(task) ? "暂停" : task.status === "failed" ? "重试" : "恢复"}：${task.title}`}
                disabled={pending.includes(task.id)}
                onClick={() => singleAction(task)}
              >
                {isActive(task) ? (
                  <Pause size={17} />
                ) : task.status === "failed" ? (
                  <RefreshCw size={17} />
                ) : (
                  <Play size={17} />
                )}
              </IconButton>
            )
          )}
          {detailButton(task)}
        </div>
      </div>
    );
  }
  function renderCard(task: Task, inGroup = false) {
    const state = recordState(task);
    const cover = <Thumbnail src={task.thumbnail} title={task.title} />;
    return (
      <article role="listitem" key={task.id} className="media-card">
        {canPlay(task) ? (
          <button
            className="media-cover"
            aria-label={`播放：${task.title}`}
            onClick={() => setPlaying(task.id)}
          >
            {cover}
            <span className="media-play" aria-hidden="true">
              <Play size={20} fill="currentColor" />
            </span>
          </button>
        ) : (
          <div className="media-cover">{cover}</div>
        )}
        <div className="media-info">
          <div>
            {title(task)}
            {meta(task, inGroup)}
            {state && <span className="record-state">{state}</span>}
          </div>
          {detailButton(task)}
        </div>
      </article>
    );
  }
  function groupHeader(name: string, members: Task[]) {
    const open = !collapsed.includes(name);
    const summary = groupSummary(members);
    const chosen = members.filter((task) => selected.includes(task.id)).length;
    const value = percent(summary.progress);
    const source = collectionSource(members);
    const status = summary.completed === members.length ? "completed" : summary.failed ? "failed" : "downloading";
    return (
      <>
        {!library && (
          <input
            type="checkbox"
            aria-label={`选择合集 ${name}`}
            checked={chosen === members.length}
            ref={(node) => {
              if (node) node.indeterminate = chosen > 0 && chosen < members.length;
            }}
            onChange={() =>
              setSelected((ids) =>
                chosen === members.length
                  ? ids.filter((id) => !members.some((task) => task.id === id))
                  : [...new Set([...ids, ...members.map((task) => task.id)])],
              )
            }
          />
        )}
        <button
          className="group-toggle"
          aria-expanded={open}
          title={name}
          onClick={() => toggleGroup(name)}
        >
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <strong>{name}</strong>
          <span>{members.length} 个视频</span>
        </button>
        <span className="group-stats">
          {summary.size != null && <span>{bytes(summary.size)}</span>}
          {/* The download list holds no finished tasks, so "0 done" would only mislead there. */}
          {(library || summary.completed > 0) && (
            <span>已完成 {summary.completed}/{members.length}</span>
          )}
          {summary.active > 0 && <span className="active">进行中 {summary.active}</span>}
          {summary.paused > 0 && <span>已暂停 {summary.paused}</span>}
          {summary.failed > 0 && <span className="failed">失败 {summary.failed}</span>}
        </span>
        <div
          className={`group-progress ${status}`}
          role="progressbar"
          aria-label={`${name} 合集进度`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={value}
        >
          <i style={{ width: `${value}%` }} />
        </div>
        {onCheckUpdates && source && (
          <button
            className="group-update"
            title={`检查「${name}」是否有新视频`}
            aria-label={`检查更新：${name}`}
            onClick={() => onCheckUpdates(name, source)}
          >
            <RefreshCw size={14} />
            <span>检查更新</span>
          </button>
        )}
      </>
    );
  }
  function renderList() {
    return (
      <div className="task-list" role="list" aria-label={library ? "媒体库列表" : "任务列表"}>
        {grouped
          ? groupTasks(visible, sort).map((section) =>
              section.kind === "task" ? (
                renderRow(section.task)
              ) : (
                <Fragment key={`group:${section.name}`}>
                  <div role="listitem" className="group-row">
                    {groupHeader(section.name, section.tasks)}
                  </div>
                  {!collapsed.includes(section.name) &&
                    section.tasks.map((task) => renderRow(task, true))}
                </Fragment>
              ),
            )
          : visible.map((task) => renderRow(task))}
      </div>
    );
  }
  function renderGrid() {
    if (!grouped)
      return (
        <div className="media-grid" role="list" aria-label="媒体库列表">
          {visible.map((task) => renderCard(task))}
        </div>
      );
    // Consecutive standalone videos share one grid; each collection gets its own section.
    const blocks: ReactNode[] = [];
    let loose: Task[] = [];
    const flush = () => {
      if (!loose.length) return;
      blocks.push(
        <div className="media-grid" role="list" aria-label="单个视频" key={`loose:${loose[0].id}`}>
          {loose.map((task) => renderCard(task))}
        </div>,
      );
      loose = [];
    };
    for (const section of groupTasks(visible, sort)) {
      if (section.kind === "task") {
        loose.push(section.task);
        continue;
      }
      flush();
      blocks.push(
        <section className="media-group" key={`group:${section.name}`} aria-label={section.name}>
          <div className="group-row">{groupHeader(section.name, section.tasks)}</div>
          {!collapsed.includes(section.name) && (
            <div className="media-grid" role="list" aria-label={section.name}>
              {section.tasks.map((task) => renderCard(task, true))}
            </div>
          )}
        </section>,
      );
    }
    flush();
    return <div className="media-library">{blocks}</div>;
  }
  const downloading = tasks?.filter((task) => task.status === "downloading") ?? [];
  const summary = !tasks
    ? "正在读取…"
    : library
      ? `${tasks.length} 个文件记录 · 共 ${bytes(tasks.reduce((sum, task) => sum + (task.total_bytes ?? 0), 0))}`
      : [
          downloading.length
            ? `${downloading.length} 个正在下载 · 总速度 ${bytes(downloading.reduce((sum, task) => sum + (task.speed ?? 0), 0))}/s`
            : "没有正在下载的任务",
          `${tasks.filter((task) => task.status === "queued").length} 个排队`,
        ].join(" · ");
  return (
    <>
      <header className="page-heading">
        <h1>{library ? "媒体库" : "下载"}</h1>
        <p className="page-summary">{summary}</p>
      </header>
      <ErrorNotice message={error} retry={refresh} />
      {!taskDetail && <ErrorNotice message={actionError} />}
      <SuccessNotice message={message || feedback} />
      <section aria-label={library ? "媒体库" : "下载任务"}>
        <div className="list-toolbar">
          <div className="chips" aria-label="任务状态">
            {(library ? libraryFilters : queueFilters).map(([value, label]) => {
              const count = tasks ? tasks.filter((task) => matchesFilter(task, value)).length : "?";
              return (
                <button
                  key={value}
                  aria-pressed={filter === value}
                  className={`chip${filter === value ? " active" : ""}${value === "failed" && count ? " warn" : ""}`}
                  onClick={() => {
                    setFilter(value);
                    setSelected([]);
                  }}
                >
                  {label}
                  <span>{count}</span>
                </button>
              );
            })}
          </div>
          <label className="search">
            <Search size={16} />
            <input
              aria-label="搜索任务"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setSelected([]);
              }}
              placeholder={library ? "搜索已下载的视频" : "搜索标题、合集或链接"}
            />
            {search && (
              <IconButton label="清空搜索" onClick={() => setSearch("")}>
                <X size={14} />
              </IconButton>
            )}
          </label>
          <div className="view-controls">
            <button
              className={`toggle${grouped ? " active" : ""}`}
              aria-pressed={grouped}
              onClick={() => {
                setGrouped(!grouped);
                savePreference(GROUP_VIEW, !grouped);
              }}
            >
              <Layers size={15} />
              按合集分组
            </button>
            <select
              aria-label="排序方式"
              value={sort}
              onChange={(event) => setSort(event.target.value)}
            >
              <option value="newest">最新添加</option>
              <option value="oldest">最早添加</option>
              <option value="name">按名称</option>
            </select>
            {library && (
              <div className="segmented-view" role="group" aria-label="显示方式">
                {(["grid", "list"] as const).map((value) => (
                  <button
                    key={value}
                    aria-label={value === "grid" ? "封面视图" : "列表视图"}
                    title={value === "grid" ? "封面视图" : "列表视图"}
                    aria-pressed={layout === value}
                    className={layout === value ? "active" : ""}
                    onClick={() => {
                      setLayout(value);
                      savePreference(LIBRARY_VIEW, value);
                    }}
                  >
                    {value === "grid" ? <LayoutGrid size={15} /> : <List size={15} />}
                  </button>
                ))}
              </div>
            )}
            <IconButton label="刷新任务" onClick={refresh} disabled={loading}>
              <RefreshCw size={16} className={loading ? "spin" : ""} />
            </IconButton>
          </div>
        </div>
        {!library && visible.length > 0 && (
          <div className={`list-head${selectedTasks.length ? " selecting" : ""}`}>
            <label className="check-label">
              <input
                type="checkbox"
                aria-label="全选任务"
                checked={allSelected}
                ref={(node) => {
                  if (node)
                    node.indeterminate = !allSelected && selectedTasks.length > 0;
                }}
                onChange={() =>
                  setSelected(allSelected ? [] : visible.map((task) => task.id))
                }
              />
              <span>
                {selectedTasks.length
                  ? `已选 ${selectedTasks.length} 项`
                  : `${visible.length} 个任务`}
              </span>
            </label>
            {selectedTasks.length > 0 && (
              <div className="batch-actions">
                <button
                  className="button secondary small"
                  disabled={pending.length > 0 || !selectedTasks.some(isActive)}
                  onClick={() => void batch("pause")}
                >
                  <Pause size={14} />
                  暂停
                </button>
                <button
                  className="button secondary small"
                  disabled={
                    pending.length > 0 ||
                    !selectedTasks.some((task) =>
                      ["paused", "failed"].includes(task.status),
                    )
                  }
                  onClick={() => void batch("resume")}
                >
                  <Play size={14} />
                  继续
                </button>
                <button className="button ghost small" onClick={() => setSelected([])}>
                  取消选择
                </button>
              </div>
            )}
          </div>
        )}
        {loading && !tasks ? (
          <div className="section-loading">
            <Spinner label="正在加载任务" />
          </div>
        ) : !tasks ? (
          <EmptyState icon={<Inbox size={30} />} title="暂时无法加载任务" />
        ) : !visible.length ? (
          <EmptyState
            icon={library ? <FolderOpen size={30} /> : <Inbox size={30} />}
            title={
              search || filter !== "all"
                ? "没有匹配的任务"
                : library
                  ? "媒体库暂无文件"
                  : "还没有下载任务"
            }
          >
            {search || filter !== "all" ? (
              <button
                className="button secondary"
                onClick={() => {
                  setSearch("");
                  setFilter("all");
                }}
              >
                重置筛选
              </button>
            ) : (
              <button className="button primary" onClick={onNew}>
                <Plus size={16} />
                新建下载
              </button>
            )}
          </EmptyState>
        ) : library && layout === "grid" ? (
          renderGrid()
        ) : (
          renderList()
        )}
        {!library && downloadDir && (
          <p className="list-footer">
            <FolderOpen size={14} />
            保存到 <code>{downloadDir}</code>
          </p>
        )}
      </section>
      {taskDetail && !deleting && (
        <TaskDetail
          task={taskDetail}
          onClose={() => setDetail(undefined)}
          onDelete={(mode) => {
            setDetail(undefined);
            setDeleting({ task: taskDetail, mode });
          }}
          onAction={() => singleAction(taskDetail)}
          onPlay={() => {
            setDetail(undefined);
            setPlaying(taskDetail.id);
          }}
          busy={pending.includes(taskDetail.id)}
          error={actionError}
        />
      )}
      {taskPlaying && canPlay(taskPlaying) && (
        <Suspense fallback={null}>
          <Player task={taskPlaying} onClose={() => setPlaying(undefined)} />
        </Suspense>
      )}
      {deleting && (
        <DeleteConfirmation
          request={deleting}
          onClose={() => setDeleting(undefined)}
          onDone={() => {
            setFeedback(
              deleting.mode === "files"
                ? "文件已删除，下载记录已保留"
                : "记录已移除，下载文件已保留",
            );
            setDeleting(undefined);
            refresh();
          }}
        />
      )}
    </>
  );
}
