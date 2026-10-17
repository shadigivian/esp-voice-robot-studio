"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  ArrowLeft,
  AudioLines,
  BookOpen,
  Bot,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  CloudUpload,
  Database,
  FileText,
  Globe2,
  Headphones,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Menu,
  MessageCircle,
  Mic,
  MicOff,
  Moon,
  Pencil,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Sun,
  Trash2,
  Users,
  Volume2,
  WandSparkles,
  Wifi,
  X,
  Zap,
} from "lucide-react";
import { translations, type Locale, type TranslationKey } from "../lib/i18n";
import DeviceSettingsView from "./device-settings";

import type {
  Bootstrap,
  Character,
  CharacterTemplate as Template,
  Device,
  Document as Doc,
  Role,
  Session,
  VerifiedFact as Fact,
} from "../lib/domain";
type ActionResult = { bootstrap?: Bootstrap; [key: string]: unknown };
export type AppContextType = {
  data: Bootstrap;
  locale: Locale;
  t: (key: TranslationKey) => string;
  l: (fa: string, en: string) => string;
  run: (
    action: string,
    payload?: Record<string, unknown>,
    message?: string,
  ) => Promise<ActionResult | null>;
  busy: string;
  refresh: () => Promise<void>;
  notify: (message: string, error?: boolean) => void;
};
const AppContext = createContext<AppContextType | null>(null);
function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error("Workspace context is missing");
  return value;
}
const emptyCharacter: Character = {
  name: "",
  description: "",
  icon: "✦",
  tone: "friendly",
  patience: "high",
  humor: "low",
  responseLength: "short",
  language: "fa",
  languages: ["fa"],
  voice: "",
  greeting: "",
  instructions: "",
};
const emptyRole: Role = {
  title: "",
  mission: "",
  tasks: [],
  restrictions: [],
  audience: "",
  unknownResponse: "اطلاعات تأییدشده‌ای برای پاسخ به این پرسش ندارم.",
  scope: "",
};
const cx = (...values: (string | false | undefined)[]) =>
  values.filter(Boolean).join(" ");
const isConfigured = (value: string) =>
  ["configured", "configured_not_tested", "demo"].includes(value);
let refreshingSession: Promise<boolean> | null = null;
async function authenticatedFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status !== 401) return response;
  if (!refreshingSession)
    refreshingSession = fetch("/api/auth", { method: "PUT" })
      .then((result) => result.ok)
      .catch(() => false)
      .finally(() => {
        refreshingSession = null;
      });
  const refreshed = await refreshingSession;
  return refreshed ? fetch(input, init) : response;
}
function date(value: string | null | undefined, locale: Locale, time = false) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : "en-US", {
    dateStyle: "medium",
    ...(time ? { timeStyle: "short" as const } : {}),
  }).format(d);
}

export function ControlPanel({ productName }: { productName?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [locale, setLocale] = useState<Locale>("fa");
  const [dark, setDark] = useState(false);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [menu, setMenu] = useState(false);
  const [mobile, setMobile] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuToggleRef = useRef<HTMLButtonElement>(null);
  const controlRevision = useRef(0);
  const refreshInFlight = useRef(false);
  const mutationInFlight = useRef(false);
  const [toast, setToast] = useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const t = useCallback(
    (key: TranslationKey) =>
      key === "product" && productName
        ? productName
        : translations[locale][key],
    [locale, productName],
  );
  const l = useCallback(
    (fa: string, en: string) => (locale === "fa" ? fa : en),
    [locale],
  );
  useEffect(() => {
    try {
      setLocale(
        localStorage.getItem("robot-panel-locale") === "en" ? "en" : "fa",
      );
      setDark(localStorage.getItem("robot-panel-theme") === "dark");
    } catch {
      /* Browser preferences are optional. */
    } finally {
      setPreferencesReady(true);
    }
  }, []);
  useEffect(() => {
    if (!preferencesReady) return;
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === "fa" ? "rtl" : "ltr";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    try {
      localStorage.setItem("robot-panel-locale", locale);
      localStorage.setItem("robot-panel-theme", dark ? "dark" : "light");
    } catch {
      /* Browser preferences are optional. */
    }
  }, [locale, dark, preferencesReady]);
  useEffect(() => {
    setMenu(false);
  }, [pathname]);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 800px)");
    const update = () => {
      setMobile(query.matches);
      if (!query.matches) setMenu(false);
    };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!menu || !mobile) return;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const items = () =>
      Array.from(
        sidebarRef.current?.querySelectorAll<HTMLElement>(
          "a[href], button:not([disabled])",
        ) || [],
      ).filter((element) => element.getClientRects().length > 0);
    items()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenu(false);
      }
      if (event.key !== "Tab") return;
      const list = items();
      const first = list[0],
        last = list.at(-1);
      if (!first || !last) return;
      if (
        !sidebarRef.current?.contains(document.activeElement) ||
        (!event.shiftKey && document.activeElement === last)
      ) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };
    const onNavigate = (event: MouseEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("#workspace-sidebar a[href]")
      )
        setMenu(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onNavigate, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onNavigate, true);
      document.body.style.overflow = oldOverflow;
      menuToggleRef.current?.focus({ preventScroll: true });
    };
  }, [menu, mobile]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(
        () => setToast(null),
        toast.error ? 10000 : 5000,
      );
      return () => clearTimeout(timer);
    }
  }, [toast]);
  const notify = useCallback(
    (message: string, isError = false) => setToast({ message, error: isError }),
    [],
  );
  const refresh = useCallback(async () => {
    if (refreshInFlight.current || mutationInFlight.current) return;
    refreshInFlight.current = true;
    const revision = controlRevision.current;
    setError("");
    try {
      const res = await authenticatedFetch("/api/control", {
        cache: "no-store",
      });
      const json = await res.json();
      if (revision !== controlRevision.current) return;
      if (res.status === 401) {
        setData(null);
        router.replace("/login");
        return;
      }
      if (!res.ok || json.error)
        throw new Error(
          json.error?.message || `Request failed (${res.status})`,
        );
      setData(json.data);
    } catch (err) {
      if (revision === controlRevision.current)
        setError(err instanceof Error ? err.message : "Connection failed");
    } finally {
      refreshInFlight.current = false;
      if (revision === controlRevision.current) setLoading(false);
    }
  }, [router]);
  useEffect(() => {
    if (pathname === "/login") {
      setLoading(false);
      return;
    }
    void refresh();
  }, [pathname, refresh]);
  const run = useCallback(
    async (
      action: string,
      payload: Record<string, unknown> = {},
      message?: string,
    ) => {
      if (mutationInFlight.current) return null;
      mutationInFlight.current = true;
      controlRevision.current += 1;
      setBusy(action);
      try {
        const res = await authenticatedFetch("/api/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ...payload }),
        });
        const json = await res.json();
        if (!res.ok || json.error)
          throw new Error(
            json.error?.message || `Request failed (${res.status})`,
          );
        const result = json.data as ActionResult;
        if (result.bootstrap) setData(result.bootstrap);
        if (message) notify(message);
        return result;
      } catch (err) {
        notify(err instanceof Error ? err.message : "Request failed", true);
        return null;
      } finally {
        mutationInFlight.current = false;
        setBusy("");
      }
    },
    [notify],
  );
  const preferences = (
    <div className="preferences">
      <button
        className="icon-button"
        onClick={() => setLocale(locale === "fa" ? "en" : "fa")}
        aria-label={l("تغییر زبان به انگلیسی", "Switch language to Persian")}
        title={l("English", "فارسی")}
      >
        <Globe2 size={18} />
        <span className="language-label">{locale === "fa" ? "EN" : "فا"}</span>
      </button>
      <button
        className="icon-button"
        onClick={() => setDark(!dark)}
        aria-label={dark ? t("light") : t("dark")}
      >
        {dark ? <Sun size={19} /> : <Moon size={19} />}
      </button>
    </div>
  );
  if (pathname === "/login")
    return (
      <>
        <Login
          locale={locale}
          t={t}
          l={l}
          preferences={preferences}
          onSuccess={() => {
            setLoading(true);
            router.replace("/dashboard");
          }}
        />
        {toast && <Toast {...toast} close={() => setToast(null)} />}
      </>
    );
  if (loading && !data)
    return (
      <div className="full-state">
        <Brand />
        <LoaderCircle className="spin" size={28} />
        <p>{t("loading")}</p>
      </div>
    );
  if (!data)
    return (
      <div className="full-state">
        <Brand />
        <div className="state-icon warning">
          <CloudUpload />
        </div>
        <h1>{t("setup")}</h1>
        <p>{error || t("loading")}</p>
        <div className="button-row">
          <button className="button primary" onClick={refresh}>
            <RefreshCw size={16} />
            {t("retry")}
          </button>
          <Link className="button secondary" href="/login">
            {t("login")}
          </Link>
        </div>
      </div>
    );
  const context: AppContextType = {
    data,
    locale,
    t,
    l,
    run,
    busy,
    refresh,
    notify,
  };
  const nav = [
    { href: "/dashboard", label: t("dashboard"), icon: LayoutDashboard },
    { href: "/devices", label: t("devices"), icon: Bot },
    { href: "/characters", label: t("characters"), icon: Users },
    { href: "/settings/integrations", label: t("settings"), icon: Settings2 },
  ];
  const segments = pathname.split("/").filter(Boolean);
  const device =
    segments[0] === "devices"
      ? data.devices.find((d) => d.id === segments[1])
      : undefined;
  const sectionTitle = device
    ? device.name
    : segments[0] === "characters"
      ? t("characters")
      : segments[0] === "devices"
        ? t("devices")
        : segments[0] === "settings"
          ? t("integrations")
          : t("dashboard");
  let content: ReactNode;
  if (segments[0] === "devices" && segments[1] === "new")
    content = <NewDevice />;
  else if (device)
    content = <DevicePage device={device} tab={segments[2] || "overview"} />;
  else if (segments[0] === "devices" && segments[1]) content = <Missing />;
  else if (segments[0] === "devices") content = <Devices />;
  else if (segments[0] === "characters" && segments[1])
    content = <CharacterEditor id={segments[1]} />;
  else if (segments[0] === "characters") content = <Characters />;
  else if (segments[0] === "settings") content = <Integrations />;
  else if (!segments.length || segments[0] === "dashboard")
    content = <Dashboard />;
  else content = <Missing />;
  return (
    <AppContext.Provider value={context}>
      <a className="skip-link" href="#main-content">
        {l("رفتن به محتوای اصلی", "Skip to main content")}
      </a>
      <div className="app-shell">
        {menu && (
          <button
            className="sidebar-backdrop"
            aria-label={t("close")}
            tabIndex={-1}
            onClick={() => setMenu(false)}
          />
        )}
        <aside
          id="workspace-sidebar"
          className={cx("sidebar", menu && "is-open")}
          ref={sidebarRef}
          inert={mobile && !menu ? true : undefined}
          aria-hidden={mobile && !menu ? true : undefined}
          role={mobile && menu ? "dialog" : undefined}
          aria-modal={mobile && menu ? true : undefined}
          aria-label={l("منوی اصلی", "Main navigation")}
        >
          <button
            className="icon-button sidebar-close"
            aria-label={l("بستن منو", "Close navigation")}
            onClick={() => setMenu(false)}
          >
            <X size={20} />
          </button>
          <Link href="/dashboard" className="brand-link">
            <Brand />
            <span className="brand-copy">
              <strong>{t("product")}</strong>
              <span>VOICE ROBOT STUDIO</span>
            </span>
          </Link>
          <div className="workspace-pill">
            <span className="workspace-avatar">
              {data.workspace.name.slice(0, 1)}
            </span>
            <div>
              <strong>{data.workspace.name || t("workspace")}</strong>
              <span>
                {data.user.role === "viewer"
                  ? l("دسترسی مشاهده", "View access")
                  : t("admin")}
              </span>
            </div>
            <ShieldCheck size={16} aria-hidden="true" />
          </div>
          <div className="nav-label">{t("workspace")}</div>
          <nav className="main-nav">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={
                  pathname.startsWith(
                    item.href.split("/").slice(0, 2).join("/"),
                  ) ||
                  (pathname === "/" && item.href === "/dashboard")
                    ? "page"
                    : undefined
                }
                className={cx(
                  "nav-item",
                  pathname.startsWith(
                    item.href.split("/").slice(0, 2).join("/"),
                  ) && "active",
                )}
              >
                <item.icon size={20} />
                <span>{item.label}</span>
                {item.href === "/devices" && (
                  <span className="nav-count">
                    {data.devices.length.toLocaleString(locale)}
                  </span>
                )}
              </Link>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="sidebar-tip">
              <div className="tip-icon">
                <ShieldCheck size={21} />
              </div>
              <strong>{t("helpTitle")}</strong>
              <p>{t("helpText")}</p>
              <Link href="/settings/integrations">
                {t("helpLink")}
                <ChevronLeft size={15} className="direction-arrow" />
              </Link>
            </div>
            <div className="account">
              <span className="account-avatar">
                {data.user.role === "viewer" ? "V" : "A"}
              </span>
              <div>
                <strong>
                  {data.user.role === "viewer"
                    ? l("مشاهده‌گر فضای کاری", "Workspace viewer")
                    : data.user.role === "owner"
                      ? l("مالک فضای کاری", "Workspace owner")
                      : l("مدیر فضای کاری", "Workspace admin")}
                </strong>
                <span>{data.user.role}</span>
              </div>
              <button
                className="icon-button"
                aria-label={t("logout")}
                title={t("logout")}
                onClick={async () => {
                  try {
                    const response = await fetch("/api/auth", {
                      method: "DELETE",
                    });
                    if (!response.ok) throw new Error("Sign out failed");
                    controlRevision.current += 1;
                    setData(null);
                    router.replace("/login");
                  } catch {
                    notify(
                      l(
                        "خروج انجام نشد؛ دوباره تلاش کنید.",
                        "Sign out failed. Please retry.",
                      ),
                      true,
                    );
                  }
                }}
              >
                <LogOut size={18} />
              </button>
            </div>
          </div>
        </aside>
        <div className="main-shell" inert={mobile && menu ? true : undefined}>
          <header className="topbar">
            <div className="breadcrumb">
              <button
                className="icon-button mobile-menu"
                aria-label={l("بازکردن منو", "Open navigation")}
                aria-expanded={menu}
                aria-controls="workspace-sidebar"
                ref={menuToggleRef}
                onClick={() => setMenu(!menu)}
              >
                <Menu size={22} />
              </button>
              <span className="breadcrumb-home">{t("workspace")}</span>
              <ChevronLeft className="direction-arrow" size={14} />
              <strong>{sectionTitle}</strong>
            </div>
            <div className="topbar-end">
              {data.demo && (
                <span className="badge demo">
                  <Sparkles size={12} />
                  {t("demo")}
                </span>
              )}
              <span className="today">
                {date(new Date().toISOString(), locale)}
              </span>
              {preferences}
              <span className="top-avatar">A</span>
            </div>
          </header>
          <main id="main-content" className="main-content" tabIndex={-1}>
            {data.demo && (
              <div className="demo-banner">
                <Sparkles size={15} />
                {t("demoNotice")}
              </div>
            )}
            {error && (
              <div className="inline-error" role="alert">
                {error}
                <button onClick={refresh}>{t("retry")}</button>
              </div>
            )}
            {content}
            <footer className="page-footer">
              <span>
                <AudioLines size={14} />
                {t("product")}
              </span>
              <span>
                <ShieldCheck size={13} />
                {t("security")}
              </span>
            </footer>
          </main>
        </div>
      </div>
      <nav
        className="mobile-bottom-nav"
        aria-label={l("ناوبری سریع", "Quick navigation")}
        inert={mobile && menu ? true : undefined}
      >
        {nav.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={
              pathname.startsWith(item.href.split("/").slice(0, 2).join("/"))
                ? "page"
                : undefined
            }
          >
            <item.icon size={21} aria-hidden="true" />
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>
      {toast && <Toast {...toast} close={() => setToast(null)} />}
    </AppContext.Provider>
  );
}

