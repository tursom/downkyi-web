import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Link,
  Plus,
  Search,
} from "lucide-react";
import { api, ApiError, errorMessage, isAbort } from "./api";
import { ErrorNotice, Modal, Spinner, Thumbnail } from "./components";
import EntryPicker, { eligible } from "./EntryPicker";
import DownloadSpecs, { availableSpecs } from "./DownloadSpecs";
import DownloadReview from "./DownloadReview";
import type { DownloadOptions, ParseResult, Task } from "./types";
export const PARSE_TIMEOUT_MS = 180_000;
const steps = ["解析内容", "选择项目与规格", "确认入队"];
export default function ParseModal({
  onClose,
  onCreated,
  downloadDir,
}: {
  onClose: () => void;
  onCreated: (count: number) => void;
  downloadDir?: string;
}) {
  const [step, setStep] = useState(1);
  const [url, setUrl] = useState("");
  const [parsed, setParsed] = useState<ParseResult>();
  const [selected, setSelected] = useState<string[]>([]);
  const [options, setOptions] = useState<DownloadOptions>({
    quality: "best",
    mode: "video",
    codec: "auto",
    cover: true,
    subtitles: false,
  });
  const [busy, setBusy] = useState<"parse" | "retry" | "create" | null>(null);
  const [retryMessage, setRetryMessage] = useState("");
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(
    () => () => {
      controller.current?.abort();
      controller.current = null;
      clearTimeout(timeout.current);
    },
    [],
  );
  useEffect(() => {
    heading.current?.focus();
    heading.current?.closest(".dialog")?.scrollTo?.(0, 0);
  }, [step]);
  const chosen =
    parsed?.entries.filter(
      (entry) => selected.includes(entry.id) && eligible(entry, options.mode),
    ) ?? [];
  const specs = availableSpecs(chosen);
  const specError =
    options.mode === "video" &&
    ((options.quality !== "best" &&
      !specs.qualities.includes(options.quality)) ||
      (options.codec !== "auto" && !specs.codecs.includes(options.codec)))
      ? "当前所选项目不含该画质或编码，请重新选择规格。"
      : "";
  const valid = chosen.length > 0 && chosen.length <= 50 && !specError;
  function abortRequest() {
    controller.current?.abort();
    controller.current = null;
    clearTimeout(timeout.current);
  }
  function cancelParse() {
    abortRequest();
    setBusy(null);
    setError(busy === "retry" ? "重试已取消，可以再次尝试。" : "解析已取消");
  }
  function close() {
    abortRequest();
    onClose();
  }
  async function parse(event: FormEvent) {
    event.preventDefault();
    if (!url.trim() || busy || controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setBusy("parse");
    setError("");
    setRetryMessage("");
    timeout.current = setTimeout(() => {
      if (controller.current !== request) return;
      abortRequest();
      setBusy(null);
      setError("解析超时（180 秒），请重试或缩小内容范围。");
    }, PARSE_TIMEOUT_MS);
    try {
      const result = await api<ParseResult>("/parse", {
        method: "POST",
        body: { url: url.trim() },
        signal: request.signal,
      });
      if (request.signal.aborted || controller.current !== request) return;
      const mode = result.entries.some((entry) => eligible(entry, "video"))
        ? "video"
        : "audio";
      setParsed(result);
      setOptions((previous) => ({
        ...previous,
        mode,
        quality: "best",
        codec: "auto",
      }));
      setSelected(
        result.entries
          .filter((entry) => eligible(entry, mode))
          .slice(0, 50)
          .map((entry) => entry.id),
      );
      setStep(2);
    } catch (cause) {
      if (!request.signal.aborted && !isAbort(cause))
        setError(errorMessage(cause));
    } finally {
      if (controller.current === request) {
        clearTimeout(timeout.current);
        controller.current = null;
        if (!request.signal.aborted) setBusy(null);
      }
    }
  }
  async function retry(entryIds: string[]) {
    if (!parsed || busy || controller.current || step !== 2) return;
    const ids = parsed.entries
      .filter((entry) => !entry.available && entryIds.includes(entry.id))
      .slice(0, 100)
      .map((entry) => entry.id);
    if (!ids.length) return;
    const request = new AbortController();
    controller.current = request;
    setBusy("retry");
    setError("");
    setRetryMessage("");
    timeout.current = setTimeout(() => {
      if (controller.current !== request) return;
      abortRequest();
      setBusy(null);
      setError("重试超时（180 秒），原列表和选择已保留，请再次尝试。");
    }, PARSE_TIMEOUT_MS);
    try {
      const result = await api<ParseResult>(
        `/parse/${encodeURIComponent(parsed.id)}/retry`,
        { method: "POST", body: { entry_ids: ids }, signal: request.signal },
      );
      if (request.signal.aborted || controller.current !== request) return;
      const recovered = result.entries.filter(
        (entry) => ids.includes(entry.id) && entry.available,
      ).length;
      // The server returns the merged result with stable entry identities and a new parse ID.
      // Keep selection/options and the mounted picker intact; recovered entries stay unchecked.
      setParsed(result);
      setRetryMessage(
        `已恢复 ${recovered} 项${recovered < ids.length ? `，${ids.length - recovered} 项仍解析失败，可再次重试。` : "，请勾选需要下载的项目。"}`,
      );
    } catch (cause) {
      if (
        !request.signal.aborted &&
        controller.current === request &&
        !isAbort(cause)
      ) {
        setError(
          cause instanceof ApiError && cause.status === 410
            ? "解析结果已过期，请点击「更换链接」后重新解析原链接。原列表和选择已保留。"
            : cause instanceof ApiError && cause.status === 429
              ? "解析繁忙，请稍后重试。"
              : errorMessage(cause),
        );
      }
    } finally {
      if (controller.current === request) {
        clearTimeout(timeout.current);
        controller.current = null;
        setBusy(null);
      }
    }
  }
  async function create() {
    if (!parsed || !valid || busy || controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setBusy("create");
    setError("");
    try {
      const result = await api<{ tasks: Task[] }>("/tasks", {
        method: "POST",
        signal: request.signal,
        body: {
          parse_id: parsed.id,
          entry_ids: chosen.map((entry) => entry.id),
          ...options,
        },
      });
      if (!request.signal.aborted) onCreated(result.tasks.length);
    } catch (cause) {
      if (!request.signal.aborted && !isAbort(cause))
        setError(errorMessage(cause));
    } finally {
      if (controller.current === request) {
        controller.current = null;
        if (!request.signal.aborted) setBusy(null);
      }
    }
  }
  return (
    <Modal title="新建下载" onClose={close} wide busy={busy === "create"}>
      <ol className="workflow-steps" aria-label="下载步骤">
        {steps.map((label, index) => (
          <li
            key={label}
            className={
              step === index + 1
                ? "current"
                : step > index + 1
                  ? "finished"
                  : ""
            }
            aria-current={step === index + 1 ? "step" : undefined}
          >
            <span>{step > index + 1 ? <Check size={13} /> : index + 1}</span>
            <strong>{label}</strong>
            {index < 2 && <ChevronRight size={14} />}
          </li>
        ))}
      </ol>
      <h3 ref={heading} tabIndex={-1} className="sr-only">
        第 {step} 步：{steps[step - 1]}
      </h3>
      {step === 1 ? (
        <div className="workflow-input">
          <form onSubmit={(event) => void parse(event)}>
            <label className="field-label" htmlFor="video-url">
              视频、合集、番剧链接或 BV / AV 号
            </label>
            <div className="parse-input">
              <Link size={18} />
              <input
                id="video-url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://www.bilibili.com/video/..."
                disabled={!!busy}
                required
                autoComplete="off"
              />
              <button
                className="button primary"
                disabled={!!busy || !url.trim()}
              >
                <Search size={16} />
                解析
              </button>
            </div>
          </form>
          <div className="source-placeholder">
            {busy === "parse" ? (
              <>
                <Spinner label="正在解析内容…" />
                <span>读取视频信息与可用资源，最长 180 秒</span>
                <button className="button secondary" onClick={cancelParse}>
                  取消解析
                </button>
              </>
            ) : (
              <>
                <Link size={30} />
                <strong>等待解析内容</strong>
              </>
            )}
          </div>
        </div>
      ) : (
        parsed && (
          <>
            <div className="workflow-source">
              <Thumbnail src={parsed.thumbnail} title={parsed.title} />
              <div>
                <span className="badge completed">解析完成</span>
                <h3>{parsed.title}</h3>
                <p>
                  {parsed.entries.length} 个项目 ·{" "}
                  {parsed.entries.filter((entry) => entry.available).length}{" "}
                  个可用
                </p>
              </div>
              {step === 2 && (
                <button
                  className="text-link"
                  disabled={!!busy}
                  onClick={() => {
                    if (controller.current) return;
                    setStep(1);
                    setError("");
                    setRetryMessage("");
                  }}
                >
                  更换链接
                  <ArrowRight size={13} />
                </button>
              )}
            </div>
            {(parsed.truncated || parsed.warnings.length > 0) && (
              <div className="workflow-warnings" role="status">
                {parsed.truncated && <p>结果已截断，最多返回 100 个项目。</p>}
                {parsed.warnings.map((warning, index) => (
                  <p key={index}>{warning}</p>
                ))}
              </div>
            )}
            {step === 2 ? (
              <div className="workflow-columns">
                <EntryPicker
                  entries={parsed.entries}
                  selected={selected}
                  setSelected={setSelected}
                  mode={options.mode}
                  retry={(ids) => void retry(ids)}
                  retrying={busy === "retry"}
                  retryMessage={retryMessage}
                  cancelRetry={cancelParse}
                />
                <DownloadSpecs
                  entries={chosen}
                  options={options}
                  setOptions={setOptions}
                  disabled={busy === "retry"}
                  downloadDir={downloadDir}
                />
              </div>
            ) : (
              <DownloadReview
                entries={chosen}
                options={options}
                downloadDir={downloadDir}
              />
            )}
          </>
        )
      )}
      <div className="workflow-error">
        <ErrorNotice message={error || (step > 1 ? specError : "")} />
      </div>
      <footer className="workflow-footer">
        <span>{step > 1 ? `已选 ${chosen.length} 项` : "服务器下载空间"}</span>
        <button
          className="button secondary"
          disabled={busy === "create" || busy === "retry"}
          onClick={
            step === 1
              ? close
              : () => {
                  if (controller.current) return;
                  setStep(step - 1);
                  setError("");
                  setRetryMessage("");
                }
          }
        >
          {step > 1 && <ArrowLeft size={15} />}
          {step === 1 ? "取消" : "上一步"}
        </button>
        {step === 2 && (
          <button
            className="button primary"
            disabled={!valid || !!busy}
            onClick={() => {
              if (controller.current) return;
              setStep(3);
              setError("");
            }}
          >
            确认规格
            <ArrowRight size={15} />
          </button>
        )}
        {step === 3 && (
          <button
            className="button primary"
            disabled={!valid || !!busy}
            onClick={() => void create()}
          >
            {busy === "create" ? (
              <Spinner label="正在创建" />
            ) : (
              <>
                <Plus size={16} />
                加入队列 ({chosen.length})
              </>
            )}
          </button>
        )}
      </footer>
    </Modal>
  );
}
