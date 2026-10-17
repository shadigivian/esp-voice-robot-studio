"use client";

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  Clock3,
  Info,
  LoaderCircle,
  Moon,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Volume2,
} from "lucide-react";
import type { Device, Command } from "../lib/domain";
import type { AppContextType } from "./control-panel";

type Props = {
  device: Device;
  context: AppContextType;
  Dialog: ComponentType<{
    title: string;
    children: ReactNode;
    close: () => void;
    wide?: boolean;
  }>;
};

export default function DeviceSettingsView({ device, context, Dialog }: Props) {
  const { data, locale, t, l, run, busy, refresh } = context;
  const router = useRouter();
  const [name, setName] = useState(device.name);
  const [transcripts, setTranscripts] = useState(
    device.privacy.storeTranscripts,
  );
  const [retention, setRetention] = useState(
    String(device.privacy.retentionDays),
  );
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null);
  const [confirmation, setConfirmation] = useState<"reboot" | "revoke" | null>(
    null,
  );
  const [leaveHref, setLeaveHref] = useState<string | null>(null);
  const [nameSaved, setNameSaved] = useState(false);
  const [privacySaved, setPrivacySaved] = useState(false);
  const viewer = data.user.role === "viewer";
  const blocked = viewer || !!busy;
  const canCommand = !blocked && device.provisioning === "paired";
  const nameDirty = name !== device.name;
  const privacyDirty =
    transcripts !== device.privacy.storeTranscripts ||
    (transcripts && Number(retention) !== device.privacy.retentionDays);
  const dirty = nameDirty || privacyDirty;
  const retentionValid =
    !transcripts ||
    (/^\d+$/.test(retention) &&
      Number(retention) >= 1 &&
      Number(retention) <= 90);
  const commands = device.commands.slice().reverse().slice(0, 10);
  const hasPendingCommands = commands.some(
    (command) => command.status === "pending",
  );
  useEffect(() => {
    if (!hasPendingCommands) return;
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 4000);
    return () => clearInterval(timer);
  }, [hasPendingCommands, refresh]);
  const lastVolume = device.commands
    .slice()
    .reverse()
    .find(
      (command) =>
        command.type === "volume" &&
        command.status === "applied" &&
        typeof command.payload.value === "number",
    );

  useEffect(() => {
    setName(device.name);
  }, [device.id, device.name]);
  useEffect(() => {
    setTranscripts(device.privacy.storeTranscripts);
    setRetention(String(device.privacy.retentionDays));
  }, [
    device.id,
    device.privacy.storeTranscripts,
    device.privacy.retentionDays,
  ]);
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const onNavigate = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest<HTMLAnchorElement>("a[href]");
      if (!link || link.target === "_blank" || link.hasAttribute("download"))
        return;
      const url = new URL(link.href, window.location.href);
      if (
        url.origin !== window.location.origin ||
        (url.pathname === window.location.pathname &&
          url.search === window.location.search)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setLeaveHref(url.pathname + url.search + url.hash);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onNavigate, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onNavigate, true);
    };
  }, [dirty]);

  const formatDate = (value: string | null) => {
    if (!value || Number.isNaN(new Date(value).getTime()))
      return l("هنوز گزارشی نرسیده", "Not reported yet");
    return new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : "en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  };
  const commandName = (type: string) => {
    const labels: Record<string, string> = {
      volume: l("تنظیم صدای بلندگو", "Speaker volume"),
      reboot: l("راه‌اندازی مجدد", "Restart device"),
      display_sleep: l("خواب نمایشگر", "Display sleep"),
      config: l("تنظیمات دستگاه", "Device configuration"),
    };
    return labels[type] || l("فرمان دستگاه", "Device command");
  };
  const commandStatus = (status: Command["status"]) =>
    ({
      pending: l("منتظر تأیید دستگاه", "Awaiting device acknowledgment"),
      applied: l("تأییدشده توسط دستگاه", "Acknowledged by device"),
      failed: l("اجرا نشد", "Could not apply"),
    })[status];
  const friendlyError = (error: string | null) =>
    error === "ACK timeout"
      ? l(
          "دستگاه در زمان مقرر پاسخ نداد. اتصال را بررسی کنید و دوباره فرمان بفرستید.",
          "The device did not respond in time. Check its connection before trying again.",
        )
      : error === "Firmware rejected command"
        ? l(
            "دستگاه این فرمان را نپذیرفت. پشتیبانی firmware را بررسی کنید.",
            "The device rejected this command. Check firmware support.",
          )
        : l(
            "فرمان با خطا روبه‌رو شد. جزئیات فنی در پایین قابل مشاهده است.",
            "The command failed. Technical details are available below.",
          );
  const sendCommand = async (
    type: "volume" | "display_sleep" | "reboot",
    payload: Record<string, unknown>,
  ) => {
    if (!canCommand || !device.capabilities.includes(type)) return false;
    return !!(await run(
      "command",
      { deviceId: device.id, type, payload },
      l(
        "فرمان ارسال شد؛ اجرای آن پس از تأیید دستگاه مشخص می‌شود.",
        "Command queued. Application will be confirmed by the device.",
      ),
    ));
  };
  const statusLabel =
    device.connectivity === "online"
      ? l("متصل", "Online")
      : device.connectivity === "offline"
        ? l("قطع ارتباط", "Offline")
        : l("وضعیت اتصال نامشخص", "Connection unknown");
  const provisioningLabel =
    device.provisioning === "paired"
      ? l("مالکیت تأییدشده", "Paired")
      : device.provisioning === "revoked"
        ? l("دسترسی لغوشده", "Access revoked")
        : l("در انتظار تأیید مالکیت", "Awaiting pairing");

  return (
    <>
      <div className="section-intro">
        <h2>{t("deviceSettings")}</h2>
        <p>
          {l(
            "همه‌چیز برای مدیریت دستگاه، صدا و حریم خصوصی شما.",
            "Make this device yours. Manage its identity, sound, and privacy.",
          )}
        </p>
      </div>
      {viewer && (
        <div className="notice settings-readonly">
          <ShieldCheck size={19} />
          <p>
            {l(
              "دسترسی شما فقط برای مشاهده است. برای تغییر تنظیمات با مدیر فضای کاری تماس بگیرید.",
              "You have view-only access. Ask a workspace administrator to change these settings.",
            )}
          </p>
        </div>
      )}
      <div className="settings-layout">
        <aside className="settings-index">
          <nav
            aria-label={l("بخش‌های تنظیمات دستگاه", "Device settings sections")}
            className="settings-index-links"
          >
            <a href="#device-identity">
              <Settings2 size={17} />
              {l("مشخصات دستگاه", "Device identity")}
            </a>
            <a href="#device-privacy">
              <ShieldCheck size={17} />
              {t("privacy")}
            </a>
            <a href="#device-audio">
              <Volume2 size={17} />
              {l("صدا و کنترل‌ها", "Sound & controls")}
            </a>
            <a href="#device-lifecycle">
              <RefreshCw size={17} />
              {l("مدیریت دسترسی", "Device access")}
            </a>
          </nav>
          <div className="device-state-card">
            <span className="section-label">
              {l("وضعیت دستگاه", "DEVICE STATUS")}
            </span>
            <strong>{device.name}</strong>
            <span className={`badge ${device.connectivity}`}>
              {statusLabel}
            </span>
            <dl className="settings-summary-grid">
              <div>
                <dt>{l("مالکیت", "Pairing")}</dt>
                <dd>{provisioningLabel}</dd>
              </div>
              <div>
                <dt>{l("آخرین ارتباط", "Last seen")}</dt>
                <dd>{formatDate(device.lastSeen)}</dd>
              </div>
              <div>
                <dt>{l("نشانی MAC", "MAC address")}</dt>
                <dd className="mono" dir="ltr">
                  {device.mac}
                </dd>
              </div>
              <div>
                <dt>{l("نسخه ارسال‌شده", "Desired version")}</dt>
                <dd dir="ltr">{device.configVersion}</dd>
              </div>
              <div>
                <dt>{l("نسخه تأییدشده", "Applied version")}</dt>
                <dd>
                  {device.appliedVersion === null
                    ? l("هنوز تأیید نشده", "Not acknowledged")
                    : device.appliedVersion}
                </dd>
              </div>
            </dl>
            <p className="field-hint">
              {l(
                "وضعیت اتصال بر اساس آخرین گزارش دستگاه است.",
                "Connection status reflects the device’s latest report.",
              )}
            </p>
          </div>
        </aside>

        <div className="device-settings-content">
          <section
            className="settings-section"
            id="device-identity"
            aria-labelledby="identity-title"
          >
            <div className="settings-title">
              <span className="section-label">
                {l("دستگاه شما", "YOUR DEVICE")}
              </span>
              <h3 id="identity-title">
                {l("یک نام آشنا", "Give it a familiar name")}
              </h3>
              <p>
                {l(
                  "نامی انتخاب کنید که پیدا کردن ربات را در فضای کاری آسان کند.",
                  "Choose a name that makes your robot easy to find in the workspace.",
                )}
              </p>
            </div>
            <form
              data-testid="device-name-form"
              onSubmit={async (event) => {
                event.preventDefault();
                if (blocked || !name.trim() || !nameDirty) return;
                if (
                  await run(
                    "rename_device",
                    { deviceId: device.id, name: name.trim() },
                    t("saved"),
                  )
                ) {
                  setName(name.trim());
                  setNameSaved(true);
                }
              }}
            >
              <div className="setting-row">
                <div className="setting-copy">
                  <label htmlFor="device-display-name">
                    {l("نام نمایشی ربات", "Robot display name")}
                  </label>
                  <p>
                    {l(
                      "این نام فقط در پنل مدیریت نمایش داده می‌شود.",
                      "This name appears in your management panel.",
                    )}
                  </p>
                </div>
                <div className="setting-control">
                  <input
                    id="device-display-name"
                    name="name"
                    required
                    maxLength={80}
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value);
                      setNameSaved(false);
                    }}
                    disabled={viewer || !!busy}
                    autoComplete="off"
                  />
                </div>
              </div>
              <div className="settings-save-bar">
                <span
                  role="status"
                  className={nameDirty ? "settings-unsaved" : "settings-saved"}
                >
                  {nameDirty ? (
                    l("تغییرات ذخیره نشده", "Unsaved changes")
                  ) : nameSaved ? (
                    <>
                      <Check size={15} />
                      {l("نام دستگاه ذخیره شد", "Device name saved")}
                    </>
                  ) : (
                    ""
                  )}
                </span>
                <button
                  type="submit"
                  className="button primary"
                  disabled={blocked || !nameDirty || !name.trim()}
                >
                  {busy === "rename_device" && (
                    <LoaderCircle className="spin" size={16} />
                  )}
                  {l("ذخیره نام", "Save name")}
                </button>
              </div>
            </form>
          </section>

          <section
            className="settings-section"
            id="device-privacy"
            aria-labelledby="privacy-title"
          >
            <div className="settings-title">
              <span className="section-label">
                {l("تحت کنترل شما", "YOU’RE IN CONTROL")}
              </span>
              <h3 id="privacy-title">{t("privacy")}</h3>
              <p>
                {l(
                  "مشخص کنید متن مکالمه‌ها ذخیره شود و تا چه زمانی نگهداری شود.",
                  "Choose whether conversation transcripts are saved and how long they are kept.",
                )}
              </p>
            </div>
            <form
              data-testid="device-privacy-form"
              onSubmit={async (event) => {
                event.preventDefault();
                if (blocked || !privacyDirty || !retentionValid) return;
                if (
                  await run(
                    "save_privacy",
                    {
                      deviceId: device.id,
                      storeTranscripts: transcripts,
                      retentionDays: transcripts
                        ? Number(retention)
                        : device.privacy.retentionDays,
                    },
                    t("saved"),
                  )
                )
                  setPrivacySaved(true);
              }}
            >
              <div className="setting-row">
                <div className="setting-copy">
                  <label id="transcripts-label">
                    {l("ذخیره متن مکالمه", "Store conversation transcripts")}
                  </label>
                  <p id="transcripts-hint">
                    {l(
                      "قبل از فعال‌سازی، به افراد حاضر در مکالمه اطلاع دهید. صدای خام ذخیره نمی‌شود.",
                      "Let conversation participants know before enabling this. Raw audio is not stored.",
                    )}
                  </p>
                </div>
                <div className="setting-control">
                  <button
                    type="button"
                    className="switch-control"
                    role="switch"
                    aria-checked={transcripts}
                    aria-labelledby="transcripts-label"
                    aria-describedby="transcripts-hint"
                    disabled={blocked}
                    onClick={() => {
                      setTranscripts(!transcripts);
                      setPrivacySaved(false);
                    }}
                  >
                    <span aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div className="setting-row">
                <div className="setting-copy">
                  <label htmlFor="transcript-retention">
                    {l("مدت نگهداری", "Retention period")}
                  </label>
                  <p id="retention-hint">
                    {l(
                      "متن‌های ذخیره‌شده پس از این مدت در پاک‌سازی زمان‌بندی‌شده حذف می‌شوند.",
                      "Saved transcripts are removed by scheduled cleanup after this period.",
                    )}
                  </p>
                </div>
                <div className="setting-control">
                  <input
                    id="transcript-retention"
                    name="retentionDays"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={90}
                    required={transcripts}
                    value={retention}
                    aria-describedby="retention-hint"
                    disabled={blocked || !transcripts}
                    onChange={(event) => {
                      setRetention(event.target.value);
                      setPrivacySaved(false);
                    }}
                  />
                  <span className="field-hint">
                    {l("روز (۱ تا ۹۰)", "days (1–90)")}
                  </span>
                </div>
              </div>
              <div className="notice">
                <ShieldCheck size={18} />
                <p>
                  {transcripts
                    ? l(
                        "متن مکالمه طبق مدت انتخاب‌شده نگهداری می‌شود. تنظیمات حریم خصوصی را متناسب با مخاطبان خود انتخاب کنید.",
                        "Conversation text is retained for the selected period. Choose settings appropriate for your audience.",
                      )
                    : l(
                        "ذخیره متن خاموش است. پرسش‌ها، پاسخ‌ها و خروجی ابزارها در گزارش‌های فنی ثبت نمی‌شوند؛ فقط فراداده فنی حداقلی نگهداری می‌شود.",
                        "Transcript storage is off. Prompts, responses, and tool output are excluded from telemetry; only minimal technical metadata is retained.",
                      )}
                </p>
              </div>
              <div className="settings-save-bar">
                <span
                  role="status"
                  className={
                    privacyDirty ? "settings-unsaved" : "settings-saved"
                  }
                >
                  {privacyDirty ? (
                    l(
                      "تغییرات حریم خصوصی ذخیره نشده",
                      "Unsaved privacy changes",
                    )
                  ) : privacySaved ? (
                    <>
                      <Check size={15} />
                      {l(
                        "تنظیمات حریم خصوصی ذخیره شد",
                        "Privacy settings saved",
                      )}
                    </>
                  ) : (
                    ""
                  )}
                </span>
                <button
                  type="submit"
                  className="button primary"
                  disabled={blocked || !privacyDirty || !retentionValid}
                >
                  {busy === "save_privacy" && (
                    <LoaderCircle className="spin" size={16} />
                  )}
                  {l("ذخیره حریم خصوصی", "Save privacy")}
                </button>
              </div>
            </form>
          </section>

          <section
            className="settings-section"
            id="device-audio"
            aria-labelledby="audio-title"
          >
            <div className="settings-title">
              <span className="section-label">
                {l("کنترل از راه دور", "REMOTE CONTROLS")}
              </span>
              <h3 id="audio-title">
                {l("صدا و کنترل‌های دستگاه", "Sound & device controls")}
              </h3>
              <p>
                {l(
                  "فرمان‌ها به دستگاه ارسال می‌شوند؛ نتیجه بعد از دریافت تأیید دستگاه نمایش داده می‌شود.",
                  "Commands are sent to your device. Results appear once the device acknowledges them.",
                )}
              </p>
            </div>
            {device.provisioning !== "paired" && (
              <div className="notice">
                <Info size={18} />
                <p>
                  {l(
                    "برای ارسال فرمان ابتدا اتصال و مالکیت دستگاه را تأیید کنید.",
                    "Pair this device before sending remote commands.",
                  )}
                </p>
              </div>
            )}
            <div className="setting-row">
              <div className="setting-copy">
                <strong>
                  <Volume2 size={18} />
                  {l("صدای بلندگو", "Speaker volume")}
                </strong>
                <p>
                  {device.capabilities.includes("volume")
                    ? l(
                        "یک سطح صدا انتخاب کنید و فرمان را بفرستید.",
                        "Choose an output level, then send the command.",
                      )
                    : l(
                        "نسخه فعلی firmware قابلیت تنظیم صدا را گزارش نکرده است.",
                        "This firmware has not reported support for volume control.",
                      )}
                </p>
                {lastVolume && (
                  <p>
                    {l("آخرین فرمان تأییدشده:", "Last acknowledged command:")}{" "}
                    <b dir="ltr">{Number(lastVolume.payload.value)}%</b>
                  </p>
                )}
              </div>
              <div className="setting-control">
                <label htmlFor="speaker-volume" className="field-hint">
                  {volumeDraft === null ? (
                    l("سطح جدید را انتخاب کنید", "Choose a new level")
                  ) : (
                    <span dir="ltr">{volumeDraft}%</span>
                  )}
                </label>
                <input
                  id="speaker-volume"
                  type="range"
                  min={0}
                  max={100}
                  value={volumeDraft ?? 0}
                  onChange={(event) =>
                    setVolumeDraft(Number(event.target.value))
                  }
                  onPointerDown={() => {
                    if (volumeDraft === null) setVolumeDraft(0);
                  }}
                  disabled={
                    !canCommand || !device.capabilities.includes("volume")
                  }
                  aria-label={l("سطح صدای جدید بلندگو", "New speaker volume")}
                />
                <button
                  type="button"
                  className="button secondary"
                  disabled={
                    !canCommand ||
                    !device.capabilities.includes("volume") ||
                    volumeDraft === null
                  }
                  onClick={() => {
                    if (volumeDraft !== null)
                      void sendCommand("volume", { value: volumeDraft });
                  }}
                >
                  {l("ارسال سطح صدا", "Send volume")}
                </button>
              </div>
            </div>
            <div className="setting-row">
              <div className="setting-copy">
                <strong>
                  <Moon size={18} />
                  {l("خواب نمایشگر", "Display sleep")}
                </strong>
                <p>
                  {device.capabilities.includes("display_sleep")
                    ? l(
                        "نمایشگر دستگاه را با یک فرمان به حالت خواب ببرید.",
                        "Put the device display to sleep with a remote command.",
                      )
                    : l(
                        "خواب نمایشگر در firmware این دستگاه پشتیبانی نشده است.",
                        "Display sleep is not supported by this device’s firmware.",
                      )}
                </p>
              </div>
              {device.capabilities.includes("display_sleep") && (
                <div className="setting-control">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={!canCommand}
                    onClick={() =>
                      void sendCommand("display_sleep", { enabled: true })
                    }
                  >
                    {l("خواب نمایشگر", "Sleep display")}
                  </button>
                </div>
              )}
            </div>
            <div className="setting-row">
              <div className="setting-copy">
                <strong>
                  <RefreshCw size={18} />
                  {l("راه‌اندازی مجدد", "Restart device")}
                </strong>
                <p>
                  {device.capabilities.includes("reboot")
                    ? l(
                        "ممکن است مکالمه جاری قطع شود. دستگاه پس از راه‌اندازی دوباره متصل می‌شود.",
                        "An active conversation may be interrupted. The device reconnects after restarting.",
                      )
                    : l(
                        "راه‌اندازی مجدد از راه دور در firmware این دستگاه پشتیبانی نشده است.",
                        "Remote restart is not supported by this device’s firmware.",
                      )}
                </p>
              </div>
              {device.capabilities.includes("reboot") && (
                <div className="setting-control">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={!canCommand}
                    onClick={() => setConfirmation("reboot")}
                  >
                    {l("راه‌اندازی مجدد…", "Restart…")}
                  </button>
                </div>
              )}
            </div>
            <details className="settings-capabilities">
              <summary>
                {l(
                  "قابلیت‌های فنی گزارش‌شده",
                  "Reported firmware capabilities",
                )}
              </summary>
              {device.capabilities.length ? (
                <div className="capability-tags">
                  {device.capabilities.map((capability) => (
                    <code key={capability} className="subtle-tag" dir="ltr">
                      {capability}
                    </code>
                  ))}
                </div>
              ) : (
                <p className="field-hint">
                  {l(
                    "دستگاه هنوز قابلیتی گزارش نکرده است.",
                    "The device has not reported any capabilities yet.",
                  )}
                </p>
              )}
            </details>
          </section>

          <section
            className="settings-section"
            aria-labelledby="commands-title"
          >
            <div className="settings-title">
              <span className="section-label">
                {l("نتیجه فرمان‌ها", "COMMAND ACTIVITY")}
              </span>
              <h3 id="commands-title">
                {l("فرمان‌های اخیر", "Recent commands")}
              </h3>
              <p>
                {l(
                  "ثبت فرمان به معنی اجرا نیست؛ تأیید واقعی دستگاه را اینجا بررسی کنید.",
                  "Queuing a command does not confirm execution. Check device acknowledgments here.",
                )}
              </p>
              <button
                className="button ghost small"
                type="button"
                onClick={() => void refresh()}
              >
                <RefreshCw size={16} />
                {l("به‌روزرسانی وضعیت", "Refresh activity")}
              </button>
            </div>
            {commands.length ? (
              <div className="settings-command-history">
                {commands.map((command) => (
                  <article className="settings-command-item" key={command.id}>
                    <div className="settings-command-meta">
                      <strong>{commandName(command.type)}</strong>
                      <time dateTime={command.createdAt}>
                        {formatDate(command.createdAt)}
                      </time>
                    </div>
                    <span className={`badge ${command.status}`}>
                      {command.status === "pending" && <Clock3 size={13} />}
                      {command.status === "applied" && <Check size={13} />}
                      {commandStatus(command.status)}
                    </span>
                    {command.status === "failed" && (
                      <p className="field-hint">
                        {friendlyError(command.error)}
                      </p>
                    )}
                    <details>
                      <summary>{l("جزئیات فنی", "Technical details")}</summary>
                      <code className="wrap-code" dir="ltr">
                        {command.id}
                      </code>
                      {command.error && <p dir="ltr">{command.error}</p>}
                    </details>
                  </article>
                ))}
              </div>
            ) : (
              <div className="quiet-empty">
                <Clock3 size={24} />
                <p>
                  {l(
                    "هنوز فرمانی ارسال نشده است.",
                    "No commands have been sent yet.",
                  )}
                </p>
              </div>
            )}
          </section>

          <section
            className="settings-section danger-zone"
            id="device-lifecycle"
            aria-labelledby="access-title"
          >
            <div className="settings-title">
              <span className="section-label">
                {l("مدیریت دسترسی", "DEVICE ACCESS")}
              </span>
              <h3 id="access-title">
                {l("لغو اتصال و مالکیت", "Revoke & unpair")}
              </h3>
              <p>
                {l(
                  "برای واگذاری دستگاه یا توقف دسترسی آن، اتصال را لغو کنید. اعتبارنامه‌ها و نشست‌های فعال فوراً لغو می‌شوند و اتصال دوباره به تأیید مالکیت نیاز دارد.",
                  "Unpair this device to transfer it or stop its access. Credentials and active sessions are immediately revoked. Connecting again requires ownership verification.",
                )}
              </p>
            </div>
            <button
              type="button"
              className="button danger-soft"
              disabled={blocked || device.provisioning === "revoked"}
              onClick={() => setConfirmation("revoke")}
            >
              <ShieldCheck size={17} />
              {device.provisioning === "revoked"
                ? l("دسترسی قبلاً لغو شده", "Access already revoked")
                : l("لغو اتصال و مالکیت…", "Revoke & unpair…")}
            </button>
          </section>
        </div>
      </div>

      {confirmation && (
        <Dialog
          title={
            confirmation === "reboot"
              ? l("دستگاه دوباره راه‌اندازی شود؟", "Restart this device?")
              : l("دسترسی دستگاه لغو شود؟", "Revoke device access?")
          }
          close={() => setConfirmation(null)}
        >
          <p className="modal-copy">
            {confirmation === "reboot"
              ? l(
                  `راه‌اندازی مجدد «${device.name}» ممکن است مکالمه جاری را قطع کند. پس از ارسال فرمان، منتظر تأیید دستگاه بمانید.`,
                  `Restarting “${device.name}” may interrupt an active conversation. Wait for device acknowledgment after the command is sent.`,
                )
              : l(
                  `دسترسی «${device.name}» فوراً لغو می‌شود. نشست‌های فعال پایان می‌یابند و برای اتصال دوباره باید مالکیت تأیید شود.`,
                  `Access for “${device.name}” will be revoked immediately. Active sessions end and reconnecting requires ownership verification.`,
                )}
          </p>
          <div className="form-actions">
            <button
              type="button"
              className={`button ${confirmation === "revoke" ? "danger" : "primary"}`}
              disabled={blocked}
              onClick={async () => {
                const success =
                  confirmation === "reboot"
                    ? await sendCommand("reboot", {})
                    : !!(await run(
                        "revoke_device",
                        { deviceId: device.id },
                        t("success"),
                      ));
                if (success) setConfirmation(null);
              }}
            >
              {!!busy && <LoaderCircle className="spin" size={16} />}
              {confirmation === "reboot"
                ? l("ارسال فرمان راه‌اندازی", "Send restart command")
                : l("لغو دسترسی", "Revoke access")}
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => setConfirmation(null)}
            >
              {t("cancel")}
            </button>
          </div>
        </Dialog>
      )}
      {leaveHref && (
        <Dialog
          title={l("تغییرات ذخیره‌نشده", "Unsaved changes")}
          close={() => setLeaveHref(null)}
        >
          <p className="modal-copy">
            {l(
              "با خروج از این صفحه، تغییرات ذخیره‌نشده نام یا حریم خصوصی از دست می‌رود.",
              "Leaving this page will discard your unsaved name or privacy changes.",
            )}
          </p>
          <div className="form-actions">
            <button
              type="button"
              className="button primary"
              onClick={() => setLeaveHref(null)}
            >
              {l("ماندن در صفحه", "Stay on page")}
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                const href = leaveHref;
                setLeaveHref(null);
                router.push(href);
              }}
            >
              {l("خروج بدون ذخیره", "Leave without saving")}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
