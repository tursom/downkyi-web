import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useQuery } from "../hooks";

describe("polling", () => {
  it("aborts superseded reads and ignores late responses after refresh", async () => {
    let resolveOld!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(new Response('{"tasks":["new"]}'));
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useQuery("/tasks"));
    const signal = fetch.mock.calls[0][1].signal as AbortSignal;
    act(() => result.current.refresh());
    expect(signal.aborted).toBe(true);
    await waitFor(() =>
      expect(result.current.data).toEqual({ tasks: ["new"] }),
    );
    await act(async () => {
      resolveOld(new Response('{"tasks":["old"]}'));
    });
    expect(result.current.data).toEqual({ tasks: ["new"] });
  });
  it("polls tasks every two seconds and stops after unmount", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response('{"tasks":[]}')));
    vi.stubGlobal("fetch", fetch);
    const { result, unmount } = renderHook(() => useQuery("/tasks", 2000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.data).toEqual({ tasks: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not overlap slow requests and aborts on unmount", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetch);
    const { unmount } = renderHook(() => useQuery("/system", 15000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const signal = fetch.mock.calls[0][1].signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it("retains the last successful data when a refresh fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response('{"tasks":[]}'))
        .mockResolvedValueOnce(
          new Response('{"detail":"服务暂不可用"}', { status: 503 }),
        ),
    );
    const { result } = renderHook(() => useQuery("/tasks"));
    await waitFor(() => expect(result.current.data).toEqual({ tasks: [] }));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.error).toBe("服务暂不可用"));
    expect(result.current.data).toEqual({ tasks: [] });
  });
});
