/* Inline SVG icons: 24 × 24, stroke = currentColor, 2 px round strokes.
   The same drawing style (and many of the same icons) as Fetch, so the tools look related. */

const svg = (d) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

export const ICONS = {
  alert: svg('<path d="M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>'),
  arrowLeft: svg('<path d="M19 12H5m0 0 6.5 6.5M5 12l6.5-6.5"/>'),
  caret: svg('<path d="m6 9 6 6 6-6"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  external: svg('<path d="M14 3.5h6.5V10M20.5 3.5 11 13"/><path d="M18 14v4.5a2.5 2.5 0 0 1-2.5 2.5h-10A2.5 2.5 0 0 1 3 18.5v-10A2.5 2.5 0 0 1 5.5 6H10"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  inbox: svg('<path d="M3 13.5h5l1.5 2.5h5l1.5-2.5h5"/><path d="M5.5 5h13l2.5 8.5V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4.5z"/>'),
  link: svg('<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>'),
  logout: svg('<path d="M14.5 4H18a2.5 2.5 0 0 1 2.5 2.5v11A2.5 2.5 0 0 1 18 20h-3.5"/><path d="M10 16.5 5.5 12 10 7.5M5.5 12h10"/>'),
  monitor: svg('<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8.5 21h7M12 17v4"/>'),
  moon: svg('<path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z"/>'),
  pencil: svg('<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4.5 1.5L5 15z"/>'),
  planet: svg('<circle cx="12" cy="12" r="5.5"/><path d="M6.8 13.9c-3 1.9-4.5 3.7-3.9 4.6.9 1.5 6.2-.6 11.8-4.7S22.9 6.4 22 4.9c-.6-.9-2.8-.6-5.6.7"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  refresh: svg('<path d="M20.5 12a8.5 8.5 0 0 1-14.9 5.6M3.5 12A8.5 8.5 0 0 1 18.4 6.4"/><path d="M18.5 2.5v4h-4M5.5 21.5v-4h4"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.5-4.5"/>'),
  sortDown: svg('<path d="M7 4v16m0 0-3.5-3.5M7 20l3.5-3.5"/><path d="M14 6h7M14 12h5M14 18h3"/>'),
  sortUp: svg('<path d="M7 20V4m0 0L3.5 7.5M7 4l3.5 3.5"/><path d="M14 6h3M14 12h5M14 18h7"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>'),
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
};
