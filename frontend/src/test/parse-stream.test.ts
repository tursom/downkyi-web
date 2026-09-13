import { describe, expect, it, vi } from "vitest";
import { ApiError, PARSE_BUFFER_LIMIT, parseStream, SESSION_EXPIRED } from "../api";
import { parsed, parseFeed, progress, respond } from "./fixtures";

function start(feed = parseFeed(), signal?: AbortSignal) {
  const fetch = vi.fn().mockResolvedValue(feed.response);
  vi.stubGlobal("fetch", fetch);
  const callback = vi.fn();
  const result = parseStream("/parse", { method: "POST", body: { url: "BVtest" }, signal }, callback);
  return { feed, fetch, callback, result };
}
describe("parse NDJSON transport", () => {
  it("decodes one-byte UTF-8 chunks, CRLF, heartbeats and multiple records; returns terminal without waiting for EOF", async () => {
    const { feed, result, callback, fetch } = start();
    const text = `\r\n${JSON.stringify({ event: "heartbeat" })}\r\n${JSON.stringify({ event: "progress", progress })}\r\n${JSON.stringify({ event: "parsed", result: parsed })}\n`;
    for (const byte of new TextEncoder().encode(text)) feed.bytes(new Uint8Array([byte]));
    await expect(result).resolves.toEqual(parsed);
    expect(callback).toHaveBeenCalledExactlyOnceWith(progress);
    const headers = new Headers(fetch.mock.calls[0][1].headers);
    expect(headers.get("Accept")).toBe("application/x-ndjson");
    expect(feed.cancelled).toBe(true);
  });
  it("accepts many records in a chunk and a terminal without a final newline", async () => {
    const { feed, result, callback } = start();
    feed.bytes(new TextEncoder().encode(`${JSON.stringify({ event: "progress", progress })}\n${JSON.stringify({ event: "parsed", result: parsed })}`));
    feed.end();
    await expect(result).resolves.toEqual(parsed);
    expect(callback).toHaveBeenCalledOnce();
  });
  it("keeps unknown totals, including single-video extraction", async () => {
    const { feed, result, callback } = start();
    feed.send({ event: "progress", progress: { ...progress, completed: 1, succeeded: 1, failed: 0, total: null } });
    feed.send({ event: "parsed", result: parsed });
    await result;
    expect(callback.mock.calls[0][0].total).toBeNull();
  });
  it.each([respond(parsed), new Response(JSON.stringify(parsed), { headers: { "Content-Type": "application/json" } })])("accepts legacy JSON", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(parseStream("/parse", {}, vi.fn())).resolves.toEqual(parsed);
  });
  it.each([410, 429, 503])("preserves HTTP and streamed error status %s", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond({ detail: "安全中文错误" }, status)));
    await expect(parseStream("/parse", {}, vi.fn())).rejects.toMatchObject({ message: "安全中文错误", status });
    const { feed, result } = start();
    feed.send({ event: "error", message: "安全中文错误", status });
    await expect(result).rejects.toMatchObject({ message: "安全中文错误", status });
  });
  it("dispatches session expiry for streamed errors", async () => {
    const expired = vi.fn();
    window.addEventListener(SESSION_EXPIRED, expired);
    try {
      const { feed, result } = start();
      feed.send({ event: "error", message: "登录已失效", status: 401 });
      await expect(result).rejects.toBeInstanceOf(ApiError);
      expect(expired).toHaveBeenCalledOnce();
    } finally { window.removeEventListener(SESSION_EXPIRED, expired); }
  });
  it.each([
    "{bad}\n", '{"event":"parsed"', '{"event":"unknown"}\n',
    `${JSON.stringify({ event: "progress", progress: { ...progress, total: -1 } })}\n`,
    `${JSON.stringify({ event: "progress", progress: { ...progress, completed: 5 } })}\n`,
    `${JSON.stringify({ event: "parsed", result: { id: "incomplete" } })}\n`,
    `${JSON.stringify({ event: "error", message: 123, status: 500 })}\n`,
  ])("rejects malformed JSON/event/result: %s", async (text) => {
    const { feed, result } = start();
    feed.bytes(new TextEncoder().encode(text)); feed.end();
    await expect(result).rejects.toThrow("无效");
  });
  it.each(["", '{"event":"heartbeat"}\n', JSON.stringify({ event: "progress", progress })])("rejects EOF without a terminal", async (text) => {
    const { feed, result } = start();
    feed.bytes(new TextEncoder().encode(text)); feed.end();
    await expect(result).rejects.toThrow("未收到完整结果");
  });
  it.each([[0xff, 10], [0xe4], [0xe4, 10]])("rejects invalid/incomplete UTF-8 %s", async (...bytes) => {
    const { feed, result } = start();
    feed.bytes(new Uint8Array(bytes)); feed.end();
    await expect(result).rejects.toThrow("无效");
  });
  it("bounds incomplete records and releases the stream", async () => {
    const { feed, result } = start();
    feed.bytes(new Uint8Array(PARSE_BUFFER_LIMIT + 1).fill(32));
    await expect(result).rejects.toThrow("大小限制");
    expect(feed.cancelled).toBe(true);
  });
  it("resets its bound between records", async () => {
    const { feed, result } = start();
    for (let i = 0; i < 3; i++) feed.bytes(new TextEncoder().encode(`${" ".repeat(PARSE_BUFFER_LIMIT - 32)}{"event":"heartbeat"}\n`));
    feed.send({ event: "parsed", result: parsed });
    await expect(result).resolves.toEqual(parsed);
  });
  it("aborts a pending reader promptly and stops callbacks", async () => {
    const controller = new AbortController();
    const { feed, result, callback } = start(undefined, controller.signal);
    await Promise.resolve();
    controller.abort();
    feed.send({ event: "progress", progress });
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(callback).not.toHaveBeenCalled();
    expect(feed.cancelled).toBe(true);
  });
  it("does not fetch an already aborted request", async () => {
    const controller = new AbortController(); controller.abort();
    const { result, fetch } = start(undefined, controller.signal);
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
