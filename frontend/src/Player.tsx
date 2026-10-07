import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Download, Maximize, MessageSquare, MessageSquareOff } from "lucide-react";
import { downloadUrl, taskPath } from "./api";
import { EmptyState, ErrorNotice, Modal, Spinner } from "./components";
import { useQuery } from "./hooks";
import type { Task, TaskFile } from "./types";

const MEDIA = /\.(mp4|m4a|webm|mkv|mov|flv)$/i;
const SUBTITLE = /\.(srt|vtt)$/i;
const COVER = /\.(jpe?g|png|webp)$/i;
const DANMAKU = /\.danmaku\.xml$/i;
const SCROLL_SECONDS = 8;
const FIXED_SECONDS = 4;
const MAX_ON_SCREEN = 80;
// Scale comments with the stage so phones are not covered edge to edge.
const fontFor = (width: number) => Math.round(Math.min(22, Math.max(13, width / 40)));

const fileUrl = (task: Task, kind: "play" | "subtitles", name: string) =>
  `/api${taskPath(task.id, `/${kind}/${encodeURIComponent(name)}`)}`;
// "media.zh-Hans.srt" → "zh-Hans"; fall back to the full name for unusual layouts.
const trackLabel = (name: string) =>
  name.replace(SUBTITLE, "").split(".").slice(1).join(".") || name;

export function playerFiles(files: TaskFile[]) {
  return {
    media: files.find((file) => MEDIA.test(file.name)),
    subtitles: files.filter((file) => SUBTITLE.test(file.name)),
    cover: files.find((file) => COVER.test(file.name)),
    danmaku: files.find((file) => DANMAKU.test(file.name)),
  };
}

interface Comment {
  time: number;
  text: string;
  mode: "scroll" | "top" | "bottom";
  color: string;
  size: number;
}
interface Shown extends Comment {
  key: number;
  lane: number;
}

export function parseDanmaku(xml: string): Comment[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) return [];
  const comments: Comment[] = [];
  for (const node of Array.from(doc.getElementsByTagName("d"))) {
    const [time, mode, size, color] = (node.getAttribute("p") ?? "").split(",").map(Number);
    const text = node.textContent?.trim();
    // Modes 1–3 scroll, 4 bottom, 5 top; reverse, positioned and code comments are skipped.
    if (!text || !Number.isFinite(time) || time < 0 || ![1, 2, 3, 4, 5].includes(mode)) continue;
    comments.push({
      time,
      text,
      mode: mode === 4 ? "bottom" : mode === 5 ? "top" : "scroll",
      color: `#${((Number.isFinite(color) ? color : 0xffffff) & 0xffffff).toString(16).padStart(6, "0")}`,
      size: size > 0 && size < 25 ? 0.85 : size > 25 ? 1.2 : 1,
    });
  }
  return comments.sort((a, b) => a.time - b.time);
}

function DanmakuLayer({ video, url }: { video: HTMLVideoElement; url: string }) {
  const layer = useRef<HTMLDivElement>(null);
  const [comments, setComments] = useState<Comment[]>();
  const [shown, setShown] = useState<Shown[]>([]);
  const [paused, setPaused] = useState(video.paused);
  const [width, setWidth] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { credentials: "same-origin", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error();
        return response.text();
      })
      .then((text) => setComments(parseDanmaku(text)))
      .catch(() => {
        if (!controller.signal.aborted) setError("弹幕加载失败");
      });
    return () => controller.abort();
  }, [url]);

  useEffect(() => {
    const element = layer.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!comments?.length || !width) return;
    let next = 0, last = video.currentTime, frame = 0, key = 0;
    const lanes = { scroll: [] as number[], top: [] as number[], bottom: [] as number[] };
    const seek = () => {
      last = video.currentTime;
      // Binary search for the first comment at or after the new position.
      let low = 0, high = comments.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (comments[middle].time < last) low = middle + 1;
        else high = middle;
      }
      next = low;
      lanes.scroll = []; lanes.top = []; lanes.bottom = [];
      setShown([]);
    };
    const font = fontFor(width), laneHeight = font * 1.5;
    const count = Math.max(1, Math.floor(((layer.current?.clientHeight ?? 300) * 0.8) / laneHeight));
    const tick = () => {
      const now = video.currentTime;
      if (now < last || now - last > 1.5) seek();
      last = now;
      const added: Shown[] = [];
      for (; next < comments.length && comments[next].time <= now; next++) {
        const comment = comments[next];
        if (now - comment.time > 1) continue;
        const free = lanes[comment.mode];
        let index = 0;
        while (index < count && (free[index] ?? 0) > now) index++;
        if (index === count) continue;
        if (comment.mode === "scroll") {
          // Release the lane once the tail has fully entered the screen.
          const textWidth = comment.text.length * font * 1.1 * comment.size;
          free[index] = now + ((textWidth + 24) / (width + textWidth)) * SCROLL_SECONDS;
        } else {
          free[index] = now + FIXED_SECONDS;
        }
        added.push({ ...comment, key: key++, lane: index });
      }
      if (added.length) setShown((items) => [...items, ...added].slice(-MAX_ON_SCREEN));
      frame = requestAnimationFrame(tick);
    };
    const play = () => setPaused(false);
    const pause = () => setPaused(true);
    video.addEventListener("seeking", seek);
    video.addEventListener("play", play);
    video.addEventListener("pause", pause);
    seek();
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      video.removeEventListener("seeking", seek);
      video.removeEventListener("play", play);
      video.removeEventListener("pause", pause);
    };
  }, [comments, video, width]);

  const remove = (key: number) => setShown((items) => items.filter((item) => item.key !== key));
  return (
    <div
      className={`danmaku-layer${paused ? " paused" : ""}`}
      ref={layer}
      aria-hidden="true"
      style={{ "--stage-width": `${width}px` } as CSSProperties}
    >
      {error && <span className="danmaku-error">{error}</span>}
      {shown.map((item) => (
        <span
          key={item.key}
          className={`danmaku ${item.mode}`}
          style={{
            color: item.color,
            fontSize: `${item.size * fontFor(width)}px`,
            [item.mode === "bottom" ? "bottom" : "top"]: `${item.lane * fontFor(width) * 1.5 + 6}px`,
          }}
          onAnimationEnd={() => remove(item.key)}
        >
          {item.text}
        </span>
      ))}
    </div>
  );
}

