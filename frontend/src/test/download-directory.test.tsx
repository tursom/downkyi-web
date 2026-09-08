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
import Settings from "../Settings";
import TaskDetail from "../TaskDetail";
import type { Settings as SettingsData } from "../types";
import { parsed, respond, system, task } from "./fixtures";

const initial: SettingsData = {
  concurrency: 2,
  cookie_configured: false,
  download_dir: "/downloads",
  default_download_dir: "/initial-downloads",
};
const saveButton = () => screen.getByRole("button", { name: "保存设置" });
const changeDir = (value: string) =>
  fireEvent.change(screen.getByLabelText("下载目录"), { target: { value } });
function settingsFetch(
  handler: (init: RequestInit) => Response | Promise<Response>,
) {
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url === "/api/settings") return handler(init);
    if (url === "/api/bilibili/account")
      return respond({ logged_in: false, username: null, vip: false });
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("download directory settings", () => {
  it("loads persisted and environment paths, saves only the directory, and reloads the canonical result", async () => {
    let settings = { ...initial };
    const fetch = settingsFetch((init) => {
      if (init.method === "PATCH")
        settings = { ...settings, download_dir: "/export/media" };
      return respond(settings);
    });
    const onSaved = vi.fn();
    const view = render(<Settings onSaved={onSaved} />);
    expect(await screen.findByLabelText("下载目录")).toHaveValue("/downloads");
    expect(screen.getByText("/initial-downloads")).toBeVisible();
    expect(screen.getByLabelText("下载目录")).toHaveAccessibleDescription(
      /已存在.*仅影响新任务/,
    );
    expect(saveButton()).toBeDisabled();
    changeDir("/export/media/");
    fireEvent.click(saveButton());
    await screen.findByText("下载设置已保存");
    expect(fetch).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({
        method: "PATCH",
        body: '{"download_dir":"/export/media/"}',
      }),
    );
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("下载目录")).toHaveValue("/export/media");
    await waitFor(() => expect(saveButton()).toBeDisabled());
    view.unmount();
    render(<Settings />);
    expect(await screen.findByLabelText("下载目录")).toHaveValue(
      "/export/media",
    );
    expect(saveButton()).toBeDisabled();
  });

  it("sends both changed fields together and does not submit reverted changes", async () => {
    const fetch = settingsFetch((init) =>
      respond(
        init.method === "PATCH"
          ? { ...initial, ...JSON.parse(String(init.body)) }
          : initial,
      ),
    );
    render(<Settings />);
    await screen.findByLabelText("下载目录");
    changeDir("/export");
    changeDir("/downloads");
    expect(saveButton()).toBeDisabled();
    changeDir("/export");
    fireEvent.click(screen.getByRole("button", { name: "增加并发" }));
    fireEvent.click(saveButton());
    await screen.findByText("下载设置已保存");
    expect(fetch).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({
        method: "PATCH",
        body: '{"concurrency":3,"download_dir":"/export"}',
      }),
    );
  });

  it("preserves dirty input during a pending refresh, refresh failure and retry while updating untouched fields", async () => {
    let resolveRefresh!: (response: Response) => void;
    let reads = 0;
    const fetch = settingsFetch((init) => {
      if (init.method === "PATCH")
        return respond({
          ...initial,
          concurrency: 4,
          download_dir: "/export/draft",
        });
      reads += 1;
      if (reads === 1) return respond(initial);
      if (reads === 2)
        return new Promise<Response>((resolve) => {
          resolveRefresh = resolve;
        });
      return respond({
        ...initial,
        concurrency: 4,
        download_dir: "/another-client",
      });
    });
    render(<Settings />);
    await screen.findByLabelText("下载目录");
    changeDir("/export/draft");
    fireEvent.click(screen.getByRole("button", { name: "刷新下载设置" }));
    expect(screen.getByLabelText("下载目录")).toHaveValue("/export/draft");
    expect(saveButton()).toBeDisabled();
    await act(async () =>
      resolveRefresh(respond({ detail: "设置读取失败" }, 503)),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("设置读取失败");
    expect(screen.getByLabelText("下载目录")).toHaveValue("/export/draft");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() =>
      expect(screen.getByLabelText("同时下载任务数")).toHaveTextContent("4"),
    );
    expect(screen.getByLabelText("下载目录")).toHaveValue("/export/draft");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(saveButton());
    await screen.findByText("下载设置已保存");
    expect(fetch).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({
        method: "PATCH",
        body: '{"download_dir":"/export/draft"}',
      }),
    );
  });

  it.each(["目录不存在", "目录不可写", "不允许使用系统或受管理任务目录"])(
    "keeps rejected input and allows retry: %s",
    async (detail) => {
      let reject = true;
      const onSaved = vi.fn();
      settingsFetch((init) =>
        init.method === "PATCH"
          ? reject
            ? respond({ detail }, 400)
            : respond({ ...initial, download_dir: "/export" })
          : respond(initial),
      );
      render(<Settings onSaved={onSaved} />);
      await screen.findByLabelText("下载目录");
      changeDir("/export");
      fireEvent.click(saveButton());
      expect(await screen.findByRole("alert")).toHaveTextContent(
        `下载设置保存失败：${detail}`,
      );
      expect(screen.getByLabelText("下载目录")).toHaveValue("/export");
      expect(saveButton()).toBeEnabled();
      expect(onSaved).not.toHaveBeenCalled();
      reject = false;
      fireEvent.click(saveButton());
      await screen.findByText("下载设置已保存");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(onSaved).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["", "export/downloads"])(
    "rejects a non-absolute directory without a request: %s",
    async (value) => {
      const fetch = settingsFetch(() => respond(initial));
      render(<Settings />);
      await screen.findByLabelText("下载目录");
      changeDir(value);
      fireEvent.click(saveButton());
      expect(await screen.findByRole("alert")).toHaveTextContent("绝对路径");
      expect(screen.getByLabelText("下载目录")).toHaveValue(value);
      expect(fetch.mock.calls.some(([, init]) => init.method === "PATCH")).toBe(
        false,
      );
    },
  );

  it("retains the confirmed save even when its follow-up read fails", async () => {
    let saved = false;
    settingsFetch((init) => {
      if (init.method === "PATCH") {
        saved = true;
        return respond({ ...initial, download_dir: "/export" });
      }
      return saved
        ? respond({ detail: "无法刷新设置" }, 503)
        : respond(initial);
    });
    const onSaved = vi.fn();
    render(<Settings onSaved={onSaved} />);
    await screen.findByLabelText("下载目录");
    changeDir("/export");
    fireEvent.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("无法刷新设置");
    expect(screen.getByLabelText("下载目录")).toHaveValue("/export");
    expect(saveButton()).toBeDisabled();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});

describe("workspace directory propagation", () => {
  it.each([true, false])(
    "refreshes system immediately, uses the new default in the wizard and keeps existing task paths (auth_required=%s)",
    async (authRequired) => {
      let settings = { ...initial };
      const user = userEvent.setup();
      const fetch = vi.fn(async (url: string, init: RequestInit) => {
        if (url === "/api/session")
          return respond({ authenticated: true, auth_required: authRequired });
        if (url === "/api/tasks") return respond({ tasks: [task] });
        if (url === "/api/library") return respond({ tasks: [] });
        if (url === "/api/system")
          return respond({ ...system, download_dir: settings.download_dir });
        if (url === "/api/settings") {
          if (init.method === "PATCH")
            settings = { ...settings, ...JSON.parse(String(init.body)) };
          return respond(settings);
        }
        if (url === "/api/bilibili/account")
          return respond({ logged_in: false, username: null, vip: false });
        if (url === "/api/parse") return respond(parsed);
        throw new Error(`Unexpected request ${url}`);
      });
      vi.stubGlobal("fetch", fetch);
      render(<App />);
      await screen.findByText("/downloads");
      await user.click(screen.getByRole("button", { name: "偏好设置" }));
      await screen.findByLabelText("下载目录");
      changeDir("/export");
      const systemReads = () =>
        fetch.mock.calls.filter(([url]) => url === "/api/system").length;
      const before = systemReads();
      await user.click(saveButton());
      await screen.findByText("下载设置已保存");
      await waitFor(() => expect(systemReads()).toBeGreaterThan(before));
      await user.click(screen.getByRole("button", { name: /下载队列 1/ }));
      expect(await screen.findByText("/export")).toBeVisible();
      await user.click(
        screen.getByRole("button", { name: "任务详情：测试视频" }),
      );
      const detail = within(screen.getByRole("dialog"));
      expect(detail.getByText("/downloads")).toBeVisible();
      expect(detail.getByText("/downloads/task-1")).toBeVisible();
      expect(detail.queryByText("/export/task-1")).not.toBeInTheDocument();
      await user.keyboard("{Escape}");
      await user.click(screen.getByRole("button", { name: "新建下载" }));
      await user.type(
        screen.getByLabelText("视频、合集、番剧链接或 BV / AV 号"),
        "BVtest",
      );
      await user.click(screen.getByRole("button", { name: "解析" }));
      await screen.findByText("测试合集");
      await user.click(screen.getByRole("button", { name: "确认规格" }));
      expect(
        within(screen.getByRole("dialog")).getByText("/export"),
      ).toBeVisible();
      if (!authRequired) {
        expect(
          screen.queryByRole("button", { name: "退出登录" }),
        ).not.toBeInTheDocument();
        expect(fetch.mock.calls.some(([url]) => url === "/api/login")).toBe(
          false,
        );
      }
    },
  );

  it("does not invent a directory for legacy tasks without a pinned path", () => {
    render(
      <TaskDetail
        task={{ ...task, download_dir: undefined }}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onAction={vi.fn()}
        busy={false}
        error=""
      />,
    );
    expect(screen.getAllByText("未提供")).toHaveLength(2);
    expect(screen.queryByText("/downloads/task-1")).not.toBeInTheDocument();
  });
});
