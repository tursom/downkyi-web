import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  CheckCheck,
  FolderOpen,
  Inbox,
  ListFilter,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { api, errorMessage, isAbort, taskPath } from "./api";
import { bytes, dateTime } from "./format";
import {
  EmptyState,
  ErrorNotice,
  IconButton,
  Spinner,
  SuccessNotice,
  Thumbnail,
} from "./components";
import TaskDetail, {
  Badge,
  DeleteConfirmation,
  isActive,
  Progress,
  statuses,
  type DeleteRequest,
} from "./TaskDetail";
import type { Task, TaskStatus } from "./types";
type Filter = "all" | "retained" | TaskStatus;
function matchesFilter(task: Task, filter: Filter) {
  return filter === "all" || (filter === "retained" ? task.record_removed && task.status !== "completed" : task.status === filter);
}
const filters: Filter[] = [
  "all",
  "downloading",
  "resolving",
  "merging",
  "queued",
  "paused",
  "failed",
  "completed",
];
export default function Tasks({
  tasks,
  loading,
  error,
  refresh,
  onNew,
  onBrowse,
  message,
  library = false,
  downloadDir,
}: {
  tasks: Task[] | undefined;
  loading: boolean;
  error: string;
  refresh: () => void;
  onNew: () => void;
  onBrowse: () => void;
  message: string;
  library?: boolean;
  downloadDir?: string;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("newest");
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
        `${task.title} ${task.url}`
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
  const allSelected =
    visible.length > 0 && visible.every((task) => selected.includes(task.id));
  const selectedTasks = visible.filter((task) => selected.includes(task.id));
  return (
    <>
      <header className="page-heading">
        <div>
          <div className="eyebrow">{library ? "LIBRARY" : "DOWNLOADS"}</div>
          <h1>
            {library ? "我的媒体库" : "下载队列"}
            <span className="title-count">{tasks?.length ?? ""}</span>
          </h1>
        </div>
        <div className="heading-actions">
          <button
            className="button secondary heading-folder"
            onClick={onBrowse}
          >
            <FolderOpen size={16} />
            {library ? "下载队列" : "浏览文件"}
          </button>
          <button className="button primary" onClick={onNew}>
            <Plus size={18} />
            新建下载
          </button>
        </div>
      </header>
      {!library && (
        <section className="metrics" aria-label="下载概况">
          <div className="metric">
            <div className="metric-icon teal">
              <ArrowDown size={20} />
            </div>
            <div>
              <span>正在下载</span>
              <strong>
                {tasks
                  ? tasks.filter((task) => task.status === "downloading").length
                  : "待加载"}
                <small>个任务</small>
              </strong>
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
                  ? bytes(
                      tasks
                        .filter((task) => task.status === "downloading")
                        .reduce((sum, task) => sum + (task.speed ?? 0), 0),
                    )
                  : "待加载"}
                <small>/s</small>
              </strong>
            </div>
          </div>
          <div className="metric">
            <div className="metric-icon gray">
              <CheckCheck size={21} />
            </div>
            <div>
              <span>已完成</span>
              <strong>
                {tasks
                  ? tasks.filter((task) => task.status === "completed").length
                  : "待加载"}
                <small>个任务</small>
              </strong>
            </div>
          </div>
        </section>
      )}
      <ErrorNotice message={error} retry={refresh} />
      {!taskDetail && <ErrorNotice message={actionError} />}
      <SuccessNotice message={message || feedback} />
      <section aria-label={library ? "媒体库列表" : "任务列表"}>
        <div className="list-toolbar">
          <div className="tabs" aria-label="任务状态">
            {(library ? (["all", "completed", "retained"] as const) : filters).map((value) => (
              <button
                key={value}
                aria-pressed={filter === value}
                className={filter === value ? "active" : ""}
                onClick={() => {
                  setFilter(value);
                  setSelected([]);
                }}
              >
                {value === "all"
                  ? library
                    ? "全部文件"
                    : "全部任务"
                  : value === "retained" ? "待清理" : statuses[value]}
                <span>
                  {tasks
                    ? tasks.filter(
                        (task) => matchesFilter(task, value),
                      ).length
                    : "?"}
                </span>
              </button>
            ))}
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
              placeholder="搜索名称或链接"
            />
            {search && (
              <IconButton label="清空搜索" onClick={() => setSearch("")}>
                <X size={14} />
              </IconButton>
            )}
          </label>
        </div>
        <div className="list-subbar">
          <label className="check-label">
            <input
              type="checkbox"
              aria-label="全选任务"
              checked={allSelected}
              ref={(node) => {
                if (node)
                  node.indeterminate = !allSelected && selectedTasks.length > 0;
              }}
              disabled={!visible.length}
              onChange={() =>
                setSelected(allSelected ? [] : visible.map((task) => task.id))
              }
            />
            <span>
              {selectedTasks.length
                ? `已选 ${selectedTasks.length} 项`
                : `${visible.length} 个${library ? "文件记录" : "任务"}`}
            </span>
          </label>
          {selectedTasks.length > 0 && !library && (
            <div className="batch-actions">
              <button
                disabled={pending.length > 0 || !selectedTasks.some(isActive)}
                onClick={() => void batch("pause")}
              >
                <Pause size={14} />
                暂停
              </button>
              <button
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
            </div>
          )}
          <div className="sort-control">
            <ListFilter size={14} />
            <select
              aria-label="排序方式"
              value={sort}
              onChange={(event) => setSort(event.target.value)}
            >
              <option value="newest">按添加时间</option>
              <option value="oldest">最早添加</option>
              <option value="name">按名称排序</option>
            </select>
            <IconButton label="刷新任务" onClick={refresh} disabled={loading}>
              <RefreshCw size={16} className={loading ? "spin" : ""} />
            </IconButton>
          </div>
        </div>
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
        ) : (
          <div
            className="table-scroll"
            role="region"
            aria-label="任务表格"
            tabIndex={0}
          >
            <table className="task-table">
              <thead>
                <tr>
                  <th>
                    <span className="sr-only">选择</span>
                  </th>
                  <th>视频名称</th>
                  <th>规格</th>
                  <th>大小</th>
                  <th>状态</th>
                  <th>下载进度</th>
                  <th>添加时间</th>
                  <th>
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((task) => (
                  <tr key={task.id}>
                    <td>
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
                    </td>
                    <td>
                      <div className="table-title">
                        <Thumbnail src={task.thumbnail} title={task.title} />
                        <div>
                          <button
                            className="task-title"
                            title={task.title}
                            onClick={() => {
                              setActionError("");
                              setDetail(task.id);
                            }}
                          >
                            {task.title}
                          </button>
                          <span>
                            {task.mode === "audio"
                              ? "仅音频"
                              : task.codec.toUpperCase()}
                          </span>
                          {(task.record_removed || task.files_deleted) && (
                            <span className="record-state">
                              {task.files_deleted
                                ? "文件已删除"
                                : task.status !== "completed" ? "记录已移除 · 临时文件待清理" : "记录已移除 · 文件保留"}
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="quality">
                        {task.mode === "audio"
                          ? "音频"
                          : task.quality === "best"
                            ? "最佳"
                            : task.quality}
                      </span>
                    </td>
                    <td>{bytes(task.total_bytes)}</td>
                    <td>
                      <Badge status={task.status} />
                    </td>
                    <td>
                      <Progress task={task} />
                    </td>
                    <td className="time-cell">{dateTime(task.created_at)}</td>
                    <td>
                      <div className="row-actions">
                        {task.status === "completed" ? (
                          <IconButton
                            label={`查看文件：${task.title}`}
                            onClick={() => setDetail(task.id)}
                          >
                            <FolderOpen size={17} />
                          </IconButton>
                        ) : (
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
                        )}
                        <IconButton
                          label={`任务详情：${task.title}`}
                          onClick={() => {
                            setActionError("");
                            setDetail(task.id);
                          }}
                        >
                          <MoreHorizontal size={19} />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <footer className="list-footer">
          <span>
            <ShieldCheck size={14} />
            {downloadDir || "服务器存储空间"}
          </span>
          <span>
            {error
              ? "数据未更新 · 正在重连"
              : loading
                ? "正在更新"
                : tasks
                  ? `${visible.length} 条记录`
                  : "等待服务器数据"}
          </span>
        </footer>
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
          busy={pending.includes(taskDetail.id)}
          error={actionError}
        />
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
