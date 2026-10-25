// icons.js — static, author-written SVG icons (24×24, stroke = currentColor).
const a = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

export const ICONS = {
  mark: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#0E252C"/><path d="M16 26a10 10 0 1 1 10-10" fill="none" stroke="#E6EFF0" stroke-width="2" stroke-linecap="round" opacity=".45"/><path d="M16 21a5 5 0 1 1 5-5" fill="none" stroke="#E6EFF0" stroke-width="2" stroke-linecap="round" opacity=".8"/><path d="M16 16 24 8" stroke="#E6EFF0" stroke-width="2" stroke-linecap="round"/><circle cx="23.2" cy="20.6" r="2.6" fill="#E9AE34"/></svg>`,
  home: `<svg ${a}><path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/></svg>`,
  alerts: `<svg ${a}><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/></svg>`,
  scan: `<svg ${a}><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><path d="M12 12 18 6"/></svg>`,
  results: `<svg ${a}><path d="M4 20h16"/><path d="M7 16v-4"/><path d="M12 16V8"/><path d="M17 16v-7"/><path d="m6 9 4-3 4 2 5-4"/></svg>`,
  more: `<svg ${a}><circle cx="6" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18" cy="12" r="1.3" fill="currentColor"/></svg>`,
  sun: `<svg ${a}><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/></svg>`,
  moon: `<svg ${a}><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>`,
  preview: `<svg ${a}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/></svg>`,
  close: `<svg ${a}><path d="M6 6l12 12M18 6 6 18"/></svg>`,
  chevron: `<svg ${a}><path d="m9 5 7 7-7 7"/></svg>`,
  back: `<svg ${a}><path d="m15 5-7 7 7 7"/></svg>`,
  copy: `<svg ${a}><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>`,
  external: `<svg ${a}><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>`,
  portfolio: `<svg ${a}><rect x="3.5" y="7" width="17" height="12.5" rx="2"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7"/><path d="M3.5 12.5h17"/></svg>`,
  backtest: `<svg ${a}><path d="M9.5 3.5h5"/><path d="M10.5 3.5v6L5 18.5A1.5 1.5 0 0 0 6.3 20.7h11.4a1.5 1.5 0 0 0 1.3-2.2L13.5 9.5v-6"/><path d="M7.5 14.5h9"/></svg>`,
  settings: `<svg ${a}><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>`,
  about: `<svg ${a}><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><circle cx="12" cy="8" r=".6" fill="currentColor"/></svg>`,
  plus: `<svg ${a}><path d="M12 5v14M5 12h14"/></svg>`,
  shield: `<svg ${a}><path d="M12 3.5 19 6v5.5c0 4.3-3 7.5-7 9-4-1.5-7-4.7-7-9V6z"/></svg>`,
};
