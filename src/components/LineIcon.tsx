/**
 * One set of line icons, drawn on the same 24-point grid with the same
 * stroke, so the sidebar, settings and task fields read as one family.
 * They take the text color: grey by default, the accent when selected.
 */
const PATHS = {
  today: <path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" />,
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  inbox: (
    <>
      <path d="M3.5 13.5V17a3 3 0 0 0 3 3h11a3 3 0 0 0 3-3v-3.5" />
      <path d="M3.5 13.5 6 6.2A2 2 0 0 1 7.9 4.8h8.2a2 2 0 0 1 1.9 1.4l2.5 7.3h-5l-1.2 2.3h-4.6l-1.2-2.3z" />
    </>
  ),
  overdue: (
    <>
      <circle cx="12" cy="12.5" r="8" />
      <path d="M12 8.5v4.2l2.8 1.8M4.5 4.5 2.8 6.2M19.5 4.5l1.7 1.7" />
    </>
  ),
  done: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.3 12.2 2.5 2.5 5-5.2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2.5" y="5.5" width="19" height="13" rx="3" />
      <path d="M6.5 9.5h.01M10 9.5h.01M13.5 9.5h.01M17 9.5h.01M6.5 12.5h.01M10 12.5h.01M13.5 12.5h.01M17 12.5h.01M8 15.5h8" />
    </>
  ),
  // A toothed gear (eight teeth), so Settings never reads as a sun.
  gear: (
    <>
      <path d="M10.13 5.25 L10.64 2.90 L13.36 2.90 L13.87 5.25 L15.45 5.91 L17.47 4.60 L19.40 6.53 L18.09 8.55 L18.75 10.13 L21.10 10.64 L21.10 13.36 L18.75 13.87 L18.09 15.45 L19.40 17.47 L17.47 19.40 L15.45 18.09 L13.87 18.75 L13.36 21.10 L10.64 21.10 L10.13 18.75 L8.55 18.09 L6.53 19.40 L4.60 17.47 L5.91 15.45 L5.25 13.87 L2.90 13.36 L2.90 10.64 L5.25 10.13 L5.91 8.55 L4.60 6.53 L6.53 4.60 L8.55 5.91Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  appearance: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5v17" />
      <path d="M12 3.5a8.5 8.5 0 0 0 0 17z" fill="currentColor" stroke="none" opacity=".3" />
    </>
  ),
  bell: (
    <>
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2H4.5z" />
      <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
    </>
  ),
  command: (
    <path d="M9 9V6.5A2.5 2.5 0 1 0 6.5 9H9zm0 0h6m-6 0v6m6-6V6.5A2.5 2.5 0 1 1 17.5 9H15zm0 0v6m0 0h-6m6 0v2.5a2.5 2.5 0 1 0 2.5-2.5H15zm-6 0v2.5A2.5 2.5 0 1 1 6.5 15H9z" />
  ),
  modes: (
    <>
      <path d="M12 3.5 3.5 8 12 12.5 20.5 8z" />
      <path d="m3.5 12 8.5 4.5 8.5-4.5M3.5 16l8.5 4.5 8.5-4.5" />
    </>
  ),
  city: (
    <>
      <path d="M3 20.5h18M5 20.5V9.5l5-2.5v13.5M10 20.5V4.5l6 2.5v13.5M16 10.5l3 1.5v8.5" />
      <path d="M7.3 12h.01M7.3 15h.01M12.8 9h.01M12.8 12h.01M12.8 15h.01" />
    </>
  ),
  macs: (
    <>
      <rect x="3" y="4.5" width="13" height="9" rx="1.8" />
      <path d="M1.8 16.5h15.4" />
      <rect x="15" y="9.5" width="6.5" height="10" rx="1.5" />
    </>
  ),
  plug: <path d="M9 7.5V3.5M15 7.5V3.5M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0zM12 16v4.5" />,
  sparkle: (
    <>
      <path d="M12 3.5c.5 4.2 2.3 6 6.5 6.5-4.2.5-6 2.3-6.5 6.5-.5-4.2-2.3-6-6.5-6.5 4.2-.5 6-2.3 6.5-6.5z" />
      <path d="M18.5 15.5c.2 1.6.9 2.3 2.5 2.5-1.6.2-2.3.9-2.5 2.5-.2-1.6-.9-2.3-2.5-2.5 1.6-.2 2.3-.9 2.5-2.5z" />
    </>
  ),
  import: (
    <>
      <path d="M12 3.5v10.5m0 0-4-4m4 4 4-4" />
      <path d="M4 14.5v2.5a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-2.5" />
    </>
  ),
  backup: (
    <>
      <ellipse cx="12" cy="6" rx="7.5" ry="2.8" />
      <path d="M4.5 6v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6M4.5 12v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-6" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.7M12 16.8h.01" />
    </>
  ),
  building: (
    <path d="M5 20.5V5.5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v15M3 20.5h18M9 7.5h.01M15 7.5h.01M9 11.5h.01M15 11.5h.01M9 15.5h.01M15 15.5h.01M11 20.5v-3h2v3" />
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  // A stopwatch: how long a task takes.
  timer: (
    <>
      <circle cx="12" cy="13.5" r="7.5" />
      <path d="M12 9.5v4l2.5 1.5M9.5 2.5h5M12 2.5V6" />
    </>
  ),
  repeat: (
    <>
      <path d="M17 3.5 20 6.5l-3 3" />
      <path d="M4 12v-1.5a4 4 0 0 1 4-4h12M7 20.5l-3-3 3-3" />
      <path d="M20 12v1.5a4 4 0 0 1-4 4H4" />
    </>
  ),
  flag: <path d="M5.5 21V4.5M5.5 4.5h11l-2 4 2 4h-11" />,
  flagFilled: <path d="M5.5 21V4.5M5.5 4.5h11l-2 4 2 4h-11z" fill="currentColor" fillOpacity=".3" />,
  target: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r=".8" fill="currentColor" />
    </>
  ),
  checklist: (
    <>
      <path d="M9.5 6.5h11M9.5 12h11M9.5 17.5h11" />
      <path d="m3.5 6.5 1.4 1.4 2.4-2.6M3.5 12l1.4 1.4 2.4-2.6" />
      <circle cx="5.3" cy="17.5" r="1.4" />
    </>
  ),
  tag: (
    <>
      <path d="M3.5 12.2V5.5a2 2 0 0 1 2-2h6.7l8.3 8.3a2 2 0 0 1 0 2.8l-5.9 5.9a2 2 0 0 1-2.8 0z" />
      <circle cx="8.3" cy="8.3" r="1.3" />
    </>
  ),
  more: (
    <>
      <circle cx="6" cy="12" r="1.3" fill="currentColor" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" />
      <circle cx="18" cy="12" r="1.3" fill="currentColor" />
    </>
  ),
  chevronDown: <path d="m7 10 5 5 5-5" />,
  chevronRight: <path d="m10 7 5 5-5 5" />,
  chevronUp: <path d="m7 14 5-5 5 5" />,
  external: <path d="M14 4.5h5.5V10M19.5 4.5 11 13M18 14v4a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V8.5a2 2 0 0 1 2-2H10" />,
  snooze: (
    <>
      <circle cx="12" cy="13" r="7.5" />
      <path d="M9.5 10.5h5l-5 5h5M4.5 4.5l2 2M19.5 4.5l-2 2" />
    </>
  ),
  someday: (
    <>
      <rect x="3.5" y="7.5" width="17" height="12" rx="2" />
      <path d="M3.5 7.5 6 4h12l2.5 3.5M9.5 12h5" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="12" height="12" rx="2.5" />
      <path d="M15.5 8.5v-2a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6.5v6.5A2.5 2.5 0 0 0 6 15.5h2.5" />
    </>
  ),
  trash: (
    <path d="M4.5 7h15M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2M6.5 7l1 12a2 2 0 0 0 2 1.8h5a2 2 0 0 0 2-1.8l1-12" />
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  eye: <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12zM12 14.8a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6z" />,
  delegate: <path d="M5.5 5h13a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM7.5 10l3 2.5-3 2.5M12.5 15.5h4" />,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  sliders: (
    <>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </>
  ),
  star: <path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" />,
} as const;

export type IconName = keyof typeof PATHS;

export function LineIcon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `licon ${className}` : "licon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[name]}
    </svg>
  );
}
