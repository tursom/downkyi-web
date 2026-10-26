import { useEffect, useState } from "react";
import { Download, Film, LogOut, Plus, Settings2, ShieldOff } from "lucide-react";
import { api, errorMessage, isAbort, SESSION_EXPIRED } from "./api";
import { useQuery } from "./hooks";
import { bytes, percent } from "./format";
import { ErrorNotice, Spinner } from "./components";
import Login, { Brand } from "./Login";
import { knownEntries } from "./grouping";
import ParseModal from "./ParseModal";
import Settings from "./Settings";
import Tasks from "./Tasks";
import type { CollectionUpdate, SystemInfo, Task } from "./types";

type View = "tasks" | "library" | "settings";
const navigation = [
  { id: "tasks", label: "下载", icon: Download },
  { id: "library", label: "媒体库", icon: Film },
  { id: "settings", label: "设置", icon: Settings2 },
] as const;
function Workspace({ onLogout, authRequired }: { onLogout: () => void; authRequired: boolean }) {
  const [view, setView] = useState<View>("tasks");
  // undefined: closed; {}: new download; { update }: check a collection for new videos.
  const [parseRequest, setParseRequest] = useState<{ update?: CollectionUpdate }>();
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [message, setMessage] = useState("");
  const tasks = useQuery<{ tasks: Task[] }>("/tasks", 2000);
  const library = useQuery<{ tasks: Task[] }>("/library", 5000);
  const system = useQuery<SystemInfo>("/system", 15000);
  // Finished downloads live in the library; the download view only shows work in progress.
  const queue = tasks.data?.tasks.filter((task) => task.status !== "completed");
  const failed = queue?.some((task) => task.status === "failed");
  const disk = system.data;
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(""), 6000);
    return () => clearTimeout(timer);
  }, [message]);
  function refresh() {
    tasks.refresh();
    library.refresh();
    system.refresh();
  }
  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError("");
    try {
      await api("/logout", { method: "POST" });
      onLogout();
    } catch (cause) {
      setLogoutError(errorMessage(cause));
    } finally {
      setLoggingOut(false);
    }
  }
  return (
    <div className="app">
      <a className="skip-link" href="#main">
        跳转至主要内容
      </a>
      <aside className="sidebar">
        <Brand />
        <button
          className="button primary new-download"
          aria-label="新建下载"
          onClick={() => setParseRequest({})}
        >
          <Plus size={18} />
          <span>新建下载</span>
        </button>
        <nav aria-label="主导航">
          {navigation.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={view === id ? "active" : ""}
              aria-current={view === id ? "page" : undefined}
              onClick={() => setView(id)}
            >
              <Icon size={18} />
              <span>{label}</span>
              {id === "tasks" && (
                <em className={failed ? "alert" : undefined}>{queue?.length ?? "…"}</em>
              )}
              {id === "library" && <em>{library.data?.tasks.length ?? "…"}</em>}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          {disk && disk.disk_total > 0 && (
            <div className="disk-meter compact">
              <div className="disk-caption">
                <span>磁盘</span>
                <span>{bytes(disk.disk_free)} 可用</span>
              </div>
              <div className="meter-track">
                <i style={{ width: `${percent((1 - disk.disk_free / disk.disk_total) * 100)}%` }} />
              </div>
            </div>
          )}
          {authRequired ? (
            <button
              className="sidebar-link"
              aria-label="退出登录"
              title="退出登录"
              disabled={loggingOut}
              onClick={() => void logout()}
            >
              <LogOut size={16} />
              <span>退出登录</span>
            </button>
          ) : (
            <span
              className="sidebar-link"
              title="访问保护已关闭，仅限可信内网。所有可达客户端均可管理任务、文件和 B 站凭据。"
            >
              <ShieldOff size={16} />
              免令牌
            </span>
          )}
        </div>
      </aside>
      <main id="main" tabIndex={-1}>
        <ErrorNotice message={logoutError} />
        {view === "settings" ? (
          <Settings onSaved={system.refresh} system={system} />
        ) : (
          <Tasks
            key={view}
            library={view === "library"}
            tasks={view === "library" ? library.data?.tasks : queue}
            loading={view === "library" ? library.loading : tasks.loading}
            error={view === "library" ? library.error : tasks.error}
            refresh={refresh}
            onNew={() => setParseRequest({})}
            onCheckUpdates={(group, url) =>
              setParseRequest({
                update: {
                  group,
                  url,
                  known: knownEntries([...(tasks.data?.tasks ?? []), ...(library.data?.tasks ?? [])]),
                },
              })
            }
            message={message}
            downloadDir={system.data?.download_dir}
          />
        )}
      </main>
      {parseRequest && (
        <ParseModal
          downloadDir={system.data?.download_dir}
          update={parseRequest.update}
          onClose={() => setParseRequest(undefined)}
          onCreated={(count) => {
            setParseRequest(undefined);
            setView("tasks");
            setMessage(`已创建 ${count} 个下载任务`);
            refresh();
          }}
        />
      )}
    </div>
  );
}
export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean>();
  const [authRequired, setAuthRequired] = useState(true);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    function expire() {
      setExpired(true);
      setAuthenticated(false);
    }
    window.addEventListener(SESSION_EXPIRED, expire);
    return () => window.removeEventListener(SESSION_EXPIRED, expire);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api<{ authenticated: boolean; auth_required?: boolean }>("/session", {
      signal: controller.signal,
      public: true,
    })
      .then((session) => {
        if (!controller.signal.aborted) {
          setAuthRequired(session.auth_required !== false);
          setAuthenticated(session.authenticated);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted && !isAbort(cause))
          setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [revision]);
  if (authenticated === undefined)
    return (
      <div className="session-loading">
        <Brand />
        {error ? (
          <ErrorNotice
            message={error}
            retry={() => setRevision((value) => value + 1)}
          />
        ) : (
          <Spinner label="正在连接服务器" />
        )}
      </div>
    );
  return authenticated ? (
    <Workspace
      authRequired={authRequired}
      onLogout={() => {
        setAuthenticated(false);
        setExpired(false);
      }}
    />
  ) : (
    <Login
      expired={expired}
      onLogin={() => {
        setExpired(false);
        setAuthenticated(true);
      }}
    />
  );
}
