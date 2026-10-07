export type TaskStatus =
  | "queued"
  | "resolving"
  | "downloading"
  | "merging"
  | "paused"
  | "completed"
  | "failed";
export type Quality = "best" | "2160" | "1440" | "1080" | "720" | "480" | "360";
export type Codec = "auto" | "avc" | "hevc" | "av1";
export type DownloadMode = "video" | "audio";
export interface Task {
  id: string;
  url: string;
  title: string;
  thumbnail: string | null;
  status: TaskStatus;
  progress: number;
  downloaded_bytes: number;
  total_bytes: number | null;
  speed: number | null;
  eta: number | null;
  error: string | null;
  quality: string;
  mode: DownloadMode;
  codec: string;
  subtitles: boolean;
  cover: boolean;
  danmaku: boolean;
  created_at: string;
  updated_at: string;
  record_removed: boolean;
  files_deleted: boolean;
  source_key: string;
  download_dir?: string;
  /** Collection, multi-part video or season the task was queued from; "" when standalone. */
  group?: string;
  /** The list link the task was queued from; "" for tasks created before it was recorded. */
  source_url?: string;
}
export interface ParsedEntry {
  resolution?: "pending" | "ready" | "failed";
  id: string;
  title: string;
  url: string;
  duration: number | null;
  thumbnail: string | null;
  group: string;
  available: boolean;
  error: string | null;
  qualities: number[];
  codecs: string[];
  has_subtitles: boolean;
}
export interface ParseProgress {
  stage: "resolving" | "listing" | "extracting";
  completed: number;
  total: number | null;
  succeeded: number;
  failed: number;
  title: string;
}
export interface ParseResult {
  id: string;
  title: string;
  thumbnail: string | null;
  entries: ParsedEntry[];
  truncated: boolean;
  warnings: string[];
  source_url?: string;
}
/** Videos of a collection that already have a task, keyed by entry URL. */
export type KnownEntries = Record<string, "downloaded" | "queued">;
export interface CollectionUpdate {
  group: string;
  url: string;
  known: KnownEntries;
}
export interface DownloadOptions {
  quality: Quality;
  mode: DownloadMode;
  codec: Codec;
  subtitles: boolean;
  cover: boolean;
  danmaku: boolean;
}
export interface TaskFile {
  name: string;
  size: number;
  url: string;
}
export interface Settings {
  concurrency: number;
  download_dir: string;
  default_download_dir: string;
  cookie_configured: boolean;
}
export interface Account {
  logged_in: boolean;
  username: string | null;
  vip: boolean;
  message?: string;
}
export interface QrSession {
  id: string;
  url: string;
  image: string;
  expires_in: number;
}
export interface QrPoll {
  status: "waiting" | "scanned" | "expired" | "confirmed";
  message: string;
}
export interface SystemInfo {
  version: string;
  yt_dlp_version: string;
  ffmpeg: boolean;
  disk_total: number;
  disk_free: number;
  download_dir: string;
  active_tasks: number;
}
