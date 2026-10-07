import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { parseDanmaku } from "../Player";
import Tasks from "../Tasks";
import { respond, task } from "./fixtures";
import type { Task } from "../types";

const completed: Task = { ...task, status: "completed", danmaku: true, subtitles: true };
const files = [
  { name: "media.mp4", size: 2048, url: "/api/tasks/task-1/files/media.mp4" },
  { name: "media.jpg", size: 64, url: "/api/tasks/task-1/files/media.jpg" },
  { name: "media.zh-CN.srt", size: 64, url: "/api/tasks/task-1/files/media.zh-CN.srt" },
  { name: "media.danmaku.xml", size: 64, url: "/api/tasks/task-1/files/media.danmaku.xml" },
  { name: "media.danmaku.ass", size: 64, url: "/api/tasks/task-1/files/media.danmaku.ass" },
];
const xml = '<i><d p="0.5,1,25,16711680,0,0,u,1">滚动</d><d p="0.1,5,25,16777215,0,0,u,2">顶部</d><d p="1,7,25,0,0,0,u,3">高级</d></i>';

function props(tasks: Task[]) {
  return { tasks, loading: false, error: "", refresh: vi.fn(), onNew: vi.fn(), onBrowse: vi.fn(), message: "" };
}
function playerFetch() {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const fetch = vi.fn(async (url: string) =>
    url.endsWith(".danmaku.xml") ? new Response(xml) : respond({ files }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("downloaded video playback", () => {
  it("parses supported danmaku modes in time order and skips unsupported ones", () => {
    expect(parseDanmaku(xml)).toEqual([
      { time: 0.1, text: "顶部", mode: "top", color: "#ffffff", size: 1 },
      { time: 0.5, text: "滚动", mode: "scroll", color: "#ff0000", size: 1 },
    ]);
    expect(parseDanmaku("<i><d")).toEqual([]);
  });

  it("plays the verified media with subtitle tracks, local cover and toggleable danmaku", async () => {
    const user = userEvent.setup(), fetch = playerFetch();
    render(<Tasks {...props([completed])} />);
    await user.click(screen.getByRole("button", { name: "播放：测试视频" }));
    const dialog = await screen.findByRole("dialog", { name: "测试视频" });
    const video = await within(dialog).findByLabelText("播放 测试视频");
    expect(video).toHaveAttribute("src", "/api/tasks/task-1/play/media.mp4");
    expect(video).toHaveAttribute("poster", `${window.location.origin}/api/tasks/task-1/files/media.jpg`);
    const track = video.querySelector("track")!;
    expect(track).toHaveAttribute("src", "/api/tasks/task-1/subtitles/media.zh-CN.srt");
    expect(track).toHaveAttribute("label", "zh-CN");
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      `${window.location.origin}/api/tasks/task-1/files/media.danmaku.xml`, expect.anything()));
    const toggle = within(dialog).getByRole("button", { name: "弹幕：开" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await user.click(toggle);
    expect(within(dialog).getByRole("button", { name: "弹幕：关" })).toHaveAttribute("aria-pressed", "false");
    expect(dialog.querySelector(".danmaku-layer")).toBeNull();
    fireEvent.error(video);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("浏览器无法播放该文件");
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
