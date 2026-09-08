import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  CheckCircle2,
  LoaderCircle,
  Video,
  X,
} from "lucide-react";

export function Spinner({ label = "加载中" }: { label?: string }) {
  return (
    <span className="loading" role="status">
      <LoaderCircle className="spin" size={18} />
      {label}
    </span>
  );
}
export function ErrorNotice({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return message ? (
    <div className="notice error" role="alert">
      <AlertCircle size={18} />
      <span>{message}</span>
      {retry && (
        <button className="text-link" onClick={retry}>
          重试
        </button>
      )}
    </div>
  ) : null;
}
export function SuccessNotice({ message }: { message: string }) {
  return message ? (
    <div className="notice success" role="status">
      <CheckCircle2 size={18} />
      <span>{message}</span>
    </div>
  ) : null;
}
export function IconButton({
  label,
  children,
  onClick,
  disabled = false,
  danger = false,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-button${danger ? " danger" : ""}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
export function Thumbnail({
  src,
  title,
  className = "",
}: {
  src: string | null;
  title: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  let valid = false;
  try {
    valid =
      !!src &&
      ["https:", "http:"].includes(
        new URL(src, window.location.origin).protocol,
      );
  } catch {
    /* Missing images use a neutral placeholder. */
  }
  return (
    <div className={`thumbnail ${className}`}>
      {valid && !failed ? (
        <img
          src={src!}
          alt={title}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <Video size={26} aria-label="暂无封面" />
      )}
    </div>
  );
}

// All overlays share one focus boundary. Portals keep the application inert, including on mobile.
export function Modal({
  title,
  children,
  onClose,
  busy = false,
  wide = false,
  className = "",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
  className?: string;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  closeRef.current = onClose;
  busyRef.current = busy;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = document.getElementById("root");
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () =>
      Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
        ) ?? [],
      ).filter(
        (element) =>
          !element.hidden &&
          !element.closest("[hidden]") &&
          element.getAttribute("aria-hidden") !== "true",
      );
    (
      dialog.current?.querySelector<HTMLElement>("[data-autofocus]") ??
      focusable()[0] ??
      dialog.current
    )?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busyRef.current) closeRef.current();
      }
      if (event.key === "Tab") {
        const elements = focusable(),
          first = elements[0],
          last = elements[elements.length - 1];
        if (!first) {
          event.preventDefault();
          dialog.current?.focus();
          return;
        }
        const inside = dialog.current?.contains(document.activeElement);
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === dialog.current ||
            !inside)
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || !inside)
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    function containFocus(event: FocusEvent) {
      if (!dialog.current?.contains(event.target as Node))
        (focusable()[0] ?? dialog.current)?.focus();
    }
    document.addEventListener("keydown", keydown);
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("focusin", containFocus);
      document.body.style.overflow = overflow;
      if (root) root.inert = wasInert;
      if (previous?.isConnected) previous.focus();
      else document.querySelector<HTMLElement>("#main")?.focus();
    };
  }, []);
  return createPortal(
    <div
      className={`overlay ${className === "nav-drawer" ? "drawer-overlay" : ""}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        className={`dialog ${wide ? "workflow-dialog" : ""} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialog}
        tabIndex={-1}
      >
        <header className={wide ? "workflow-heading" : "dialog-heading"}>
          <div>
            {wide && <div className="eyebrow">NEW DOWNLOAD</div>}
            <h2 id={titleId}>{title}</h2>
          </div>
          <IconButton label="关闭弹窗" onClick={onClose} disabled={busy}>
            <X size={20} />
          </IconButton>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}
export function EmptyState({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div>{icon}</div>
      <h3>{title}</h3>
      {children}
    </div>
  );
}
