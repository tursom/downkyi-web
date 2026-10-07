import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDanmaku } from "../Player";
import Tasks from "../Tasks";
import { respond, task } from "./fixtures";
import type { Task } from "../types";

const players = vi.hoisted(() => [] as {
  option: Record<string, any>;
  handlers: Record<string, () => void>;
  destroy: ReturnType<typeof vi.fn>;
  instance: { fullscreenWeb: boolean };
}[]);
vi.mock("artplayer", () => ({
  default: vi.fn(function (this: unknown, option: Record<string, any>) {
    const destroy = vi.fn();
    const handlers: Record<string, () => void> = {};
    const instance = {
      fullscreenWeb: false,
      on: (name: string, handler: () => void) => { handlers[name] = handler; },
      destroy,
      subtitle: { switch: vi.fn() },
    };
    players.push({ option, handlers, destroy, instance });
    return instance;
  }),
}));
vi.mock("artplayer-plugin-danmuku", () => ({
  default: vi.fn((option: Record<string, unknown>) => ({ danmakuOption: option })),
}));

const completed: Task = { ...task, status: "completed", danmaku: true, subtitles: true };
const files = [
  { name: "media.mp4", size: 2048, url: "/api/tasks/task-1/files/media.mp4" },
  { name: "media.jpg", size: 64, url: "/api/tasks/task-1/files/media.jpg" },
  { name: "media.zh-CN.srt", size: 64, url: "/api/tasks/task-1/files/media.zh-CN.srt" },
  { name: "media.en-US.srt", size: 64, url: "/api/tasks/task-1/files/media.en-US.srt" },
  { name: "media.danmaku.xml", size: 64, url: "/api/tasks/task-1/files/media.danmaku.xml" },
  { name: "media.danmaku.ass", size: 64, url: "/api/tasks/task-1/files/media.danmaku.ass" },
];
const xml = '<i><d p="0.5,1,25,16711680,0,0,u,1">滚动</d><d p="0.1,5,25,16777215,0,0,u,2">顶部</d><d p="0.2,4,25,255,0,0,u,3">底部</d><d p="1,7,25,0,0,0,u,4">高级</d></i>';

function props(tasks: Task[]) {
  return { tasks, loading: false, error: "", refresh: vi.fn(), onNew: vi.fn(), onBrowse: vi.fn(), message: "" };
}
function playerFetch(list = files) {
  const fetch = vi.fn(async (url: string) =>
    url.endsWith(".danmaku.xml") ? new Response(xml) : respond({ files: list }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("downloaded video playback", () => {
  beforeEach(() => { players.length = 0; });

  it("parses supported danmaku modes in time order and skips unsupported ones", () => {
    expect(parseDanmaku(xml)).toEqual([
      { time: 0.1, text: "顶部", mode: 1, color: "#ffffff" },
      { time: 0.2, text: "底部", mode: 2, color: "#0000ff" },
      { time: 0.5, text: "滚动", mode: 0, color: "#ff0000" },
    ]);
    expect(parseDanmaku("<i><d")).toEqual([]);
  });

  it("opens ArtPlayer with verified media, local cover, subtitle tracks and danmaku", async () => {
    const user = userEvent.setup(), fetch = playerFetch();
    render(<Tasks {...props([completed])} />);
    await user.click(screen.getByRole("button", { name: "播放：测试视频" }));
    const dialog = await screen.findByRole("dialog", { name: "测试视频" });
    await waitFor(() => expect(players).toHaveLength(1));
    const { option } = players[0];
    expect(within(dialog).getByLabelText("播放 测试视频")).toBe(option.container);
    expect(option).toMatchObject({
      url: "/api/tasks/task-1/play/media.mp4",
      poster: `${window.location.origin}/api/tasks/task-1/files/media.jpg`,
      lang: "zh-cn",
      autoPlayback: true,
      fullscreenWeb: true,
      subtitle: { url: "/api/tasks/task-1/subtitles/media.zh-CN.srt", name: "zh-CN", type: "vtt", escape: true },
    });
    expect(option.settings[0].selector.map((item: { html: string }) => item.html)).toEqual(["zh-CN", "en-US"]);
    const danmaku = option.plugins[0].danmakuOption;
    expect(danmaku.emitter).toBe(false);
    expect(await danmaku.danmuku()).toHaveLength(3);
    expect(fetch).toHaveBeenCalledWith(
      `${window.location.origin}/api/tasks/task-1/files/media.danmaku.xml`, { credentials: "same-origin" });
    act(() => players[0].handlers["video:error"]());
    expect(within(dialog).getByRole("alert")).toHaveTextContent("浏览器无法播放该文件");
    // Escape leaves web fullscreen without closing the dialog; the next press closes it.
    players[0].instance.fullscreenWeb = true;
    await user.keyboard("{Escape}");
    expect(players[0].instance.fullscreenWeb).toBe(false);
    expect(dialog).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(players[0].destroy).toHaveBeenCalledWith(false);
  });

  it("skips danmaku for audio-only tasks", async () => {
    const user = userEvent.setup();
    playerFetch([{ name: "media.m4a", size: 1, url: "/api/tasks/task-1/files/media.m4a" }, files[4]]);
    render(<Tasks {...props([{ ...completed, mode: "audio" }])} />);
    await user.click(screen.getByRole("button", { name: "播放：测试视频" }));
    await waitFor(() => expect(players).toHaveLength(1));
    expect(players[0].option).toMatchObject({ url: "/api/tasks/task-1/play/media.m4a", poster: "", plugins: [] });
    expect(players[0].option).not.toHaveProperty("subtitle");
  });

  it("offers playback only for completed tasks whose files still exist", async () => {
    const user = userEvent.setup();
    playerFetch();
    render(<Tasks {...props([
      { ...completed, id: "gone", title: "已删除", files_deleted: true },
      { ...task, id: "paused", title: "暂停中", status: "paused" },
      { ...completed, title: "可播放" },
    ])} />);
    expect(screen.queryByRole("button", { name: "播放：已删除" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "播放：暂停中" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "任务详情：可播放" }));
    await user.click(await screen.findByRole("button", { name: "在线播放" }));
    expect(await screen.findByLabelText("播放 可播放")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "任务详情" })).not.toBeInTheDocument();
  });
});
