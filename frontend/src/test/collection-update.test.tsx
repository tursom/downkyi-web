import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { collectionSource, knownEntries } from "../grouping";
import ParseModal from "../ParseModal";
import Tasks from "../Tasks";
import { discovered, parsed, respond, task } from "./fixtures";
import type { KnownEntries, Task } from "../types";

const member = (id: string, extra: Partial<Task>): Task =>
  ({ ...task, id, source_key: id, group: "合集·中世纪", title: `视频 ${id}`, status: "completed", ...extra });
const body = (fetch: ReturnType<typeof vi.fn>, index: number) => JSON.parse(fetch.mock.calls[index][1].body);

function check(known: KnownEntries, source = { ...discovered(), title: "合集·中世纪" }) {
  const fetch = vi.fn().mockResolvedValueOnce(respond(source));
  vi.stubGlobal("fetch", fetch);
  render(<ParseModal onClose={vi.fn()} onCreated={vi.fn()} update={{ group: "合集·中世纪", url: "https://www.bilibili.com/video/BVlegacy", known }} />);
  return fetch;
}

describe("collection update checks", () => {
  it("prefers the newest recorded list link and falls back to a member video for older tasks", () => {
    const legacy = member("a", { url: "https://www.bilibili.com/video/BVa?p=2", created_at: "2026-09-01T00:00:00Z" });
    expect(collectionSource([legacy])).toBe("https://www.bilibili.com/video/BVa?p=2");
    expect(collectionSource([
      legacy,
      member("b", { source_url: "https://space.bilibili.com/1/favlist?fid=1", created_at: "2026-09-02T00:00:00Z" }),
      member("c", { source_url: "https://www.bilibili.com/medialist/detail/ml9", created_at: "2026-09-03T00:00:00Z" }),
    ])).toBe("https://www.bilibili.com/medialist/detail/ml9");
    expect(knownEntries([
      member("x", { url: "u1", status: "failed" }), member("y", { url: "u1" }), member("z", { url: "u2", status: "paused" }),
    ])).toEqual({ u1: "downloaded", u2: "queued" });
  });

  it("offers a check on each collection row with the collection's link", async () => {
    const onCheckUpdates = vi.fn();
    render(<Tasks tasks={[member("a", { url: "https://www.bilibili.com/video/BVa" }), member("b", { url: "https://www.bilibili.com/video/BVb" })]}
      loading={false} error="" refresh={vi.fn()} onNew={vi.fn()} onBrowse={vi.fn()} message="" onCheckUpdates={onCheckUpdates} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "检查更新：合集·中世纪" }));
    expect(onCheckUpdates).toHaveBeenCalledWith("合集·中世纪", "https://www.bilibili.com/video/BVa");
  });

  it("reads the whole collection on open, marks known videos and preselects only new ones", async () => {
    const fetch = check({ entry1: "downloaded", entry2: "queued", entry3: "downloaded" });
    expect(screen.getByRole("dialog", { name: "检查合集更新" })).toBeInTheDocument();
    const listing = await screen.findByRole("region", { name: "待解析项目" });
    expect(fetch.mock.calls[0][0]).toBe("/api/discover");
    expect(body(fetch, 0)).toEqual({ url: "https://www.bilibili.com/video/BVlegacy", whole: true });
    const total = parsed.entries.length;
    expect(screen.getByText(`发现 ${total - 3} 个新视频，已默认选中；其余 3 个已下载或在队列中。`)).toHaveAttribute("role", "status");
    expect(within(listing).getByRole("checkbox", { name: "第一集" })).toBeDisabled();
    expect(within(listing).getByRole("checkbox", { name: "第二集" })).not.toBeChecked();
    expect(within(listing).getByText("已在队列")).toBeVisible();
    expect(within(listing).getAllByText("已下载")).toHaveLength(2);
    expect(within(listing).getByRole("checkbox", { name: "音频访谈" })).toBeChecked();
    expect(within(listing).getByText(`已选 ${total - 3} / ${total - 3}`)).toBeVisible();

    fetch.mockResolvedValueOnce(respond({ ...discovered(), id: "resolved" }));
    fireEvent.click(screen.getByRole("button", { name: /解析所选项目/ }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls[1][0]).toBe("/api/parse/discover-parse-1/resolve");
    expect(body(fetch, 1).entry_ids).toEqual(parsed.entries.slice(3).map((entry) => entry.id));
  });

  it("reports when everything in the collection already has a task", async () => {
    check(Object.fromEntries(parsed.entries.map((entry) => [entry.url, "downloaded"])));
    expect(await screen.findByText(`暂无更新：${parsed.entries.length} 个视频都已下载或在队列中。`)).toBeVisible();
    expect(screen.getByRole("button", { name: "解析所选项目 (0)" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "全选" })).toBeDisabled();
  });
});

describe("collection renamed on B 站", () => {
  it("notes the new name and queues new videos into the existing group", async () => {
    const source = { ...discovered(), title: "合集·欧陆往事" };
    const fetch = check(Object.fromEntries(parsed.entries.slice(1).map((entry) => [entry.url, "downloaded"])), source);
    expect(await screen.findByText(/发现 1 个新视频/)).toHaveTextContent(
      "B 站上的名称现为「合集·欧陆往事」，新视频仍归入「合集·中世纪」。");
    const ready = { ...source, id: "resolved", entries: source.entries.map((entry, index) => index === 0
      ? { ...parsed.entries[0], resolution: "ready" as const } : entry) };
    fetch.mockResolvedValueOnce(respond(ready)).mockResolvedValueOnce(respond({ tasks: [task] }, 201));
    fireEvent.click(screen.getByRole("button", { name: "解析所选项目 (1)" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole("button", { name: /确认规格/ }));
    fireEvent.click(screen.getByRole("button", { name: /加入队列/ }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(fetch.mock.calls[2][0]).toBe("/api/tasks");
    expect(body(fetch, 2)).toMatchObject({ parse_id: "resolved", entry_ids: [parsed.entries[0].id], group: "合集·中世纪" });
  });
});
