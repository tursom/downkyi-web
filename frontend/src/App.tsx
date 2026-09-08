import { useEffect, useState } from "react";
import {
  ChevronRight,
  Download,
  FolderOpen,
  LogOut,
  Menu,
  Server,
  Settings2,
  ShieldOff,
} from "lucide-react";
import { api, errorMessage, isAbort, SESSION_EXPIRED } from "./api";
import { useQuery } from "./hooks";
import { ErrorNotice, IconButton, Modal, Spinner } from "./components";
import Login, { Brand } from "./Login";
import ParseModal from "./ParseModal";
import Settings from "./Settings";
import System from "./System";
import Tasks from "./Tasks";
import type { SystemInfo, Task } from "./types";

type View = "tasks" | "library" | "settings" | "system";
const navigation = [
  { id: "tasks", label: "下载队列", icon: Download },
  { id: "library", label: "已完成", icon: FolderOpen },
  { id: "settings", label: "偏好设置", icon: Settings2 },
  { id: "system", label: "服务器", icon: Server },
] as const;
function Workspace({ onLogout, authRequired }: { onLogout: () => void; authRequired: boolean }) {
  const [view, setView] = useState<View>("tasks");
  const [parseOpen, setParseOpen] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [message, setMessage] = useState("");
  const tasks = useQuery<{ tasks: Task[] }>("/tasks", 2000);
  const library = useQuery<{ tasks: Task[] }>("/library", 5000);
  const system = useQuery<SystemInfo>("/system", 15000);
  const active = tasks.data?.tasks.filter(
    (task) => task.status !== "completed",
  ).length;
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(""), 6000);
    return () => clearTimeout(timer);
  }, [message]);
  function navigate(next: View) {
    setView(next);
    setDrawer(false);
  }
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
  const nav = (
    <nav aria-label="主导航">
      {navigation.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          className={view === id ? "active" : ""}
          aria-current={view === id ? "page" : undefined}
          onClick={() => navigate(id)}
        >
          <Icon size={18} />
          <span>{label}</span>
          {id === "tasks" && <em>{active ?? "待加载"}</em>}
          {id === "library" && (
            <em>{library.data?.tasks.length ?? "待加载"}</em>
          )}
        </button>
      ))}
    </nav>
  );
  const listing = view === "library" ? library : tasks;
  return (
    <div className="app variant-B">
      <a className="skip-link" href="#main">
        跳转至主要内容
      </a>
      <header className="app-nav">
        <Brand />
        <div className="desktop-nav">{nav}</div>
        <div className="nav-tools">
          {authRequired ? <IconButton
            label="退出登录"
            disabled={loggingOut}
            onClick={() => void logout()}
          >
            <LogOut size={18} />
          </IconButton> : <span className="connection" title="访问保护已关闭，仅限可信内网。所有可达客户端均可管理任务、文件和 B 站凭据。"><ShieldOff size={14} />免令牌</span>}
          <div className="mobile-menu">
            <IconButton label="打开导航" onClick={() => setDrawer(true)}>
              <Menu size={20} />
            </IconButton>
          </div>
        </div>
      </header>
      <div className="main-shell">
        <div className="topbar">
          <div className="breadcrumb">
            <span>工作空间</span>
            <ChevronRight size={14} />
            <strong>
              {navigation.find((item) => item.id === view)?.label}
            </strong>
          </div>
          <span className={`connection ${tasks.error ? "offline" : ""}`}>
            <i className="status-dot" />
            {tasks.error ? "连接异常" : tasks.data ? "服务已连接" : "正在连接"}
          </span>
        </div>
        <main id="main" tabIndex={-1}>
          <ErrorNotice message={logoutError} />
          {view === "tasks" || view === "library" ? (
            <Tasks
              key={view}
              library={view === "library"}
              tasks={listing.data?.tasks}
              loading={listing.loading}
              error={listing.error}
              refresh={refresh}
              onNew={() => setParseOpen(true)}
              onBrowse={() =>
                navigate(view === "library" ? "tasks" : "library")
              }
              message={message}
              downloadDir={system.data?.download_dir}
            />
          ) : view === "settings" ? (
            <Settings onSaved={system.refresh} />
          ) : (
            <System {...system} />
          )}
        </main>
        <footer className="app-footer">
          <span>DownKyi Web {system.data?.version}</span>
          <span>
            {tasks.error
              ? "连接异常"
              : tasks.data
                ? "已连接服务器"
                : "等待服务器响应"}
          </span>
        </footer>
      </div>
      {drawer && (
        <Modal
          title="工作空间"
          className="nav-drawer"
          onClose={() => setDrawer(false)}
        >
          {nav}
        </Modal>
      )}
      {parseOpen && (
        <ParseModal
          downloadDir={system.data?.download_dir}
          onClose={() => setParseOpen(false)}
          onCreated={(count) => {
            setParseOpen(false);
            navigate("tasks");
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
