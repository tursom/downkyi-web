import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ParseModal, { PARSE_TIMEOUT_MS } from "../ParseModal";
import { discovered, parsed, parseFeed, progress, respond, task } from "./fixtures";
import type { ParseResult } from "../types";

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name, }));
const choose = (title: string) => fireEvent.click(screen.getByRole("checkbox", { name: title }));
const resolveSelected = () => click(/解析所选项目/);
const body = (fetch: ReturnType<typeof vi.fn>, index: number) => JSON.parse(fetch.mock.calls[index][1].body);
function mount() {
  const onClose = vi.fn(), onCreated = vi.fn();
  const view = render(<ParseModal onClose={onClose} onCreated={onCreated} />);
  fireEvent.change(screen.getByLabelText("视频、合集、番剧链接或 BV / AV 号"), { target: { value: " BVtest " } });
  click("读取列表");
  return { ...view, onClose, onCreated };
}
function merged(ids: string[], id = "resolved-1", source = discovered()): ParseResult {
  return { ...source, id, entries: source.entries.map((entry) => ids.includes(entry.id)
    ? { ...parsed.entries.find((candidate) => candidate.id === entry.id)!, resolution: entry.id === "p3" ? "failed" : "ready" }
    : entry) };
}
async function send(feed: ReturnType<typeof parseFeed>, event: unknown) {
  await act(async () => { feed.send(event); });
}
async function list(source = discovered()) {
  const fetch = vi.fn().mockResolvedValueOnce(respond(source));
  vi.stubGlobal("fetch", fetch);
  const view = mount();
  await screen.findByRole("region", { name: "待解析项目" });
  return { ...view, fetch };
}

