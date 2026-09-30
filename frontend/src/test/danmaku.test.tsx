import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ParseModal from "../ParseModal";
import TaskDetail from "../TaskDetail";
import type { Task } from "../types";
import { discovered, parsed, respond, task } from "./fixtures";

async function openSpecs() {
  // This entry has no subtitles; danmaku must remain independently selectable.
  const source = { ...parsed, entries: [parsed.entries[1]] };
  const fetch = vi.fn()
    .mockResolvedValueOnce(respond(discovered(source)))
    .mockResolvedValueOnce(respond(source))
    .mockResolvedValueOnce(respond({ tasks: [task] }));
  vi.stubGlobal("fetch", fetch);
  const onCreated = vi.fn();
  const user = userEvent.setup();
  render(<ParseModal onClose={vi.fn()} onCreated={onCreated} />);
  await user.type(screen.getByLabelText("视频、合集、番剧链接或 BV / AV 号"), "BVtest");
  await user.click(screen.getByRole("button", { name: "读取列表" }));
  await screen.findByRole("region", { name: "下载规格" });
  return { fetch, onCreated, user };
}

const danmakuOption = () => screen.getByRole("checkbox", { name: "下载弹幕 (XML + ASS)" });

describe("danmaku attachments", () => {
  it.each(["video", "audio"] as const)(
    "preserves opt-in through review/back and submits it independently in %s mode",
    async (mode) => {
      const { fetch, onCreated, user } = await openSpecs();
      expect(danmakuOption()).not.toBeChecked();
      await user.click(screen.getByLabelText("下载封面"));
      await user.click(danmakuOption());
      // Switching modes must retain the checkbox and allow changing it.
      await user.click(screen.getByRole("button", { name: "仅音频" }));
      expect(danmakuOption()).toBeEnabled();
      expect(danmakuOption()).toBeChecked();
      await user.click(danmakuOption());
      expect(danmakuOption()).not.toBeChecked();
      await user.click(danmakuOption());
      if (mode === "video") await user.click(screen.getByRole("button", { name: "视频" }));
      expect(screen.getByLabelText("下载字幕")).not.toBeChecked();
      expect(screen.getByLabelText("下载封面")).not.toBeChecked();
      await user.click(screen.getByRole("button", { name: "确认规格" }));
      expect(screen.getByText(mode === "audio"
        ? "仅音频 · 弹幕 (XML + ASS)"
        : "视频 · 最佳可用画质 · 自动编码 · 弹幕 (XML + ASS)")).toBeVisible();
      expect(within(screen.getByRole("table")).getByRole("cell", {
        name: "弹幕 (XML + ASS)",
      })).toBeVisible();
      expect(fetch).toHaveBeenCalledTimes(2);
      await user.click(screen.getByRole("button", { name: "上一步" }));
      expect(danmakuOption()).toBeChecked();
      expect(screen.getByLabelText("下载字幕")).not.toBeChecked();
      expect(screen.getByLabelText("下载封面")).not.toBeChecked();
      await user.click(screen.getByRole("button", { name: "确认规格" }));
      await user.click(screen.getByRole("button", { name: "加入队列 (1)" }));
      await waitFor(() => expect(onCreated).toHaveBeenCalledWith(1));
      expect(fetch.mock.calls[2][0]).toBe("/api/tasks");
      expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({
        parse_id: parsed.id, entry_ids: ["p2"], quality: "best", codec: "auto",
        mode, cover: false, subtitles: false, danmaku: true,
      });
    },
  );

  it.each(["default", "unchecked"])("submits false when %s and omits danmaku from review", async (choice) => {
    const { fetch, onCreated, user } = await openSpecs();
    expect(danmakuOption()).not.toBeChecked();
    if (choice === "unchecked") {
      await user.click(danmakuOption());
      await user.click(danmakuOption());
    }
    expect(screen.getByLabelText("下载封面")).toBeChecked();
    expect(screen.getByLabelText("下载字幕")).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "确认规格" }));
    expect(screen.getByRole("dialog")).not.toHaveTextContent("弹幕");
    await user.click(screen.getByRole("button", { name: "上一步" }));
    expect(danmakuOption()).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "确认规格" }));
    await user.click(screen.getByRole("button", { name: "加入队列 (1)" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(1));
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toMatchObject({
      cover: true, subtitles: false, danmaku: false,
    });
  });

  it("shows danmaku in task attachments and downloads both formats through the generic files API", async () => {
    const files = ["video.xml", "video.ass"].map((name) => ({
      name, size: 1024, url: `/api/tasks/task-1/files/${name}`,
    }));
    const fetch = vi.fn().mockResolvedValue(respond({ files }));
    vi.stubGlobal("fetch", fetch);
    renderDetail({ ...task, cover: false, danmaku: true, mode: "audio", status: "completed" });
    expect(screen.getByText("弹幕 (XML + ASS)")).toBeVisible();
    for (const file of files) {
      const link = await screen.findByRole("link", { name: `下载 ${file.name}` });
      expect(link).toHaveAttribute("href", `${window.location.origin}${file.url}`);
      expect(link).toHaveAttribute("download");
    }
    expect(fetch).toHaveBeenCalledWith("/api/tasks/task-1/files", expect.anything());
  });

  it.each([false, undefined])("does not show danmaku for tasks with danmaku=%s", (danmaku) => {
    const legacyTask: Partial<Task> = { ...task, cover: false, danmaku };
    if (danmaku === undefined) delete legacyTask.danmaku;
    renderDetail(legacyTask as Task);
    expect(screen.getByText("无")).toBeVisible();
    expect(screen.getByRole("dialog")).not.toHaveTextContent("弹幕");
  });
});

function renderDetail(detailTask: Task) {
  return render(<TaskDetail task={detailTask} onClose={vi.fn()} onDelete={vi.fn()}
    onAction={vi.fn()} busy={false} error="" />);
}
