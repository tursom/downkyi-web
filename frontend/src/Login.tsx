import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Eye,
  EyeOff,
  KeyRound,
  ShieldCheck,
} from "lucide-react";
import { api, errorMessage, isAbort } from "./api";
import { ErrorNotice, IconButton, Spinner } from "./components";

export function Brand() {
  return (
    <div className="brand">
      <div className="brand-symbol">
        <ArrowDownToLine size={23} strokeWidth={2.5} />
      </div>
      <span>
        DownKyi <small>WEB</small>
      </span>
    </div>
  );
}
export default function Login({
  onLogin,
  expired,
}: {
  onLogin: () => void;
  expired: boolean;
}) {
  const [token, setToken] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token.trim() || busy) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError("");
    try {
      await api("/login", {
        method: "POST",
        body: { token },
        public: true,
        signal: request.signal,
      });
      const session = await api<{ authenticated: boolean }>("/session", {
        public: true,
        signal: request.signal,
      });
      if (request.signal.aborted) return;
      if (!session.authenticated)
        throw new Error("登录未成功，请检查访问令牌或浏览器 Cookie 设置");
      setToken("");
      onLogin();
    } catch (cause) {
      if (!isAbort(cause)) setError(errorMessage(cause));
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <section className="login-panel">
        <Brand />
        <div className="login-heading">
          <div className="eyebrow">SERVER ACCESS</div>
          <h1>登录下载工作台</h1>
        </div>
        {expired && (
          <div className="notice warning" role="status">
            会话已过期，请重新登录。
          </div>
        )}
        <form onSubmit={(event) => void submit(event)}>
          <label className="field-label" htmlFor="token">
            访问令牌
          </label>
          <div className="input-icon">
            <KeyRound size={18} />
            <input
              id="token"
              type={visible ? "text" : "password"}
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="current-password"
              required
              disabled={busy}
            />
            <IconButton
              label={visible ? "隐藏令牌" : "显示令牌"}
              onClick={() => setVisible((value) => !value)}
            >
              {visible ? <EyeOff size={18} /> : <Eye size={18} />}
            </IconButton>
          </div>
          <ErrorNotice message={error} />
          <button
            className="button primary login-submit"
            disabled={busy || !token.trim()}
          >
            {busy ? (
              <Spinner label="登录中" />
            ) : (
              <>
                登录
                <ArrowRight size={17} />
              </>
            )}
          </button>
        </form>
        <div className="login-footer">
          <ShieldCheck size={15} />
          私人下载空间
        </div>
      </section>
    </main>
  );
}
