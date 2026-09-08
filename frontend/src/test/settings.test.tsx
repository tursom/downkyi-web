import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import Settings from "../Settings";
import QrLogin from "../QrLogin";
import { respond } from "./fixtures";
const image = "data:image/png;base64,iVBORw0KGgo=";
describe("settings", () => {
  it("saves concurrency, refreshes account, imports cookie text then clears with confirmation", async () => {
    const user = userEvent.setup();
    let concurrency = 2,
      configured = false;
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url === "/api/bilibili/account")
        return respond({
          logged_in: configured,
          username: configured ? "测试账户" : null,
          vip: false,
        });
      if (url === "/api/settings" && init.method === "PATCH")
        concurrency = JSON.parse(init.body as string).concurrency;
      if (url === "/api/settings/cookies") configured = init.method === "PUT";
      return respond({ concurrency, cookie_configured: configured });
    });
    vi.stubGlobal("fetch", fetch);
    render(<Settings />);
    await user.click(await screen.findByRole("button", { name: "增加并发" }));
    await user.click(screen.getByRole("button", { name: "增加并发" }));
    await user.click(screen.getByRole("button", { name: "保存设置" }));
    expect(await screen.findByText("下载设置已保存")).toBeVisible();
    expect(fetch).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({ method: "PATCH", body: '{"concurrency":4}' }),
    );
    await user.click(screen.getByRole("button", { name: "哔哩哔哩账户" }));
    const cookieInput = screen.getByLabelText("Netscape Cookie 文本");
    await waitFor(() => expect(cookieInput).toBeEnabled());
    fireEvent.change(cookieInput, {
      target: {
        value:
          "# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tprivate",
      },
    });
    await user.click(screen.getByRole("button", { name: "导入 Cookie" }));
    expect(await screen.findByText("Cookie 已导入")).toBeVisible();
    expect(cookieInput).toHaveValue("");
    expect(await screen.findByText("测试账户")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "清除 Cookie" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "确认清除" }));
    expect(await screen.findByText("Cookie 已清除")).toBeVisible();
    expect(fetch).toHaveBeenCalledWith(
      "/api/settings/cookies",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
  it("rejects cookie files over 128KB before upload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        respond(
          url === "/api/settings"
            ? { concurrency: 2, cookie_configured: false }
            : { logged_in: false, username: null, vip: false },
        ),
      ),
    );
    render(<Settings />);
    fireEvent.click(
      await screen.findByRole("button", { name: "哔哩哔哩账户" }),
    );
    fireEvent.change(screen.getByLabelText("选择 Cookie 文件"), {
      target: { files: [new File(["x".repeat(131073)], "cookies.txt")] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("128 KB");
  });
});
describe("QR lifecycle", () => {
  it("uses the returned image, never overlaps polls, and aborts when closed", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        respond({
          id: "qr/1",
          url: "https://passport.bilibili.com/test",
          image,
          expires_in: 120,
        }),
      )
      .mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetch);
    const { unmount } = render(
      <QrLogin onClose={vi.fn()} onConfirmed={vi.fn()} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByAltText("哔哩哔哩登录二维码")).toHaveAttribute(
      "src",
      image,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toBe("/api/bilibili/qr/qr%2F1/poll");
    const signal = fetch.mock.calls[1][1].signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200000);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(["confirmed", "expired"] as const)(
    "stops after server %s",
    async (status) => {
      vi.useFakeTimers();
      const onConfirmed = vi.fn();
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          respond({
            id: "qr",
            url: "https://passport.bilibili.com/test",
            image,
            expires_in: 120,
          }),
        )
        .mockResolvedValue(
          respond({
            status,
            message: status === "confirmed" ? "登录成功" : "二维码已过期",
          }),
        );
      vi.stubGlobal("fetch", fetch);
      render(<QrLogin onClose={vi.fn()} onConfirmed={onConfirmed} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250000);
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(onConfirmed).toHaveBeenCalledTimes(status === "confirmed" ? 1 : 0);
      expect(
        screen.queryByAltText("哔哩哔哩登录二维码"),
      ).not.toBeInTheDocument();
    },
  );
  it("expires locally and aborts a stalled poll at the returned deadline", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        respond({
          id: "qr",
          url: "https://passport.bilibili.com/test",
          image,
          expires_in: 5,
        }),
      )
      .mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetch);
    render(<QrLogin onClose={vi.fn()} onConfirmed={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetch.mock.calls[1][1].signal.aborted).toBe(true);
    expect(
      screen.getByRole("button", { name: "重新获取二维码" }),
    ).toBeEnabled();
    expect(screen.queryByAltText("哔哩哔哩登录二维码")).not.toBeInTheDocument();
  });
});
