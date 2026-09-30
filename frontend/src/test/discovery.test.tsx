import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ParseModal from "../ParseModal";
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
function bulk(count = 65) {
  return discovered({ ...parsed, entries: Array.from({ length: count }, (_, index) => ({
    ...parsed.entries[0], id: `p-${index}`, title: `项目 ${index}`,
  })) });
}
function readyBatch(source: ParseResult, start: number, end: number, id: string): ParseResult {
  return { ...source, id, entries: source.entries.map((entry, index) => index >= start && index < end
    ? { ...entry, resolution: "ready", available: true, qualities: [720], codecs: ["avc"] } : entry) };
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

  it.each([65, 100])("resolves all %i selections sequentially, accumulates progress and admits the full selection", async (count) => {
    const source = bulk(count);
    const first = readyBatch(source, 0, 50, "batch-1");
    const last = readyBatch(first, 50, count, "batch-2");
    const { fetch, onCreated } = await list(source);
    const firstFeed = parseFeed(), lastFeed = parseFeed();
    fetch.mockResolvedValueOnce(firstFeed.response).mockResolvedValueOnce(lastFeed.response);
    click("全选");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    resolveSelected(); resolveSelected();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(body(fetch, 1).entry_ids).toEqual(source.entries.slice(0, 50).map((entry) => entry.id));
    await send(firstFeed, { event: "parsed", result: first });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2][0]).toBe("/api/parse/batch-1/resolve");
    expect(body(fetch, 2).entry_ids).toEqual(source.entries.slice(50).map((entry) => entry.id));
    await send(lastFeed, { event: "progress", progress: { ...progress, completed: 2, total: count - 50, succeeded: 1, failed: 1 } });
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "52");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuemax", String(count));
    expect(screen.getByText("成功 51 · 失败 1")).toBeVisible();
    expect(screen.getByText(/已耗时 \d+ 秒/)).toBeVisible();
    await send(lastFeed, { event: "parsed", result: last });
    click("确认规格");
    fetch.mockResolvedValueOnce(respond({ tasks: Array.from({ length: count }, () => task) }));
    await act(async () => { click(`加入队列 (${count})`); });
    expect(body(fetch, 3)).toMatchObject({ parse_id: "batch-2", entry_ids: source.entries.map((entry) => entry.id) });
    expect(onCreated).toHaveBeenCalledWith(count);
  });

  it.each(["cancel", "error"] as const)("keeps completed batches and resumes only the unfinished entries after %s", async (kind) => {
    const source = bulk();
    const first = readyBatch(source, 0, 50, "checkpoint");
    const { fetch } = await list(source);
    vi.useFakeTimers();
    const firstFeed = parseFeed(), lastFeed = parseFeed();
    fetch.mockResolvedValueOnce(firstFeed.response).mockResolvedValueOnce(lastFeed.response);
    click("全选"); resolveSelected();
    // Neither a batch nor the entire operation has a wall-clock deadline.
    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    expect(fetch.mock.calls[1][1].signal.aborted).toBe(false);
    await send(firstFeed, { event: "parsed", result: first });
    const signal = fetch.mock.calls[2][1].signal;
    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    expect(signal.aborted).toBe(false);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("已耗时 1200 秒")).toBeVisible();
    if (kind === "cancel") click("取消解析");
    if (kind === "error") await send(lastFeed, { event: "error", status: 502, message: "资源请求失败" });
    if (kind !== "error") expect(signal.aborted).toBe(true);
    expect(screen.getByRole("alert")).toHaveTextContent("已完成批次和选择已保留");
    expect(screen.getByRole("checkbox", { name: "项目 64" })).toBeChecked();
    expect(screen.getAllByText("资源已就绪")).toHaveLength(50);
    expect(fetch).toHaveBeenCalledTimes(3);
    fetch.mockResolvedValueOnce(respond(readyBatch(first, 50, 65, "resumed")));
    await act(async () => { resolveSelected(); });
    expect(fetch.mock.calls[3][0]).toBe("/api/parse/checkpoint/resolve");
    expect(body(fetch, 3).entry_ids).toEqual(source.entries.slice(50).map((entry) => entry.id));
    expect(screen.getByRole("button", { name: "确认规格" })).toBeEnabled();
  });

  it.each(["cancel", "change-link", "close", "unmount"] as const)("aborts selected resolution on %s and rejects late progress/results", async (kind) => {
    const { fetch, unmount, onClose } = await list();
    choose("第一集");
    vi.useFakeTimers();
    let deliver!: (response: Response) => void;
    const old = parseFeed(), next = parseFeed();
    fetch.mockReturnValueOnce(new Promise<Response>((resolve) => { deliver = resolve; }));
    resolveSelected();
    const signal = fetch.mock.calls[1][1].signal;
    if (kind === "cancel") click("取消解析");
    if (kind === "change-link") click("更换链接");
    if (kind === "close") click("关闭弹窗");
    if (kind === "unmount") unmount();
    expect(signal.aborted).toBe(true);
    if (kind === "close") expect(onClose).toHaveBeenCalledOnce();
    if (kind === "cancel") {
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
    if (kind === "cancel") {
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
