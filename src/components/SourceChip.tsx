import { createContext, useContext, type MouseEvent, type ReactNode } from "react";
import { api } from "../lib/api";
import { useSourceLogo, type Logo } from "../lib/sourceLogos";
import { canOpenSource, sourceKind, sourceLabel, sourceTooltip, type SourceKind } from "../lib/taskText";
import type { LookSettings, Task } from "../lib/types";

/** Settings → General → "Show where tasks came from": always, on hover, or never. */
export const SourceDisplay = createContext<LookSettings["show_source"]>("always");
export const useSourceDisplay = () => useContext(SourceDisplay);

const GLYPHS: Record<SourceKind, ReactNode> = {
  mail: (
    <>
      <rect x="2" y="3.5" width="12" height="9" rx="1.6" />
      <path d="m2.6 4.4 5.4 4.2 5.4-4.2" />
    </>
  ),
  chat: <path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5L4.5 14v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z" />,
  web: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M2.4 8h11.2M8 2.2c1.7 1.6 2.5 3.5 2.5 5.8S9.7 12.2 8 13.8C6.3 12.2 5.5 10.3 5.5 8S6.3 3.8 8 2.2Z" />
    </>
  ),
  doc: (
    <>
      <path d="M4 2.2h5.2L12.5 5.5v8.3H4Z" />
      <path d="M9 2.4v3.3h3.3" />
    </>
  ),
  app: <rect x="2.8" y="2.8" width="10.4" height="10.4" rx="2.6" />,
};

/**
 * Where a task came from — "from Mail", "from Slack", a site or a file — as
 * a small chip with an icon. Clicking it opens the exact email, message, page
 * or file when TodoCity kept a link, or the app itself when it didn't.
 */
export function SourceChip({ task, prefix = true, onFail }: { task: Task; prefix?: boolean; onFail?: (e: unknown) => void }) {
  const display = useSourceDisplay();
  const logo = useSourceLogo(task);
  const label = sourceLabel(task);
  if (!label || display === "never") return null;
  const kind = sourceKind(task);
  const tip = sourceTooltip(task);
  // With a logo, the logo says which app or site; the name moves to the
  // tooltip. A site without its own logo ("example.com") still shows its
  // name next to the browser's icon.
  const logoOnly = !!logo && (logo.site || label === (task.source_app ?? "").trim());
  const cls = ["src-chip", `src-${kind}`, logo ? "has-logo" : "", logoOnly ? "logo-only" : "", display === "hover" ? "hover-only" : ""]
    .filter(Boolean)
    .join(" ");
  const icon = logo ? (
    <img className={logo.dark ? "src-logo dark-tile" : "src-logo"} src={logo.src} width={14} height={14} alt="" aria-hidden draggable={false} />
  ) : (
    <svg className="src-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" aria-hidden>
      {GLYPHS[kind]}
    </svg>
  );
  const text = (
    <span className={logoOnly ? "src-text sr-only" : "src-text"}>
      {prefix && "from "}
      {label}
    </span>
  );
  if (!canOpenSource(task)) {
    return (
      <span className={cls} title={logoOnly ? `from ${label}` : undefined}>
        {icon}
        {text}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`${cls} link`}
      data-nodrag
      title={tip ?? `from ${label}`}
      aria-label={tip ?? `from ${label}`}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        void api.openSource(task.id).catch((err) => onFail?.(err));
      }}
    >
      {icon}
      {text}
    </button>
  );
}

/** Just the logo of where a task came from, inline, for tight spots like Calendar's all-day row. */
export function SourceMark({ task, size = 12 }: { task: Task; size?: number }) {
  const display = useSourceDisplay();
  const logo = useSourceLogo(task);
  const label = sourceLabel(task);
  if (!logo || display === "never") return null;
  return (
    <img
      className={logo.dark ? "src-mark dark-tile" : "src-mark"}
      src={logo.src}
      width={size}
      height={size}
      alt=""
      title={label ? `from ${label}` : undefined}
      draggable={false}
    />
  );
}

/**
 * A logo on a small tile at a block's top-right corner, as Calendar shows
 * where a task or meeting came from. `null` when there's nothing to show.
 */
export function LogoBadge({ logo, title }: { logo: Logo | null; title?: string }) {
  if (!logo) return null;
  return (
    <span className={logo.dark ? "src-badge dark" : "src-badge"} title={title} aria-hidden>
      <img src={logo.src} alt="" draggable={false} />
    </span>
  );
}

/** The corner badge for a task: where it came from, if not added in TodoCity. */
export function SourceBadge({ task }: { task: Task }) {
  const display = useSourceDisplay();
  const logo = useSourceLogo(task);
  const label = sourceLabel(task);
  if (display === "never") return null;
  return <LogoBadge logo={logo} title={label ? `from ${label}` : undefined} />;
}
