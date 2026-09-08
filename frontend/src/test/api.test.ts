import { describe, expect, it, vi } from "vitest";
import { api, ApiError, downloadUrl, SESSION_EXPIRED, taskPath } from "../api";
import { bytes, duration, percent } from "../format";

describe("API client", () => {
  it("uses same-origin cookies and JSON request bodies", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response('{"authenticated":true}'));
    vi.stubGlobal("fetch", fetch);
    expect(
      await api("/login", { method: "POST", body: { token: "test-token" } }),
    ).toEqual({ authenticated: true });
    expect(fetch).toHaveBeenCalledWith(
      "/api/login",
      expect.objectContaining({
        credentials: "same-origin",
        body: '{"token":"test-token"}',
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  it("turns FastAPI validation details into useful text without exposing input values", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              detail: [
                {
                  loc: ["body", "concurrency"],
                  msg: "必须小于等于 4",
                  input: "private-input",
                },
              ],
            }),
            { status: 422 },
          ),
        ),
    );
    await expect(api("/settings")).rejects.toThrow(
      "concurrency: 必须小于等于 4",
    );
  });

  it("expires protected sessions on 401 but not rejected login attempts", async () => {
    const expired = vi.fn();
    window.addEventListener(SESSION_EXPIRED, expired);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(new Response('{"detail":"未认证"}', { status: 401 })),
        ),
    );
    await expect(api("/tasks")).rejects.toBeInstanceOf(ApiError);
    expect(expired).toHaveBeenCalledTimes(1);
    await expect(api("/login", { public: true })).rejects.toThrow("未认证");
    expect(expired).toHaveBeenCalledTimes(1);
    window.removeEventListener(SESSION_EXPIRED, expired);
  });

  it("accepts 204 responses and handles non-JSON errors", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response("<html>bad gateway</html>", { status: 502 }),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(api("/logout", { method: "POST" })).resolves.toBeUndefined();
    await expect(api("/tasks")).rejects.toThrow("502");
  });

  it("preserves aborts and reports network failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new DOMException("Aborted", "AbortError"))
        .mockRejectedValueOnce(new TypeError("Failed to fetch")),
    );
    await expect(api("/tasks")).rejects.toHaveProperty("name", "AbortError");
    await expect(api("/tasks")).rejects.toThrow("无法连接服务器");
  });

  it("rejects invalid successful JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>not API</html>")),
    );
    await expect(api("/tasks")).rejects.toThrow("无效的数据");
  });

  it("encodes IDs and limits download links to the authenticated origin", () => {
    expect(taskPath("part/a?", "/resume")).toBe("/tasks/part%2Fa%3F/resume");
    expect(downloadUrl("/api/tasks/1/files/a.mp4")).toBe(
      `${window.location.origin}/api/tasks/1/files/a.mp4`,
    );
    expect(downloadUrl("javascript:alert(1)")).toBeUndefined();
    expect(downloadUrl("https://untrusted.example/file")).toBeUndefined();
    expect(downloadUrl("")).toBeUndefined();
  });
});

describe("formatting", () => {
  it("formats real units and unknown values without invented data", () => {
    expect(bytes(1024)).toBe("1.0 KB");
    expect(bytes(0)).toBe("0 B");
    expect(bytes(null)).toBe("—");
    expect(duration(3661)).toBe("1:01:01");
    expect(duration(null)).toBe("—");
    expect(percent(105)).toBe(100);
    expect(percent(-1)).toBe(0);
  });
});
