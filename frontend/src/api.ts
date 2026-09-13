import type { ParseProgress, ParseResult } from "./types";

export const SESSION_EXPIRED = "downkyi:session-expired";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function detailMessage(detail: unknown): string | undefined {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item: unknown) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "msg" in item) {
          const issue = item as { msg: unknown; loc?: unknown[] };
          const location = issue.loc
            ?.filter((part) => part !== "body")
            .join(".");
          return `${location ? `${location}: ` : ""}${String(issue.msg)}`;
        }
        return "请求参数不正确";
      })
      .join("；");
  }
  return undefined;
}

interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  public?: boolean;
}

export async function api<T = void>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { body, public: isPublic = false, headers, ...init } = options;
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      credentials: "same-origin",
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new Error("无法连接服务器，请检查网络后重试");
  }
  if (response.status === 401 && !isPublic) {
    window.dispatchEvent(new Event(SESSION_EXPIRED));
  }
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!response.ok) {
    const detail =
      data && typeof data === "object" && "detail" in data
        ? data.detail
        : undefined;
    throw new ApiError(
      detailMessage(detail) ||
        (response.status === 401
          ? "登录已失效，请重新登录"
          : `请求失败（${response.status}），请稍后重试`),
      response.status,
    );
  }
  if (text && data === undefined)
    throw new Error("服务器返回了无效的数据，请稍后重试");
  return data as T;
}

// Bound each NDJSON record (including the complete result), or the legacy JSON body.
export const PARSE_BUFFER_LIMIT = 2 * 1024 * 1024;
const invalidParse = () => new Error("服务器返回了无效的解析数据，请重试");
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const nullableString = (value: unknown) => value === null || typeof value === "string";
function parseResult(value: unknown): ParseResult {
  if (!record(value) || typeof value.id !== "string" || !value.id ||
      typeof value.title !== "string" || !nullableString(value.thumbnail) ||
      typeof value.truncated !== "boolean" || !strings(value.warnings) ||
      !Array.isArray(value.entries) || !value.entries.every((entry) =>
        record(entry) && typeof entry.id === "string" && typeof entry.title === "string" &&
        typeof entry.url === "string" && typeof entry.group === "string" &&
        typeof entry.available === "boolean" && typeof entry.has_subtitles === "boolean" &&
        nullableString(entry.error) && nullableString(entry.thumbnail) &&
        (entry.duration === null || (typeof entry.duration === "number" && Number.isFinite(entry.duration) && entry.duration >= 0)) &&
        strings(entry.codecs) && Array.isArray(entry.qualities) && entry.qualities.every(count)))
    throw invalidParse();
  return value as unknown as ParseResult;
}
function parseProgress(value: unknown): ParseProgress {
  if (!record(value) || !["resolving", "listing", "extracting"].includes(String(value.stage)) ||
      !count(value.completed) || !(value.total === null || count(value.total)) ||
      !count(value.succeeded) || !count(value.failed) || typeof value.title !== "string" ||
      (value.total !== null && value.completed > value.total) ||
      value.succeeded + value.failed > value.completed)
    throw invalidParse();
  return value as unknown as ParseProgress;
}

/** Dedicated parse transport; ordinary API calls keep their existing JSON behavior. */
export async function parseStream(
  path: string,
  options: RequestOptions,
  onProgress: (progress: ParseProgress) => void,
): Promise<ParseResult> {
  const { body, headers, public: isPublic = false, ...init } = options;
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Accept", "application/x-ndjson");
  if (body !== undefined) requestHeaders.set("Content-Type", "application/json");
  const checkAbort = () => {
    if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  };
  checkAbort();
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init, credentials: "same-origin", headers: Object.fromEntries(
        [...requestHeaders].map(([key, value]) => [key === "content-type" ? "Content-Type" : key, value]),
      ),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (cause) {
    checkAbort();
    if (isAbort(cause)) throw cause;
    throw new Error("无法连接服务器，请检查网络后重试");
  }
  const expire = (status: number) => {
    if (status === 401 && !isPublic) window.dispatchEvent(new Event(SESSION_EXPIRED));
  };
  const streaming = response.ok && response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() === "application/x-ndjson";
  const reader = response.body?.getReader();
  if (!reader) { checkAbort(); throw invalidParse(); }
  const abort = () => { void reader.cancel().catch(() => {}); };
  init.signal?.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", bufferedBytes = 0;
  const json = (text: string): unknown => {
    try { return JSON.parse(text); } catch { throw invalidParse(); }
  };
  const event = (line: string): ParseResult | undefined => {
    if (!line.trim()) return;
    const data = json(line);
    if (!record(data)) throw invalidParse();
    if (data.event === "heartbeat") return;
    if (data.event === "progress") { checkAbort(); onProgress(parseProgress(data.progress)); return; }
    if (data.event === "parsed") return parseResult(data.result);
    if (data.event === "error" && typeof data.message === "string" && data.message.trim() &&
        count(data.status) && data.status >= 400 && data.status <= 599) {
      expire(data.status);
      throw new ApiError(data.message, data.status);
    }
    throw invalidParse();
  };
  try {
    checkAbort();
    expire(response.status);
    while (true) {
      const { value, done } = await reader.read();
      checkAbort();
      // Scan bytes first: limits are enforced before decoding/concatenating large chunks.
      if (value) {
        let start = 0;
        for (let end = 0; end <= value.length; end++) {
          const newline = streaming && end < value.length && value[end] === 10;
          if (!newline && end !== value.length) continue;
          const piece = value.subarray(start, end);
          bufferedBytes += piece.byteLength;
          if (bufferedBytes > PARSE_BUFFER_LIMIT) throw new Error("解析数据超过大小限制，请缩小内容范围后重试");
          try { buffer += decoder.decode(piece, { stream: true }); } catch { throw invalidParse(); }
          if (newline) {
            // A UTF-8 character cannot straddle a newline.
            try { buffer += decoder.decode(); } catch { throw invalidParse(); }
            const result = event(buffer);
            buffer = ""; bufferedBytes = 0;
            if (result) return result;
          }
          start = end + 1;
        }
      }
      if (done) break;
    }
    try { buffer += decoder.decode(); } catch { throw invalidParse(); }
    if (streaming) {
      const result = event(buffer);
      if (result) return result;
      throw new Error("解析连接提前结束，未收到完整结果，请重试");
    }
    if (!response.ok) {
      let data: unknown;
      try { data = JSON.parse(buffer); } catch { /* Use the safe HTTP fallback. */ }
      throw new ApiError(
        (record(data) && detailMessage(data.detail)) ||
          (response.status === 401 ? "登录已失效，请重新登录" : `请求失败（${response.status}），请稍后重试`),
        response.status,
      );
    }
    return parseResult(json(buffer));
  } finally {
    init.signal?.removeEventListener("abort", abort);
    // Also stop streams whose producer leaves the connection open after a terminal event.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function isAbort(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "AbortError"
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}

export function taskPath(id: string, suffix = ""): string {
  return `/tasks/${encodeURIComponent(id)}${suffix}`;
}

// Downloads stay on the authenticated origin; never turn API data into executable links.
export function downloadUrl(value: string): string | undefined {
  try {
    const url = new URL(value, window.location.origin);
    if (
      !value.trim() ||
      url.origin !== window.location.origin ||
      !["http:", "https:"].includes(url.protocol)
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
