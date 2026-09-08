import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileVideo,
  FolderOpen,
  HardDrive,
  Headphones,
  Link,
  Loader2,
  LockKeyhole,
  Plus,
  Search,
  ShieldCheck,
  Video,
  X,
} from "lucide-react";

export type DownloadDraft = {
  title: string;
  author: string;
  cover: string;
  duration: string;
  quality: string;
  mode: "video" | "audio";
  subtitles: boolean;
  saveCover: boolean;
  sourceKey: string;
  sourceUrl: string;
  part: string;
  codec: string;
};
type Entry = {
  id: string;
  title: string;
  duration: string;
  group: string;
  maxQuality: number;
  subtitles: boolean;
  unavailable?: string;
};
type Source = {
  title: string;
  author: string;
  cover: string;
  kind: string;
  entries: Entry[];
};
const examples = [
  { label: "单视频", url: "https://www.bilibili.com/video/BV1xx411c7mS" },
  { label: "多 P 视频", url: "https://www.bilibili.com/video/BV1xx411c7mD" },
  {
    label: "视频合集",
    url: "https://space.bilibili.com/123/lists/456?type=season",
  },
  { label: "番剧", url: "https://www.bilibili.com/bangumi/play/ss12345" },
  { label: "失效内容", url: "https://www.bilibili.com/video/BV1xx411c7mE" },
];
const parts: Entry[] = [
  {
    id: "mountain-1",
    title: "P1 · 山野之间",
    duration: "18:42",
    group: "全部分 P",
    maxQuality: 2160,
    subtitles: true,
  },
  {
    id: "mountain-2",
    title: "P2 · 湖畔清晨",
    duration: "12:08",
    group: "全部分 P",
    maxQuality: 1080,
    subtitles: true,
  },
  {
    id: "mountain-3",
    title: "P3 · 日落之后",
    duration: "08:36",
    group: "全部分 P",
    maxQuality: 720,
    subtitles: false,
  },
];
function resolveDemo(input: string): Source {
  let url: URL;
  const text = input.trim();
  try {
    url = new URL(
      /^(BV[\da-z]{10}|av\d+)$/i.test(text)
        ? `https://www.bilibili.com/video/${text}`
        : text,
    );
  } catch {
    throw new Error("请输入有效的哔哩哔哩视频链接或 BV / AV 号。");
  }
  if (
    url.protocol !== "https:" ||
    !["www.bilibili.com", "bilibili.com", "space.bilibili.com"].includes(
      url.hostname,
    )
  )
    throw new Error("当前原型仅接受 HTTPS 哔哩哔哩链接。");
  if (url.pathname.endsWith("BV1xx411c7mE"))
    throw new Error("该视频已失效或被删除，无法获取下载资源。");
  if (/^\/bangumi\/play\/(ss|ep)\d+$/.test(url.pathname))
    return {
      title: "自然的来信 · 第一季",
      author: "自然影像社",
      cover: "sky",
      kind: "番剧",
      entries: [
        {
          ...parts[0],
          id: "episode-1",
          title: "第 1 集 · 远山",
          group: "正片",
          maxQuality: 1080,
        },
        {
          ...parts[1],
          id: "episode-2",
          title: "第 2 集 · 湖泊",
          group: "正片",
          unavailable: "需购买",
        },
        {
          ...parts[2],
          id: "episode-3",
          title: "第 3 集 · 星空",
          group: "正片",
          unavailable: "尚未播出",
        },
        {
          ...parts[2],
          id: "episode-preview",
          title: "预告 · 自然的来信",
          group: "预告与花絮",
        },
      ],
    };
  if (/^\/\d+\/lists\/\d+$/.test(url.pathname))
    return {
      title: "山野影像集｜在自然里找回自己",
      author: "山野之间",
      cover: "mountain",
      kind: "合集",
      entries: [
        ...parts.map((e) => ({
          ...e,
          id: `collection-${e.id}`,
          group: "第一章 · 山与湖",
        })),
        {
          ...parts[0],
          id: "collection-4",
          title: "P1 · 抬头之后",
          group: "第二章 · 星空",
          duration: "21:05",
        },
        {
          ...parts[1],
          id: "collection-5",
          title: "P2 · 星空摄影手记",
          group: "第二章 · 星空",
          unavailable: "视频已失效",
        },
      ],
    };
  if (!/^\/video\/(BV[\da-z]{10}|av\d+)\/?$/i.test(url.pathname))
    throw new Error("暂不支持这个入口，请使用视频、合集或番剧链接。");
  const single = !url.pathname.endsWith("BV1xx411c7mD");
  return {
    title: single
      ? "在阿尔卑斯山，记录一场迟来的日出"
      : "山野影像集｜在自然里找回自己",
    author: "山野之间",
    cover: "mountain",
    kind: single ? "单视频" : "多 P 视频",
    entries: single
      ? [
          {
            ...parts[0],
            id: `single-${url.pathname.split("/").pop()}`,
            title: "完整影片",
          },
        ]
      : parts,
  };
}
function qualityName(value: number) {
  return value === 2160 ? "4K" : `${value}P`;
}

