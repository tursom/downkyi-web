import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ParseModal, { PARSE_TIMEOUT_MS } from "../ParseModal";
import { respond, retryParsed, retryResult, task } from "./fixtures";

function deferred() {
  let resolve!: (response: Response) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function setup(source = retryParsed) {
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
    .mockResolvedValueOnce(respond(source));
  vi.stubGlobal("fetch", fetch);
  const onClose = vi.fn(), onCreated = vi.fn();
  const view = render(<ParseModal onClose={onClose} onCreated={onCreated} />);
  fireEvent.change(screen.getByLabelText("视频、合集、番剧链接或 BV / AV 号"), {
    target: { value: "BVtest" },
  });
  fireEvent.click(screen.getByRole("button", { name: "解析" }));
  await screen.findByText("测试合集");
  return { ...view, fetch, onClose, onCreated, user: userEvent.setup() };
}
const batch = () => screen.getByRole("button", { name: /重新解析失败项/ });
const single = () => screen.getByRole("button", { name: "重试：未播出" });
const checkbox = (title: string) => screen.getByRole("checkbox", { name: new RegExp(title) });
function body(fetch: Awaited<ReturnType<typeof setup>>["fetch"], index: number) {
  return JSON.parse(fetch.mock.calls[index][1].body as string);
}
function expectOriginalChoices() {
  expect(checkbox("第一集")).toBeChecked();
  expect(checkbox("第二集")).not.toBeChecked();
  expect(checkbox("未播出")).toBeDisabled();
  expect(screen.getByLabelText("画质")).toHaveValue("1440");
}
async function setChoices(user: ReturnType<typeof userEvent.setup>) {
  await user.click(checkbox("第二集"));
  await user.selectOptions(screen.getByLabelText("画质"), "1440");
  await user.selectOptions(screen.getByLabelText("视频编码"), "av1");
  await user.click(screen.getByLabelText("下载字幕"));
  await user.click(screen.getByLabelText("下载封面"));
}

describe("retry failed parse entries", () => {
  it("merges results, preserves choices/options and step2 position, then uses each new parse ID for retry and enqueue", async () => {
    const { fetch, user, onCreated } = await setup();
    await setChoices(user);
    await user.click(screen.getByRole("button", { name: "仅音频" }));
    const dialog = screen.getByRole("dialog");
    dialog.scrollTop = 120;
    const scrollTo = vi.fn();
    dialog.scrollTo = scrollTo;
    const picker = screen.getByRole("region", { name: "下载项目" });
    const firstRow = checkbox("第一集").closest(".entry-row");
    expect(single().closest("label")).toBeNull();
    expect(screen.queryByRole("button", { name: "重试：音频访谈" })).not.toBeInTheDocument();
    fetch.mockResolvedValueOnce(respond(retryResult("parse-2", ["p3"])));
    await user.click(batch());
    expect(fetch.mock.calls[1][0]).toBe("/api/parse/parse-1/retry");
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" } });
    expect(body(fetch, 1)).toEqual({ entry_ids: ["p3", "p5"] });
    expect(await screen.findByText("已恢复 1 项，1 项仍解析失败，可再次重试。")).toBeVisible();
    expect(screen.getByRole("region", { name: "下载项目" })).toBe(picker);
    expect(checkbox("第一集").closest(".entry-row")).toBe(firstRow);
    expect(dialog.scrollTop).toBe(120);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(checkbox("第一集")).toBeChecked();
    expect(checkbox("第二集")).not.toBeChecked();
    expect(checkbox("未播出")).toBeEnabled();
    expect(checkbox("未播出")).not.toBeChecked();
    expect(checkbox("音频访谈")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "仅音频" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("画质")).toHaveValue("1440");
    expect(screen.getByLabelText("视频编码")).toHaveValue("av1");
    expect(screen.getByLabelText("下载字幕")).toBeChecked();
    expect(screen.getByLabelText("下载封面")).not.toBeChecked();
    fetch.mockResolvedValueOnce(respond(retryResult("parse-3", ["p3", "p5"])));
    await user.click(screen.getByRole("button", { name: "重试：加载失败的花絮" }));
    expect(fetch.mock.calls[2][0]).toBe("/api/parse/parse-2/retry");
    expect(body(fetch, 2)).toEqual({ entry_ids: ["p5"] });
    expect(await screen.findByText("已恢复 1 项，请勾选需要下载的项目。")).toBeVisible();
    expect(screen.queryByRole("button", { name: /重新解析失败项/ })).not.toBeInTheDocument();
    expect(checkbox("加载失败的花絮")).not.toBeChecked();
    fetch.mockResolvedValueOnce(respond({ tasks: [task] }));
    await user.click(screen.getByRole("button", { name: "确认规格" }));
    await user.click(screen.getByRole("button", { name: "加入队列 (1)" }));
    expect(body(fetch, 3)).toEqual({
      parse_id: "parse-3", entry_ids: ["p1"], quality: "1440", codec: "av1",
      mode: "audio", cover: false, subtitles: true,
    });
    expect(onCreated).toHaveBeenCalledWith(1);
  });

  it("retries one failure and keeps search and collapsed groups through the merged response", async () => {
    const { fetch, user } = await setup();
    await user.type(screen.getByLabelText("搜索分 P 或剧集"), "花絮");
    const group = screen.getByRole("button", { name: /^花絮/, expanded: true });
    await user.click(group);
    fetch.mockResolvedValueOnce(respond(retryResult("parse-2", [])));
    await user.click(batch());
    expect(await screen.findByText("已恢复 0 项，2 项仍解析失败，可再次重试。")).toBeVisible();
    expect(screen.getByLabelText("搜索分 P 或剧集")).toHaveValue("花絮");
    expect(group).toHaveAttribute("aria-expanded", "false");
    await user.click(group);
    fetch.mockResolvedValueOnce(respond(retryResult("parse-3", ["p3"])));
    await user.click(single());
    expect(body(fetch, 2)).toEqual({ entry_ids: ["p3"] });
    expect(fetch.mock.calls[2][0]).toBe("/api/parse/parse-2/retry");
    expect(checkbox("加载失败的花絮")).toBeDisabled();
    expect(checkbox("未播出")).not.toBeChecked();
  });

  it.each([
    [410, "解析结果已过期"],
    [429, "解析繁忙"],
    [503, "暂时无法解析"],
  ])("preserves the list and choices on HTTP %s and permits another attempt", async (status, message) => {
    const { fetch, user } = await setup();
    await setChoices(user);
    fetch.mockResolvedValueOnce(respond({ detail: "暂时无法解析" }, Number(status)));
    await user.click(single());
    expect(await screen.findByRole("alert")).toHaveTextContent(String(message));
    expectOriginalChoices();
    expect(single()).toBeEnabled();
    expect(batch()).toBeEnabled();
    fetch.mockResolvedValueOnce(respond(retryResult("parse-next", [])));
    await user.click(single());
    expect(fetch.mock.calls[2][0]).toBe("/api/parse/parse-1/retry");
    expect(await screen.findByText("已恢复 0 项，1 项仍解析失败，可再次重试。")).toBeVisible();
    expectOriginalChoices();
  });

  it("disables repeat submissions, navigation, selection and specs while pending, but allows cancel and close", async () => {
    const { fetch, user } = await setup();
    const pending = deferred();
    fetch.mockReturnValueOnce(pending.promise);
    await user.click(single());
    for (const name of [/重新解析失败项/, "重试：未播出", "重试：加载失败的花絮", "更换链接", "上一步", "确认规格", "视频", "仅音频"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name }));
    }
    for (const control of within(screen.getByRole("region", { name: "下载规格" })).getAllByRole("combobox")) {
      expect(control).toBeDisabled();
    }
    expect(checkbox("第一集")).toBeDisabled();
    expect(screen.getByLabelText("下载字幕")).toBeDisabled();
    expect(screen.getByLabelText("下载封面")).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消重试" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "关闭弹窗" })).toBeEnabled();
    expect(fetch).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "取消重试" }));
    expect(fetch.mock.calls[1][1].signal?.aborted).toBe(true);
    expect(single()).toBeEnabled();
  });

  it.each(["cancel", "timeout"] as const)("ignores stale success/failure after %s, without clearing the next request's busy state or timeout", async (kind) => {
    const { fetch, user } = await setup();
    await setChoices(user);
    vi.useFakeTimers();
    const old = deferred(), next = deferred();
    fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    fireEvent.click(single());
    const signal = fetch.mock.calls[1][1].signal!;
    await act(async () => { await vi.advanceTimersByTimeAsync(PARSE_TIMEOUT_MS - 1); });
    expect(signal.aborted).toBe(false);
    if (kind === "cancel") fireEvent.click(screen.getByRole("button", { name: "取消重试" }));
    else await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(signal.aborted).toBe(true);
    expect(screen.getByRole("alert")).toHaveTextContent(kind === "cancel" ? "重试已取消" : "180 秒");
    expectOriginalChoices();
    fireEvent.click(single());
    await act(async () => {
      if (kind === "cancel") old.resolve(respond(retryResult("stale", ["p3", "p5"])));
      else old.reject(new Error("stale failure"));
    });
    expect(single()).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expectOriginalChoices();
    await act(async () => { await vi.advanceTimersByTimeAsync(PARSE_TIMEOUT_MS); });
    expect(fetch.mock.calls[2][1].signal?.aborted).toBe(true);
    expect(screen.getByRole("alert")).toHaveTextContent("180 秒");
    await act(async () => { next.resolve(respond(retryResult("also-stale", ["p3"]))); });
    expectOriginalChoices();
    fetch.mockResolvedValueOnce(respond(retryResult("fresh", ["p3"])));
    await act(async () => { fireEvent.click(single()); });
    expect(fetch.mock.calls[3][0]).toBe("/api/parse/parse-1/retry");
    expect(checkbox("未播出")).toBeEnabled();
    expect(checkbox("未播出")).not.toBeChecked();
  });

  it.each(["close", "escape", "overlay", "unmount"] as const)("aborts on %s and ignores a late response after opening a new modal", async (kind) => {
    const { fetch, onClose, unmount } = await setup();
    const old = deferred();
    fetch.mockReturnValueOnce(old.promise);
    fireEvent.click(single());
    if (kind === "close") fireEvent.click(screen.getByRole("button", { name: "关闭弹窗" }));
    if (kind === "escape") fireEvent.keyDown(document, { key: "Escape" });
    if (kind === "overlay") fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    if (kind !== "unmount") {
      expect(onClose).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[1][1].signal?.aborted).toBe(true);
    }
    unmount();
    expect(fetch.mock.calls[1][1].signal?.aborted).toBe(true);
    await setup({ ...retryParsed, id: "new-modal" });
    await act(async () => { old.resolve(respond(retryResult("stale", ["p3", "p5"]))); });
    expect(checkbox("未播出")).toBeDisabled();
    expect(batch()).toHaveTextContent("(2)");
  });

  it("does not let an aborted retry overwrite a new source", async () => {
    const { fetch, user } = await setup();
    const old = deferred();
    fetch.mockReturnValueOnce(old.promise);
    await user.click(single());
    await user.click(screen.getByRole("button", { name: "取消重试" }));
    await user.click(screen.getByRole("button", { name: "更换链接" }));
    fetch.mockResolvedValueOnce(respond({ ...retryParsed, id: "new-source", title: "新合集" }));
    await user.click(screen.getByRole("button", { name: "解析" }));
    await screen.findByText("新合集");
    await act(async () => { old.resolve(respond(retryResult("stale", ["p3"]))); });
    expect(screen.getByText("新合集")).toBeVisible();
    fetch.mockResolvedValueOnce(respond(retryResult("fresh", [])));
    await user.click(single());
    expect(fetch.mock.calls[3][0]).toBe("/api/parse/new-source/retry");
  });

  it("caps a batch at 100 currently unavailable IDs, including failures hidden by search", async () => {
    const source = {
      ...retryParsed,
      entries: [...retryParsed.entries.filter((entry) => entry.available),
        ...Array.from({ length: 101 }, (_, index) => ({ ...retryParsed.entries[2], id: `failed-${index}` }))],
    };
    const { fetch, user } = await setup(source);
    await user.type(screen.getByLabelText("搜索分 P 或剧集"), "第一集");
    fetch.mockReturnValueOnce(deferred().promise);
    await user.click(batch());
    expect(body(fetch, 1)).toEqual({ entry_ids: Array.from({ length: 100 }, (_, index) => `failed-${index}`) });
  });
});
