import { HardDrive, Headphones, Video } from "lucide-react";
import type { Codec, DownloadOptions, ParsedEntry, Quality } from "./types";
import { qualityName } from "./EntryPicker";
const qualities: Quality[] = ["2160", "1440", "1080", "720", "480", "360"];
const codecs: Codec[] = ["avc", "hevc", "av1"];
export function availableSpecs(entries: ParsedEntry[]) {
  return {
    qualities: qualities.filter((value) =>
      entries.some((entry) => entry.qualities.includes(Number(value))),
    ),
    codecs: codecs.filter((value) =>
      entries.some((entry) => entry.codecs.includes(value)),
    ),
  };
}
export default function DownloadSpecs({
  options,
  setOptions,
  entries,
  downloadDir,
}: {
  options: DownloadOptions;
  setOptions: (options: DownloadOptions) => void;
  entries: ParsedEntry[];
  downloadDir?: string;
}) {
  const available = availableSpecs(entries);
  const update = (patch: Partial<DownloadOptions>) =>
    setOptions({ ...options, ...patch });
  return (
    <section className="download-specs" aria-label="下载规格">
      <h3>下载规格</h3>
      <span className="field-label">下载内容</span>
      <div className="segmented" role="group" aria-label="下载内容">
        <button
          aria-pressed={options.mode === "video"}
          className={options.mode === "video" ? "active" : ""}
          onClick={() => update({ mode: "video" })}
        >
          <Video size={15} />
          视频
        </button>
        <button
          aria-pressed={options.mode === "audio"}
          className={options.mode === "audio" ? "active" : ""}
          onClick={() => update({ mode: "audio" })}
        >
          <Headphones size={15} />
          仅音频
        </button>
      </div>
      <label className="field-label spec-label" htmlFor="quality">
        画质
      </label>
      <select
        id="quality"
        value={options.quality}
        disabled={options.mode === "audio"}
        onChange={(event) => update({ quality: event.target.value as Quality })}
      >
        <option value="best">最佳可用画质</option>
        {available.qualities.map((value) => (
          <option key={value} value={value}>
            {qualityName(value)}
          </option>
        ))}
        {options.quality !== "best" &&
          !available.qualities.includes(options.quality) && (
            <option value={options.quality} disabled>
              {qualityName(options.quality)} · 当前项目不可用
            </option>
          )}
      </select>
      <label className="field-label spec-label" htmlFor="codec">
        视频编码
      </label>
      <select
        id="codec"
        value={options.codec}
        disabled={options.mode === "audio"}
        onChange={(event) => update({ codec: event.target.value as Codec })}
      >
        <option value="auto">自动选择</option>
        {available.codecs.map((value) => (
          <option key={value} value={value}>
            {value.toUpperCase()}
          </option>
        ))}
        {options.codec !== "auto" &&
          !available.codecs.includes(options.codec) && (
            <option value={options.codec} disabled>
              {options.codec.toUpperCase()} · 当前项目不可用
            </option>
          )}
      </select>
      <fieldset className="artifact-options">
        <legend>附加文件</legend>
        <label className="check-label">
          <input
            type="checkbox"
            checked={options.cover}
            onChange={(event) => update({ cover: event.target.checked })}
          />
          下载封面
        </label>
        <label className="check-label">
          <input
            type="checkbox"
            checked={options.subtitles}
            onChange={(event) => update({ subtitles: event.target.checked })}
          />
          下载字幕
        </label>
      </fieldset>
      {downloadDir && (
        <div className="destination-line">
          <HardDrive size={14} />
          <code>{downloadDir}</code>
        </div>
      )}
    </section>
  );
}