function Brand() {
  return (
    <span className="brand-icon">
      <AudioLines size={25} strokeWidth={1.8} />
    </span>
  );
}
function Toast({
  message,
  error,
  close,
}: {
  message: string;
  error: boolean;
  close: () => void;
}) {
  return (
    <div
      className={cx("toast", error && "toast-error")}
      role={error ? "alert" : "status"}
    >
      {error ? <CircleHelp size={19} /> : <CheckCheck size={19} />}
      <span>{message}</span>
      <button className="icon-button" onClick={close} aria-label="Close">
        <X size={16} />
      </button>
    </div>
  );
}
function Badge({ value, children }: { value: string; children?: ReactNode }) {
  const { t } = useApp();
  return (
    <span className={cx("badge", value)}>
      <span className="status-dot" />
      {children ||
        (value in translations.en ? t(value as TranslationKey) : value)}
    </span>
  );
}
function Panel({
  title,
  description,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("panel", className)}>
      {(title || action) && (
        <div className="panel-header">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
function PageHeading({
  title,
  description,
  action,
  eyebrow,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action}
    </div>
  );
}
function Empty({
  icon,
  title,
  description,
  action,
  small,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  small?: boolean;
}) {
  return (
    <div className={cx("empty-state", small && "small")}>
      <span className="empty-icon">{icon || <Bot size={27} />}</span>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("field", className)}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function Submit({
  children,
  action,
}: {
  children?: ReactNode;
  action?: string;
}) {
  const { busy, t } = useApp();
  return (
    <button className="button primary" type="submit" disabled={!!busy}>
      {busy && (!action || busy === action) ? (
        <LoaderCircle size={16} className="spin" />
      ) : (
        <Check size={16} />
      )}
      {busy && (!action || busy === action)
        ? t("saving")
        : children || t("save")}
    </button>
  );
}
function Modal({
  title,
  children,
  close,
  wide,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onClose = useRef(close);
  onClose.current = close;
  const { t } = useApp();
  useEffect(() => {
    const old = document.activeElement as HTMLElement;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose.current();
      if (event.key === "Tab") {
        const items = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]',
          ) || [],
        ).filter(
          (element) =>
            element.getClientRects().length > 0 &&
            element.getAttribute("aria-hidden") !== "true",
        );
        if (!items?.length) return;
        const first = items[0],
          last = items[items.length - 1];
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === ref.current)
        ) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      document.body.style.overflow = oldOverflow;
      if (old?.isConnected) old.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className={cx("modal", wide && "wide")}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          <button
            className="icon-button"
            onClick={close}
            aria-label={t("close")}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Login({
  locale: _locale,
  t,
  l,
  preferences,
  onSuccess,
}: {
  locale: Locale;
  t: AppContextType["t"];
  l: AppContextType["l"];
  preferences: ReactNode;
  onSuccess: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [meta, setMeta] = useState<{ demo?: boolean; configured?: boolean }>(
    {},
  );
  useEffect(() => {
    fetch("/api/auth")
      .then((r) => r.json())
      .then((v) => setMeta(v.data || {}))
      .catch(() => {
        /* The server may still be awaiting setup. */
      });
  }, []);
  async function login(event?: FormEvent<HTMLFormElement>, demo = false) {
    event?.preventDefault();
    setBusy(true);
    setError("");
    const form = event ? new FormData(event.currentTarget) : null;
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          demo
            ? { demo: true }
            : { email: form?.get("email"), password: form?.get("password") },
        ),
      });
      const json = await res.json();
      if (!res.ok || json.error)
        throw new Error(json.error?.message || "Sign in failed");
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <div className="login-prefs">{preferences}</div>
      <section className="login-story">
        <Link href="/login" className="brand-link">
          <Brand />
          <strong>{t("product")}</strong>
        </Link>
        <div className="login-story-content">
          <span className="eyebrow">
            <span className="status-dot" />
            {t("security")}
          </span>
          <h1>{t("loginSubtitle")}</h1>
          <p>{t("loginCopy")}</p>
          <div className="orbital">
            <div className="orbit orbit-one" />
            <div className="orbit orbit-two" />
            <div className="orbit-center">
              <AudioLines size={68} strokeWidth={1.2} />
            </div>
            <span className="orbit-tag tag-role">
              <WandSparkles size={18} />
              {t("role")}
            </span>
            <span className="orbit-tag tag-character">
              <Sparkles size={18} />
              {t("character")}
            </span>
            <span className="orbit-tag tag-knowledge">
              <BookOpen size={18} />
              {t("knowledge")}
            </span>
          </div>
        </div>
        <span className="login-copyright">
          VOICE ROBOT STUDIO · {new Date().getFullYear()}
        </span>
      </section>
      <section className="login-form-area">
        <div className="login-form-card">
          <span className="eyebrow">
            {l("به فضای خودتان خوش آمدید", "YOUR ROBOTS, YOUR WORKSPACE")}
          </span>
          <h2>{t("login")}</h2>
          <p>
            {l(
              "برای مدیریت دستگاه‌ها و شخصیت‌ها وارد شوید.",
              "Sign in to manage your devices and characters.",
            )}
          </p>
          <form onSubmit={(event) => void login(event)}>
            <Field label={t("email")}>
              <input
                name="email"
                type="email"
                placeholder="you@example.com"
                autoComplete="email"
                required
                dir="ltr"
              />
            </Field>
            <Field label={t("password")}>
              <input
                name="password"
                type="password"
                minLength={8}
                autoComplete="current-password"
                required
                dir="ltr"
              />
            </Field>
            {error && (
              <div className="inline-error" role="alert">
                {error}
              </div>
            )}
            <button className="button primary full-width" disabled={busy}>
              {busy ? (
                <LoaderCircle size={17} className="spin" />
              ) : (
                <ArrowLeft size={17} className="direction-arrow" />
              )}
              {t("signIn")}
            </button>
          </form>
          {meta.demo && (
            <>
              <div className="form-divider">
                <span>
                  {l("یا محیط را کشف کنید", "or explore the workspace")}
                </span>
              </div>
              <button
                className="button secondary full-width"
                disabled={busy}
                onClick={() => void login(undefined, true)}
              >
                <Sparkles size={17} />
                {t("demoLogin")}
              </button>
              <p className="fine-print">{t("demoNotice")}</p>
            </>
          )}
          {meta.configured === false && !meta.demo && (
            <div className="notice warning">
              <Settings2 size={18} />
              <div>
                <strong>{t("setup")}</strong>
                <p>
                  {l(
                    "احراز هویت و دیتابیس را در تنظیمات سرور آماده کنید. راهنما: docs/setup.md",
                    "Configure server authentication and database first. See docs/setup.md.",
                  )}
                </p>
              </div>
            </div>
          )}
          <div className="login-security">
            <ShieldCheck size={15} />
            {t("secureLogin")}
          </div>
        </div>
      </section>
    </div>
  );
}

function Dashboard() {
  const { data, t, l, locale } = useApp();
  const paired = data.devices.some((d) => d.provisioning === "paired");
  const published = data.devices.some((d) => d.published);
  const hasKnowledge = data.devices.some((d) =>
    d.documents.some((doc) => doc.active && doc.status !== "deleted"),
  );
  const cards = [
    {
      label: t("devices"),
      value: data.stats.totalDevices,
      detail: t("registered"),
      icon: Bot,
      color: "teal",
    },
    {
      label: t("online"),
      value: data.stats.online,
      detail: l("بر اساس heartbeat معتبر", "Based on verified heartbeats"),
      icon: Radio,
      color: "blue",
    },
    {
      label: t("sessions"),
      value: data.stats.sessions,
      detail: l("جلسات واقعی و آزمایشی", "Live and test sessions"),
      icon: MessageCircle,
      color: "purple",
    },
    {
      label: t("sources"),
      value: data.stats.activeSources,
      detail: l("آماده و منتشرشده", "Ready and explicitly published"),
      icon: BookOpen,
      color: "amber",
    },
  ];
  const steps = [
    {
      title: l("ثبت دستگاه", "Register your device"),
      text: l("نام و MAC ایستگاه Wi-Fi", "Name and Wi-Fi Station MAC"),
      done: data.devices.length > 0,
    },
    {
      title: t("ownership"),
      text: l("کد یک‌بارمصرف روی OLED", "One-time code from the OLED"),
      done: paired,
    },
    {
      title: l("شغل و شخصیت", "Define role & character"),
      text: l("یک هدف روشن برای ربات", "Give your robot a clear purpose"),
      done: published,
    },
    {
      title: l("دانش و انتشار", "Add knowledge & publish"),
      text: l(
        "منابع تأییدشده و آزمایش پاسخ",
        "Approved sources and a tested response",
      ),
      done: hasKnowledge,
    },
  ];
  return (
    <>
      <PageHeading
        title={t("dashboard")}
        description={t("welcomeSub")}
        action={
          <Link href="/devices/new" className="button primary">
            <Plus size={18} />
            {t("newDevice")}
          </Link>
        }
      />
      <section className="welcome-card">
        <div className="welcome-text">
          <span className="eyebrow">
            <span className="status-dot" />
            {t("hello")}
          </span>
          <h2>{t("welcome")}</h2>
          <p>
            {l(
              "ربات‌های شما، هر کدام با داستان و دانشی متفاوت. همه‌چیز از اینجا در دسترس است.",
              "Your robots, each with their own story and knowledge. Everything you need is right here.",
            )}
          </p>
          <Link
            href={data.devices.length ? "/devices" : "/devices/new"}
            className="welcome-link"
          >
            {data.devices.length ? t("devices") : t("start")}
            <ArrowLeft size={16} className="direction-arrow" />
          </Link>
        </div>
        <div className="welcome-art" aria-hidden="true">
          <div className="art-orbit" />
          <div className="robot-illustration">
            <span className="antenna" />
            <div className="robot-eyes">
              <span />
              <span />
            </div>
            <div className="robot-wave">
              <i />
              <i />
              <i />
              <i />
              <i />
            </div>
          </div>
          <span className="art-dot one" />
          <span className="art-dot two" />
          <span className="art-spark">✧</span>
          <span className="art-chip">
            <ShieldCheck size={16} />
            {t("security")}
          </span>
        </div>
      </section>
      <div className="stats-grid">
        {cards.map((item) => (
          <div className="stat-card" key={item.label}>
            <div className="stat-top">
              <span>{item.label}</span>
              <span className={cx("stat-icon", item.color)}>
                <item.icon size={20} />
              </span>
            </div>
            <strong className="stat-value">
              {typeof item.value === "number"
                ? item.value.toLocaleString(locale)
                : "—"}
            </strong>
            <p>{item.detail}</p>
          </div>
        ))}
      </div>
      <div className="dashboard-grid">
        <div className="stack">
          <Panel
            title={t("devices")}
            description={l(
              "نمایی سریع از ربات‌های فضای کاری",
              "A quick look at your workspace robots",
            )}
            action={
              <Link className="text-link" href="/devices">
                {l("مشاهده همه", "View all")}
                <ChevronLeft className="direction-arrow" size={15} />
              </Link>
            }
          >
            {data.devices.length ? (
              <div className="device-summary-list">
                {data.devices.slice(0, 4).map((device) => (
                  <DeviceSummary key={device.id} device={device} />
                ))}
              </div>
            ) : (
              <Empty
                title={t("noDevices")}
                description={t("noDevicesSub")}
                action={
                  <Link className="button secondary" href="/devices/new">
                    <Plus size={16} />
                    {t("newDevice")}
                  </Link>
                }
              />
            )}
          </Panel>
          <Panel
            title={t("usage")}
            action={
              <span className="subtle-tag">
                {l("داده معتبر سرویس", "Verified provider data")}
              </span>
            }
          >
            <div className="usage-empty">
              <div className="usage-lines">
                <span />
                <span />
                <span />
                <span />
              </div>
              <div>
                <Activity size={25} />
                <strong>
                  {data.stats.usage == null
                    ? t("unavailable")
                    : l("مصرف ثبت شده است", "Usage recorded")}
                </strong>
                <p>{t("recordedUsage")}</p>
                {data.stats.usage && (
                  <dl className="measured-usage">
                    {Object.entries(data.stats.usage).map(([key, value]) => (
                      <div key={key}>
                        <dt dir="ltr">{key.replaceAll("_", " ")}</dt>
                        <dd>{value.toLocaleString(locale)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            </div>
          </Panel>
        </div>
        <div className="stack">
          <Panel
            title={l("مسیر راه‌اندازی شما", "Your setup journey")}
            description={l(
              "چهار قدم تا اولین مکالمه",
              "Four steps to your first conversation",
            )}
            className="onboarding-panel"
          >
            <div className="setup-progress">
              <span
                style={{ width: `${steps.filter((s) => s.done).length * 25}%` }}
              />
            </div>
            <div className="setup-steps">
              {steps.map((step, index) => (
                <div
                  className={cx("setup-step", step.done && "done")}
                  key={step.title}
                >
                  <span className="step-number">
                    {step.done ? (
                      <Check size={15} />
                    ) : (
                      (index + 1).toLocaleString(locale)
                    )}
                  </span>
                  <div>
                    <strong>{step.title}</strong>
                    <p>{step.text}</p>
                  </div>
                  {step.done && (
                    <span className="step-check">
                      <CheckCheck size={16} />
                    </span>
                  )}
                </div>
              ))}
            </div>
            <Link
              className="button secondary full-width"
              href={
                data.devices[0]
                  ? `/devices/${data.devices[0].id}/overview`
                  : "/devices/new"
              }
            >
              {t("next")}
              <ArrowLeft size={15} className="direction-arrow" />
            </Link>
          </Panel>
          <Panel title={t("install")}>
            <div className="integration-mini">
              {[
                {
                  label: l("دیتابیس و احراز هویت", "Database & authentication"),
                  ok:
                    isConfigured(data.integrations.database) &&
                    isConfigured(data.integrations.auth),
                },
                {
                  label: l("هوش مصنوعی", "AI provider"),
                  ok: isConfigured(data.integrations.openai),
                },
                {
                  label: l("سرور صوتی", "Voice server"),
                  ok: isConfigured(data.integrations.voiceServer),
                },
              ].map((item) => (
                <div key={item.label}>
                  <span className={cx("integration-dot", item.ok && "ok")} />
                  <span>{item.label}</span>
                  <span className={cx("small-status", item.ok && "ok")}>
                    {item.ok ? t("configured") : t("setup")}
                  </span>
                </div>
              ))}
            </div>
            <Link
              className="text-link setup-link"
              href="/settings/integrations"
            >
              {t("integrations")}
              <ChevronLeft className="direction-arrow" size={15} />
            </Link>
          </Panel>
        </div>
      </div>
      <Panel title={t("audit")} action={<Clock3 size={18} className="muted" />}>
        {data.audit.length ? (
          <div className="audit-list">
            {data.audit.slice(0, 5).map((event, index) => (
              <div key={event.id || index}>
                <span className="audit-icon">
                  <Check size={15} />
                </span>
                <span>{event.action.replaceAll("_", " ")}</span>
                <time>{date(event.at, locale, true)}</time>
              </div>
            ))}
          </div>
        ) : (
          <div className="quiet-empty">
            <Clock3 size={19} />
            {t("noAudit")}
          </div>
        )}
      </Panel>
    </>
  );
}

function RobotAvatar({ device, large }: { device: Device; large?: boolean }) {
  const icon = device.draft?.character?.icon;
  return (
    <span className={cx("robot-avatar", large && "large")}>
      {icon && icon !== "✦" ? icon : <Bot size={large ? 29 : 22} />}
    </span>
  );
}
function DeviceSummary({ device }: { device: Device }) {
  const { t, l, locale } = useApp();
  return (
    <Link href={`/devices/${device.id}/overview`} className="device-summary">
      <RobotAvatar device={device} />
      <div className="device-summary-name">
        <strong>{device.name}</strong>
        <span>
          {device.published?.role.title ||
            device.draft?.role.title ||
            l("شغل تعیین نشده", "No role assigned")}
        </span>
      </div>
      <Badge value={device.connectivity} />
      <div className="summary-source">
        <BookOpen size={14} />
        {device.documents
          .filter((doc) => doc.active && doc.status !== "deleted")
          .length.toLocaleString(locale)}
        <span>{t("sourceCount")}</span>
      </div>
      <ChevronLeft className="direction-arrow" size={17} />
    </Link>
  );
}

function Devices() {
  const { data, t, l, locale } = useApp();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const devices = data.devices.filter(
    (d) =>
      (d.name + " " + d.mac).toLowerCase().includes(search.toLowerCase()) &&
      (filter === "all" || d.connectivity === filter),
  );
  return (
    <>
      <PageHeading
        title={t("devices")}
        description={l(
          "هر دستگاه، یک نقش و یک دنیای مستقل",
          "Each device has its own purpose and private world",
        )}
        action={
          <Link className="button primary" href="/devices/new">
            <Plus size={18} />
            {t("newDevice")}
          </Link>
        }
      />
      <div className="list-toolbar">
        <div className="search-field">
          <Search size={18} />
          <input
            aria-label={t("search")}
            placeholder={t("search")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="filter-group">
          {["all", "online", "offline", "unknown"].map((value) => (
            <button
              key={value}
              onClick={() => setFilter(value)}
              className={cx("filter-button", filter === value && "selected")}
            >
              {t(value as TranslationKey)}
            </button>
          ))}
        </div>
        <span className="result-count">
          {devices.length.toLocaleString(locale)} {l("دستگاه", "devices")}
        </span>
      </div>
      {devices.length ? (
        <div className="devices-grid">
          {devices.map((d) => (
            <Link
              href={`/devices/${d.id}/overview`}
              className="device-card"
              key={d.id}
            >
              <div className="device-card-top">
                <RobotAvatar device={d} large />
                <Badge value={d.connectivity} />
              </div>
              <h2>{d.name}</h2>
              <p className="device-role">
                {d.published?.role.title ||
                  d.draft.role.title ||
                  l("شغل تعیین نشده", "No role assigned")}
              </p>
              <code className="mac" dir="ltr">
                {d.mac}
              </code>
              <div className="device-card-details">
                <div>
                  <Sparkles size={15} />
                  <span>
                    {d.published?.character.name ||
                      d.draft.character.name ||
                      l("بدون شخصیت", "No character")}
                  </span>
                </div>
                <div>
                  <BookOpen size={15} />
                  <span>
                    {d.documents
                      .filter((doc) => doc.active && doc.status !== "deleted")
                      .length.toLocaleString(locale)}{" "}
                    {t("activeSources")}
                  </span>
                </div>
                <div>
                  <Clock3 size={15} />
                  <span>
                    {d.lastSeen ? date(d.lastSeen, locale, true) : t("never")}
                  </span>
                </div>
              </div>
              <div className="device-card-bottom">
                <Badge value={d.provisioning} />
                <span>
                  {t("details")}
                  <ArrowLeft className="direction-arrow" size={15} />
                </span>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <Panel>
          <Empty
            title={
              search || filter !== "all"
                ? l("دستگاهی با این مشخصات پیدا نشد", "No matching devices")
                : t("noDevices")
            }
            description={t("noDevicesSub")}
            action={
              <Link className="button primary" href="/devices/new">
                <Plus size={17} />
                {t("newDevice")}
              </Link>
            }
          />
        </Panel>
      )}
    </>
  );
}

function NewDevice() {
  const { t, l, run, locale } = useApp();
  const router = useRouter();
  const [mac, setMac] = useState("");
  const [validation, setValidation] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const normalized = mac.trim().replace(/[:-]/g, "").toUpperCase();
    if (!/^[0-9A-F]{12}$/.test(normalized)) {
      setValidation(
        l(
          "MAC باید شامل ۱۲ رقم هگزادسیمال باشد.",
          "Enter a valid 12-digit hexadecimal MAC.",
        ),
      );
      return;
    }
    const result = await run("create_device", {
      name: form.get("name"),
      mac: normalized.match(/.{2}/g)?.join(":"),
    });
    if (result) {
      const created = result.device as Device | undefined;
      const id =
        created?.id ||
        (result.deviceId as string | undefined) ||
        result.bootstrap?.devices.find(
          (d) => d.mac.replaceAll(":", "") === normalized,
        )?.id;
      router.push(id ? `/devices/${id}/overview` : "/devices");
    }
  }
  return (
    <>
      <PageHeading
        title={t("newDevice")}
        description={l(
          "اول دستگاه را ثبت کنید؛ مالکیت با کد روی OLED تأیید می‌شود.",
          "Register first. Verify ownership using the code shown on the device OLED.",
        )}
      />
      <div className="wizard-progress">
        {[
          l("ثبت دستگاه", "Register"),
          t("ownership"),
          t("role"),
          t("character"),
          t("knowledge"),
          t("playground"),
          t("publish"),
        ].map((step, index) => (
          <div key={step} className={index === 0 ? "current" : ""}>
            <span>{(index + 1).toLocaleString(locale)}</span>
            {step}
          </div>
        ))}
      </div>
      <div className="form-aside-grid">
        <Panel title={l("با ربات جدیدتان آشنا شویم", "Meet your new robot")}>
          <form className="padded-form" onSubmit={submit}>
            <Field
              label={l("نام دستگاه", "Device name")}
              hint={l(
                "نامی روشن برای تشخیص این ربات در فضای کاری",
                "A clear name to identify this robot in your workspace",
              )}
            >
              <input
                name="name"
                placeholder={l("مثلاً: راهنمای کتابخانه", "e.g. Library guide")}
                required
                maxLength={80}
              />
            </Field>
            <Field
              label={l("آدرس MAC ایستگاه Wi-Fi", "Wi-Fi Station MAC address")}
              hint={l(
                "از Firmware یا خروجی سریال دستگاه دریافت کنید. MAC یک شناسه است، نه رمز عبور.",
                "Read it from firmware or serial output. A MAC identifies a device; it is not a password.",
              )}
            >
              <input
                value={mac}
                onChange={(e) => {
                  setMac(e.target.value);
                  setValidation("");
                }}
                name="mac"
                placeholder="AA:BB:CC:DD:EE:FF"
                dir="ltr"
                className="mono"
                required
                autoComplete="off"
                maxLength={17}
                aria-invalid={!!validation}
              />
            </Field>
            {validation && (
              <div className="inline-error" role="alert">
                {validation}
              </div>
            )}
            <div className="form-actions">
              <Submit>
                {l("ثبت و تأیید اتصال", "Register & verify connection")}
              </Submit>
              <Link href="/devices" className="button ghost">
                {t("cancel")}
              </Link>
            </div>
          </form>
        </Panel>
        <div className="guide-card">
          <span className="guide-icon">
            <ShieldCheck size={28} />
          </span>
          <h3>{l("مالکیت، فراتر از یک MAC", "Ownership beyond a MAC")}</h3>
          <p>
            {l(
              "دستگاه باید با هویت امن خود به سرور متصل شود. سپس کد یک‌بارمصرف روی OLED را در پنل وارد می‌کنید.",
              "Your device connects to the server using its secure identity. Then enter its one-time OLED code here.",
            )}
          </p>
          <ul>
            <li>
              {l("کد ۵ دقیقه اعتبار دارد", "The code expires after 5 minutes")}
            </li>
            <li>
              {l("حداکثر ۵ تلاش برای تأیید", "Up to 5 verification attempts")}
            </li>
            <li>
              {l(
                "ثبت دستگاه به معنی آنلاین‌بودن نیست",
                "Registration does not imply connectivity",
              )}
            </li>
          </ul>
          <div className="notice">
            <CircleHelp size={18} />
            <p>
              {l(
                "برای اتصال واقعی، تنظیمات provisioning و Firmware را طبق docs/device-protocol.md آماده کنید.",
                "For a real connection, configure provisioning and firmware as described in docs/device-protocol.md.",
              )}
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

function DevicePage({ device, tab }: { device: Device; tab: string }) {
  const { t, l, data } = useApp();
  const [publish, setPublish] = useState(false);
  const tabsRef = useRef<HTMLElement>(null);
  useEffect(() => {
    tabsRef.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: "auto",
      });
  }, [tab, device.id]);
  const tabs: { id: string; key: TranslationKey; icon: typeof Bot }[] = [
    { id: "overview", key: "overview", icon: LayoutDashboard },
    { id: "role", key: "role", icon: WandSparkles },
    { id: "character", key: "character", icon: Sparkles },
    { id: "knowledge", key: "knowledge", icon: BookOpen },
    { id: "playground", key: "playground", icon: Headphones },
    { id: "conversations", key: "conversations", icon: MessageCircle },
    { id: "settings", key: "deviceSettings", icon: SlidersHorizontal },
  ];
  return (
    <>
      <div className="device-breadcrumb">
        <Link href="/devices">{t("devices")}</Link>
        <ChevronLeft className="direction-arrow" size={14} />
        <span>{device.name}</span>
      </div>
      <div className="device-heading">
        <RobotAvatar device={device} large />
        <div>
          <div className="device-title-row">
            <h1>{device.name}</h1>
            <Badge value={device.connectivity} />
          </div>
          <span className="device-heading-meta">
            <code dir="ltr">{device.mac}</code>
            <span>·</span>
            {device.published?.role.title ||
              device.draft.role.title ||
              l("شغل تعیین نشده", "No role assigned")}
          </span>
        </div>
        <button
          className="button primary"
          disabled={data.user.role === "viewer"}
          onClick={() => setPublish(true)}
        >
          <CloudUpload size={17} />
          {t("publish")}
        </button>
      </div>
      <div className="device-edit-banner">
        <ShieldCheck size={17} />
        <span>
          {t("editWarning")} <strong>«{device.name}»</strong> {l("هستید", "")}.
        </span>
        <span className="subtle-tag">
          {t("draft")} → {t("published")}
        </span>
      </div>
      <nav
        className="device-tabs"
        ref={tabsRef}
        aria-label={l("بخش‌های دستگاه", "Device sections")}
      >
        {tabs.map((item) => (
          <Link
            className={cx("device-tab", tab === item.id && "active")}
            href={`/devices/${device.id}/${item.id}`}
            key={item.id}
            aria-current={tab === item.id ? "page" : undefined}
          >
            <item.icon size={17} />
            {t(item.key)}
            {item.id === "knowledge" && (
              <span>
                {device.documents.filter((d) => d.status !== "deleted").length}
              </span>
            )}
          </Link>
        ))}
      </nav>
      {tab === "overview" ? (
        <DeviceOverview device={device} />
      ) : tab === "role" ? (
        <RoleEditor device={device} />
      ) : tab === "character" ? (
        <DeviceCharacter device={device} />
      ) : tab === "knowledge" ? (
        <Knowledge device={device} />
      ) : tab === "playground" ? (
        <Playground device={device} />
      ) : tab === "conversations" ? (
        <Conversations device={device} />
      ) : tab === "settings" ? (
        <DeviceSettings device={device} />
      ) : (
        <Missing />
      )}
      {publish && (
        <PublishDialog device={device} close={() => setPublish(false)} />
      )}
    </>
  );
}

function DeviceOverview({ device }: { device: Device }) {
  const { t, l, run, busy, locale } = useApp();
  const [code, setCode] = useState("");
  const [rollback, setRollback] = useState<number | null>(null);
  return (
    <>
      <div className="device-status-grid">
        {[
          {
            label: l("وضعیت مالکیت", "Provisioning"),
            value: device.provisioning,
            icon: ShieldCheck,
          },
          { label: t("connection"), value: device.connectivity, icon: Wifi },
          {
            label: l("وضعیت مکالمه", "Conversation state"),
            value: device.conversation,
            icon: AudioLines,
          },
        ].map((item) => (
          <Panel key={item.label}>
            <div className="status-card">
              <span className="stat-icon teal">
                <item.icon size={20} />
              </span>
              <div>
                <span>{item.label}</span>
                <Badge value={item.value} />
              </div>
            </div>
          </Panel>
        ))}
      </div>
      <div className="form-aside-grid">
        <div className="stack">
          {device.provisioning === "pending" && (
            <Panel
              title={t("ownership")}
              description={l(
                "کد امن نمایش‌داده‌شده روی OLED همین دستگاه را وارد کنید.",
                "Enter the secure code shown on this device’s OLED.",
              )}
            >
              <form
                className="padded-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (
                    await run(
                      "verify_claim",
                      { deviceId: device.id, code },
                      t("success"),
                    )
                  )
                    setCode("");
                }}
              >
                <Field
                  label={l("کد یک‌بارمصرف دستگاه", "One-time device code")}
                  hint={
                    device.claim
                      ? `${l("انقضا", "Expires")}: ${date(device.claim.expiresAt, locale, true)} · ${l("تعداد تلاش", "Attempts")}: ${device.claim.attempts}/5`
                      : l(
                          "دستگاه باید ابتدا با هویت bootstrap خود به سرور متصل شود.",
                          "The device must first connect using its bootstrap identity.",
                        )
                  }
                >
                  <input
                    className="pairing-input mono"
                    dir="ltr"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="• • • • • •"
                    autoComplete="one-time-code"
                    required
                    minLength={4}
                    maxLength={12}
                  />
                </Field>
                <Submit>
                  {l("تأیید مالکیت دستگاه", "Verify device ownership")}
                </Submit>
              </form>
            </Panel>
          )}
          <Panel
            title={t("liveConfig")}
            action={
              <span className="subtle-tag">
                {t("version")} {device.configVersion}
              </span>
            }
          >
            <div className="config-summary">
              <div>
                <span>{t("role")}</span>
                <strong>{device.published?.role.title || "—"}</strong>
                <Link href={`/devices/${device.id}/role`}>
                  {t("edit")}
                  <Pencil size={13} />
                </Link>
              </div>
              <div>
                <span>{t("character")}</span>
                <strong>{device.published?.character.name || "—"}</strong>
                <Link href={`/devices/${device.id}/character`}>
                  {t("edit")}
                  <Pencil size={13} />
                </Link>
              </div>
              <div>
                <span>{t("sources")}</span>
                <strong>
                  {(
                    device.published?.activeSourceIds.length ?? 0
                  ).toLocaleString(locale)}
                </strong>
                <Link href={`/devices/${device.id}/knowledge`}>
                  {t("details")}
                  <ChevronLeft className="direction-arrow" size={13} />
                </Link>
              </div>
              <div>
                <span>{t("lastSeen")}</span>
                <strong>
                  {device.lastSeen
                    ? date(device.lastSeen, locale, true)
                    : t("never")}
                </strong>
              </div>
            </div>
            {!device.published && (
              <div className="notice inline">
                <CircleHelp size={17} />
                <p>
                  {l(
                    "هنوز نسخه‌ای منتشر نشده است. شغل و شخصیت را تنظیم و سپس پیش‌نویس را منتشر کنید.",
                    "No configuration has been published. Set up a role and character, then publish your draft.",
                  )}
                </p>
              </div>
            )}
          </Panel>
          <Panel title={t("history")}>
            {device.history.length ? (
              <div className="history-list">
                {device.history.map((item, index) => (
                  <div key={item.version ?? index}>
                    <span className="history-version">v{item.version}</span>
                    <div>
                      <strong>
                        {t("version")} {item.version}
                      </strong>
                      <small>{date(item.createdAt, locale, true)}</small>
                    </div>
                    {item.version === device.configVersion ? (
                      <Badge value="active" />
                    ) : (
                      <button
                        className="button ghost small"
                        onClick={() => setRollback(item.version)}
                      >
                        {l("بازگردانی", "Restore")}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="quiet-empty">{t("empty")}</div>
            )}
          </Panel>
        </div>
        <div className="stack">
          <Panel title={l("همگام‌سازی دستگاه", "Device synchronization")}>
            <div className="sync-versions">
              <div>
                <span>{t("desired")}</span>
                <strong>v{device.configVersion}</strong>
              </div>
              <ArrowLeft className="direction-arrow" size={22} />
              <div>
                <span>{t("applied")}</span>
                <strong>
                  {device.appliedVersion === null
                    ? "—"
                    : `v${device.appliedVersion}`}
                </strong>
              </div>
            </div>
            <p className="panel-note">
              {l(
                "ذخیره یا انتشار به معنی اعمال روی دستگاه نیست. دریافت نسخه با ACK دستگاه تأیید می‌شود.",
                "Saving or publishing does not imply application. The device confirms receipt with an ACK.",
              )}
            </p>
          </Panel>
          <div className="guide-card compact">
            <Headphones size={28} />
            <h3>
              {l("قبل از انتشار، گفت‌وگو کنید", "Try a conversation first")}
            </h3>
            <p>
              {l(
                "پیش‌نویس را بدون تغییر ربات زنده در محیط آزمایش بررسی کنید.",
                "Preview your draft in the playground without changing the live robot.",
              )}
            </p>
            <Link
              className="button secondary full-width"
              href={`/devices/${device.id}/playground`}
            >
              <Play size={15} />
              {t("playground")}
            </Link>
          </div>
        </div>
      </div>
      {rollback !== null && (
        <Modal
          title={l("بازگردانی نسخه", "Restore configuration")}
          close={() => setRollback(null)}
        >
          <p className="modal-copy">
            {l(
              `نسخه ${rollback} به‌عنوان نسخه جدید منتشر می‌شود. منابع لغوشده دوباره فعال نمی‌شوند.`,
              `Version ${rollback} will be published as a new version. Revoked sources remain inaccessible.`,
            )}
          </p>
          <div className="form-actions">
            <button
              className="button primary"
              disabled={!!busy}
              onClick={async () => {
                if (
                  await run(
                    "rollback",
                    { deviceId: device.id, version: rollback },
                    t("publishedSuccess"),
                  )
                )
                  setRollback(null);
              }}
            >
              {l("بازگردانی", "Restore")}
            </button>
            <button
              className="button secondary"
              onClick={() => setRollback(null)}
            >
              {t("cancel")}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function RoleEditor({ device }: { device: Device }) {
  const { t, l, run } = useApp();
  const [role, setRole] = useState<Role>(device.draft.role || emptyRole);
  const [mode, setMode] = useState(device.draft.knowledgeMode);
  const [retain, setRetain] = useState(false);
  const changedRole =
    role.title !== device.draft.role.title &&
    device.draft.activeSourceIds.length > 0;
  useEffect(() => {
    setRole(device.draft.role);
    setMode(device.draft.knowledgeMode);
  }, [device.id, device.draft]);
  const presets = [
    {
      title: l("راهنمای رستوران", "Restaurant guide"),
      mission: l(
        "راهنمایی مهمانان بر اساس اطلاعات تأییدشده رستوران؛ بدون ثبت سفارش یا پرداخت.",
        "Help guests using verified restaurant information. No ordering or payment tools.",
      ),
      icon: "◌",
    },
    {
      title: l("معلم", "Teacher"),
      mission: l(
        "توضیح مفاهیم آموزشی متناسب با مخاطب و سنجش فهم با پرسش‌های کوتاه.",
        "Explain educational concepts for the audience and check understanding with short questions.",
      ),
      icon: "✦",
    },
    {
      title: l("راهنمای فروشگاه", "Store assistant"),
      mission: l(
        "راهنمایی مشتریان بر اساس مشخصات و قیمت‌های تأییدشده؛ بدون ثبت فروش.",
        "Guide customers using verified specifications and prices. No sale execution.",
      ),
      icon: "◇",
    },
    {
      title: l("پذیرش", "Receptionist"),
      mission: l(
        "خوشامدگویی و راهنمایی مراجعه‌کنندگان با اطلاعات تأییدشده محل.",
        "Welcome and guide visitors with verified location information.",
      ),
      icon: "⌘",
    },
    { title: l("شغل سفارشی", "Custom role"), mission: "", icon: "+" },
  ];
  const update = (key: keyof Role, value: string | string[]) =>
    setRole((prev) => ({ ...prev, [key]: value }));
  return (
    <>
      <div className="section-intro">
        <h2>{t("role")}</h2>
        <p>{t("roleDescription")}</p>
      </div>
      <div className="role-presets">
        {presets.map((preset) => (
          <button
            className={cx(
              "role-preset",
              role.title === preset.title && "selected",
            )}
            key={preset.title}
            onClick={() => {
              setRole({
                ...emptyRole,
                title: preset.title,
                mission: preset.mission,
              });
              setRetain(false);
            }}
          >
            <span>{preset.icon}</span>
            {preset.title}
          </button>
        ))}
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await run(
            "save_draft",
            {
              deviceId: device.id,
              retainKnowledge: retain,
              config: {
                ...device.draft,
                role,
                knowledgeMode: mode,
                activeSourceIds:
                  changedRole && !retain ? [] : device.draft.activeSourceIds,
              },
            },
            t("saved"),
          );
        }}
      >
        <Panel>
          <div className="padded-form form-grid">
            <Field label={l("عنوان شغل", "Role title")}>
              <input
                value={role.title}
                onChange={(e) => update("title", e.target.value)}
                required
                maxLength={100}
              />
            </Field>
            <Field label={l("مخاطب", "Audience")}>
              <input
                value={role.audience}
                onChange={(e) => update("audience", e.target.value)}
                maxLength={200}
              />
            </Field>
            <Field
              className="span-two"
              label={l("مأموریت و هدف", "Mission & purpose")}
            >
              <textarea
                value={role.mission}
                onChange={(e) => update("mission", e.target.value)}
                required
                rows={3}
                maxLength={3000}
              />
            </Field>
            <Field
              label={l("وظایف مجاز", "Allowed tasks")}
              hint={l("هر وظیفه در یک خط", "One task per line")}
            >
              <textarea
                value={role.tasks.join("\n")}
                onChange={(e) => update("tasks", e.target.value.split("\n"))}
                rows={4}
              />
            </Field>
            <Field
              label={l("محدودیت‌ها", "Boundaries")}
              hint={l("هر محدودیت در یک خط", "One boundary per line")}
            >
              <textarea
                value={role.restrictions.join("\n")}
                onChange={(e) =>
                  update("restrictions", e.target.value.split("\n"))
                }
                rows={4}
              />
            </Field>
            <Field label={l("محدوده پاسخ‌گویی", "Answer scope")}>
              <textarea
                value={role.scope}
                onChange={(e) => update("scope", e.target.value)}
                rows={3}
              />
            </Field>
            <Field label={l("نحوه اعلام ندانستن", "How to say ‘I don’t know’")}>
              <textarea
                value={role.unknownResponse}
                onChange={(e) => update("unknownResponse", e.target.value)}
                rows={3}
                required
              />
            </Field>
            <fieldset className="knowledge-mode span-two">
              <legend>{l("شیوه استفاده از دانش", "Knowledge policy")}</legend>
              <label className={mode === "strict_sources" ? "selected" : ""}>
                <input
                  type="radio"
                  name="mode"
                  checked={mode === "strict_sources"}
                  onChange={() => setMode("strict_sources")}
                />
                <div>
                  <strong>{l("فقط منابع تأییدشده", "Strict sources")}</strong>
                  <p>
                    {l(
                      "اطلاعات اختصاصی فقط از منابع فعال؛ در نبود پاسخ، اعلام ندانستن.",
                      "Specific facts come only from active sources. Missing information stays unknown.",
                    )}
                  </p>
                </div>
                <ShieldCheck size={21} />
              </label>
              <label className={mode === "hybrid" ? "selected" : ""}>
                <input
                  type="radio"
                  name="mode"
                  checked={mode === "hybrid"}
                  onChange={() => setMode("hybrid")}
                />
                <div>
                  <strong>
                    {l("منابع + دانش عمومی مرتبط", "Hybrid knowledge")}
                  </strong>
                  <p>
                    {l(
                      "توضیح عمومی مرتبط با نقش، بدون ساختن اطلاعات اختصاصی محیط.",
                      "Add relevant general explanations, without inventing private business facts.",
                    )}
                  </p>
                </div>
                <Sparkles size={21} />
              </label>
            </fieldset>
            {changedRole && (
              <label className="checkbox-row span-two warning-box">
                <input
                  type="checkbox"
                  checked={retain}
                  onChange={(e) => setRetain(e.target.checked)}
                />
                <span>
                  {l(
                    "شغل تغییر کرده است. منابع قبلی را برای شغل جدید صریحاً فعال نگه دار.",
                    "The role has changed. Explicitly keep the previous sources enabled for the new role.",
                  )}
                </span>
              </label>
            )}
            <div className="form-actions span-two">
              <Submit />
              <span className="form-footnote">{t("reviewBeforePublish")}</span>
            </div>
          </div>
        </Panel>
      </form>
    </>
  );
}

function CharacterFields({
  character,
  change,
}: {
  character: Character;
  change: (key: keyof Character, value: string | string[]) => void;
}) {
  const { t, l } = useApp();
  return (
    <div className="form-grid">
      <Field label={l("نام شخصیت", "Character name")}>
        <input
          value={character.name}
          onChange={(e) => change("name", e.target.value)}
          required
          maxLength={80}
        />
      </Field>
      <Field label={l("نماد ساده", "Simple symbol")}>
        <input
          value={character.icon}
          onChange={(e) => change("icon", e.target.value)}
          maxLength={8}
        />
      </Field>
      <Field label={t("description")} className="span-two">
        <textarea
          rows={2}
          value={character.description}
          onChange={(e) => change("description", e.target.value)}
          maxLength={1000}
        />
      </Field>
      <Field label={l("لحن", "Tone")}>
        <select
          value={character.tone}
          onChange={(e) => change("tone", e.target.value)}
        >
          <option value="friendly">{l("صمیمی", "Friendly")}</option>
          <option value="formal">{l("رسمی", "Formal")}</option>
        </select>
      </Field>
      <Field label={l("طول پاسخ", "Response length")}>
        <select
          value={character.responseLength}
          onChange={(e) => change("responseLength", e.target.value)}
        >
          <option value="short">{l("کوتاه", "Short")}</option>
          <option value="medium">{l("متوسط", "Medium")}</option>
          <option value="long">{l("تفصیلی", "Detailed")}</option>
        </select>
      </Field>
      <Field label={l("صبوری", "Patience")}>
        <select
          value={character.patience}
          onChange={(e) => change("patience", e.target.value)}
        >
          <option value="high">{l("زیاد", "High")}</option>
          <option value="medium">{l("متوسط", "Medium")}</option>
        </select>
      </Field>
      <Field label={l("میزان شوخی", "Humor")}>
        <select
          value={character.humor}
          onChange={(e) => change("humor", e.target.value)}
        >
          <option value="none">{l("بدون شوخی", "None")}</option>
          <option value="low">{l("کم", "Low")}</option>
          <option value="moderate">{l("متعادل", "Moderate")}</option>
        </select>
      </Field>
      <Field label={l("زبان پیش‌فرض ربات", "Default conversation language")}>
        <select
          value={character.language}
          onChange={(e) => change("language", e.target.value)}
        >
          <option value="fa">{l("فارسی", "Persian")}</option>
          <option value="en">English</option>
          <option value="ar">العربية</option>
        </select>
      </Field>
      <Field
        label={l("زبان‌های مجاز", "Allowed languages")}
        hint={l(
          "کدهای زبان با کاما، مثلاً fa,en",
          "Comma-separated language codes, e.g. fa,en",
        )}
      >
        <input
          dir="ltr"
          value={character.languages.join(",")}
          onChange={(e) =>
            change(
              "languages",
              e.target.value.split(",").map((v) => v.trim()),
            )
          }
          required
        />
      </Field>
      <Field
        label={t("voice")}
        hint={l(
          "شناسه صدا باید با adapter و مدل تنظیم‌شده سازگار باشد؛ دسترسی واقعی با آزمایش صریح بررسی می‌شود.",
          "Voice must match the configured adapter and model. Explicit voice testing verifies actual provider access.",
        )}
        className="span-two"
      >
        <input
          value={character.voice}
          onChange={(e) => change("voice", e.target.value)}
          placeholder={l(
            "شناسه صدای پشتیبانی‌شده",
            "Supported voice identifier",
          )}
          dir="ltr"
          maxLength={80}
        />
      </Field>
      <Field label={l("پیام آغاز", "Opening greeting")} className="span-two">
        <textarea
          rows={3}
          value={character.greeting}
          onChange={(e) => change("greeting", e.target.value)}
          maxLength={2000}
        />
      </Field>
      <Field
        label={l("دستور رفتاری تکمیلی", "Additional behavioral instructions")}
        className="span-two"
      >
        <textarea
          rows={4}
          value={character.instructions}
          onChange={(e) => change("instructions", e.target.value)}
          maxLength={5000}
        />
      </Field>
    </div>
  );
}
function CharacterPreview({ character }: { character: Character }) {
  const { l } = useApp();
  return (
    <div className="character-preview">
      <span className="preview-label">
        <Sparkles size={14} />
        {l("پیش‌نمایش رفتار", "Behavior preview")}
      </span>
      <span className="character-preview-avatar">{character.icon || "✦"}</span>
      <h3>{character.name || l("شخصیت جدید شما", "Your new character")}</h3>
      <p>
        {character.description ||
          l(
            "یک همراه با هویت روشن و رفتاری قابل‌پیش‌بینی",
            "A companion with a clear identity and consistent behavior",
          )}
      </p>
      <div className="preview-bubble">
        {character.greeting ||
          l(
            "سلام! من یک دستیار هوش مصنوعی هستم. چطور می‌توانم کمک کنم؟",
            "Hello! I’m an AI assistant. How can I help?",
          )}
      </div>
      <div className="preview-chips">
        <span>
          {character.tone === "formal"
            ? l("رسمی", "Formal")
            : l("صمیمی", "Friendly")}
        </span>
        <span>{character.language.toUpperCase()}</span>
        <span>
          {character.responseLength === "short"
            ? l("پاسخ کوتاه", "Short answers")
            : l("پاسخ تفصیلی", "Detailed answers")}
        </span>
      </div>
      <div className="notice">
        <CircleHelp size={17} />
        <p>
          {l(
            "این پیش‌نمایش متن تنظیمات است. رفتار واقعی را با اقدام صریح در محیط آزمایش بررسی کنید.",
            "This previews configured text. Test actual behavior explicitly in the playground.",
          )}
        </p>
      </div>
    </div>
  );
}

function VoiceSample({ deviceId }: { deviceId: string }) {
  const { data, l } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [url, setUrl] = useState("");
  const audio = useRef<HTMLAudioElement>(null);
  const mediaUrl = useRef("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    setUrl("");
    return () => {
      request.current?.abort();
      request.current = null;
      audio.current?.pause();
      if (mediaUrl.current) URL.revokeObjectURL(mediaUrl.current);
      mediaUrl.current = "";
    };
  }, [deviceId]);
  async function sample() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    audio.current?.pause();
    if (mediaUrl.current) {
      URL.revokeObjectURL(mediaUrl.current);
      mediaUrl.current = "";
      setUrl("");
    }
    try {
      const response = await authenticatedFetch("/api/voice-sample", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId, preview: "draft" }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error?.message || "Voice sample failed");
      }
      const blob = await response.blob();
      if (!blob.type.startsWith("audio/"))
        throw new Error(
          l(
            "پاسخ صوتی معتبر دریافت نشد.",
            "The server returned no valid audio.",
          ),
        );
      if (request.current !== controller) return;
      const next = URL.createObjectURL(blob);
      mediaUrl.current = next;
      setUrl(next);
      if (audio.current) {
        audio.current.src = next;
        await audio.current.play().catch(() => {
          /* The audio controls remain available if autoplay is blocked. */
        });
      }
    } catch (err) {
      if (
        request.current === controller &&
        !(err instanceof DOMException && err.name === "AbortError")
      )
        setError(err instanceof Error ? err.message : "Voice sample failed");
    } finally {
      if (request.current === controller) {
        setBusy(false);
        request.current = null;
      }
    }
  }
  return (
    <div className="voice-sample">
      <div>
        <strong>{l("نمونه صدای شخصیت", "Character voice sample")}</strong>
        <p>
          {l(
            "ابتدا پیش‌نویس را ذخیره کنید. نمونه با صدا و پیام آغاز ذخیره‌شده ساخته می‌شود و ممکن است مصرف سرویس داشته باشد.",
            "Save your draft first. The sample uses the saved voice and greeting and may incur provider usage.",
          )}
        </p>
      </div>
      <button
        className="button secondary"
        type="button"
        disabled={busy || data.demo || !isConfigured(data.integrations.openai)}
        onClick={() => void sample()}
      >
        {busy ? (
          <LoaderCircle size={16} className="spin" />
        ) : (
          <Volume2 size={16} />
        )}
        {l("پخش نمونه صدا", "Play voice sample")}
      </button>
      <audio
        ref={audio}
        src={url || undefined}
        controls={!!url}
        aria-label={l("نمونه صدای تولیدشده", "Generated voice sample")}
      />
      {data.demo && (
        <span className="fine-print">
          {l(
            "تولید صدای زنده در دمو غیرفعال است.",
            "Live speech generation is disabled in demo.",
          )}
        </span>
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function DeviceCharacter({ device }: { device: Device }) {
  const { data, t, l, run, busy } = useApp();
  const [character, setCharacter] = useState(device.draft.character);
  const [template, setTemplate] = useState("");
  const [confirm, setConfirm] = useState(false);
  useEffect(
    () => setCharacter(device.draft.character),
    [device.draft.character],
  );
  return (
    <>
      <div className="section-intro">
        <h2>{t("character")}</h2>
        <p>{t("characterDescription")}</p>
      </div>
      <Panel className="template-picker">
        <div>
          <span className="stat-icon purple">
            <Users size={21} />
          </span>
          <div>
            <strong>
              {l(
                "از یک قالب شخصیت شروع کنید",
                "Start from a character template",
              )}
            </strong>
            <p>
              {l(
                "نسخه‌ای مستقل برای این ربات ساخته می‌شود؛ دانش دستگاه تغییری نمی‌کند.",
                "A separate snapshot is assigned to this robot. Private knowledge stays with the device.",
              )}
            </p>
          </div>
        </div>
        <select
          aria-label={t("character")}
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
        >
          <option value="">{t("none")}</option>
          {data.templates
            .filter((v) => !v.archived)
            .map((v) => (
              <option value={v.id} key={v.id}>
                {v.name} · v{v.version}
              </option>
            ))}
        </select>
        <button
          className="button secondary"
          disabled={!template || !!busy}
          onClick={() => setConfirm(true)}
        >
          {t("apply")}
        </button>
      </Panel>
      <div className="form-aside-grid">
        <Panel>
          <form
            className="padded-form"
            onSubmit={async (e) => {
              e.preventDefault();
              await run(
                "save_draft",
                { deviceId: device.id, config: { ...device.draft, character } },
                t("saved"),
              );
            }}
          >
            <CharacterFields
              character={character}
              change={(key, value) =>
                setCharacter((prev) => ({ ...prev, [key]: value }))
              }
            />
            <VoiceSample deviceId={device.id} />
            <div className="form-actions">
              <Submit />
            </div>
          </form>
        </Panel>
        <CharacterPreview character={character} />
      </div>
      {confirm && (
        <Modal title={t("apply")} close={() => setConfirm(false)}>
          <p className="modal-copy">
            {l(
              "نسخه انتخاب‌شده در پیش‌نویس این دستگاه قرار می‌گیرد. برای تغییر ربات زنده، پیش‌نمایش را بررسی و سپس منتشر کنید.",
              "The selected version will replace this device’s draft character. Review and publish it to change the live robot.",
            )}
          </p>
          <div className="diff-block">
            <span>{t("character")}</span>
            <del>{device.draft.character.name || "—"}</del>
            <strong>
              {data.templates.find((v) => v.id === template)?.name}
            </strong>
          </div>
          <div className="form-actions">
            <button
              className="button primary"
              disabled={!!busy}
              onClick={async () => {
                if (
                  await run(
                    "apply_template",
                    { deviceId: device.id, templateId: template },
                    t("saved"),
                  )
                )
                  setConfirm(false);
              }}
            >
              {t("confirm")}
            </button>
            <button
              className="button secondary"
              onClick={() => setConfirm(false)}
            >
              {t("cancel")}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Characters() {
  const { data, t, l, run, busy } = useApp();
  const [archive, setArchive] = useState<Template | null>(null);
  return (
    <>
      <PageHeading
        title={t("characters")}
        description={t("templateCopy")}
        action={
          <Link className="button primary" href="/characters/new">
            <Plus size={18} />
            {t("newCharacter")}
          </Link>
        }
      />
      {data.templates.filter((v) => !v.archived).length ? (
        <div className="characters-grid">
          {data.templates
            .filter((v) => !v.archived)
            .map((template) => (
              <div className="character-card" key={template.id}>
                <div className="character-card-top">
                  <span className="character-template-icon">
                    {template.character.icon || "✦"}
                  </span>
                  <span className="subtle-tag">v{template.version}</span>
                </div>
                <h2>{template.name}</h2>
                <p>
                  {template.character.description ||
                    l(
                      "شخصیت اختصاصی برای ربات‌های شما",
                      "A reusable personality for your robots",
                    )}
                </p>
                <div className="preview-chips">
                  <span>
                    {template.character.tone === "formal"
                      ? l("رسمی", "Formal")
                      : l("صمیمی", "Friendly")}
                  </span>
                  <span>{template.character.language.toUpperCase()}</span>
                  <span>
                    {template.character.voice ||
                      l("صدا تنظیم نشده", "Voice not set")}
                  </span>
                </div>
                <div className="character-card-actions">
                  <Link
                    className="button secondary"
                    href={`/characters/${template.id}`}
                  >
                    <Pencil size={15} />
                    {t("edit")}
                  </Link>
                  <button
                    className="icon-button"
                    aria-label={l("آرشیو شخصیت", "Archive character")}
                    onClick={() => setArchive(template)}
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
              </div>
            ))}
        </div>
      ) : (
        <Panel>
          <Empty
            icon={<Sparkles size={28} />}
            title={t("emptyTemplates")}
            description={t("templateCopy")}
            action={
              <Link className="button primary" href="/characters/new">
                <Plus size={17} />
                {t("newCharacter")}
              </Link>
            }
          />
        </Panel>
      )}
      {archive && (
        <Modal
          title={l("آرشیو شخصیت", "Archive character")}
          close={() => setArchive(null)}
        >
          <p className="modal-copy">
            {l(
              `شخصیت «${archive.name}» آرشیو می‌شود. نسخه‌های تخصیص‌یافته به دستگاه‌ها حفظ می‌شوند.`,
              `Archive “${archive.name}”? Snapshots already assigned to devices will be preserved.`,
            )}
          </p>
          <div className="form-actions">
            <button
              className="button danger"
              disabled={!!busy}
              onClick={async () => {
                if (
                  await run(
                    "archive_template",
                    { templateId: archive.id },
                    t("success"),
                  )
                )
                  setArchive(null);
              }}
            >
              {l("آرشیو", "Archive")}
            </button>
            <button
              className="button secondary"
              onClick={() => setArchive(null)}
            >
              {t("cancel")}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
function CharacterEditor({ id }: { id: string }) {
  const { data, t, l, run } = useApp();
  const router = useRouter();
  const template = data.templates.find((v) => v.id === id);
  const [character, setCharacter] = useState<Character>(
    template?.character || emptyCharacter,
  );
  const [name, setName] = useState(template?.name || "");
  if (id !== "new" && !template) return <Missing />;
  return (
    <>
      <div className="device-breadcrumb">
        <Link href="/characters">{t("characters")}</Link>
        <ChevronLeft className="direction-arrow" size={14} />
        <span>{id === "new" ? t("newCharacter") : template?.name}</span>
      </div>
      <PageHeading
        title={
          id === "new"
            ? t("newCharacter")
            : l("ویرایش قالب شخصیت", "Edit character template")
        }
        description={t("templateCopy")}
      />
      <div className="form-aside-grid">
        <Panel>
          <form
            className="padded-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const result = await run(
                "save_template",
                { ...(template ? { id: template.id } : {}), name, character },
                t("saved"),
              );
              if (result) router.push("/characters");
            }}
          >
            <Field label={l("نام قالب", "Template name")}>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={80}
              />
            </Field>
            <div className="form-section-divider" />
            <CharacterFields
              character={character}
              change={(key, value) =>
                setCharacter((prev) => ({ ...prev, [key]: value }))
              }
            />
            <div className="form-actions">
              <Submit>
                {template
                  ? l("ذخیره نسخه جدید", "Save new version")
                  : t("newCharacter")}
              </Submit>
              <Link href="/characters" className="button ghost">
                {t("cancel")}
              </Link>
            </div>
          </form>
        </Panel>
        <CharacterPreview character={character} />
      </div>
    </>
  );
}

function PublishDialog({
  device,
  close,
}: {
  device: Device;
  close: () => void;
}) {
  const { t, l, run, busy } = useApp();
  const [confirmKnowledge, setConfirmKnowledge] = useState(false);
  const draft = device.draft,
    old = device.published;
  const needsKnowledgeConfirmation =
    !!old &&
    old.role.title !== draft.role.title &&
    draft.activeSourceIds.length > 0;
  const changes = [
    {
      label: t("role"),
      before: old?.role.title || "—",
      after: draft.role.title || "—",
      changed: JSON.stringify(old?.role) !== JSON.stringify(draft.role),
    },
    {
      label: t("character"),
      before: old?.character.name || "—",
      after: draft.character.name || "—",
      changed:
        JSON.stringify(old?.character) !== JSON.stringify(draft.character),
    },
    {
      label: t("voice"),
      before: old?.character.voice || "—",
      after: draft.character.voice || "—",
      changed: old?.character.voice !== draft.character.voice,
    },
    {
      label: l("شیوه دانش", "Knowledge policy"),
      before: old?.knowledgeMode || "—",
      after: draft.knowledgeMode,
      changed: old?.knowledgeMode !== draft.knowledgeMode,
    },
    {
      label: t("sources"),
      before: String(old?.activeSourceIds.length ?? 0),
      after: String(draft.activeSourceIds.length),
      changed:
        JSON.stringify(old?.activeSourceIds) !==
        JSON.stringify(draft.activeSourceIds),
    },
  ];
  return (
    <Modal title={t("publish")} close={close} wide>
      <p className="modal-copy">
        {l(
          `انتشار نسخه ${device.configVersion + 1} برای «${device.name}». تغییر نقش و شخصیت از جلسه بعدی اعمال می‌شود.`,
          `Publish version ${device.configVersion + 1} for “${device.name}”. Role and character changes take effect in the next session.`,
        )}
      </p>
      <div className="publish-diff">
        <div className="diff-heading">
          <span>{l("بخش", "Section")}</span>
          <span>{t("published")}</span>
          <span>{t("draft")}</span>
        </div>
        {changes.map((change) => (
          <div
            className={cx("diff-row", change.changed && "changed")}
            key={change.label}
          >
            <strong>
              {change.label}
              {change.changed && <span className="change-dot" />}
            </strong>
            <span>{change.before}</span>
            <span>{change.after}</span>
          </div>
        ))}
      </div>
      <details className="full-diff">
        <summary>
          {l("بررسی کامل تنظیمات و منابع", "Inspect full settings and sources")}
        </summary>
        <div className="full-diff-columns">
          <div>
            <h4>{t("published")}</h4>
            <pre dir="ltr">{JSON.stringify(old, null, 2)}</pre>
          </div>
          <div>
            <h4>{t("draft")}</h4>
            <pre dir="ltr">{JSON.stringify(draft, null, 2)}</pre>
          </div>
        </div>
      </details>
      {needsKnowledgeConfirmation && (
        <label className="checkbox-row warning-box">
          <input
            type="checkbox"
            checked={confirmKnowledge}
            onChange={(event) => setConfirmKnowledge(event.target.checked)}
          />
          <span>
            {l(
              "شغل تغییر کرده است. استفاده از منابع انتخاب‌شده برای شغل جدید را تأیید می‌کنم.",
              "The role has changed. I explicitly approve the selected sources for the new role.",
            )}
          </span>
        </label>
      )}
      <div className="notice">
        <ShieldCheck size={18} />
        <p>
          {l(
            "تنها منابع آماده و انتخاب‌شده منتشر می‌شوند. انتشار به معنی دریافت تنظیمات توسط دستگاه نیست.",
            "Only ready, explicitly selected sources are published. Publication does not imply receipt by the device.",
          )}
        </p>
      </div>
      <div className="form-actions">
        <button
          className="button primary"
          disabled={!!busy || (needsKnowledgeConfirmation && !confirmKnowledge)}
          onClick={async () => {
            if (
              await run(
                "publish",
                { deviceId: device.id, confirmKnowledge },
                t("publishedSuccess"),
              )
            )
              close();
          }}
        >
          {busy === "publish" ? (
            <LoaderCircle className="spin" size={17} />
          ) : (
            <CloudUpload size={17} />
          )}
          {l("انتشار نسخه جدید", "Publish new version")}
        </button>
        <button className="button secondary" onClick={close}>
          {t("cancel")}
        </button>
      </div>
    </Modal>
  );
}

function Missing() {
  const { t, l } = useApp();
  return (
    <Panel>
      <Empty
        title={l("موردی پیدا نشد", "Not found")}
        description={l(
          "این مورد موجود نیست یا اجازه مشاهده آن را ندارید.",
          "This item does not exist or is not available to your account.",
        )}
        action={
          <Link href="/dashboard" className="button secondary">
            {t("dashboard")}
          </Link>
        }
      />
    </Panel>
  );
}

function Knowledge({ device }: { device: Device }) {
  const { t, l, run, busy, refresh, notify, locale } = useApp();
  const [tab, setTab] = useState("sources");
  const [note, setNote] = useState(false);
  const [editing, setEditing] = useState<Doc | null>(null);
  const [text, setText] = useState("");
  const [deleting, setDeleting] = useState<Doc | null>(null);
  const [fact, setFact] = useState<Fact | "new" | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deleteFact, setDeleteFact] = useState<Fact | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const documents = device.documents.filter((doc) => doc.status !== "deleted");
  async function upload(file: File) {
    setUploading(true);
    try {
      const body = new FormData();
      body.set("file", file);
      const res = await authenticatedFetch(
        `/api/upload?deviceId=${encodeURIComponent(device.id)}`,
        { method: "POST", body },
      );
      const json = await res.json();
      if (!res.ok || json.error)
        throw new Error(json.error?.message || "Upload failed");
      await refresh();
      notify(
        l(
          "فایل دریافت شد؛ متن استخراج‌شده را بررسی کنید.",
          "File received. Review the extracted text before approval.",
        ),
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : "Upload failed", true);
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  }
  return (
    <>
      <div className="section-intro with-action">
        <div>
          <h2>{t("knowledge")}</h2>
          <p>{t("sourcesDescription")}</p>
        </div>
        <div className="button-row">
          <button className="button secondary" onClick={() => setNote(true)}>
            <Plus size={16} />
            {t("note")}
          </button>
          <button
            className="button primary"
            onClick={() => input.current?.click()}
            disabled={uploading || !!busy}
          >
            {uploading ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <CloudUpload size={16} />
            )}
            {t("upload")}
          </button>
          <input
            type="file"
            accept=".pdf,.txt,.md,text/plain,text/markdown,application/pdf"
            className="visually-hidden"
            ref={input}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
            aria-label={t("upload")}
          />
        </div>
      </div>
      <div className="knowledge-destination">
        <BookOpen size={19} />
        <div>
          <strong>
            {l("دانش خصوصی", "Private knowledge")} · {device.name}
          </strong>
          <p>
            {l(
              "منابع با دستگاه‌های دیگر به اشتراک گذاشته نمی‌شوند. آماده بودن منبع به معنی انتشار آن نیست.",
              "Sources are never shared with other devices. Indexed sources are not automatically published.",
            )}
          </p>
        </div>
        <ShieldCheck size={24} />
      </div>
      <div className="knowledge-toolbar">
        <div className="segmented">
          <button
            onClick={() => setTab("sources")}
            className={tab === "sources" ? "active" : ""}
          >
            {l("منابع و فایل‌ها", "Sources & files")}
            <span>{documents.length}</span>
          </button>
          <button
            onClick={() => setTab("facts")}
            className={tab === "facts" ? "active" : ""}
          >
            {t("verifiedFacts")}
            <span>{device.facts.length}</span>
          </button>
        </div>
        <button
          className="icon-button"
          onClick={refresh}
          title={t("refresh")}
          aria-label={t("refresh")}
        >
          <RefreshCw size={17} />
        </button>
      </div>
      {tab === "sources" ? (
        <>
          <div className="ingestion-flow">
            {[
              l("دریافت", "Upload"),
              l("استخراج متن", "Extract"),
              l("بررسی مدیر", "Review"),
              l("تأیید", "Approve"),
              l("نمایه‌سازی", "Index"),
              l("انتخاب و انتشار", "Select & publish"),
            ].map((step, index) => (
              <span key={step}>
                <span className="flow-number">
                  {(index + 1).toLocaleString(locale)}
                </span>
                {step}
                {index < 5 && (
                  <ChevronLeft className="direction-arrow" size={13} />
                )}
              </span>
            ))}
          </div>
          <Panel>
            {documents.length ? (
              <div className="documents-list">
                {documents.map((doc) => {
                  const selected = device.draft.activeSourceIds.includes(
                    doc.id,
                  );
                  return (
                    <article className="document-row" key={doc.id}>
                      <span className="document-icon">
                        <FileText size={23} />
                      </span>
                      <div className="document-info">
                        <div>
                          <strong>{doc.title}</strong>
                          <span className="subtle-tag">r{doc.revision}</span>
                          {doc.active && (
                            <span className="badge active">
                              {t("published")}
                            </span>
                          )}
                        </div>
                        <span>
                          {doc.mimeType} · {date(doc.createdAt, locale)}
                        </span>
                        {doc.error && (
                          <p className="document-error">{doc.error}</p>
                        )}
                      </div>
                      <Badge value={doc.status} />
                      <div className="document-actions">
                        <button
                          className="button ghost small"
                          onClick={() => {
                            setEditing(doc);
                            setText(doc.text);
                          }}
                        >
                          <Pencil size={14} />
                          {l("متن و بررسی", "Review text")}
                        </button>
                        {(doc.status === "approved" ||
                          (doc.status === "failed" &&
                            doc.approvedRevision === doc.revision)) && (
                          <button
                            className="button secondary small"
                            disabled={!!busy}
                            onClick={() =>
                              void run(
                                "index_document",
                                { deviceId: device.id, documentId: doc.id },
                                l(
                                  "درخواست نمایه‌سازی ثبت شد.",
                                  "Indexing requested.",
                                ),
                              )
                            }
                          >
                            {doc.status === "failed"
                              ? t("retry")
                              : l("نمایه‌سازی", "Index")}
                          </button>
                        )}
                        {!!doc.readyRevision && (
                          <label
                            className="source-toggle"
                            title={l(
                              "انتخاب در پیش‌نویس؛ برای فعال‌شدن منتشر کنید",
                              "Select in draft, then publish to activate",
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={selected}
                              disabled={!!busy}
                              onChange={(e) =>
                                void run(
                                  "toggle_document",
                                  {
                                    deviceId: device.id,
                                    documentId: doc.id,
                                    active: e.target.checked,
                                  },
                                  e.target.checked
                                    ? l(
                                        "منبع در پیش‌نویس انتخاب شد؛ برای فعال‌شدن منتشر کنید.",
                                        "Source selected in draft. Publish to activate.",
                                      )
                                    : l(
                                        "دسترسی منبع قطع شد؛ جلسات مرتبط بسته شدند.",
                                        "Source access was revoked and affected sessions closed.",
                                      ),
                                )
                              }
                            />
                            <span>{l("انتخاب", "Select")}</span>
                          </label>
                        )}
                        <button
                          className="icon-button danger-text"
                          aria-label={`${t("remove")} ${doc.title}`}
                          onClick={() => setDeleting(doc)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <Empty
                icon={<CloudUpload size={28} />}
                title={l(
                  "دانش این ربات را بسازید",
                  "Build this robot’s knowledge",
                )}
                description={l(
                  "یک فایل PDF، متن یا Markdown بارگذاری کنید؛ یا یادداشت و FAQ بنویسید.",
                  "Upload a PDF, text, or Markdown file, or write a note or FAQ.",
                )}
                action={
                  <button
                    className="button secondary"
                    onClick={() => input.current?.click()}
                  >
                    <CloudUpload size={17} />
                    {t("upload")}
                  </button>
                }
              />
            )}
          </Panel>
          <div className="notice">
            <CircleHelp size={17} />
            <p>
              {l(
                "نوع، اندازه و تعداد صفحات در سرور بررسی می‌شوند. PDF تصویری بدون OCR واقعی به بررسی یا متن جایگزین نیاز دارد. نسخه اصلاح‌شده شما پس از تأیید نمایه‌سازی می‌شود.",
                "File type, size, and pages are validated on the server. Image-only PDFs need real OCR or replacement text. The reviewed revision is the one that is indexed.",
              )}
            </p>
          </div>
        </>
      ) : (
        <Panel
          title={t("verifiedFacts")}
          description={l(
            "قیمت، موجودی یا هر واقعیت دقیق با تاریخ تأیید؛ این اطلاعات لحظه‌ای نیستند.",
            "Prices, stock, or other exact facts with verification dates. These are not live inventory.",
          )}
          action={
            <button
              className="button secondary small"
              onClick={() => setFact("new")}
            >
              <Plus size={15} />
              {t("add")}
            </button>
          }
        >
          {device.facts.length ? (
            <div className="facts-list">
              {device.facts.map((item) => (
                <div key={item.id}>
                  <div>
                    <strong>{item.key}</strong>
                    <span>
                      {l("تأیید", "Verified")}: {date(item.verifiedAt, locale)}{" "}
                      · r{item.revision}
                    </span>
                  </div>
                  <strong>
                    {item.value} <small>{item.unit}</small>
                  </strong>
                  <button
                    className="icon-button"
                    aria-label={t("edit")}
                    onClick={() => setFact(item)}
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    className="icon-button danger-text"
                    aria-label={t("remove")}
                    onClick={() => setDeleteFact(item)}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              small
              icon={<CheckCheck size={26} />}
              title={t("empty")}
              description={l(
                "اطلاعات اختصاصی دقیق را با منبع تأیید مدیر ثبت کنید.",
                "Record exact private facts verified by an administrator.",
              )}
            />
          )}
        </Panel>
      )}
      {note && (
        <Modal
          title={`${t("note")} · ${device.name}`}
          close={() => setNote(false)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              if (
                await run(
                  "add_document",
                  {
                    deviceId: device.id,
                    title: form.get("title"),
                    text: form.get("text"),
                    mimeType: "text/plain",
                  },
                  t("saved"),
                )
              )
                setNote(false);
            }}
          >
            <Field label={t("title")}>
              <input name="title" required maxLength={160} />
            </Field>
            <Field
              label={l(
                "متن یادداشت / پرسش و پاسخ",
                "Note / question and answer text",
              )}
            >
              <textarea
                name="text"
                rows={10}
                required
                placeholder={l(
                  "اطلاعات تأییدشده این ربات را بنویسید…",
                  "Write verified information for this robot…",
                )}
              />
            </Field>
            <div className="form-actions">
              <Submit>{l("ذخیره برای بررسی", "Save for review")}</Submit>
              <button
                type="button"
                className="button secondary"
                onClick={() => setNote(false)}
              >
                {t("cancel")}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {editing && (
        <Modal
          title={`${l("بررسی متن", "Review extracted text")} · ${editing.title}`}
          close={() => setEditing(null)}
          wide
        >
          <div className="review-meta">
            <Badge value={editing.status} />
            <span>r{editing.revision}</span>
            <span>{editing.mimeType}</span>
          </div>
          {editing.error && <div className="inline-error">{editing.error}</div>}
          <Field
            label={l(
              "متن استخراج‌شده / متن جایگزین",
              "Extracted / replacement text",
            )}
            hint={l(
              "اصلاح متن، نسخه جدیدی برای بررسی می‌سازد. ابتدا ذخیره و سپس همان نسخه را تأیید کنید.",
              "Editing creates a new review revision. Save changes first, then approve that revision.",
            )}
          >
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={15}
            />
          </Field>
          <div className="form-actions">
            <button
              className="button secondary"
              disabled={
                !!busy ||
                !text.trim() ||
                (text === editing.text && editing.status !== "failed")
              }
              onClick={async () => {
                const result = await run(
                  "edit_document",
                  { deviceId: device.id, documentId: editing.id, text },
                  t("saved"),
                );
                if (result) {
                  const updated = result.bootstrap?.devices
                    .find((d) => d.id === device.id)
                    ?.documents.find((d) => d.id === editing.id);
                  if (updated) {
                    setEditing(updated);
                    setText(updated.text);
                  }
                }
              }}
            >
              <Check size={16} />
              {l("ذخیره اصلاح متن", "Save corrected text")}
            </button>
            {editing.status === "needs_review" && (
              <button
                className="button primary"
                disabled={!!busy || !text.trim() || text !== editing.text}
                onClick={async () => {
                  if (
                    await run(
                      "approve_document",
                      { deviceId: device.id, documentId: editing.id },
                      l(
                        "متن تأیید شد. اکنون نمایه‌سازی کنید.",
                        "Text approved. You can now index it.",
                      ),
                    )
                  )
                    setEditing(null);
                }}
              >
                <ShieldCheck size={16} />
                {l("تأیید همین نسخه", "Approve this revision")}
              </button>
            )}
            <button className="button ghost" onClick={() => setEditing(null)}>
              {t("close")}
            </button>
          </div>
        </Modal>
      )}
      {deleting && (
        <Modal
          title={l("حذف منبع", "Delete source")}
          close={() => setDeleting(null)}
        >
          <p className="modal-copy">
            {l(
              `دسترسی به «${deleting.title}» فوراً قطع می‌شود. جلسات آلوده به محتوای آن بسته و پاک‌سازی فایل در ادامه انجام می‌شود.`,
              `Access to “${deleting.title}” will be revoked immediately. Affected sessions will be closed before storage cleanup.`,
            )}
          </p>
          <div className="form-actions">
            <button
              className="button danger"
              disabled={!!busy}
              onClick={async () => {
                if (
                  await run(
                    "delete_document",
                    { deviceId: device.id, documentId: deleting.id },
                    t("success"),
                  )
                )
                  setDeleting(null);
              }}
            >
              <Trash2 size={16} />
              {t("remove")}
            </button>
            <button
              className="button secondary"
              onClick={() => setDeleting(null)}
            >
              {t("cancel")}
            </button>
          </div>
        </Modal>
      )}
      {fact && (
        <Modal title={t("verifiedFacts")} close={() => setFact(null)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              if (
                await run(
                  "save_fact",
                  {
                    deviceId: device.id,
                    ...(fact === "new" ? {} : { id: fact.id }),
                    key: form.get("key"),
                    value: form.get("value"),
                    unit: form.get("unit"),
                  },
                  t("saved"),
                )
              )
                setFact(null);
            }}
          >
            <Field label={t("key")}>
              <input
                name="key"
                defaultValue={fact === "new" ? "" : fact.key}
                required
                maxLength={160}
              />
            </Field>
            <Field label={t("value")}>
              <input
                name="value"
                defaultValue={fact === "new" ? "" : fact.value}
                required
                maxLength={2000}
              />
            </Field>
            <Field label={t("units")}>
              <input
                name="unit"
                defaultValue={fact === "new" ? "" : fact.unit}
                maxLength={80}
              />
            </Field>
            <div className="notice">
              <CheckCheck size={18} />
              <p>
                {l(
                  "ذخیره این فرم تأیید صریح صحت اطلاعات توسط مدیر است. زمان و نسخه ثبت می‌شود.",
                  "Saving explicitly confirms this information as verified. The revision and timestamp are recorded.",
                )}
              </p>
            </div>
            <div className="form-actions">
              <Submit>{l("تأیید و ذخیره", "Verify & save")}</Submit>
            </div>
          </form>
        </Modal>
      )}
      {deleteFact && (
        <Modal title={t("remove")} close={() => setDeleteFact(null)}>
          <p className="modal-copy">
            {l(
              `اطلاعات «${deleteFact.key}» حذف شود؟`,
              `Delete the verified fact “${deleteFact.key}”?`,
            )}
          </p>
          <div className="form-actions">
            <button
              className="button danger"
              disabled={!!busy}
              onClick={async () => {
                if (
                  await run(
                    "delete_fact",
                    { deviceId: device.id, factId: deleteFact.id },
                    t("success"),
                  )
                )
                  setDeleteFact(null);
              }}
            >
              {t("remove")}
            </button>
            <button
              className="button secondary"
              onClick={() => setDeleteFact(null)}
            >
              {t("cancel")}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  sources?: {
    sourceId?: string;
    title?: string;
    revision?: number;
    excerpt?: string;
    page?: number;
  }[];
  demo?: boolean;
};
function Playground({ device }: { device: Device }) {
  const { data, t, l, run, busy } = useApp();
  const [mode, setMode] = useState<"draft" | "published">("draft");
  const [tab, setTab] = useState("text");
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const end = useRef<HTMLDivElement>(null);
  useEffect(
    () => end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
    [messages, busy],
  );
  async function send(event: FormEvent) {
    event.preventDefault();
    const question = query.trim();
    if (!question || busy) return;
    setQuery("");
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    const result = await run("playground", {
      deviceId: device.id,
      query: question,
      preview: mode,
    });
    if (result)
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: String(result.answer || ""),
          sources: result.sources as ChatMessage["sources"],
          demo: !!result.demo,
        },
      ]);
  }
  return (
    <>
      <div className="section-intro with-action">
        <div>
          <h2>{t("playground")}</h2>
          <p>
            {l(
              "نقش، شخصیت و دانش همین دستگاه را در یک جلسه آزمایشی مستقل بررسی کنید.",
              "Test this device’s role, character, and knowledge in an independent test session.",
            )}
          </p>
        </div>
        <div className="segmented">
          <button
            className={mode === "draft" ? "active" : ""}
            onClick={() => {
              setMode("draft");
              setMessages([]);
            }}
          >
            {t("draft")} {t("preview")}
          </button>
          <button
            className={mode === "published" ? "active" : ""}
            disabled={!device.published}
            onClick={() => {
              setMode("published");
              setMessages([]);
            }}
          >
            {t("published")}
          </button>
        </div>
      </div>
      <div className="playground-grid">
        <Panel
          className="chat-panel"
          title={
            <span className="inline-title">
              <RobotAvatar device={device} />
              <span>
                {(mode === "draft" ? device.draft : device.published)?.character
                  .name || device.name}
                <small>
                  {mode === "draft"
                    ? `${t("draft")} · ${t("preview")}`
                    : `${t("published")} · v${device.configVersion}`}
                </small>
              </span>
            </span>
          }
          action={
            <div className="segmented compact">
              <button
                className={tab === "text" ? "active" : ""}
                onClick={() => setTab("text")}
              >
                <MessageCircle size={15} />
                {t("textTest")}
              </button>
              <button
                className={tab === "voice" ? "active" : ""}
                onClick={() => setTab("voice")}
              >
                <Mic size={15} />
                {t("voiceTest")}
              </button>
            </div>
          }
        >
          {tab === "text" ? (
            <>
              <div className="chat-messages" aria-live="polite">
                {!messages.length && (
                  <div className="chat-empty">
                    <span className="chat-bot-icon">
                      <AudioLines size={33} />
                    </span>
                    <h3>
                      {l(
                        "با رباتتان گفت‌وگو کنید",
                        "Meet your robot in conversation",
                      )}
                    </h3>
                    <p>
                      {l(
                        "یک پرسش درباره دانش اختصاصی دستگاه بپرسید. پاسخ‌ها از context و بازیابی مشترک با سرور صوتی استفاده می‌کنند.",
                        "Ask about this device’s private knowledge. Text tests share the voice server’s context and retrieval.",
                      )}
                    </p>
                    <div className="suggested-questions">
                      {[
                        l("خودت را معرفی کن", "Introduce yourself"),
                        l(
                          "چه اطلاعات تأییدشده‌ای داری؟",
                          "What verified facts do you know?",
                        ),
                      ].map((value) => (
                        <button key={value} onClick={() => setQuery(value)}>
                          {value}
                          <ArrowLeft size={14} className="direction-arrow" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {messages.map((message, index) => (
                  <div className={cx("chat-message", message.role)} key={index}>
                    <span className="message-avatar">
                      {message.role === "assistant" ? (
                        <AudioLines size={17} />
                      ) : (
                        "A"
                      )}
                    </span>
                    <div>
                      <div className="message-label">
                        {message.role === "assistant"
                          ? device.draft.character.name || device.name
                          : l("شما", "You")}
                        {message.demo && (
                          <span className="badge demo">Demo</span>
                        )}
                      </div>
                      <div className="message-bubble">{message.content}</div>
                      {!!message.sources?.length && (
                        <details className="chat-sources">
                          <summary>
                            <BookOpen size={13} />
                            {message.sources.length} {t("sourceCount")}
                          </summary>
                          {message.sources.map((source, i) => (
                            <div key={i}>
                              <strong>
                                {source.title || source.sourceId} · r
                                {source.revision}
                                {source.page
                                  ? ` · ${l("صفحه", "page")} ${source.page}`
                                  : ""}
                              </strong>
                              {source.excerpt && <p>{source.excerpt}</p>}
                            </div>
                          ))}
                        </details>
                      )}
                    </div>
                  </div>
                ))}
                {busy === "playground" && (
                  <div className="chat-typing">
                    <LoaderCircle size={17} className="spin" />
                    {t("processing")}
                  </div>
                )}
                <div ref={end} />
              </div>
              <form className="chat-composer" onSubmit={send}>
                <textarea
                  aria-label={t("question")}
                  placeholder={t("question")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  rows={2}
                  maxLength={6000}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      if (query.trim() && !busy) void send(e);
                    }
                  }}
                />
                <button
                  className="button primary send-button"
                  type="submit"
                  disabled={!query.trim() || !!busy}
                  aria-label={t("send")}
                >
                  <Send size={18} />
                </button>
              </form>
              <div className="chat-footer">
                <ShieldCheck size={12} />
                {device.privacy.storeTranscripts
                  ? l(
                      "ذخیره متن برای این دستگاه فعال است.",
                      "Transcript storage is enabled for this device.",
                    )
                  : t("transcriptOff")}
                <button
                  onClick={() => setMessages([])}
                  disabled={!messages.length || !!busy}
                >
                  {l("جلسه تازه", "New session")}
                </button>
              </div>
            </>
          ) : (
            <VoicePlayground device={device} mode={mode} />
          )}
        </Panel>
        <div className="stack">
          <Panel title={l("زمینه این آزمایش", "Test context")}>
            <div className="context-list">
              <div>
                <span>{t("name")}</span>
                <strong>{device.name}</strong>
              </div>
              <div>
                <span>{t("role")}</span>
                <strong>
                  {(mode === "draft" ? device.draft : device.published)?.role
                    .title || "—"}
                </strong>
              </div>
              <div>
                <span>{t("status")}</span>
                <Badge value={mode} />
              </div>
              <div>
                <span>{t("sources")}</span>
                <strong>
                  {(mode === "draft" ? device.draft : device.published)
                    ?.activeSourceIds.length ?? 0}
                </strong>
              </div>
              <div>
                <span>{t("model")}</span>
                <code dir="ltr">{data.integrations.model || t("setup")}</code>
              </div>
            </div>
          </Panel>
          <div className="guide-card compact">
            <ShieldCheck size={25} />
            <h3>{l("آزمایش با خیال روشن", "Know what you are testing")}</h3>
            <p>
              {l(
                "این جلسه از نوع test است و دستگاه فیزیکی را آنلاین نمی‌کند. پیش‌نمایش، تنظیمات منتشرشده را تغییر نمی‌دهد.",
                "This is a test session. It does not mark the physical device online or change published settings.",
              )}
            </p>
            {!data.demo && !isConfigured(data.integrations.openai) && (
              <Link className="text-link" href="/settings/integrations">
                {t("setup")}
                <ChevronLeft className="direction-arrow" size={14} />
              </Link>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
function VoicePlayground({
  device,
  mode,
}: {
  device: Device;
  mode: "draft" | "published";
}) {
  const { t, l, data, refresh } = useApp();
  const [phase, setPhase] = useState("idle");
  const [sessionId, setSessionId] = useState("");
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [microphone, setMicrophone] = useState("");
  const [transcript, setTranscript] = useState("");
  const connection = useRef<RTCPeerConnection | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const frame = useRef(0);
  const activeId = useRef("");
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const ready =
    !data.demo &&
    data.integrations.openai === "configured_not_tested" &&
    !!data.integrations.model;
  const active = phase !== "idle" && phase !== "error";
  const cleanup = useCallback((sendEnd = true) => {
    generation.current++;
    request.current?.abort();
    request.current = null;
    const id = activeId.current;
    activeId.current = "";
    connection.current?.close();
    connection.current = null;
    localStream.current?.getTracks().forEach((track) => track.stop());
    localStream.current = null;
    if (audio.current) {
      audio.current.pause();
      audio.current.srcObject = null;
    }
    if (audioContext.current)
      void audioContext.current.close().catch(() => {
        /* Already closed. */
      });
    audioContext.current = null;
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
    canvas.current?.getContext("2d")?.clearRect(0, 0, 400, 70);
    if (id && sendEnd)
      void authenticatedFetch("/api/voice", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: id }),
        keepalive: true,
      }).catch(() => {
        /* Server also enforces a session timeout. */
      });
  }, []);
  useEffect(() => {
    setPhase("idle");
    setSessionId("");
    setTranscript("");
    return () => cleanup();
  }, [cleanup, device.id, mode]);
  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await authenticatedFetch(
          `/api/voice?sessionId=${encodeURIComponent(sessionId)}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (!disposed && (!res.ok || !json.data?.active)) {
          cleanup();
          setSessionId("");
          setPhase("idle");
          setError(
            l(
              "جلسه توسط سرور پایان یافت یا دسترسی منابع تغییر کرد. برای زمینه پاک، جلسه تازه آغاز کنید.",
              "The server ended this session or source access changed. Start a new session with clean context.",
            ),
          );
          void refresh();
        }
      } catch {
        if (!disposed) {
          cleanup();
          setSessionId("");
          setPhase("error");
          setError(
            l(
              "ارتباط کنترل جلسه قطع شد؛ پخش صدا برای جلوگیری از استفاده از زمینه قدیمی متوقف شد.",
              "Session control disconnected. Playback stopped to avoid using stale context.",
            ),
          );
        }
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [sessionId, cleanup, l, refresh]);
  async function start() {
    if (!ready || active) return;
    cleanup();
    const current = generation.current;
    setPhase("connecting");
    setError("");
    setTranscript("");
    setMuted(false);
    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof RTCPeerConnection === "undefined"
      )
        throw new Error(
          l(
            "مرورگر از صوت امن پشتیبانی نمی‌کند. از HTTPS یا localhost و مرورگر به‌روز استفاده کنید.",
            "Secure browser audio is unavailable. Use HTTPS or localhost and a current browser.",
          ),
        );
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: microphone
          ? {
              deviceId: { exact: microphone },
              echoCancellation: true,
              noiseSuppression: true,
            }
          : { echoCancellation: true, noiseSuppression: true },
      });
      if (generation.current !== current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      localStream.current = stream;
      setMicrophones(
        (await navigator.mediaDevices.enumerateDevices()).filter(
          (item) => item.kind === "audioinput",
        ),
      );
      if (generation.current !== current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const pc = new RTCPeerConnection();
      connection.current = pc;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      pc.ontrack = (event) => {
        if (audio.current && generation.current === current) {
          audio.current.srcObject =
            event.streams[0] || new MediaStream([event.track]);
          void audio.current
            .play()
            .catch(() =>
              setError(
                l(
                  "پخش خودکار مسدود شد؛ دکمه پخش صدا را بزنید.",
                  "Autoplay was blocked. Use the audio playback controls.",
                ),
              ),
            );
        }
      };
      pc.onconnectionstatechange = () => {
        if (generation.current !== current) return;
        if (pc.connectionState === "connected") setPhase("listening");
        if (["failed", "disconnected"].includes(pc.connectionState)) {
          cleanup();
          setSessionId("");
          setPhase("error");
          setError(
            l(
              "ارتباط صوتی قطع شد. جلسه برای جلوگیری از پخش صدای قدیمی بسته شد.",
              "Voice connection lost. The session was closed to discard stale audio.",
            ),
          );
        }
      };
      const channel = pc.createDataChannel("oai-events");
      channel.onmessage = (event) => {
        if (generation.current !== current) return;
        try {
          const message = JSON.parse(String(event.data));
          if (message.type === "response.output_audio_transcript.delta")
            setTranscript((prev) =>
              (prev + String(message.delta || "")).slice(-12000),
            );
          if (
            message.type === "response.output_audio_transcript.done" &&
            message.transcript
          )
            setTranscript(String(message.transcript).slice(-12000));
          if (
            message.type ===
            "conversation.item.input_audio_transcription.completed"
          )
            setTranscript(String(message.transcript || "").slice(-12000));
          if (message.type === "input_audio_buffer.speech_started") {
            setPhase("listening");
            setTranscript("");
          }
          if (message.type === "input_audio_buffer.speech_stopped")
            setPhase("processing");
          if (message.type === "response.created") setPhase("speaking");
          if (message.type === "response.done") setPhase("listening");
          if (message.type === "error")
            setError(
              String(
                message.error?.message ||
                  l("خطای سرویس صوتی", "Voice provider error"),
              ),
            );
        } catch {
          /* Non-JSON or unsupported provider events are ignored; tools run on the server. */
        }
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (generation.current !== current) return;
      const controller = new AbortController();
      request.current = controller;
      const res = await authenticatedFetch("/api/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: device.id,
          preview: mode,
          sdp: offer.sdp,
        }),
        signal: controller.signal,
      });
      const json = await res.json();
      if (!res.ok || json.error)
        throw new Error(json.error?.message || "Voice session failed");
      if (generation.current !== current) {
        void authenticatedFetch("/api/voice", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: json.data.sessionId }),
        });
        return;
      }
      activeId.current = String(json.data.sessionId);
      setSessionId(activeId.current);
      await pc.setRemoteDescription({ type: "answer", sdp: json.data.sdp });
      const context = new AudioContext();
      audioContext.current = context;
      await context.resume();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      const buffer = new Uint8Array(analyser.frequencyBinCount);
      const draw = () => {
        if (generation.current !== current) return;
        const element = canvas.current;
        const drawing = element?.getContext("2d");
        if (element && drawing) {
          analyser.getByteTimeDomainData(buffer);
          drawing.clearRect(0, 0, element.width, element.height);
          drawing.beginPath();
          drawing.strokeStyle = "#42a892";
          drawing.lineWidth = 2;
          buffer.forEach((value, index) => {
            const x = (index / (buffer.length - 1)) * element.width;
            const y = (value / 255) * element.height;
            if (!index) drawing.moveTo(x, y);
            else drawing.lineTo(x, y);
          });
          drawing.stroke();
        }
        frame.current = requestAnimationFrame(draw);
      };
      draw();
    } catch (err) {
      if (generation.current !== current) return;
      cleanup();
      setSessionId("");
      setPhase("error");
      const message =
        err instanceof Error ? err.message : "Voice session failed";
      setError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? l(
              "اجازه دسترسی به میکروفون رد شد. مجوز سایت را بررسی و دوباره تلاش کنید.",
              "Microphone permission was denied. Check site permissions and retry.",
            )
          : message,
      );
    }
  }
  async function endSession(interrupted = false) {
    const id = activeId.current;
    cleanup(false);
    setSessionId("");
    setPhase("idle");
    if (id) {
      try {
        const res = await authenticatedFetch("/api/voice", {
          method: interrupted ? "POST" : "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(interrupted ? { action: "interrupt" } : {}),
            sessionId: id,
          }),
        });
        if (!res.ok) {
          const result = await res.json();
          throw new Error(
            result.error?.message ||
              "Server did not confirm session termination",
          );
        }
      } catch (err) {
        setError(
          l(
            "ضبط و پخش محلی متوقف شد، اما سرور پایان جلسه را تأیید نکرد: ",
            "Local capture and playback stopped, but the server did not confirm termination: ",
          ) + (err instanceof Error ? err.message : "Connection failed"),
        );
      }
    }
    void refresh();
  }
  return (
    <div className="voice-playground">
      <audio
        ref={audio}
        autoPlay
        controls={!!error && active}
        className="voice-audio"
      />
      <span className={cx("voice-orb", active && "connected")}>
        {muted ? <MicOff size={35} /> : <Mic size={35} />}
      </span>
      <h3>{t("voiceTest")}</h3>
      {ready ? (
        <Badge
          value={
            phase === "error" ? "error" : phase === "idle" ? "inactive" : phase
          }
        >
          {phase === "idle"
            ? l("آماده شروع", "Ready to start")
            : t(phase as TranslationKey)}
        </Badge>
      ) : (
        <Badge value="pending">
          {data.demo
            ? l("صوت زنده در دمو غیرفعال است", "Live voice is disabled in demo")
            : t("setup")}
        </Badge>
      )}
      <canvas
        className="voice-waveform"
        ref={canvas}
        width={400}
        height={70}
        aria-label={l(
          "موج واقعی ورودی میکروفون",
          "Live microphone input waveform",
        )}
        hidden={!active}
      />
      <p>
        {ready
          ? l(
              "شروع فقط با کلیک شما میکروفون را فعال می‌کند و می‌تواند مصرف سرویس داشته باشد. کنترل ابزارها و کلیدها روی سرور باقی می‌مانند.",
              "Starting explicitly enables your microphone and may incur provider usage. Tool execution and secrets remain on the server.",
            )
          : l(
              "برای صوت زنده، کلید و مدل Realtime را روی سرور تنظیم کنید. هیچ دسترسی خودکار به میکروفون انجام نمی‌شود.",
              "Configure the provider key and Realtime model on the server. Your microphone is never accessed automatically.",
            )}
      </p>
      <Field label={t("microphone")}>
        <select
          value={microphone}
          onChange={(e) => setMicrophone(e.target.value)}
          disabled={active || !ready}
        >
          <option value="">
            {l("میکروفون پیش‌فرض سیستم", "System default microphone")}
          </option>
          {microphones.map((item, index) => (
            <option key={item.deviceId || index} value={item.deviceId}>
              {item.label || `${t("microphone")} ${index + 1}`}
            </option>
          ))}
        </select>
      </Field>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {active ? (
        <div className="voice-buttons">
          <button
            className="button secondary"
            disabled={phase === "connecting"}
            onClick={() => {
              const next = !muted;
              localStream.current?.getAudioTracks().forEach((track) => {
                track.enabled = !next;
              });
              setMuted(next);
            }}
          >
            {muted ? <Mic size={17} /> : <MicOff size={17} />}
            {muted ? t("unmute") : t("mute")}
          </button>
          <button className="button danger" onClick={() => void endSession()}>
            <Square size={14} />
            {t("stop")}
          </button>
          <button
            className="button secondary"
            onClick={() => void endSession(true)}
          >
            <X size={16} />
            {l("قطع پاسخ و جلسه", "Interrupt & reset")}
          </button>
        </div>
      ) : (
        <button
          className="button primary"
          onClick={() => void start()}
          disabled={!ready}
        >
          <Mic size={17} />
          {phase === "error"
            ? t("retry")
            : l("شروع مکالمه صوتی", "Start voice conversation")}
        </button>
      )}
      {transcript && (
        <div className="voice-transcript" aria-live="polite">
          <span>{l("متن جاری", "Current transcript")}</span>
          <p>{transcript}</p>
        </div>
      )}
      <span className="fine-print">
        {device.privacy.storeTranscripts
          ? l("ذخیره متن مکالمه فعال است.", "Transcript storage is enabled.")
          : t("transcriptOff")}
      </span>
      {!ready && (
        <Link href="/settings/integrations" className="text-link">
          {t("integrations")}
          <ChevronLeft size={14} className="direction-arrow" />
        </Link>
      )}
    </div>
  );
}

function Conversations({ device }: { device: Device }) {
  const { data, t, l, locale, run, busy } = useApp();
  const [type, setType] = useState("all");
  const [start, setStart] = useState("");
  const [finish, setFinish] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Session | null>(null);
  const [deleting, setDeleting] = useState<Session | null>(null);
  const sessions = data.sessions
    .filter(
      (s) =>
        s.deviceId === device.id &&
        (type === "all" || s.type === type) &&
        (!start || s.startedAt.slice(0, 10) >= start) &&
        (!finish || s.startedAt.slice(0, 10) <= finish),
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const pages = Math.max(1, Math.ceil(sessions.length / 10));
  const current = Math.min(page, pages);
  const paged = sessions.slice((current - 1) * 10, current * 10);
  return (
    <>
      <div className="section-intro">
        <h2>{t("conversations")}</h2>
        <p>
          {l(
            "متادیتای جلسات واقعی و آزمایشی؛ متن فقط در صورت فعال‌بودن ذخیره‌سازی نگهداری می‌شود.",
            "Live and test session metadata. Transcripts are retained only when explicitly enabled.",
          )}
        </p>
      </div>
      <div className="session-filters">
        <Field label={t("type")}>
          <select
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setPage(1);
            }}
          >
            <option value="all">{t("all")}</option>
            <option value="test">{t("test")}</option>
            <option value="live">{t("live")}</option>
          </select>
        </Field>
        <Field label={l("از تاریخ", "From date")}>
          <input
            type="date"
            value={start}
            onChange={(e) => {
              setStart(e.target.value);
              setPage(1);
            }}
            dir="ltr"
          />
        </Field>
        <Field label={l("تا تاریخ", "To date")}>
          <input
            type="date"
            value={finish}
            onChange={(e) => {
              setFinish(e.target.value);
              setPage(1);
            }}
            dir="ltr"
          />
        </Field>
        <span className="result-count">
          {sessions.length.toLocaleString(locale)} {l("جلسه", "sessions")}
        </span>
      </div>
      <Panel>
        {paged.length ? (
          <>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{l("شناسه جلسه", "Session ID")}</th>
                    <th>{t("time")}</th>
                    <th>{t("type")}</th>
                    <th>{t("status")}</th>
                    <th>{l("ذخیره متن", "Transcript")}</th>
                    <th>
                      <span className="visually-hidden">{t("details")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {paged.map((session) => (
                    <tr key={session.id}>
                      <td>
                        <button
                          className="table-link mono"
                          dir="ltr"
                          onClick={() => setSelected(session)}
                        >
                          {session.id.slice(0, 8)}
                        </button>
                      </td>
                      <td>{date(session.startedAt, locale, true)}</td>
                      <td>
                        <span className={cx("badge", session.type)}>
                          {session.type === "test" ? t("test") : t("live")}
                        </span>
                      </td>
                      <td>
                        <Badge value={session.status} />
                      </td>
                      <td>
                        {session.transcriptStored
                          ? l("فعال", "Stored")
                          : l("خاموش", "Not stored")}
                      </td>
                      <td>
                        <div className="button-row">
                          <button
                            className="icon-button"
                            aria-label={t("sessionDetail")}
                            onClick={() => setSelected(session)}
                          >
                            <FileText size={16} />
                          </button>
                          <button
                            className="icon-button danger-text"
                            aria-label={t("remove")}
                            onClick={() => setDeleting(session)}
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <span>
                {l("صفحه", "Page")} {current.toLocaleString(locale)}{" "}
                {l("از", "of")} {pages.toLocaleString(locale)}
              </span>
              <div className="button-row">
                <button
                  className="icon-button"
                  disabled={current === 1}
                  aria-label={l("صفحه قبل", "Previous page")}
                  onClick={() => setPage(current - 1)}
                >
                  <ChevronRight className="direction-arrow" size={18} />
                </button>
                <button
                  className="icon-button"
                  disabled={current === pages}
                  aria-label={l("صفحه بعد", "Next page")}
                  onClick={() => setPage(current + 1)}
                >
                  <ChevronLeft className="direction-arrow" size={18} />
                </button>
              </div>
            </div>
          </>
        ) : (
          <Empty
            title={t("emptySessions")}
            description={t("emptySessionsSub")}
            icon={<MessageCircle size={28} />}
          />
        )}
      </Panel>
      {selected && (
        <Modal title={t("sessionDetail")} close={() => setSelected(null)} wide>
          <div className="session-detail-meta">
            <code dir="ltr">{selected.id}</code>
            <Badge value={selected.status} />
            <span>{date(selected.startedAt, locale, true)}</span>
            <span>v{selected.configVersion}</span>
          </div>
          {selected.error && (
            <div className="inline-error">{selected.error}</div>
          )}
          {!selected.transcriptStored ? (
            <div className="notice">
              <ShieldCheck size={20} />
              <div>
                <strong>{t("transcriptOff")}</strong>
                <p>
                  {l(
                    "متن این جلسه طبق تنظیم حریم خصوصی ذخیره نشده است؛ این وضعیت خطای دریافت متن نیست.",
                    "This transcript was not retained under the privacy policy. This is not a transcript retrieval error.",
                  )}
                </p>
              </div>
            </div>
          ) : selected.messages.length ? (
            <div className="transcript-messages">
              {selected.messages.map((message, index) => (
                <div key={index}>
                  <strong>{message.role}</strong>
                  <p>{message.text}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="quiet-empty">{t("noContent")}</div>
          )}
          <div className="form-actions">
            <button
              className="button secondary"
              onClick={() => setSelected(null)}
            >
              {t("close")}
            </button>
          </div>
        </Modal>
      )}
      {deleting && (
        <Modal
          title={l("حذف جلسه", "Delete session")}
          close={() => setDeleting(null)}
        >
          <p className="modal-copy">
            {l(
              "این جلسه و متن ذخیره‌شده آن حذف شود؟",
              "Delete this session and its stored transcript?",
            )}
          </p>
          <div className="form-actions">
            <button
              className="button danger"
              disabled={!!busy}
              onClick={async () => {
                if (
                  await run(
                    "delete_session",
                    { sessionId: deleting.id },
                    t("success"),
                  )
                )
                  setDeleting(null);
              }}
            >
              {t("remove")}
            </button>
            <button
              className="button secondary"
              onClick={() => setDeleting(null)}
            >
              {t("cancel")}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function DeviceSettings({ device }: { device: Device }) {
  return (
    <DeviceSettingsView device={device} context={useApp()} Dialog={Modal} />
  );
}

function Integrations() {
  const { data, t, l, run, busy } = useApp();
  const [result, setResult] = useState<ActionResult | null>(null);
  const rows = [
    {
      name: l("دیتابیس و فضای خصوصی", "Database & private storage"),
      icon: Database,
      configured: isConfigured(data.integrations.database),
      variable: "DATABASE_URL · PRIVATE_STORAGE_DIR",
    },
    {
      name: l("احراز هویت", "Authentication"),
      icon: ShieldCheck,
      configured: isConfigured(data.integrations.auth),
      variable: "SUPABASE_URL · SUPABASE_ANON_KEY",
    },
    {
      name: l("هوش مصنوعی OpenAI", "OpenAI provider"),
      icon: Sparkles,
      configured: isConfigured(data.integrations.openai),
      variable: "OPENAI_API_KEY · OPENAI_TEXT_MODEL · OPENAI_REALTIME_MODEL",
    },
    {
      name: l("سرور صوتی موجود", "Existing voice server"),
      icon: AudioLines,
      configured: isConfigured(data.integrations.voiceServer),
      variable: "VOICE_SERVER_URL",
    },
  ];
  return (
    <>
      <PageHeading
        title={t("integrations")}
        description={t("configDesc")}
        action={
          <button
            className="button primary"
            disabled={!!busy}
            onClick={async () => setResult(await run("integrations_test"))}
          >
            {busy === "integrations_test" ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <Zap size={17} />
            )}
            {t("testConnection")}
          </button>
        }
      />
      <div className="notice integrations-notice">
        <ShieldCheck size={22} />
        <div>
          <strong>
            {l(
              "کلیدها فقط در تنظیمات امن سرور",
              "Secrets belong in server configuration",
            )}
          </strong>
          <p>
            {l(
              "کلید اصلی را در مرورگر، localStorage یا متغیرهای NEXT_PUBLIC_ قرار ندهید. وضعیت پیکربندی به معنی تضمین دسترسی مدل نیست.",
              "Keep primary keys out of the browser, localStorage, and NEXT_PUBLIC_ variables. Configuration does not guarantee model access.",
            )}
          </p>
        </div>
      </div>
      <div className="integration-cards">
        {rows.map((row) => (
          <Panel key={row.name}>
            <div className="integration-card-head">
              <span className="integration-service-icon">
                <row.icon size={25} />
              </span>
              <Badge value={row.configured ? "active" : "pending"}>
                {row.configured ? t("configured") : t("setup")}
              </Badge>
            </div>
            <h2>{row.name}</h2>
            <p>
              {row.configured
                ? l(
                    "تنظیمات سرور موجود است. با اقدام صریح اتصال را آزمایش کنید.",
                    "Server configuration is present. Explicitly test the connection to verify access.",
                  )
                : l(
                    "متغیرهای لازم را در Environment امن سرور تنظیم کنید.",
                    "Set the required variables in the secure server environment.",
                  )}
            </p>
            <code className="env-variables" dir="ltr">
              {row.variable}
            </code>
          </Panel>
        ))}
      </div>
      <div className="form-aside-grid">
        <Panel title={l("پیکربندی قابل مشاهده", "Public connection details")}>
          <div className="config-summary">
            <div>
              <span>{t("model")}</span>
              <code dir="ltr">{data.integrations.model || t("setup")}</code>
            </div>
            <div>
              <span>{t("endpoint")}</span>
              <code dir="ltr" className="wrap-code">
                {data.integrations.voiceEndpoint || t("setup")}
              </code>
            </div>
            <div>
              <span>{l("حالت برنامه", "Application mode")}</span>
              <strong>
                {data.demo ? "Demo" : l("واقعی (بدون دمو)", "Real (non-demo)")}
              </strong>
            </div>
          </div>
        </Panel>
        <div className="guide-card compact">
          <BookOpen size={26} />
          <h3>{l("راهنمای اتصال", "Connection guide")}</h3>
          <p>
            {l(
              "متغیرهای لازم، راه‌اندازی Windows و Linux و نحوه اتصال سرور موجود در docs/setup.md و docs/integration-contract.md ثبت شده‌اند.",
              "Required variables, Windows and Linux setup, and the existing server adapter contract are documented in docs/setup.md and docs/integration-contract.md.",
            )}
          </p>
          <span className="subtle-tag">docs/setup.md</span>
        </div>
      </div>
      {result && (
        <Panel title={l("نتیجه آزمایش اتصال", "Connection test results")}>
          <div className="test-results">
            <pre dir="ltr">
              {JSON.stringify(
                Object.fromEntries(
                  Object.entries(result).filter(([key]) => key !== "bootstrap"),
                ),
                null,
                2,
              )}
            </pre>
          </div>
        </Panel>
      )}
    </>
  );
}