function storedPosition(id: string): number {
  try {
    return Number(localStorage.getItem(`downkyi:position:${id}`)) || 0;
  } catch {
    return 0;
  }
}
function storePosition(id: string, value: number | undefined) {
  try {
    const key = `downkyi:position:${id}`;
    if (value) localStorage.setItem(key, value.toFixed(1));
    else localStorage.removeItem(key);
  } catch {
    /* Resume position is only a convenience. */
  }
}

export default function Player({ task, onClose }: { task: Task; onClose: () => void }) {
  const files = useQuery<{ files: TaskFile[] }>(taskPath(task.id, "/files"));
  const stage = useRef<HTMLDivElement>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [danmakuOn, setDanmakuOn] = useState(true);
  const saved = useRef(0);
  const { media, subtitles, cover, danmaku } = playerFiles(files.data?.files ?? []);
  const poster =
    (cover && downloadUrl(cover.url)) ||
    (task.thumbnail && /^https?:\/\//i.test(task.thumbnail) ? task.thumbnail : undefined);

  return (
    <Modal title={task.title} onClose={onClose} className="player-dialog">
      <ErrorNotice message={files.error} retry={files.refresh} />
      {files.loading && !files.data ? (
        <Spinner label="正在读取文件" />
      ) : !media ? (
        files.data && <EmptyState icon={<Download size={24} />} title="没有可播放的媒体文件" />
      ) : (
        <>
          <div className="player-stage" ref={stage}>
            <video
              ref={setVideo}
              src={fileUrl(task, "play", media.name)}
              poster={poster}
              controls
              autoPlay
              playsInline
              preload="metadata"
              aria-label={`播放 ${task.title}`}
              onError={() => setFailed(true)}
              onLoadedMetadata={(event) => {
                const position = storedPosition(task.id);
                if (position > 0 && position < event.currentTarget.duration - 5)
                  event.currentTarget.currentTime = position;
              }}
              onTimeUpdate={(event) => {
                const now = event.currentTarget.currentTime;
                if (Math.abs(now - saved.current) < 5) return;
                saved.current = now;
                storePosition(task.id, now);
              }}
              onEnded={() => storePosition(task.id, undefined)}
            >
              {subtitles.map((file, index) => (
                <track
                  key={file.name}
                  kind="subtitles"
                  src={fileUrl(task, "subtitles", file.name)}
                  label={trackLabel(file.name)}
                  default={index === 0}
                />
              ))}
            </video>
            {video && danmaku && danmakuOn && task.mode === "video" && (
              <DanmakuLayer video={video} url={downloadUrl(danmaku.url) ?? ""} />
            )}
          </div>
          {failed && (
            <ErrorNotice message="浏览器无法播放该文件。HEVC、AV1 等编码或 MKV/FLV 容器可能不受当前浏览器支持，可下载后用本地播放器观看。" />
          )}
          <footer className="player-toolbar">
            {danmaku && task.mode === "video" && (
              <button
                className="button secondary"
                aria-pressed={danmakuOn}
                onClick={() => setDanmakuOn((value) => !value)}
              >
                {danmakuOn ? <MessageSquare size={15} /> : <MessageSquareOff size={15} />}
                {danmakuOn ? "弹幕：开" : "弹幕：关"}
              </button>
            )}
            {task.mode === "video" && (
              <button
                className="button secondary"
                onClick={() => void stage.current?.requestFullscreen?.().catch(() => {})}
              >
                <Maximize size={15} />
                全屏
              </button>
            )}
            {downloadUrl(media.url) && (
              <a className="button secondary" href={downloadUrl(media.url)} download>
                <Download size={15} />
                下载文件
              </a>
            )}
          </footer>
        </>
      )}
    </Modal>
  );
}
