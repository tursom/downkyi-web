import { useEffect, useRef, useState } from "react";
import { QrCode, RefreshCw } from "lucide-react";
import { api, errorMessage, isAbort } from "./api";
import { ErrorNotice, Modal, Spinner } from "./components";
import type { QrPoll, QrSession } from "./types";
export default function QrLogin({
  onClose,
  onConfirmed,
}: {
  onClose: () => void;
  onConfirmed: () => void;
}) {
  const [session, setSession] = useState<QrSession>();
  const [status, setStatus] = useState<QrPoll["status"]>("waiting");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const confirmed = useRef(onConfirmed);
  confirmed.current = onConfirmed;
  useEffect(() => {
    const controller = new AbortController();
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    setSession(undefined);
    setStatus("waiting");
    setMessage("");
    setError("");
    function expire() {
      clearTimeout(pollTimer);
      controller.abort();
      setStatus("expired");
      setMessage("二维码已过期");
    }
    async function poll(id: string) {
      try {
        const result = await api<QrPoll>(
          `/bilibili/qr/${encodeURIComponent(id)}/poll`,
          { method: "POST", signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setStatus(result.status);
        setMessage(result.message);
        if (result.status === "confirmed") {
          clearTimeout(expiryTimer);
          confirmed.current();
          return;
        }
        if (result.status === "expired") {
          clearTimeout(expiryTimer);
          return;
        }
        pollTimer = setTimeout(() => void poll(id), 2000);
      } catch (cause) {
        if (!controller.signal.aborted && !isAbort(cause)) {
          clearTimeout(expiryTimer);
          setError(errorMessage(cause));
        }
      }
    }
    async function create() {
      try {
        const result = await api<QrSession>("/bilibili/qr", {
          method: "POST",
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (
          !/^data:image\/png;base64,[A-Za-z0-9+/=\r\n]+$/.test(result.image) ||
          !Number.isFinite(result.expires_in) ||
          result.expires_in <= 0
        )
          throw new Error("服务器返回了无效的二维码");
        setSession(result);
        setMessage("等待扫码");
        expiryTimer = setTimeout(expire, result.expires_in * 1000);
        pollTimer = setTimeout(() => void poll(result.id), 2000);
      } catch (cause) {
        if (!controller.signal.aborted && !isAbort(cause))
          setError(errorMessage(cause));
      }
    }
    void create();
    return () => {
      controller.abort();
      clearTimeout(pollTimer);
      clearTimeout(expiryTimer);
    };
  }, [revision]);
  return (
    <Modal title="哔哩哔哩扫码登录" onClose={onClose} className="qr-dialog">
      <div className="qr-area">
        {!session && !error ? (
          <Spinner label="正在获取二维码" />
        ) : session &&
          status !== "expired" &&
          status !== "confirmed" &&
          !error ? (
          <img
            src={session.image}
            alt="哔哩哔哩登录二维码"
            width={220}
            height={220}
          />
        ) : (
          <QrCode size={64} />
        )}
      </div>
      <p className="qr-status" role="status">
        {message}
      </p>
      <ErrorNotice message={error} />
      <footer className="dialog-footer">
        {(error || status === "expired") && (
          <button
            className="button primary"
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw size={16} />
            重新获取二维码
          </button>
        )}
        <button className="button secondary" onClick={onClose}>
          关闭
        </button>
      </footer>
    </Modal>
  );
}
