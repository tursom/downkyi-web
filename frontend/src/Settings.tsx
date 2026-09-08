import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Download,
  FileUp,
  Minus,
  Plus,
  QrCode,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { api, errorMessage } from "./api";
import {
  ErrorNotice,
  IconButton,
  Modal,
  Spinner,
  SuccessNotice,
} from "./components";
import { useQuery } from "./hooks";
import QrLogin from "./QrLogin";
import type { Account, Settings as SettingsData } from "./types";
export const COOKIE_MAX_BYTES = 128 * 1024;
export default function Settings({ onSaved }: { onSaved?: () => void }) {
  const query = useQuery<SettingsData>("/settings");
  const account = useQuery<Account>("/bilibili/account");
  const [tab, setTab] = useState<"download" | "account">("download");
  const [savedSettings, setSavedSettings] = useState<SettingsData>();
  const [concurrencyDraft, setConcurrency] = useState<number>();
  const [downloadDirDraft, setDownloadDir] = useState<string>();
  const settings = savedSettings ?? query.data;
  const concurrency = concurrencyDraft ?? settings?.concurrency;
  const downloadDir = downloadDirDraft ?? settings?.download_dir ?? "";
  const changes: Partial<Pick<SettingsData, "concurrency" | "download_dir">> = {};
  if (concurrency !== undefined && concurrency !== settings?.concurrency)
    changes.concurrency = concurrency;
  if (downloadDir !== (settings?.download_dir ?? ""))
    changes.download_dir = downloadDir;
  const [cookies, setCookies] = useState("");
  const [busy, setBusy] = useState<"save" | "import" | "clear" | "file" | null>(
    null,
  );
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [qr, setQr] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const reader = useRef<FileReader | null>(null);
  useEffect(() => () => reader.current?.abort(), []);
  useEffect(() => {
    if (query.data) setSavedSettings(query.data);
  }, [query.data]);
  async function mutate(operation: "save" | "import" | "clear") {
    if (busy) return;
    setError("");
    setSuccess("");
    if (operation === "save") {
      if (!Object.keys(changes).length) return;
      if (changes.download_dir !== undefined && !downloadDir.startsWith("/")) {
        setError("下载目录必须是服务器或容器内的绝对路径，以 / 开头");
        return;
      }
    }
    if (
      operation === "import" &&
      new TextEncoder().encode(cookies).byteLength > COOKIE_MAX_BYTES
    ) {
      setError("Cookie 文本不能超过 128 KB");
      return;
    }
    setBusy(operation);
    try {
      if (operation === "save") {
        const saved = await api<SettingsData>("/settings", {
          method: "PATCH",
          body: changes,
        });
        setSavedSettings(saved);
        setConcurrency(undefined);
        setDownloadDir(undefined);
        setSuccess("下载设置已保存");
        onSaved?.();
      } else if (operation === "import") {
        await api("/settings/cookies", { method: "PUT", body: { cookies } });
        setCookies("");
        setSuccess("Cookie 已导入");
      } else {
        await api("/settings/cookies", { method: "DELETE" });
        setCookies("");
        setConfirmClear(false);
        setSuccess("Cookie 已清除");
      }
      query.refresh();
      if (operation !== "save") account.refresh();
    } catch (cause) {
      setError(
        operation === "save"
          ? `下载设置保存失败：${errorMessage(cause)}`
          : errorMessage(cause),
      );
    } finally {
      setBusy(null);
    }
  }
  function readCookieFile(file: File | undefined) {
    if (!file) return;
    setError("");
    setSuccess("");
    if (file.size > COOKIE_MAX_BYTES) {
      setError("Cookie 文件不能超过 128 KB");
      return;
    }
    setBusy("file");
    const fileReader = new FileReader();
    reader.current = fileReader;
    fileReader.onload = () => {
      setCookies(String(fileReader.result ?? ""));
      setBusy(null);
    };
    fileReader.onerror = () => {
      setError("无法读取文件，请重新选择");
      setBusy(null);
    };
    fileReader.readAsText(file);
  }
  function submitCookies(event: FormEvent) {
    event.preventDefault();
    void mutate("import");
  }
  const locked = !!busy || !query.data || query.loading;
  return (
    <>
      <header className="page-heading">
        <div>
          <div className="eyebrow">PREFERENCES</div>
          <h1>偏好设置</h1>
        </div>
        <ShieldCheck size={22} />
      </header>
      <ErrorNotice message={query.error} retry={query.refresh} />
      {!confirmClear && <ErrorNotice message={error} />}
      <SuccessNotice message={success} />
      {query.loading && !query.data ? (
        <Spinner label="正在加载设置" />
      ) : (
        query.data && (
          <section className="settings-layout">
            <nav className="settings-nav" aria-label="设置分类">
              <button
                aria-pressed={tab === "download"}
                className={tab === "download" ? "active" : ""}
                onClick={() => setTab("download")}
              >
                <Download size={16} />
                下载设置
              </button>
              <button
                aria-pressed={tab === "account"}
                className={tab === "account" ? "active" : ""}
                onClick={() => setTab("account")}
              >
                <ShieldCheck size={16} />
                哔哩哔哩账户
              </button>
            </nav>
            <div className="settings-content">
              {tab === "download" ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void mutate("save");
                  }}
                >
                  <div className="settings-heading">
                    <h2>下载设置</h2>
                    <IconButton
                      label="刷新下载设置"
                      onClick={query.refresh}
                      disabled={locked}
                    >
                      <RefreshCw size={16} />
                    </IconButton>
                  </div>
                  <div className="setting-row">
                    <strong>同时下载任务数</strong>
                    <div className="stepper">
                      <IconButton
                        label="减少并发"
                        disabled={locked || (concurrency ?? 1) <= 1}
                        onClick={() =>
                          setConcurrency(Math.max(1, (concurrency ?? 2) - 1))
                        }
                      >
                        <Minus size={15} />
                      </IconButton>
                      <output aria-label="同时下载任务数">{concurrency}</output>
                      <IconButton
                        label="增加并发"
                        disabled={locked || (concurrency ?? 4) >= 4}
                        onClick={() =>
                          setConcurrency(Math.min(4, (concurrency ?? 2) + 1))
                        }
                      >
                        <Plus size={15} />
                      </IconButton>
                    </div>
                  </div>
                  <label className="field-label" htmlFor="download-dir">
                    下载目录
                  </label>
                  <input
                    id="download-dir"
                    className="download-dir-input"
                    type="text"
                    value={downloadDir}
                    onChange={(event) => {
                      setDownloadDir(event.target.value);
                      setSuccess("");
                    }}
                    aria-describedby="download-dir-hint download-dir-default"
                    placeholder="例如 /downloads 或 /downloads/archive"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    disabled={locked}
                  />
                  <p id="download-dir-hint" className="download-dir-hint muted">
                    服务器或容器内已存在、可写的绝对路径，不会自动创建文件夹。仅影响新任务，已有任务目录不变。
                  </p>
                  <p
                    id="download-dir-default"
                    className="download-dir-hint muted"
                  >
                    环境初始目录：
                    <code>{settings?.default_download_dir || "未提供"}</code>
                  </p>
                  <div className="settings-save">
                    <button
                      className="button primary"
                      type="submit"
                      disabled={
                        locked || !settings || !Object.keys(changes).length
                      }
                    >
                      {busy === "save" ? (
                        <Spinner label="保存中" />
                      ) : (
                        <>
                          <Save size={16} />
                          保存设置
                        </>
                      )}
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <h2>哔哩哔哩账户</h2>
                  <div className="setting-row">
                    <strong>登录凭据</strong>
                    <span
                      className={`badge ${query.data.cookie_configured ? "completed" : "paused"}`}
                    >
                      {query.data.cookie_configured ? "已配置" : "未配置"}
                    </span>
                  </div>
                  <ErrorNotice
                    message={account.error}
                    retry={account.refresh}
                  />
                  <div className="setting-row">
                    <div>
                      {account.loading && !account.data ? (
                        <Spinner label="正在读取账户" />
                      ) : account.data ? (
                        <>
                          <strong>
                            {account.data.logged_in
                              ? account.data.username || "已登录账户"
                              : "未登录哔哩哔哩"}
                          </strong>
                          <span>
                            {account.data.logged_in
                              ? account.data.vip
                                ? "大会员"
                                : "普通账户"
                              : account.data.message || "尚未授权"}
                            {account.error ? " · 数据未更新" : ""}
                          </span>
                        </>
                      ) : (
                        <strong>账户状态未知</strong>
                      )}
                    </div>
                    <IconButton
                      label="刷新账户状态"
                      onClick={account.refresh}
                      disabled={account.loading}
                    >
                      <RefreshCw size={16} />
                    </IconButton>
                  </div>
                  <div className="cookie-buttons">
                    <button
                      className="button secondary"
                      disabled={locked}
                      onClick={() => setQr(true)}
                    >
                      <QrCode size={17} />
                      扫码登录
                    </button>
                  </div>
                  <form onSubmit={submitCookies}>
                    <label className="field-label" htmlFor="cookies">
                      Netscape Cookie 文本
                    </label>
                    <textarea
                      id="cookies"
                      value={cookies}
                      onChange={(event) => setCookies(event.target.value)}
                      placeholder="# Netscape HTTP Cookie File"
                      rows={7}
                      spellCheck={false}
                      autoComplete="off"
                      disabled={locked}
                    />
                    <div className="cookie-buttons">
                      <input
                        ref={input}
                        className="sr-only"
                        type="file"
                        accept=".txt,text/plain"
                        aria-label="选择 Cookie 文件"
                        tabIndex={-1}
                        disabled={locked}
                        onChange={(event) => {
                          readCookieFile(event.target.files?.[0]);
                          event.target.value = "";
                        }}
                      />
                      <button
                        type="button"
                        className="button secondary"
                        disabled={locked}
                        onClick={() => input.current?.click()}
                      >
                        <FileUp size={16} />
                        选择文件
                      </button>
                      <button
                        type="button"
                        className="button danger"
                        disabled={locked || !query.data.cookie_configured}
                        onClick={() => {
                          setError("");
                          setConfirmClear(true);
                        }}
                      >
                        <Trash2 size={16} />
                        清除 Cookie
                      </button>
                      <button
                        className="button primary"
                        disabled={locked || !cookies.trim()}
                      >
                        {busy === "import" ? (
                          <Spinner label="导入中" />
                        ) : (
                          <>
                            <FileUp size={16} />
                            导入 Cookie
                          </>
                        )}
                      </button>
                    </div>
                  </form>
                </>
              )}
            </div>
          </section>
        )
      )}
      {confirmClear && (
        <Modal
          title="清除 B站 Cookie？"
          onClose={() => setConfirmClear(false)}
          busy={busy === "clear"}
        >
          <p className="muted">
            清除后，新任务将使用未登录状态，部分资源可能不可用。
          </p>
          <ErrorNotice message={error} />
          <footer className="dialog-footer">
            <button
              className="button secondary"
              onClick={() => setConfirmClear(false)}
              disabled={!!busy}
            >
              取消
            </button>
            <button
              className="button danger-solid"
              disabled={!!busy}
              onClick={() => void mutate("clear")}
            >
              {busy === "clear" ? (
                <Spinner label="正在清除" />
              ) : (
                <>
                  <Trash2 size={16} />
                  确认清除
                </>
              )}
            </button>
          </footer>
        </Modal>
      )}
      {qr && (
        <QrLogin
          onClose={() => setQr(false)}
          onConfirmed={() => {
            setSuccess("哔哩哔哩登录成功");
            setCookies("");
            query.refresh();
            account.refresh();
          }}
        />
      )}
    </>
  );
}
