import type { ParseProgress, ParseResult, Task } from "../types";
export const task: Task = {
  id: "task-1",
  url: "https://www.bilibili.com/video/BVtest",
  title: "测试视频",
  thumbnail: null,
  status: "downloading",
  progress: 42.5,
  downloaded_bytes: 1024,
  total_bytes: 4096,
  speed: 100,
  eta: 30,
  error: null,
  quality: "1080",
  mode: "video",
  codec: "avc",
  cover: true,
  subtitles: false,
  record_removed: false,
  files_deleted: false,
  source_key: "source-1",
  download_dir: "/downloads",
  created_at: "2026-01-01T12:00:00Z",
  updated_at: "2026-01-01T12:00:00Z",
};
export const parsed: ParseResult = {
  id: "parse-1",
  title: "测试合集",
  thumbnail: null,
  truncated: true,
  warnings: ["部分资源不可用"],
  entries: [
    {
      id: "p1",
      title: "第一集",
      group: "正片",
      available: true,
      error: null,
      qualities: [2160, 1440, 1080, 720],
      codecs: ["avc", "hevc", "av1"],
      has_subtitles: true,
      url: "entry1",
      duration: 60,
      thumbnail: null,
    },
    {
      id: "p2",
      title: "第二集",
      group: "正片",
      available: true,
      error: null,
      qualities: [720],
      codecs: ["avc"],
      has_subtitles: false,
      url: "entry2",
      duration: 120,
      thumbnail: null,
    },
    {
      id: "p3",
      title: "未播出",
      group: "花絮",
      available: false,
      error: "尚未播出",
      qualities: [],
      codecs: [],
      has_subtitles: false,
      url: "entry3",
      duration: null,
      thumbnail: null,
    },
    {
      id: "p4",
      title: "音频访谈",
      group: "花絮",
      available: true,
      error: null,
      qualities: [],
      codecs: [],
      has_subtitles: false,
      url: "entry4",
      duration: 10,
      thumbnail: null,
    },
  ],
};
// A retry response is the complete merged result, including entries not retried.
export const retryParsed: ParseResult = {
  ...parsed,
  entries: [
    ...parsed.entries,
    {
      ...parsed.entries[2],
      id: "p5",
      title: "加载失败的花絮",
      url: "entry5",
      error: "读取资源超时",
    },
  ],
};
export function retryResult(id: string, recoveredIds: string[]): ParseResult {
  return {
    ...retryParsed,
    id,
    entries: retryParsed.entries.map((entry) =>
      recoveredIds.includes(entry.id)
        ? { ...entry, available: true, error: null, qualities: [720], codecs: ["avc"] }
        : entry,
    ),
  };
}
export const system = {
  version: "test",
  yt_dlp_version: "test",
  ffmpeg: true,
  disk_total: 1024,
  disk_free: 512,
  download_dir: "/downloads",
  active_tasks: 0,
};
export const progress: ParseProgress = {
  stage: "extracting", completed: 2, total: 4, succeeded: 1, failed: 1, title: "当前中文标题 🎬",
};
// Controlled byte stream: tests deliver actual events; clocks never invent progress.
export function parseFeed() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
  return {
    response,
    get cancelled() { return cancelled; },
    bytes(value: Uint8Array) { if (!cancelled) controller.enqueue(value); },
    send(value: unknown) { if (!cancelled) controller.enqueue(new TextEncoder().encode(`${JSON.stringify(value)}\n`)); },
    end() { if (!cancelled) controller.close(); },
  };
}
export function respond(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status });
}
