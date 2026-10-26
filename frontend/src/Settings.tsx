import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileUp,
  HardDrive,
  Minus,
  Plus,
  QrCode,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import { api, errorMessage } from "./api";
import { bytes, percent } from "./format";
import {
  ErrorNotice,
  IconButton,
  Modal,
  Spinner,
  SuccessNotice,
} from "./components";
import { useQuery } from "./hooks";
import QrLogin from "./QrLogin";
import { applyTheme, loadTheme, type Theme } from "./theme";
import type { Account, Settings as SettingsData, SystemInfo } from "./types";
export const COOKIE_MAX_BYTES = 128 * 1024;
const themes: [Theme, string][] = [
  ["system", "跟随系统"],
  ["light", "浅色"],
  ["dark", "深色"],
];
type SystemQuery = {
  data?: SystemInfo;
  error: string;
  loading: boolean;
  updatedAt?: Date;
  refresh: () => void;
};
export default function Settings({
  onSaved,
  system,
}: {
  onSaved?: () => void;
  /** Server status, shown read-only at the end of the page. */
  system?: SystemQuery;
}) {
  const query = useQuery<SettingsData>("/settings");
  const account = useQuery<Account>("/bilibili/account");
  const [cookieForm, setCookieForm] = useState(false);
  const [theme, setTheme] = useState(loadTheme);
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
  const server = system?.data;
  const usedPercent =
    server && server.disk_total > 0
      ? percent((1 - server.disk_free / server.disk_total) * 100)
      : 0;
  return (
    <>
      <header className="page-heading">
        <h1>设置</h1>
      </header>
      <ErrorNotice message={query.error} retry={query.refresh} />
      {!confirmClear && <ErrorNotice message={error} />}
      <SuccessNotice message={success} />
      <div className="settings-page">
        {query.loading && !query.data ? (
          <Spinner label="正在加载设置" />
        ) : (
          query.data && (
            <>
              <section className="panel" aria-labelledby="settings-download">
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void mutate("save");
                  }}
                >
                  <div className="panel-heading">
                    <h2 id="settings-download">下载</h2>
                    <IconButton
                      label="刷新下载设置"
                      onClick={query.refresh}
                      disabled={locked}
                    >
                      <RefreshCw size={16} />
                    </IconButton>
                  </div>
                  <div className="setting-row">
                    <div>
                      <strong>同时下载任务数</strong>
                      <span>同时进行的下载数量，最多 4 个。</span>
                    </div>
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
                  <div className="setting-field">
                    <label className="field-label" htmlFor="download-dir">
                      下载目录
                    </label>
                    <input
                      id="download-dir"
                      className="text-input mono"
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
                    <p id="download-dir-hint" className="hint">
                      服务器或容器内已存在、可写的绝对路径，不会自动创建文件夹。仅影响新任务，已有任务目录不变。
                    </p>
                    <p id="download-dir-default" className="hint">
                      环境初始目录：
                      <code>{settings?.default_download_dir || "未提供"}</code>
                    </p>
                  </div>
                  <div className="panel-actions">
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
              </section>
              <section className="panel" aria-labelledby="settings-account">
                <div className="panel-heading">
                  <h2 id="settings-account">哔哩哔哩账户</h2>
                  <IconButton
                    label="刷新账户状态"
                    onClick={account.refresh}
                    disabled={account.loading}
                  >
                    <RefreshCw size={16} />
                  </IconButton>
                </div>
                <ErrorNotice message={account.error} retry={account.refresh} />
                <div className="account-row">
                  <span className="avatar" aria-hidden="true">
                    {account.data?.logged_in
                      ? (account.data.username || "B").slice(0, 1).toUpperCase()
                      : "?"}
                  </span>
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
                          {" · 登录凭据"}
                          {query.data.cookie_configured ? "已配置" : "未配置"}
                          {account.error ? " · 数据未更新" : ""}
                        </span>
                      </>
                    ) : (
                      <strong>账户状态未知</strong>
                    )}
                  </div>
                </div>
                <div className="panel-actions">
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
                    disabled={locked}
                    onClick={() => setQr(true)}
                  >
                    <QrCode size={17} />
                    扫码登录
                  </button>
                </div>
                <button
                  type="button"
                  className="disclosure"
                  aria-expanded={cookieForm}
                  onClick={() => setCookieForm((open) => !open)}
                >
                  {cookieForm ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  手动导入 Cookie
                </button>
                {cookieForm && (
                  <form onSubmit={submitCookies} className="cookie-form">
                    <label className="field-label" htmlFor="cookies">
                      Netscape Cookie 文本
                    </label>
                    <textarea
                      id="cookies"
                      value={cookies}
                      onChange={(event) => setCookies(event.target.value)}
                      placeholder="# Netscape HTTP Cookie File"
                      rows={6}
                      spellCheck={false}
                      autoComplete="off"
                      disabled={locked}
                    />
                    <div className="panel-actions">
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
                )}
              </section>
            </>
          )
        )}
        <section className="panel" aria-labelledby="settings-appearance">
          <div className="setting-row compact">
            <div>
              <h2 id="settings-appearance">外观</h2>
              <span>只影响当前浏览器。</span>
            </div>
            <div className="segmented-view labelled" role="group" aria-label="颜色主题">
              {themes.map(([value, label]) => (
                <button
                  key={value}
                  aria-pressed={theme === value}
                  className={theme === value ? "active" : ""}
                  onClick={() => {
                    setTheme(value);
                    applyTheme(value);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </section>
        {system && (
          <section className="panel" aria-labelledby="settings-server">
            <div className="panel-heading">
              <h2 id="settings-server">服务器</h2>
              <IconButton
                label="刷新系统状态"
                onClick={system.refresh}
                disabled={system.loading}
              >
                <RefreshCw size={16} className={system.loading ? "spin" : ""} />
              </IconButton>
            </div>
            <ErrorNotice message={system.error} retry={system.refresh} />
            {system.loading && !server ? (
              <Spinner label="正在读取系统信息" />
            ) : (
              server && (
                <>
                  <div className="disk-meter">
                    <div className="disk-caption">
                      <span>
                        <HardDrive size={15} />
                        下载目录所在磁盘
                      </span>
                      <span>
                        <strong>{bytes(server.disk_free)}</strong> 可用 / {bytes(server.disk_total)}
                      </span>
                    </div>
                    <div
                      className="meter-track"
                      role="progressbar"
                      aria-label="磁盘使用率"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={usedPercent}
                    >
                      <i style={{ width: `${usedPercent}%` }} />
                    </div>
                  </div>
                  <dl className="info-list">
                    <div>
                      <dt>应用版本</dt>
                      <dd>{server.version || "未知版本"}</dd>
                    </div>
                    <div>
                      <dt>下载引擎 yt-dlp</dt>
                      <dd>{server.yt_dlp_version || "未知版本"}</dd>
                    </div>
                    <div>
                      <dt>媒体处理 FFmpeg</dt>
                      <dd className={server.ffmpeg ? "ok" : "bad"}>
                        {server.ffmpeg ? "可用" : "未安装 / 不可用"}
                      </dd>
                    </div>
                    <div>
                      <dt>当前下载目录</dt>
                      <dd>
                        <code>{server.download_dir}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>活跃任务</dt>
                      <dd>{server.active_tasks}</dd>
                    </div>
                  </dl>
                  {system.updatedAt && (
                    <p className="hint">
                      {system.error ? "数据未更新 · " : ""}最近更新{" "}
                      {system.updatedAt.toLocaleTimeString("zh-CN", { hour12: false })}
                    </p>
                  )}
                </>
              )
            )}
          </section>
        )}
      </div>
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
