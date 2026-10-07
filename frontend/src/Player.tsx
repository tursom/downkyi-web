import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import Artplayer from "artplayer";
import artplayerPluginDanmuku, { type Danmu } from "artplayer-plugin-danmuku";
import { downloadUrl, taskPath } from "./api";
import { EmptyState, ErrorNotice, Modal, Spinner } from "./components";
import { useQuery } from "./hooks";
import type { Task, TaskFile } from "./types";

const MEDIA = /\.(mp4|m4a|webm|mkv|mov|flv)$/i;
const SUBTITLE = /\.(srt|vtt)$/i;
const COVER = /\.(jpe?g|png|webp)$/i;
const DANMAKU = /\.danmaku\.xml$/i;

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

export function parseDanmaku(xml: string): Danmu[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) return [];
  const comments: Danmu[] = [];
  for (const node of Array.from(doc.getElementsByTagName("d"))) {
    const [time, mode, , color] = (node.getAttribute("p") ?? "").split(",").map(Number);
    const text = node.textContent?.trim();
    // Modes 1–3 scroll, 4 bottom, 5 top; reverse, positioned and code comments are skipped.
    if (!text || !Number.isFinite(time) || time < 0 || ![1, 2, 3, 4, 5].includes(mode)) continue;
    comments.push({
      time,
      text,
      mode: mode === 5 ? 1 : mode === 4 ? 2 : 0,
      color: `#${((Number.isFinite(color) ? color : 0xffffff) & 0xffffff).toString(16).padStart(6, "0")}`,
    });
  }
  return comments.sort((a, b) => a.time! - b.time!);
}

async function loadDanmaku(url: string): Promise<Danmu[]> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new Error("弹幕加载失败");
  return parseDanmaku(await response.text());
}

function ArtPlayerView({ task, files, onError }: {
  task: Task;
  files: ReturnType<typeof playerFiles>;
  onError: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const { media, subtitles, cover, danmaku } = files;
  const key = [media?.name, cover?.name, danmaku?.name, ...subtitles.map((file) => file.name)].join("|");

  useEffect(() => {
    if (!container.current || !media) return;
    const tracks = subtitles.map((file) => ({
      html: trackLabel(file.name),
      url: fileUrl(task, "subtitles", file.name),
    }));
    const poster =
      (cover && downloadUrl(cover.url)) ||
      (task.thumbnail && /^https?:\/\//i.test(task.thumbnail) ? task.thumbnail : undefined);
    const danmakuUrl = danmaku && task.mode === "video" ? downloadUrl(danmaku.url) : undefined;
    // Phones get fewer control-bar buttons and smaller comments so the stage stays usable.
    const wide = container.current.clientWidth >= 520;
    const art = new Artplayer({
      container: container.current,
      url: fileUrl(task, "play", media.name),
      // ArtPlayer validates option types strictly; omit absent values instead of passing undefined.
      poster: poster ?? "",
      lang: "zh-cn",
      theme: "#00a1d6",
      autoplay: true,
      autoPlayback: true,
      playbackRate: true,
      aspectRatio: true,
      setting: true,
      hotkey: true,
      pip: wide,
      screenshot: wide,
      fullscreen: true,
      // Web fullscreen also listens for Escape, which would close the surrounding dialog.
      fullscreenWeb: false,
      miniProgressBar: true,
      subtitleOffset: tracks.length > 0,
      playsInline: true,
      mutex: true,
      ...(tracks[0] && { subtitle: { url: tracks[0].url, name: tracks[0].html, type: "vtt", escape: true } }),
      settings: tracks.length > 1
        ? [{
            html: "字幕",
            tooltip: tracks[0].html,
            selector: tracks.map((track, index) => ({ ...track, default: index === 0 })),
            onSelect(item) {
              void art.subtitle.switch(item.url as string, { name: item.html });
              return item.html;
            },
          }]
        : [],
      plugins: danmakuUrl
        ? [artplayerPluginDanmuku({
            danmuku: () => loadDanmaku(danmakuUrl),
            speed: 7,
            fontSize: wide ? 25 : 16,
            antiOverlap: true,
            synchronousPlayback: true,
            heatmap: true,
            emitter: false,
            // Below 512px the danmaku bar moves under the video, onto the light dialog background.
            theme: "light",
          })]
        : [],
    });
    art.on("video:error", () => errorRef.current());
    return () => art.destroy(false);
    // Rebuild only when the set of playable files changes, not on task polling.
  }, [task.id, task.mode, key]);

  return <div className="player-stage" ref={container} aria-label={`播放 ${task.title}`} />;
}

export default function Player({ task, onClose }: { task: Task; onClose: () => void }) {
  const files = useQuery<{ files: TaskFile[] }>(taskPath(task.id, "/files"));
  const [failed, setFailed] = useState(false);
  const found = playerFiles(files.data?.files ?? []);
  const href = found.media && downloadUrl(found.media.url);

  return (
    <Modal title={task.title} onClose={onClose} className="player-dialog">
      <ErrorNotice message={files.error} retry={files.refresh} />
      {files.loading && !files.data ? (
        <Spinner label="正在读取文件" />
      ) : !found.media ? (
        files.data && <EmptyState icon={<Download size={24} />} title="没有可播放的媒体文件" />
      ) : (
        <>
          <ArtPlayerView task={task} files={found} onError={() => setFailed(true)} />
          {failed && (
            <ErrorNotice message="浏览器无法播放该文件。HEVC、AV1 等编码或 MKV/FLV 容器可能不受当前浏览器支持，可下载后用本地播放器观看。" />
          )}
          <footer className="player-toolbar">
            {href && (
              <a className="button secondary" href={href} download>
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
