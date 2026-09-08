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
import { api, errorMessage, isAbort } from "./api";
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
  const [busy, setBusy] = useState<"parse" | "create" | null>(null);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(
    () => () => {
      controller.current?.abort();
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
  function cancelParse() {
    controller.current?.abort();
    clearTimeout(timeout.current);
    setBusy(null);
    setError("解析已取消");
  }
  function close() {
    controller.current?.abort();
    clearTimeout(timeout.current);
    onClose();
  }
  async function parse(event: FormEvent) {
    event.preventDefault();
    if (!url.trim() || busy) return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setBusy("parse");
    setError("");
    timeout.current = setTimeout(() => {
      request.abort();
      setBusy(null);
      setError("解析超时（180 秒），请重试或缩小内容范围。");
    }, PARSE_TIMEOUT_MS);
    try {
      const result = await api<ParseResult>("/parse", {
        method: "POST",
        body: { url: url.trim() },
        signal: request.signal,
      });
      if (request.signal.aborted) return;
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
        if (!request.signal.aborted) setBusy(null);
      }
    }
  }
  async function create() {
    if (!parsed || !valid || busy) return;
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
      if (!request.signal.aborted) setBusy(null);
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
                  onClick={() => {
                    setStep(1);
                    setError("");
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
                />
                <DownloadSpecs
                  entries={chosen}
                  options={options}
                  setOptions={setOptions}
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
          disabled={busy === "create"}
          onClick={
            step === 1
              ? close
              : () => {
                  setStep(step - 1);
                  setError("");
                }
          }
        >
          {step > 1 && <ArrowLeft size={15} />}
          {step === 1 ? "取消" : "上一步"}
        </button>
        {step === 2 && (
          <button
            className="button primary"
            disabled={!valid}
            onClick={() => {
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
