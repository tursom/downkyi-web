export const SESSION_EXPIRED = "downkyi:session-expired";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function detailMessage(detail: unknown): string | undefined {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item: unknown) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "msg" in item) {
          const issue = item as { msg: unknown; loc?: unknown[] };
          const location = issue.loc
            ?.filter((part) => part !== "body")
            .join(".");
          return `${location ? `${location}: ` : ""}${String(issue.msg)}`;
        }
        return "请求参数不正确";
      })
      .join("；");
  }
  return undefined;
}

interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  public?: boolean;
}

export async function api<T = void>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { body, public: isPublic = false, headers, ...init } = options;
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      credentials: "same-origin",
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new Error("无法连接服务器，请检查网络后重试");
  }
  if (response.status === 401 && !isPublic) {
    window.dispatchEvent(new Event(SESSION_EXPIRED));
  }
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!response.ok) {
    const detail =
      data && typeof data === "object" && "detail" in data
        ? data.detail
        : undefined;
    throw new ApiError(
      detailMessage(detail) ||
        (response.status === 401
          ? "登录已失效，请重新登录"
          : `请求失败（${response.status}），请稍后重试`),
      response.status,
    );
  }
  if (text && data === undefined)
    throw new Error("服务器返回了无效的数据，请稍后重试");
  return data as T;
}

export function isAbort(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "AbortError"
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}

export function taskPath(id: string, suffix = ""): string {
  return `/tasks/${encodeURIComponent(id)}${suffix}`;
}

// Downloads stay on the authenticated origin; never turn API data into executable links.
export function downloadUrl(value: string): string | undefined {
  try {
    const url = new URL(value, window.location.origin);
    if (
      !value.trim() ||
      url.origin !== window.location.origin ||
      !["http:", "https:"].includes(url.protocol)
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
