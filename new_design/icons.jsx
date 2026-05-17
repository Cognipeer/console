/* global React */
// Tabler-style icon set — original SVG paths, ~24px stroke icons
// Usage: <Icon name="brain" size={18} />

const ICON_PATHS = {
  // Build
  brain: <><path d="M15.5 13a3.5 3.5 0 0 0-3.5 3.5v1a3.5 3.5 0 0 0 7 0V17"/><path d="M8.5 13a3.5 3.5 0 0 1 3.5 3.5v1a3.5 3.5 0 0 1-7 0V17"/><path d="M17.5 16a3.5 3.5 0 0 0 0-7H17"/><path d="M19 9.3V7.5a3.5 3.5 0 0 0-7 0v9"/><path d="M6.5 16a3.5 3.5 0 0 1 0-7H7"/><path d="M5 9.3V7.5a3.5 3.5 0 0 1 7 0v9"/></>,
  sparkles: <><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/></>,
  robot: <><rect x="4" y="6" width="16" height="14" rx="3"/><circle cx="9" cy="13" r="1.2" fill="currentColor"/><circle cx="15" cy="13" r="1.2" fill="currentColor"/><path d="M9 17h6M12 3v3M8 6V4M16 6V4"/></>,
  tool: <><path d="m14.5 6 2.5-2.5a3 3 0 1 1 4 4L18.5 10M14.5 6 7.4 13.1c-.4.4-.6.9-.6 1.4v2.5a2 2 0 0 1-.6 1.4l-1.7 1.7M14.5 6l4 4M7 14l3 3"/></>,
  api: <><path d="M3 12h4l3-8 4 16 3-8h4"/></>,

  // Data
  vector: <><circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 8c8 0 8 8 8 8"/><path d="m13 4 2 3-3 2"/></>,
  bulb: <><path d="M9 18h6M10 21h4M12 3a7 7 0 0 0-4 12.7c.7.5 1 1.3 1 2.1V18h6v-.2c0-.8.3-1.6 1-2.1A7 7 0 0 0 12 3Z"/></>,
  folder: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></>,
  book: <><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5v-17Z"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/></>,

  // Operate
  dashboard: <><rect x="3" y="3" width="8" height="10" rx="1.5"/><rect x="13" y="3" width="8" height="6" rx="1.5"/><rect x="13" y="11" width="8" height="10" rx="1.5"/><rect x="3" y="15" width="8" height="6" rx="1.5"/></>,
  timeline: <><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 8v8M8 6l8 5M8 18l8-5"/></>,
  serverbolt: <><rect x="3" y="4" width="18" height="7" rx="2"/><path d="M3 15v3a2 2 0 0 0 2 2h7"/><circle cx="7" cy="7.5" r="1" fill="currentColor"/><path d="m16 14-3 4h3l-1 3 4-5h-3l1-2Z" fill="currentColor"/></>,
  shield: <><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z"/></>,
  world: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18"/></>,
  bell: <><path d="M6 9a6 6 0 1 1 12 0c0 4 2 5 2 7H4c0-2 2-3 2-7"/><path d="M10 20a2 2 0 0 0 4 0"/></>,

  // Admin
  users: <><circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3 3-5 6-5s6 2 6 5"/><circle cx="17" cy="9" r="2.5"/><path d="M21 19c0-2.2-1.8-3.5-4-3.5"/></>,
  plug: <><path d="M9 7V3M15 7V3"/><rect x="7" y="7" width="10" height="6" rx="1"/><path d="M12 13v4a3 3 0 0 0 3 3"/></>,
  key: <><circle cx="7.5" cy="14.5" r="3.5"/><path d="m10 12 9-9M16 6l3 3M14 8l3 3"/></>,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></>,
  clipboard: <><rect x="6" y="4" width="12" height="17" rx="2"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/></>,
  certificate: <><circle cx="12" cy="10" r="5"/><path d="m9 14-1 7 4-2 4 2-1-7"/></>,

  // Generic
  search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
  plus: <><path d="M12 5v14M5 12h14"/></>,
  chevronDown: <><path d="m6 9 6 6 6-6"/></>,
  chevronRight: <><path d="m9 6 6 6-6 6"/></>,
  chevronLeft: <><path d="m15 6-6 6 6 6"/></>,
  arrowRight: <><path d="M5 12h14M13 6l6 6-6 6"/></>,
  arrowUp: <><path d="M12 19V5M6 11l6-6 6 6"/></>,
  arrowDown: <><path d="M12 5v14M6 13l6 6 6-6"/></>,
  more: <><circle cx="12" cy="5" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="19" r="1.5" fill="currentColor"/></>,
  filter: <><path d="M4 5h16l-6 8v6l-4-2v-4Z"/></>,
  refresh: <><path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5"/></>,
  external: <><path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></>,
  check: <><path d="M5 12.5 10 17 19 7"/></>,
  x: <><path d="M6 6l12 12M18 6l-12 12"/></>,
  moon: <><path d="M21 12.8a9 9 0 1 1-9.8-9.8 7 7 0 0 0 9.8 9.8Z"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="m19.4 15-1 2 .8 1.5-1.5 1.5L16 19l-2 1-.5 2h-3l-.5-2-2-1-1.7.9L4.8 18.5l1-1.5-1-2-2-.5v-3l2-.5 1-2L4.8 6l1.5-1.5L8 5.5l2-1L10.5 2.5h3l.5 2 2 1 1.7-.9L19.2 6l-1 1.5 1 2 2 .5v3l-2 .5Z"/></>,
  help: <><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.5.3-1 .9-1 1.7v.5M12 17.5v.01"/></>,
  doc: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z"/><path d="M13 3v6h6M8 13h8M8 17h5"/></>,
  play: <><path d="M7 5v14l12-7Z"/></>,
  pause: <><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></>,
  trash: <><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/></>,
  edit: <><path d="M4 20h4l11-11-4-4L4 16v4Z"/><path d="m13 6 4 4"/></>,
  download: <><path d="M12 4v12M6 12l6 6 6-6M4 20h16"/></>,
  upload: <><path d="M12 20V8M6 12l6-6 6 6M4 20h16"/></>,
  send: <><path d="M5 12 19 5l-5 14-3-7-6-1.5Z"/></>,
  globe: <><circle cx="12" cy="12" r="9"/><path d="M3.5 9h17M3.5 15h17M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18"/></>,
  zap: <><path d="m13 2-9 12h7l-1 8 9-12h-7l1-8Z"/></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></>,
  star: <><path d="m12 3 2.6 6 6.4.5-4.9 4.2 1.5 6.3L12 17l-5.6 3 1.5-6.3L3 9.5 9.4 9 12 3Z"/></>,
  pin: <><path d="M9 4h6M11 4v8M7 12h10M9 12v6l3 3 3-3v-6"/></>,
  layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5M3 17l9 5 9-5"/></>,
  bolt: <><path d="m13 3-9 11h7l-1 7 9-11h-7l1-7Z"/></>,
  cube: <><path d="m12 3 9 5v8l-9 5-9-5V8l9-5Z"/><path d="m3 8 9 5 9-5M12 13v9"/></>,
  graph: <><path d="M4 20V8M9 20V12M14 20V4M19 20V14"/></>,
  command: <><path d="M9 6V4.5A1.5 1.5 0 1 0 7.5 6H9Zm0 0v12m0 0v1.5A1.5 1.5 0 1 0 7.5 18H9Zm0 0h6m0 0V6m0 0V4.5A1.5 1.5 0 1 1 16.5 6H15Zm0 12h1.5A1.5 1.5 0 1 1 15 19.5V18ZM9 6h6"/></>,
  arrowsLeftRight: <><path d="M7 7 3 11l4 4M3 11h12M17 17l4-4-4-4M21 13H9"/></>,
  spinner: <><circle cx="12" cy="12" r="9" opacity=".25"/><path d="M21 12a9 9 0 0 0-9-9"/></>,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></>,
  flag: <><path d="M5 21V4h13l-2 4 2 4H5"/></>,
};

function Icon({ name, size = 18, stroke = 1.6, className = '', style = {} }) {
  const content = ICON_PATHS[name];
  if (!content) return null;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flexShrink: 0, ...style }}
      aria-hidden="true"
    >
      {content}
    </svg>
  );
}

window.Icon = Icon;