export default function NewDownload({
  onClose,
  onAdd,
  existingKeys,
}: {
  onClose: () => void;
  onAdd: (drafts: DownloadDraft[]) => void;
  existingKeys: string[];
}) {
  const [step, setStep] = useState(1);
  const [url, setUrl] = useState("");
  const [source, setSource] = useState<Source | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loggedIn, setLoggedIn] = useState(false);
  const [quality, setQuality] = useState("best");
  const [mode, setMode] = useState<"video" | "audio">("video");
  const [codec, setCodec] = useState("AVC");
  const [subtitles, setSubtitles] = useState(false);
  const [saveCover, setSaveCover] = useState(true);
  const [query, setQuery] = useState("");
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dialogRef = useRef<HTMLElement>(null);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => () => clearTimeout(pending.current), []);
  useEffect(() => {
    dialogRef.current?.scrollTo(0, 0);
    stepHeading.current?.focus();
  }, [step]);
  const duplicate = (entry: Entry) =>
    existingKeys.includes(`${entry.id}:${mode}`);
  const eligible = (entry: Entry) => !entry.unavailable && !duplicate(entry);
  const available = source?.entries.filter(eligible) ?? [];
  const chosen = available.filter((e) => selected.includes(e.id));
  const groups = [...new Set(source?.entries.map((e) => e.group))];
  const maxAccess = loggedIn ? 1080 : 720;
  const actualQuality = (entry: Entry) =>
    Math.min(
      entry.maxQuality,
      maxAccess,
      quality === "best" ? Infinity : Number(quality),
    );
  const toggle = (entry: Entry) =>
    setSelected((ids) =>
      ids.includes(entry.id)
        ? ids.filter((id) => id !== entry.id)
        : [...ids, entry.id],
    );
  function parse() {
    setError("");
    setLoading(true);
    clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      try {
        const result = resolveDemo(url);
        setSource(result);
        setSelected(result.entries.filter(eligible).map((e) => e.id));
        setCollapsed([]);
        setQuery("");
        setStep(2);
      } catch (e) {
        setError(e instanceof Error ? e.message : "解析失败");
      }
      setLoading(false);
    }, 650);
  }
  function changeMode(value: "video" | "audio") {
    setMode(value);
  }
  function submit() {
    if (!source || !chosen.length) return;
    onAdd(
      chosen.map((entry) => ({
        title:
          source.entries.length === 1
            ? source.title
            : `${source.title} · ${entry.title}`,
        part: entry.title,
        author: source.author,
        cover: source.cover,
        duration: entry.duration,
        quality:
          mode === "audio" ? "AAC 192k" : qualityName(actualQuality(entry)),
        mode,
        codec: mode === "audio" ? "AAC" : codec,
        subtitles: subtitles && entry.subtitles,
        saveCover,
        sourceKey: `${entry.id}:${mode}`,
        sourceUrl: url,
      })),
    );
  }
  return (
    <div className="overlay" onClick={onClose}>
      <section
        ref={dialogRef}
        className={`dialog workflow-dialog step-${step}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="workflow-top">
          <header className="workflow-heading">
            <div>
              <span className="eyebrow">NEW DOWNLOAD</span>
              <h2 id="new-title">新建下载</h2>
            </div>
            <span className="prototype-mark">演示模式</span>
            <button
              className="icon-button"
              aria-label="关闭弹窗"
              onClick={onClose}
            >
              <X size={20} />
            </button>
          </header>
          <ol className="workflow-steps" aria-label="下载步骤">
            {["解析内容", "选择项目与规格", "确认入队"].map((label, i) => (
              <li
                key={label}
                className={
                  step === i + 1 ? "current" : step > i + 1 ? "finished" : ""
                }
                aria-current={step === i + 1 ? "step" : undefined}
              >
                <span>{step > i + 1 ? <Check size={13} /> : i + 1}</span>
                <strong>{label}</strong>
                {i < 2 && <ChevronRight size={14} />}
              </li>
            ))}
          </ol>
        </div>
        <h3 ref={stepHeading} tabIndex={-1} className="sr-only">
          第 {step} 步：{["解析内容", "选择项目与规格", "确认入队"][step - 1]}
        </h3>
        {step === 1 && (
          <div className="workflow-input">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                parse();
              }}
            >
              <label className="field-label" htmlFor="video-url">
                视频、合集、番剧链接或 BV / AV 号
              </label>
              <div className="parse-input">
                <Link size={18} />
                <input
                  id="video-url"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    setError("");
                  }}
                  placeholder="https://www.bilibili.com/video/..."
                  required
                  disabled={loading}
                  autoComplete="off"
                />
                <button
                  className="button primary"
                  disabled={loading || !url.trim()}
                >
                  {loading ? (
                    <Loader2 className="spin" size={16} />
                  ) : (
                    <Search size={16} />
                  )}
                  解析
                </button>
              </div>
            </form>
            {error && (
              <p role="alert" className="error-note">
                {error}
              </p>
            )}
            <div className="demo-examples">
              <span>演示内容</span>
              {examples.map((e) => (
                <button
                  disabled={loading}
                  key={e.label}
                  onClick={() => {
                    setUrl(e.url);
                    setError("");
                  }}
                >
                  <FileVideo size={14} />
                  {e.label}
                  <ArrowRight size={13} />
                </button>
              ))}
            </div>
            <div className="source-placeholder">
              {loading ? (
                <Loader2 size={30} className="spin" />
              ) : (
                <Link size={30} />
              )}
              <strong>{loading ? "正在解析内容…" : "等待解析内容"}</strong>
              <span>
                {loading
                  ? "读取视频信息与可用资源"
                  : "单视频 / 分 P / 合集章节 / 番剧选集"}
              </span>
            </div>
          </div>
        )}
        {step > 1 && source && (
          <>
            <div className="workflow-source">
              <img
                src={`/covers/${source.cover}.jpg`}
                alt={`${source.title}封面`}
              />
              <div>
                <span className="badge completed">
                  <CheckCircle2 size={12} />
                  {source.kind}
                </span>
                <h3>{source.title}</h3>
                <p>
                  {source.author}
                  <span>·</span>
                  {source.entries.length} 个项目<span>·</span>
                  {available.length} 个可添加
                </p>
              </div>
              {step === 2 && (
                <button className="text-link" onClick={() => setStep(1)}>
                  更换链接
                  <ArrowRight size={13} />
                </button>
              )}
            </div>
            {step === 2 && (
              <div className="workflow-columns">
                <section className="entry-picker" aria-label="下载项目">
                  <div className="picker-heading">
                    <h3>
                      {source.entries.length === 1 ? "下载项目" : "选择项目"}
                    </h3>
                    <span>
                      已选 {chosen.length} / {available.length}
                    </span>
                  </div>
                  {source.entries.length > 1 && (
                    <label className="entry-search">
                      <Search size={15} />
                      <input
                        aria-label="搜索分 P 或剧集"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="搜索分 P 或剧集"
                      />
                    </label>
                  )}
                  {groups.map((group) => {
                    const entries = source.entries.filter(
                      (e) => e.group === group,
                    );
                    const visible = entries.filter((e) =>
                      e.title.includes(query),
                    );
                    if (!visible.length) return null;
                    const selectable = visible.filter(eligible);
                    const checked =
                      selectable.length > 0 &&
                      selectable.every((e) => selected.includes(e.id));
                    return (
                      <div className="entry-group" key={group}>
                        <div className="entry-group-heading">
                          <input
                            type="checkbox"
                            aria-label={`选择${group}`}
                            checked={checked}
                            disabled={!selectable.length}
                            onChange={() =>
                              setSelected((ids) =>
                                checked
                                  ? ids.filter(
                                      (id) =>
                                        !selectable.some((e) => e.id === id),
                                    )
                                  : [
                                      ...new Set([
                                        ...ids,
                                        ...selectable.map((e) => e.id),
                                      ]),
                                    ],
                              )
                            }
                          />
                          <button
                            onClick={() =>
                              setCollapsed((gs) =>
                                gs.includes(group)
                                  ? gs.filter((g) => g !== group)
                                  : [...gs, group],
                              )
                            }
                            aria-expanded={!collapsed.includes(group)}
                          >
                            {collapsed.includes(group) ? (
                              <ChevronRight size={14} />
                            ) : (
                              <ChevronDown size={14} />
                            )}
                            <strong>{group}</strong>
                            <span>{entries.length}</span>
                          </button>
                        </div>
                        {!collapsed.includes(group) &&
                          visible.map((entry) => (
                            <label
                              key={entry.id}
                              className={`entry-row ${!eligible(entry) ? "unavailable" : ""}`}
                            >
                              <input
                                type="checkbox"
                                checked={
                                  eligible(entry) && selected.includes(entry.id)
                                }
                                disabled={!eligible(entry)}
                                onChange={() => toggle(entry)}
                              />
                              <span className="entry-title">
                                {entry.title}
                                <small>
                                  {entry.unavailable ||
                                    (duplicate(entry)
                                      ? "已在下载记录中"
                                      : `${qualityName(entry.maxQuality)} 源画质${entry.subtitles ? " · 有字幕" : ""}`)}
                                </small>
                              </span>
                              {!eligible(entry) ? (
                                <LockKeyhole size={13} />
                              ) : (
                                <span className="entry-duration">
                                  {entry.duration}
                                </span>
                              )}
                            </label>
                          ))}
                      </div>
                    );
                  })}
                  {!source.entries.some((e) => e.title.includes(query)) && (
                    <div className="picker-empty">没有匹配的项目</div>
                  )}
                </section>
                <section className="download-specs" aria-label="下载规格">
                  <h3>下载规格</h3>
                  <span className="field-label">下载内容</span>
                  <div className="segmented">
                    <button
                      className={mode === "video" ? "active" : ""}
                      onClick={() => changeMode("video")}
                    >
                      <Video size={15} />
                      视频
                    </button>
                    <button
                      className={mode === "audio" ? "active" : ""}
                      onClick={() => changeMode("audio")}
                    >
                      <Headphones size={15} />
                      仅音频
                    </button>
                  </div>
                  <div className="account-line">
                    <ShieldCheck size={14} />
                    <span>
                      {loggedIn ? "已登录 · 普通账户" : "未登录哔哩哔哩"}
                    </span>
                    <button
                      onClick={() => {
                        setLoggedIn((v) => !v);
                        setQuality("best");
                      }}
                    >
                      {loggedIn ? "模拟退出" : "模拟登录"}
                    </button>
                  </div>
                  {mode === "video" ? (
                    <>
                      <label className="field-label" htmlFor="quality">
                        画质
                      </label>
                      <select
                        id="quality"
                        value={quality}
                        onChange={(e) => setQuality(e.target.value)}
                      >
                        <option value="best">最佳可用画质</option>
                        {[2160, 1080, 720, 480, 360]
                          .filter((q) =>
                            source.entries.some(
                              (e) => !e.unavailable && e.maxQuality >= q,
                            ),
                          )
                          .map((q) => (
                            <option key={q} value={q} disabled={q > maxAccess}>
                              {qualityName(q)}
                              {q === 2160
                                ? " · 需大会员"
                                : q > maxAccess
                                  ? " · 需登录"
                                  : ""}
                            </option>
                          ))}
                      </select>
                      <p className="spec-note">
                        {loggedIn
                          ? "演示权限：普通账户最高 1080P。"
                          : "演示权限：匿名资源最高 720P。"}
                      </p>
                      <label className="field-label" htmlFor="codec">
                        视频编码
                      </label>
                      <select
                        id="codec"
                        value={codec}
                        onChange={(e) => setCodec(e.target.value)}
                      >
                        <option>AVC</option>
                        <option>HEVC</option>
                      </select>
                    </>
                  ) : (
                    <div className="audio-spec">
                      <Headphones size={18} />
                      <div>
                        <strong>AAC · 192 kbps</strong>
                        <span>M4A 音频文件</span>
                      </div>
                    </div>
                  )}
                  <fieldset className="artifact-options">
                    <legend>附加文件</legend>
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={saveCover}
                        onChange={(e) => setSaveCover(e.target.checked)}
                      />
                      视频封面 <span>JPG</span>
                    </label>
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={subtitles}
                        onChange={(e) => setSubtitles(e.target.checked)}
                      />
                      可用字幕 <span>SRT</span>
                    </label>
                  </fieldset>
                  <div className="destination-line">
                    <HardDrive size={14} />
                    <span>/downloads</span>
                  </div>
                </section>
              </div>
            )}
            {step === 3 && (
              <div className="review-content">
                <div className="review-summary">
                  <CheckCircle2 size={24} />
                  <div>
                    <h3>准备添加 {chosen.length} 个下载任务</h3>
                    <p>
                      {mode === "video"
                        ? `视频 · MP4 · ${codec}`
                        : "仅音频 · M4A · AAC"}
                      {saveCover ? " · 封面" : ""}
                      {subtitles ? " · 可用字幕" : ""}
                    </p>
                  </div>
                </div>
                <div className="review-table-wrap">
                  <table className="review-table">
                    <thead>
                      <tr>
                        <th>下载项目</th>
                        <th>{mode === "video" ? "最终画质" : "音质"}</th>
                        <th>附加文件</th>
                      </tr>
                    </thead>
                    <tbody>
                      {chosen.map((entry) => (
                        <tr key={entry.id}>
                          <td>
                            {entry.title}
                            <span>{entry.duration}</span>
                          </td>
                          <td>
                            {mode === "video"
                              ? qualityName(actualQuality(entry))
                              : "AAC 192k"}
                            {mode === "video" &&
                              actualQuality(entry) <
                                (quality === "best"
                                  ? maxAccess
                                  : Number(quality)) && (
                                <small>源画质上限</small>
                              )}
                          </td>
                          <td>
                            {[
                              saveCover ? "封面" : "",
                              subtitles && entry.subtitles ? "字幕" : "",
                            ]
                              .filter(Boolean)
                              .join("、") || "无"}
                            {subtitles && !entry.subtitles && (
                              <small>无可用字幕</small>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="review-destination">
                  <FolderOpen size={17} />
                  <div>
                    <strong>服务器保存目录</strong>
                    <code>/downloads/视频标题_分P/</code>
                  </div>
                  <span>可用 379.6 GB</span>
                </div>
                <p className="review-note">
                  每个选中项目独立入队，完成媒体下载、合并与校验后才会进入已完成。
                </p>
              </div>
            )}
          </>
        )}
        <footer className="workflow-footer">
          <span>
            {step === 1 ? "服务器下载空间" : `已选 ${chosen.length} 项`}
          </span>
          <button
            className="button secondary"
            onClick={step === 1 ? onClose : () => setStep(step - 1)}
          >
            {step > 1 && <ArrowLeft size={15} />}
            {step === 1 ? "取消" : "上一步"}
          </button>
          {step === 2 && (
            <button
              className="button primary"
              disabled={!chosen.length}
              onClick={() => setStep(3)}
            >
              确认规格
              <ArrowRight size={15} />
            </button>
          )}
          {step === 3 && (
            <button
              className="button primary"
              disabled={!chosen.length}
              onClick={submit}
            >
              <Plus size={16} />
              加入队列 ({chosen.length})
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