describe("discover then resolve only explicitly chosen resources", () => {
  it("streams metadata only for a multi-entry list and never automatically resolves or selects any entry", async () => {
    const feed = parseFeed();
    const fetch = vi.fn().mockResolvedValueOnce(feed.response);
    vi.stubGlobal("fetch", fetch);
    mount();
    await send(feed, { event: "progress", progress: { ...progress, stage: "listing", completed: 0, total: 4, succeeded: 0, failed: 0 } });
    expect(screen.getByText("正在读取视频列表")).toBeVisible();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "4");
    await send(feed, { event: "parsed", result: discovered() });
    const listing = screen.getByRole("region", { name: "待解析项目" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("/api/discover");
    expect(body(fetch, 0)).toEqual({ url: "BVtest" });
    for (const checkbox of within(listing).getAllByRole("checkbox")) expect(checkbox).not.toBeChecked();
    expect(within(listing).getAllByText("待解析", { exact: true })).toHaveLength(4);
    expect(within(listing).getByText("正片")).toBeVisible();
    expect(within(listing).getByText("01:00")).toBeVisible();
    expect(listing.querySelector(".lucide-circle-alert")).toBeNull();
    expect(screen.queryByText(/解析失败/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认规格" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "解析所选项目 (0)" })).toBeDisabled();
    resolveSelected();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sends only manual IDs, excludes pending from specs/retry/admission and uses each new cache ID", async () => {
    const { fetch, onCreated } = await list();
    choose("第一集"); choose("未播出");
    fetch.mockResolvedValueOnce(respond(merged(["p1", "p3"])));
    await act(async () => { resolveSelected(); });
    expect(fetch.mock.calls[1][0]).toBe("/api/parse/discover-parse-1/resolve");
    expect(body(fetch, 1)).toEqual({ entry_ids: ["p1", "p3"] });
    expect(screen.queryByRole("checkbox", { name: /第二集/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新解析失败项 (1)" })).toBeVisible();
    fetch.mockResolvedValueOnce(respond({ ...merged(["p1", "p3"], "retry-new"), entries: merged(["p1", "p3"]).entries.map((entry) => entry.id === "p3" ? { ...entry, resolution: "ready", available: true, qualities: [720] } : entry) }));
    await act(async () => { click("重试：未播出"); });
    expect(fetch.mock.calls[2][0]).toBe("/api/parse/resolved-1/retry");
    expect(body(fetch, 2)).toEqual({ entry_ids: ["p3"] });
    fetch.mockResolvedValueOnce(respond({ tasks: [task] }));
    click("确认规格");
    await act(async () => { click("加入队列 (1)"); });
    expect(body(fetch, 3)).toMatchObject({ parse_id: "retry-new", entry_ids: ["p1"] });
    expect(onCreated).toHaveBeenCalledWith(1);
  });

  it("retains the complete cache on back, reuses ready entries, preserves download choices/specs and resolves newly selected pending IDs only", async () => {
    const { fetch } = await list();
    choose("第一集"); choose("第二集");
    fetch.mockResolvedValueOnce(respond(merged(["p1", "p2"])));
    await act(async () => { resolveSelected(); });
    fireEvent.click(screen.getByRole("checkbox", { name: /^第二集/ }));
    fireEvent.change(screen.getByLabelText("画质"), { target: { value: "1440" } });
    fireEvent.change(screen.getByLabelText("视频编码"), { target: { value: "av1" } });
    click("上一步");
    expect(screen.getByRole("checkbox", { name: "第二集" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "音频访谈" })).not.toBeChecked();
    await act(async () => { resolveSelected(); });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("checkbox", { name: /^第二集/ })).not.toBeChecked();
    expect(screen.getByLabelText("画质")).toHaveValue("1440");
    expect(screen.getByLabelText("视频编码")).toHaveValue("av1");
    click("上一步"); choose("未播出");
    fetch.mockResolvedValueOnce(respond(merged(["p1", "p2", "p3"], "resolved-2")));
    await act(async () => { resolveSelected(); });
    expect(fetch.mock.calls[2][0]).toBe("/api/parse/resolved-1/resolve");
    expect(body(fetch, 2)).toEqual({ entry_ids: ["p3"] });
    expect(screen.getByLabelText("画质")).toHaveValue("1440");
    click("上一步");
    expect(screen.getByRole("checkbox", { name: "音频访谈" })).toBeEnabled();
  });

  it.each(["ready", "failed"] as const)("automatically resolves a single pending entry to %s and retains the existing retry path", async (resolution) => {
    const source = discovered({ ...parsed, entries: [parsed.entries[resolution === "ready" ? 0 : 2]] });
    const result = merged([source.entries[0].id], "single-new", source);
    const feed = parseFeed();
    const fetch = vi.fn().mockResolvedValueOnce(respond(source)).mockResolvedValueOnce(feed.response);
    vi.stubGlobal("fetch", fetch);
    mount();
    await screen.findByText("正在解析所选项目的画质和资源");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(body(fetch, 1)).toEqual({ entry_ids: [source.entries[0].id] });
    await send(feed, { event: "progress", progress: { ...progress, completed: 0, total: 1, succeeded: 0, failed: 0 } });
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "1");
    await send(feed, { event: "parsed", result });
    expect(screen.getByRole("button", { name: "确认规格" })).toBeVisible();
    if (resolution === "ready") expect(screen.getByRole("button", { name: "确认规格" })).toBeEnabled();
    else {
      expect(screen.getByRole("button", { name: "确认规格" })).toBeDisabled();
      fetch.mockResolvedValueOnce(respond(result));
      await act(async () => { click("重试：未播出"); });
      expect(fetch.mock.calls[2][0]).toBe("/api/parse/single-new/retry");
    }
  });

  it("accepts a legacy single ready result without resolving it again", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(respond({ ...parsed, entries: [parsed.entries[0]] }));
    vi.stubGlobal("fetch", fetch);
    mount();
    expect(await screen.findByRole("button", { name: "确认规格" })).toBeEnabled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("blocks 51 pending selections and sends exactly 50 unique IDs after reducing the selection", async () => {
    const source = discovered({ ...parsed, entries: Array.from({ length: 51 }, (_, index) => ({ ...parsed.entries[0], id: `p-${index}`, title: `项目 ${index}` })) });
    const { fetch } = await list(source);
    click("全选");
    expect(screen.getByRole("alert")).toHaveTextContent("单次最多解析 50 项");
    resolveSelected();
    expect(fetch).toHaveBeenCalledTimes(1);
    choose("项目 50");
    fetch.mockReturnValueOnce(new Promise(() => {}));
    resolveSelected(); resolveSelected();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(body(fetch, 1).entry_ids).toEqual(source.entries.slice(0, 50).map((entry) => entry.id));
  });

  it.each(["cancel", "timeout", "change-link", "close", "unmount"] as const)("aborts selected resolution on %s and rejects late progress/results", async (kind) => {
    const { fetch, unmount, onClose } = await list();
    choose("第一集");
    vi.useFakeTimers();
    let deliver!: (response: Response) => void;
    const old = parseFeed(), next = parseFeed();
    fetch.mockReturnValueOnce(new Promise<Response>((resolve) => { deliver = resolve; }));
    resolveSelected();
    const signal = fetch.mock.calls[1][1].signal;
    if (kind === "cancel") click("取消解析");
    if (kind === "timeout") await act(async () => { await vi.advanceTimersByTimeAsync(PARSE_TIMEOUT_MS); });
    if (kind === "change-link") click("更换链接");
    if (kind === "close") click("关闭弹窗");
    if (kind === "unmount") unmount();
    expect(signal.aborted).toBe(true);
    if (kind === "close") expect(onClose).toHaveBeenCalledOnce();
    if (kind === "cancel" || kind === "timeout") {
      expect(screen.getByRole("checkbox", { name: "第一集" })).toBeChecked();
      fetch.mockResolvedValueOnce(next.response);
      resolveSelected();
      await send(next, { event: "progress", progress: { ...progress, title: "新资源请求", total: 1, completed: 0, succeeded: 0, failed: 0 } });
    }
    old.send({ event: "progress", progress: { ...progress, title: "迟到事件" } });
    old.send({ event: "parsed", result: merged(["p1"], "stale") });
    await act(async () => { deliver(old.response); });
    expect(screen.queryByText("当前：迟到事件")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认规格" })).not.toBeInTheDocument();
    if (kind === "cancel" || kind === "timeout") {
      expect(screen.getByText("当前：新资源请求")).toBeVisible();
      expect(screen.getByRole("button", { name: /解析所选项目/ })).toBeDisabled();
      await send(next, { event: "parsed", result: merged(["p1"], "fresh") });
      expect(screen.getByRole("button", { name: "确认规格" })).toBeEnabled();
    }
    if (kind === "change-link") expect(screen.getByRole("button", { name: "读取列表" })).toBeEnabled();
  });

  it("retains the list on a streamed stale-cache error and starts a new discovery after changing links", async () => {
    const { fetch } = await list();
    choose("第一集");
    const feed = parseFeed();
    fetch.mockResolvedValueOnce(feed.response);
    resolveSelected();
    await send(feed, { event: "error", status: 410, message: "expired" });
    expect(screen.getByRole("alert")).toHaveTextContent("解析结果已过期");
    expect(screen.getByRole("checkbox", { name: "第一集" })).toBeChecked();
    click("更换链接");
    fetch.mockResolvedValueOnce(respond(discovered()));
    click("读取列表");
    await screen.findByRole("region", { name: "待解析项目" });
    expect(fetch.mock.calls[2][0]).toBe("/api/discover");
    expect(screen.getByRole("checkbox", { name: "第一集" })).not.toBeChecked();
  });
});
