import { HardDrive, RefreshCw, Server } from "lucide-react";
import { ErrorNotice, IconButton, Spinner } from "./components";
import { bytes, percent } from "./format";
import type { SystemInfo } from "./types";
export default function System({
  data,
  error,
  loading,
  updatedAt,
  refresh,
}: {
  data?: SystemInfo;
  error: string;
  loading: boolean;
  updatedAt?: Date;
  refresh: () => void;
}) {
  const usedPercent =
    data && data.disk_total > 0
      ? percent((1 - data.disk_free / data.disk_total) * 100)
      : 0;
  return (
    <>
      <header className="page-heading">
        <div>
          <div className="eyebrow">SERVER STATUS</div>
          <h1>服务器状态</h1>
        </div>
        <IconButton label="刷新系统状态" onClick={refresh} disabled={loading}>
          <RefreshCw size={19} className={loading ? "spin" : ""} />
        </IconButton>
      </header>
      <ErrorNotice message={error} retry={refresh} />
      {loading && !data ? (
        <Spinner label="正在读取系统信息" />
      ) : (
        data && (
          <section className="system-content">
            <div className="server-identity">
              <div className="server-identity-icon">
                <Server size={32} />
              </div>
              <div>
                <h2>DownKyi Web</h2>
                <p>{data.version}</p>
              </div>
              <span className={`badge ${error ? "failed" : "completed"}`}>
                {error ? "连接异常" : "已连接"}
              </span>
            </div>
            <div className="system-metrics">
              <div>
                <span>
                  <HardDrive size={14} /> 可用磁盘空间
                </span>
                <strong>{bytes(data.disk_free)}</strong>
                <div
                  className="storage-track"
                  role="progressbar"
                  aria-label="磁盘使用率"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={usedPercent}
                >
                  <i style={{ width: `${usedPercent}%` }} />
                </div>
                <p>总容量 {bytes(data.disk_total)}</p>
              </div>
              <div>
                <span>媒体处理</span>
                <strong>{data.ffmpeg ? "就绪" : "不可用"}</strong>
                <p>FFmpeg</p>
              </div>
              <div>
                <span>活跃任务</span>
                <strong>{data.active_tasks}</strong>
              </div>
            </div>
            <h3>运行环境</h3>
            <dl className="environment">
              <div>
                <dt>应用版本</dt>
                <dd>{data.version || "未知版本"}</dd>
              </div>
              <div>
                <dt>下载引擎 yt-dlp</dt>
                <dd>{data.yt_dlp_version || "未知版本"}</dd>
              </div>
              <div>
                <dt>媒体处理 FFmpeg</dt>
                <dd>{data.ffmpeg ? "可用" : "未安装 / 不可用"}</dd>
              </div>
              <div>
                <dt>下载目录</dt>
                <dd>
                  <code>{data.download_dir}</code>
                </dd>
              </div>
            </dl>
            <div className="list-footer">
              <span>{error ? "数据未更新" : "服务器数据"}</span>
              <span>
                {updatedAt
                  ? `最近更新 ${updatedAt.toLocaleTimeString("zh-CN", { hour12: false })}`
                  : ""}
              </span>
            </div>
          </section>
        )
      )}
    </>
  );
}
