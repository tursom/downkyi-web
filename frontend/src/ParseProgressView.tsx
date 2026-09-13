import { useEffect, useState } from "react";
import { Spinner } from "./components";
import type { ParseProgress } from "./types";

const stages = { resolving: "正在识别链接", listing: "正在读取项目列表", extracting: "正在提取资源" };

export default function ParseProgressView({ progress, startedAt }: {
  progress?: ParseProgress;
  startedAt: number;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const update = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  const completed = progress?.completed ?? 0;
  const total = progress?.total ?? null;
  const summary = `已处理 ${completed} / ${total === null ? "总数未知" : total}`;
  return (
    <div className="parse-progress" aria-label="解析进度">
      <div className="parse-progress-stage" role="status">
        <Spinner label={progress ? stages[progress.stage] : "正在等待解析进度"} />
      </div>
      <div className="parse-progress-track" role="progressbar" aria-label="解析项目进度"
        aria-valuemin={0} aria-valuemax={total ?? undefined}
        aria-valuenow={total === null ? undefined : completed} aria-valuetext={summary}>
        {total !== null && <span style={{ width: `${total > 0 ? completed / total * 100 : 0}%` }} />}
      </div>
      <div className="parse-progress-counts">
        <span>{summary}</span>
        <span>成功 {progress?.succeeded ?? 0} · 失败 {progress?.failed ?? 0}</span>
      </div>
      <p className="parse-progress-title" title={progress?.title || undefined}>
        当前：{progress?.title || "等待服务器更新"}
      </p>
      <p className="parse-progress-time">已耗时 {elapsed} 秒 · 最长 180 秒</p>
    </div>
  );
}
