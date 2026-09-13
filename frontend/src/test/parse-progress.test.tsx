import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ParseModal, { PARSE_TIMEOUT_MS } from "../ParseModal";
import { parsed, parseFeed, progress, respond, retryParsed, retryResult } from "./fixtures";

function mount() {
  const close = vi.fn();
  const view = render(<ParseModal onClose={close} onCreated={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("视频、合集、番剧链接或 BV / AV 号"), { target: { value: "BVtest" } });
  return { ...view, close };
}
const submit = () => fireEvent.click(screen.getByRole("button", { name: "解析" }));
async function send(feed: ReturnType<typeof parseFeed>, value: unknown) {
  await act(async () => { feed.send(value); });
}
describe("real parse progress UI", () => {
  it("renders server stages/counts/title, keeps unknown totals indeterminate and only advances elapsed time on the clock", async () => {
    vi.useFakeTimers();
    const feed = parseFeed();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(feed.response));
    mount(); submit();
    expect(screen.getByText("正在等待解析进度")).toBeVisible();
    await send(feed, { event: "progress", progress: { ...progress, stage: "resolving", completed: 0, succeeded: 0, failed: 0, total: null, title: "" } });
    expect(screen.getByText("正在识别链接")).toBeVisible();
    const bar = screen.getByRole("progressbar");
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(screen.getByText("已处理 0 / 总数未知")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText("已耗时 3 秒 · 最长 180 秒")).toBeVisible();
    expect(screen.getByText("已处理 0 / 总数未知")).toBeVisible();
    await send(feed, { event: "heartbeat" });
    await send(feed, { event: "progress", progress: { ...progress, stage: "listing" } });
    expect(screen.getByText("正在读取项目列表")).toBeVisible();
    await send(feed, { event: "progress", progress });
    expect(screen.getByText("正在提取资源")).toBeVisible();
    expect(screen.getByRole("progressbar")).toBe(bar);
    expect(bar).toHaveAttribute("aria-valuenow", "2");
    expect(bar).toHaveAttribute("aria-valuemax", "4");
    expect(bar).toHaveAttribute("aria-valuetext", "已处理 2 / 4");
    expect(screen.getByText("成功 1 · 失败 1")).toBeVisible();
    expect(screen.getByText(`当前：${progress.title}`)).toHaveAttribute("title", progress.title);
    await send(feed, { event: "parsed", result: parsed });
    expect(screen.getByRole("button", { name: "确认规格" })).toBeEnabled();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("supports a single video that stays unknown until the terminal", async () => {
    const feed = parseFeed();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(feed.response));
    mount(); submit();
    await send(feed, { event: "progress", progress: { ...progress, total: null, completed: 1, succeeded: 1, failed: 0 } });
    expect(screen.getByText("已处理 1 / 总数未知")).toBeVisible();
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
    await send(feed, { event: "parsed", result: { ...parsed, entries: [parsed.entries[0]] } });
    expect(screen.getByText("已选 1 项")).toBeVisible();
  });
  it.each(["cancel", "timeout", "close", "unmount"])("cleans up stream and both timers on %s", async (kind) => {
    vi.useFakeTimers();
    const feed = parseFeed();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(feed.response));
    const view = mount(); submit();
    await send(feed, { event: "progress", progress });
    if (kind === "cancel") fireEvent.click(screen.getByRole("button", { name: "取消解析" }));
    if (kind === "close") fireEvent.click(screen.getByRole("button", { name: "关闭弹窗" }));
    if (kind === "unmount") view.unmount();
    if (kind === "timeout") await act(async () => { await vi.advanceTimersByTimeAsync(PARSE_TIMEOUT_MS); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(feed.cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    if (kind === "close") expect(view.close).toHaveBeenCalledOnce();
    if (kind === "timeout") expect(screen.getByRole("alert")).toHaveTextContent("180 秒");
  });
  it("ignores a cancelled request's late stream without disturbing a new parse", async () => {
    let resolve!: (value: Response) => void;
    const old = parseFeed(), next = parseFeed();
    const fetch = vi.fn().mockReturnValueOnce(new Promise<Response>((yes) => { resolve = yes; })).mockResolvedValueOnce(next.response);
    vi.stubGlobal("fetch", fetch);
    mount(); submit();
    fireEvent.click(screen.getByRole("button", { name: "取消解析" })); submit();
    await send(next, { event: "progress", progress: { ...progress, title: "新请求" } });
    old.send({ event: "progress", progress: { ...progress, title: "陈旧标题" } });
    old.send({ event: "parsed", result: parsed });
    await act(async () => { resolve(old.response); });
    expect(screen.getByText("当前：新请求")).toBeVisible();
    expect(screen.queryByText("当前：陈旧标题")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "解析" })).toBeDisabled();
    await send(next, { event: "parsed", result: { ...parsed, title: "新结果" } });
    expect(screen.getByText("新结果")).toBeVisible();
  });
  it("shows retry events in the existing picker pending area and preserves the picker, scroll and selection", async () => {
    const feed = parseFeed();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(respond(retryParsed)).mockResolvedValueOnce(feed.response));
    mount();
    // Flush the initial step transition and its focus/scroll effect before
    // observing whether the subsequent retry changes the scroll position.
    await act(async () => { submit(); });
    await screen.findByText("测试合集");
    const picker = screen.getByRole("region", { name: "下载项目" });
    const dialog = screen.getByRole("dialog");
    dialog.scrollTop = 120; dialog.scrollTo = vi.fn();
    fireEvent.click(screen.getByRole("button", { name: /重新解析失败项/ }));
    await send(feed, { event: "progress", progress });
    expect(within(picker).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");
    expect(within(picker).getByText("成功 1 · 失败 1")).toBeVisible();
    expect(dialog.scrollTop).toBe(120);
    expect(dialog.scrollTo).not.toHaveBeenCalled();
    await send(feed, { event: "parsed", result: retryResult("next", ["p3"]) });
    expect(screen.getByRole("region", { name: "下载项目" })).toBe(picker);
    expect(screen.getByRole("checkbox", { name: /^第一集/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /^未播出/ })).not.toBeChecked();
    expect(screen.getByText("已恢复 1 项，1 项仍解析失败，可再次重试。")).toBeVisible();
  });
  it("clears retry progress/timers on cancel and starts the next retry with fresh counts", async () => {
    vi.useFakeTimers();
    const old = parseFeed(), next = parseFeed();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(respond(retryParsed))
      .mockResolvedValueOnce(old.response).mockResolvedValueOnce(next.response));
    mount();
    await act(async () => { submit(); });
    const retry = () => fireEvent.click(screen.getByRole("button", { name: /重新解析失败项/ }));
    retry();
    await send(old, { event: "progress", progress });
    fireEvent.click(screen.getByRole("button", { name: "取消重试" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(old.cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    retry();
    expect(screen.getByText("已处理 0 / 总数未知")).toBeVisible();
    await send(next, { event: "progress", progress: { ...progress, completed: 0, succeeded: 0, failed: 0, total: 2, title: "新重试" } });
    await send(old, { event: "progress", progress });
    expect(screen.getByText("当前：新重试")).toBeVisible();
    await send(next, { event: "error", message: "结果过期", status: 410 });
    expect(screen.getByRole("alert")).toHaveTextContent("解析结果已过期");
    expect(screen.getByRole("checkbox", { name: /^第一集/ })).toBeChecked();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("renders terminal stream errors without advancing the wizard", async () => {
    const feed = parseFeed();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(feed.response));
    mount(); submit();
    await send(feed, { event: "error", message: "暂时无法解析", status: 503 });
    expect(screen.getByRole("alert")).toHaveTextContent("暂时无法解析");
    expect(screen.getByRole("button", { name: "解析" })).toBeEnabled();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
});
