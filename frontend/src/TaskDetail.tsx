import {
  Check,
  Download,
  File,
  FolderOpen,
  Pause,
  Play,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { api, downloadUrl, errorMessage, taskPath } from "./api";
import { bytes, dateTime, duration, percent } from "./format";
import {
  EmptyState,
  ErrorNotice,
  Modal,
  Spinner,
  Thumbnail,
} from "./components";
import { useQuery } from "./hooks";
import { useState } from "react";
import type { Task, TaskFile, TaskStatus } from "./types";
export const statuses: Record<TaskStatus, string> = {
  queued: "等待中",
  resolving: "解析资源",
  downloading: "下载中",
  merging: "合并校验",
  paused: "已暂停",
  completed: "已完成",
  failed: "下载失败",
};
export const isActive = (task: Task) =>
  ["queued", "resolving", "downloading", "merging"].includes(task.status);
export function Badge({ status }: { status: TaskStatus }) {
  return (
    <span className={`badge ${status}`}>
      <span className="status-dot" />
      {statuses[status]}
    </span>
  );
}
export function Progress({ task }: { task: Task }) {
  const value = percent(task.progress);
  return (
    <div className={`progress-cell ${task.status}`}>
      <div className="progress-caption">
        <span>
          {task.status === "downloading"
            ? `${bytes(task.speed)}/s`
            : task.files_deleted
              ? "文件已删除"
              : statuses[task.status]}
        </span>
        <strong>{value.toFixed(1)}%</strong>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-label={`${task.title} 下载进度`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
      >
        <i style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}
function TaskFiles({ task }: { task: Task }) {
  const files = useQuery<{ files: TaskFile[] }>(taskPath(task.id, "/files"));
  return (
    <section aria-label="输出文件">
      <div className="files-heading">
        <h3>输出文件</h3>
        {task.record_removed && (
          <span className="muted">记录已移除 · 文件保留</span>
        )}
      </div>
      <ErrorNotice message={files.error} retry={files.refresh} />
      {files.loading && !files.data ? (
        <Spinner label="正在读取文件" />
      ) : files.data?.files.length === 0 ? (
        <EmptyState
          icon={<FolderOpen size={24} />}
          title={task.files_deleted ? "文件已删除，记录仍保留" : task.record_removed && task.status !== "completed" ? "保留了未完成的临时文件" : "暂无可用文件"}
        >{task.record_removed && task.status !== "completed" && !task.files_deleted && <p className="muted">临时文件未通过完成校验，不提供下载。可删除文件以释放服务器空间。</p>}</EmptyState>
      ) : (
        files.data?.files.map((file, index) => {
          const href = downloadUrl(file.url);
          return (
            <div className="file-row" key={`${file.name}-${index}`}>
              <File size={20} />
              <div>
                <strong>{file.name}</strong>
                <span>{bytes(file.size)}</span>
              </div>
              {href ? (
                <a
                  className="icon-button"
                  href={href}
                  download
                  aria-label={`下载 ${file.name}`}
                  title={`下载 ${file.name}`}
                >
                  <Download size={17} />
                </a>
              ) : (
                <span className="muted">链接不可用</span>
              )}
            </div>
          );
        })
      )}
    </section>
  );
}
export type DeleteRequest = { task: Task; mode: "record" | "files" };
export function DeleteConfirmation({
  request,
  onClose,
  onDone,
}: {
  request: DeleteRequest;
  onClose: () => void;
  onDone: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const files = request.mode === "files";
  async function remove() {
    if (busy || (files && !confirmed)) return;
    setBusy(true);
    setError("");
    try {
      await api(taskPath(request.task.id, files ? "/files" : ""), {
        method: "DELETE",
      });
      onDone();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={files ? "删除服务器上的文件？" : "移除这条下载记录？"}
      onClose={onClose}
      busy={busy}
      className="confirm-dialog"
    >
      <p className="delete-title">{request.task.title}</p>
      <p className="muted">
        {files
          ? "该任务的输出文件和临时文件将永久删除，下载记录会保留。此操作不可撤销。"
          : "任务将停止并移除记录，不会删除已下载的文件。输出文件和未完成的临时文件仍可在媒体库中查看或清理。"}
      </p>
      {files && (
        <label className="file-delete-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            disabled={busy}
          />
          我确认删除该任务的全部文件
        </label>
      )}
      <ErrorNotice message={error} />
      <footer className="dialog-footer">
        <button className="button secondary" disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          className="button danger-solid"
          disabled={busy || (files && !confirmed)}
          onClick={() => void remove()}
        >
          {busy ? (
            <Spinner label="正在删除" />
          ) : (
            <>
              <Trash2 size={15} />
              {files ? "永久删除文件" : "移除记录"}
            </>
          )}
        </button>
      </footer>
    </Modal>
  );
}
export default function TaskDetail({
  task,
  onClose,
  onDelete,
  onAction,
  busy,
  error,
}: {
  task: Task;
  onClose: () => void;
  onDelete: (mode: "record" | "files") => void;
  onAction: () => void;
  busy: boolean;
  error: string;
}) {
  const phases: TaskStatus[] = [
    "queued",
    "resolving",
    "downloading",
    "merging",
    "completed",
  ];
  const phase = phases.indexOf(task.status);
  return (
    <Modal title="任务详情" onClose={onClose} className="detail-dialog">
      <Thumbnail
        src={task.thumbnail}
        title={task.title}
        className="detail-cover"
      />
      <h3>{task.title}</h3>
      <Badge status={task.status} />
      {phase >= 0 && (
        <ol className="stage-timeline" aria-label="任务处理阶段">
          {phases.map((status, index) => (
            <li
              key={status}
              className={
                phase === index ? "current" : phase > index ? "done" : ""
              }
              aria-current={phase === index ? "step" : undefined}
            >
              <span>{phase > index ? <Check size={12} /> : index + 1}</span>
              {statuses[status]}
            </li>
          ))}
        </ol>
      )}
      <Progress task={task} />
      <dl className="detail-info">
        <div>
          <dt>下载根目录</dt>
          <dd>
            <code>{task.download_dir || "未提供"}</code>
          </dd>
        </div>
        <div>
          <dt>任务保存目录</dt>
          <dd>
            <code>
              {task.download_dir
                ? `${task.download_dir.replace(/\/+$/, "")}/${task.id}`
                : "未提供"}
            </code>
          </dd>
        </div>
        <div>
          <dt>下载规格</dt>
          <dd>
            {task.mode === "audio"
              ? "仅音频"
              : `视频 · ${task.quality === "best" ? "最佳可用画质" : task.quality} · ${task.codec}`}
          </dd>
        </div>
        <div>
          <dt>附加文件</dt>
          <dd>
            {[task.cover && "封面", task.subtitles && "可用字幕"]
              .filter(Boolean)
              .join("、") || "无"}
          </dd>
        </div>
        <div>
          <dt>已下载 / 总大小</dt>
          <dd>
            {bytes(task.downloaded_bytes)} / {bytes(task.total_bytes)}
          </dd>
        </div>
        {task.status === "downloading" && (
          <div>
            <dt>速度 / 剩余时间</dt>
            <dd>
              {bytes(task.speed)}/s · {duration(task.eta)}
            </dd>
          </div>
        )}
        <div>
          <dt>添加时间</dt>
          <dd>{dateTime(task.created_at)}</dd>
        </div>
        <div>
          <dt>最后更新</dt>
          <dd>{dateTime(task.updated_at)}</dd>
        </div>
      </dl>
      <ErrorNotice message={task.error || ""} />
      <ErrorNotice message={error} />
      {(task.status === "completed" || task.record_removed) && (
        <TaskFiles key={`${task.id}-${task.files_deleted}`} task={task} />
      )}
      <footer className="dialog-footer">
        {!task.record_removed && (
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => onDelete("record")}
          >
            <Trash2 size={15} />
            移除记录
          </button>
        )}
        {!isActive(task) && !task.files_deleted && (
          <button
            className="button danger"
            disabled={busy}
            onClick={() => onDelete("files")}
          >
            <Trash2 size={15} />
            删除文件
          </button>
        )}
        {task.status !== "completed" && !task.record_removed && (
          <button
            className="button secondary"
            disabled={busy}
            onClick={onAction}
          >
            {isActive(task) ? (
              <Pause size={15} />
            ) : task.status === "failed" ? (
              <RefreshCw size={15} />
            ) : (
              <Play size={15} />
            )}
            {isActive(task)
              ? "暂停任务"
              : task.status === "failed"
                ? "重试下载"
                : "继续下载"}
          </button>
        )}
      </footer>
    </Modal>
  );
}
