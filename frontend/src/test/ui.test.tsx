import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import App from "../App";
import ParseModal, { PARSE_TIMEOUT_MS } from "../ParseModal";
import Tasks from "../Tasks";
import { parsed, respond, system, task } from "./fixtures";
import type { Task } from "../types";
function tasksProps(tasks: Task[]) {
  return {
    tasks,
    loading: false,
    error: "",
    refresh: vi.fn(),
    onNew: vi.fn(),
    onBrowse: vi.fn(),
    message: "",
  };
}
function workspaceFetch(auth = true) {
  let authenticated = auth;
  return vi.fn(async (url: string) => {
    if (url === "/api/session") return respond({ authenticated });
    if (url === "/api/login") {
      authenticated = true;
      return respond({ authenticated });
    }
    if (url === "/api/logout") {
      authenticated = false;
      return respond({ ok: true });
    }
    if (url === "/api/tasks") return respond({ tasks: [] });
    if (url === "/api/library")
      return respond({
        tasks: [{ ...task, status: "completed", record_removed: true }],
      });
    if (url === "/api/system") return respond(system);
    throw new Error(`Unexpected request ${url}`);
  });
}
describe("authentication and shell", () => {
  it("logs in with the token, loads the genuine empty state and separate preserved-file library", async () => {
    const user = userEvent.setup(),
      fetch = workspaceFetch(false);
    vi.stubGlobal("fetch", fetch);
    render(<App />);
    await user.type(await screen.findByLabelText("访问令牌"), "test-token");
    await user.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByText("还没有下载任务")).toBeVisible();
    expect(fetch).toHaveBeenCalledWith(
      "/api/login",
      expect.objectContaining({ body: '{"token":"test-token"}' }),
    );
    await user.click(screen.getByRole("button", { name: /已完成 1/ }));
    expect(await screen.findByText("记录已移除 · 文件保留")).toBeVisible();
    expect(fetch).toHaveBeenCalledWith("/api/library", expect.anything());
  });
  it("returns to login when a protected API returns 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/session"
          ? respond({ authenticated: true })
          : url === "/api/tasks"
            ? respond({ detail: "expired" }, 401)
            : url === "/api/library"
              ? respond({ tasks: [] })
              : respond(system),
      ),
    );
    render(<App />);
    expect(await screen.findByText("会话已过期，请重新登录。")).toBeVisible();
  });
  it("logs out via the server", async () => {
    const user = userEvent.setup(),
      fetch = workspaceFetch();
    vi.stubGlobal("fetch", fetch);
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "退出登录" }));
    expect(await screen.findByLabelText("访问令牌")).toBeVisible();
    expect(fetch).toHaveBeenCalledWith(
      "/api/logout",
      expect.objectContaining({ method: "POST" }),
    );
  });
  it("contains drawer focus, closes on escape and restores focus", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", workspaceFetch());
    render(<App />);
    const opener = await screen.findByRole("button", { name: "打开导航" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.tab({ shift: true });
    expect(
      within(dialog).getByRole("button", { name: "服务器" }),
    ).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
async function parseSource() {
  const user = userEvent.setup();
  await user.type(
    screen.getByLabelText("视频、合集、番剧链接或 BV / AV 号"),
    " BVtest ",
  );
  await user.click(screen.getByRole("button", { name: "解析" }));
  await screen.findByText("测试合集");
  return user;
}
describe("three-step parse and create", () => {
  it("uses actual qualities/codecs, unavailable groups, and preserves options through review/back/create", async () => {
    const onCreated = vi.fn(),
      fetch = vi
        .fn()
        .mockResolvedValueOnce(respond(parsed))
        .mockResolvedValueOnce(respond({ tasks: [task] }));
    vi.stubGlobal("fetch", fetch);
    render(<ParseModal onClose={vi.fn()} onCreated={onCreated} />);
    const user = await parseSource();
    expect(screen.getByRole("checkbox", { name: /未播出/ })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /音频访谈/ })).toBeDisabled();
    expect(screen.getByText("部分资源不可用")).toBeVisible();
    expect(screen.getByText("结果已截断，最多返回 100 个项目。")).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "480P" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /第二集/ }));
    expect(
      screen.getByRole("checkbox", { name: "选择正片" }),
    ).toBePartiallyChecked();
    await user.selectOptions(screen.getByLabelText("画质"), "1440");
    await user.selectOptions(screen.getByLabelText("视频编码"), "av1");
    await user.click(screen.getByLabelText("下载字幕"));
    await user.click(screen.getByLabelText("下载封面"));
    await user.click(screen.getByRole("button", { name: "仅音频" }));
    expect(screen.getByLabelText("画质")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "确认规格" }));
    expect(screen.getByText("准备添加 1 个下载任务")).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "上一步" }));
    expect(screen.getByLabelText("视频编码")).toHaveValue("av1");
    await user.click(screen.getByRole("button", { name: "确认规格" }));
    await user.click(screen.getByRole("button", { name: "加入队列 (1)" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(1));
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/api/parse",
      expect.objectContaining({ body: '{"url":"BVtest"}' }),
    );
    const body = JSON.parse(fetch.mock.calls[1][1].body);
    expect(body).toEqual({
      parse_id: "parse-1",
      entry_ids: ["p1"],
      quality: "1440",
      codec: "av1",
      mode: "audio",
      subtitles: true,
      cover: false,
    });
  });
  it("lets the server reject duplicates and retains review choices on 409", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(respond(parsed))
      .mockResolvedValueOnce(respond({ detail: "任务已存在" }, 409));
    vi.stubGlobal("fetch", fetch);
    render(<ParseModal onClose={vi.fn()} onCreated={vi.fn()} />);
    const user = await parseSource();
    await user.click(screen.getByRole("button", { name: "确认规格" }));
    await user.click(screen.getByRole("button", { name: "加入队列 (2)" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("任务已存在");
    expect(screen.getByRole("button", { name: "加入队列 (2)" })).toBeEnabled();
  });
  it("shows parse errors and permits retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(respond({ detail: "视频不存在" }, 400)),
    );
    const user = userEvent.setup();
    render(<ParseModal onClose={vi.fn()} onCreated={vi.fn()} />);
    await user.type(
      screen.getByLabelText("视频、合集、番剧链接或 BV / AV 号"),
      "invalid",
    );
    await user.click(screen.getByRole("button", { name: "解析" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("视频不存在");
    expect(screen.getByRole("button", { name: "解析" })).toBeEnabled();
  });
  it("admits at most 50 entries and handles audio-only sources", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        respond({
          ...parsed,
          entries: Array.from({ length: 51 }, (_, index) => ({
            ...parsed.entries[3],
            id: String(index),
            title: `音频 ${index}`,
          })),
        }),
      ),
    );
    render(<ParseModal onClose={vi.fn()} onCreated={vi.fn()} />);
    const user = await parseSource();
    expect(screen.getByRole("button", { name: "仅音频" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("checkbox", { name: "选择花絮" }));
    expect(screen.getByRole("alert")).toHaveTextContent("单次最多创建 50");
    expect(screen.getByRole("button", { name: "确认规格" })).toBeDisabled();
  });
  it.each(["cancel", "timeout", "unmount"] as const)(
    "aborts pending parse on %s without stale updates",
    async (kind) => {
      vi.useFakeTimers();
      const fetch = vi.fn(() => new Promise<Response>(() => {}));
      vi.stubGlobal("fetch", fetch);
      const { unmount } = render(
        <ParseModal onClose={vi.fn()} onCreated={vi.fn()} />,
      );
      fireEvent.change(
        screen.getByLabelText("视频、合集、番剧链接或 BV / AV 号"),
        { target: { value: "BVtest" } },
      );
      fireEvent.click(screen.getByRole("button", { name: "解析" }));
      const signal = (
        fetch.mock.calls as unknown as [string, RequestInit][]
      )[0][1].signal!;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PARSE_TIMEOUT_MS - 1);
      });
      expect(signal.aborted).toBe(false);
      if (kind === "cancel")
        fireEvent.click(screen.getByRole("button", { name: "取消解析" }));
      else if (kind === "unmount") unmount();
      else
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1);
        });
      expect(signal.aborted).toBe(true);
      if (kind === "timeout")
        expect(screen.getByRole("alert")).toHaveTextContent("180 秒");
    },
  );
});
describe("task table and real actions", () => {
  it("updates an open detail from polled task state without simulated transitions", async () => {
    const user = userEvent.setup();
    const props = tasksProps([
      { ...task, status: "resolving" as const, progress: 0, total_bytes: null },
    ]);
    const { rerender } = render(<Tasks {...props} />);
    await user.click(
      screen.getByRole("button", { name: "任务详情：测试视频" }),
    );
    expect(
      within(screen.getByRole("dialog")).getByLabelText("任务处理阶段"),
    ).toHaveTextContent("解析资源");
    rerender(
      <Tasks
        {...props}
        tasks={[{ ...task, status: "merging", progress: 100 }]}
      />,
    );
    expect(
      screen.getByRole("dialog").querySelector('[aria-current="step"]'),
    ).toHaveTextContent("合并校验");
    expect(
      within(screen.getByRole("dialog")).getByRole("progressbar"),
    ).toHaveAttribute("aria-valuenow", "100");
  });

  it("aborts a batch on unmount and does not send the remaining mutations", async () => {
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    const props = tasksProps([task, { ...task, id: "task-2" }]);
    const { unmount } = render(<Tasks {...props} />);
    await user.click(screen.getByRole("checkbox", { name: "全选任务" }));
    await user.click(screen.getByRole("button", { name: "暂停" }));
    expect(fetch).toHaveBeenCalledTimes(1);
    const signal = fetch.mock.calls[0][1].signal!;
    unmount();
    await act(async () => {});
    expect(signal.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(props.refresh).not.toHaveBeenCalled();
  });
  it("shows actual progress, filters and searches", async () => {
    const user = userEvent.setup();
    render(<Tasks {...tasksProps([task])} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "42.5",
    );
    await user.type(screen.getByLabelText("搜索任务"), "no-match");
    expect(screen.getByText("没有匹配的任务")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "清空搜索" }));
    expect(screen.getByRole("button", { name: "测试视频" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "已暂停 0" }));
    expect(screen.getByText("没有匹配的任务")).toBeVisible();
  });
  it.each([
    ["downloading", "暂停", "pause"],
    ["resolving", "暂停", "pause"],
    ["merging", "暂停", "pause"],
    ["paused", "恢复", "resume"],
    ["failed", "重试", "resume"],
  ] as const)("handles %s tasks", async (status, label, endpoint) => {
    const user = userEvent.setup(),
      fetch = vi.fn().mockResolvedValue(respond(task));
    vi.stubGlobal("fetch", fetch);
    const props = tasksProps([{ ...task, status }]);
    render(<Tasks {...props} />);
    await user.click(
      screen.getByRole("button", { name: `${label}：测试视频` }),
    );
    await waitFor(() => expect(props.refresh).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledWith(
      `/api/tasks/task-1/${endpoint}`,
      expect.objectContaining({ method: "POST" }),
    );
  });
  it("separately confirms record removal and preserves files", async () => {
    const user = userEvent.setup(),
      fetch = vi.fn().mockResolvedValue(respond({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    const props = tasksProps([task]);
    render(<Tasks {...props} />);
    await user.click(
      screen.getByRole("button", { name: "任务详情：测试视频" }),
    );
    expect(
      screen.queryByRole("button", { name: "删除文件" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "移除记录" }));
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "不会删除已下载的文件",
    );
    await user.click(screen.getByRole("button", { name: "移除记录" }));
    await waitFor(() => expect(props.refresh).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledWith(
      "/api/tasks/task-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
  it("fetches preserved output files and requires an explicit file-delete checkbox", async () => {
    const user = userEvent.setup(),
      fetch = vi.fn().mockImplementation(() =>
        Promise.resolve(
          respond({
            files: [
              {
                name: "video.mp4",
                size: 1024,
                url: "/api/tasks/task-1/files/video.mp4",
              },
            ],
          }),
        ),
      );
    vi.stubGlobal("fetch", fetch);
    const props = tasksProps([
      { ...task, status: "completed", record_removed: true },
    ]);
    render(<Tasks {...props} library />);
    await user.click(
      screen.getByRole("button", { name: "查看文件：测试视频" }),
    );
    expect(
      await screen.findByRole("link", { name: "下载 video.mp4" }),
    ).toHaveAttribute(
      "href",
      `${window.location.origin}/api/tasks/task-1/files/video.mp4`,
    );
    expect(
      screen.queryByRole("button", { name: "移除记录" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "删除文件" }));
    expect(screen.getByRole("button", { name: "永久删除文件" })).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", { name: "我确认删除该任务的全部文件" }),
    );
    await user.click(screen.getByRole("button", { name: "永久删除文件" }));
    await waitFor(() => expect(props.refresh).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledWith(
      "/api/tasks/task-1/files",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
