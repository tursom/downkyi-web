import { CheckCircle2, FolderOpen } from "lucide-react";
import type { DownloadOptions, ParsedEntry } from "./types";
import { duration } from "./format";
import { qualityName } from "./EntryPicker";
export default function DownloadReview({
  entries,
  options,
  downloadDir,
}: {
  entries: ParsedEntry[];
  options: DownloadOptions;
  downloadDir?: string;
}) {
  return (
    <div className="review-content">
      <div className="review-summary">
        <CheckCircle2 size={24} />
        <div>
          <h3>准备添加 {entries.length} 个下载任务</h3>
          <p>
            {options.mode === "video"
              ? `视频 · ${qualityName(options.quality)} · ${options.codec === "auto" ? "自动编码" : options.codec.toUpperCase()}`
              : "仅音频"}
            {options.cover ? " · 封面" : ""}
            {options.subtitles ? " · 可用字幕" : ""}
          </p>
        </div>
      </div>
      <div className="review-table-wrap">
        <table className="review-table">
          <thead>
            <tr>
              <th>下载项目</th>
              <th>源资源</th>
              <th>附加文件</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>
                  {entry.title}
                  <span>
                    {entry.group} · {duration(entry.duration)}
                  </span>
                </td>
                <td>
                  {options.mode === "audio"
                    ? "音频"
                    : entry.qualities.map(qualityName).join(" / ")}
                  {options.mode === "video" &&
                    options.codec !== "auto" &&
                    !entry.codecs.includes(options.codec) && (
                      <small>源不含所选编码</small>
                    )}
                </td>
                <td>
                  {[
                    options.cover && "封面",
                    options.subtitles && entry.has_subtitles && "字幕",
                  ]
                    .filter(Boolean)
                    .join("、") || "无"}
                  {options.subtitles && !entry.has_subtitles && (
                    <small>无可用字幕</small>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {downloadDir && (
        <div className="review-destination">
          <FolderOpen size={17} />
          <div>
            <strong>服务器保存目录</strong>
            <code>{downloadDir}</code>
          </div>
        </div>
      )}
    </div>
  );
}
