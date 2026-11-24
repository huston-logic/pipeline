// The board's line icons (docs/STYLE-GUIDE.md §8): 24 × 24, stroke 1.75 in the text colour, round caps and joins.
// Always beside a text label, so they are hidden from assistive technology. Markup written here, never data.
import { type Html, raw } from "./html.ts";
import type { IconName } from "./routes.ts";

const PATHS: Record<IconName, string> = {
  today:
    '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>' +
    '<circle cx="12" cy="15.25" r="1.5" fill="currentColor"/>',
  pipeline:
    '<rect x="3.5" y="4" width="4.5" height="16" rx="1.5"/><rect x="9.75" y="4" width="4.5" height="11.5" rx="1.5"/>' +
    '<rect x="16" y="4" width="4.5" height="7" rx="1.5"/>',
  contacts:
    '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 19.5c.8-3.4 3.4-5.5 6.5-5.5s5.7 2.1 6.5 5.5"/>' +
    '<path d="M15.5 4.8a3.5 3.5 0 0 1 0 6.4M17.5 14.3c2 .7 3.4 2.6 4 5.2"/>',
  brief:
    '<path d="M6.5 3.5h7.5l4.5 4.5v11a2 2 0 0 1-2 2h-10a2 2 0 0 1-2-2v-13.5a2 2 0 0 1 2-2z"/>' +
    '<path d="M14 3.5V8h4.5M8.5 12.5h7M8.5 16.5h5"/>',
  more: '<circle cx="5.5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18.5" cy="12" r="1.5"/>',
  rules: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  changes: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 4v4.5H8"/><path d="M12 7.5V12l3 2"/>',
  report:
    '<path d="M4.5 20.5h15"/><rect x="5.5" y="12" width="3.5" height="6.5" rx="1"/>' +
    '<rect x="10.25" y="7.5" width="3.5" height="11" rx="1"/><rect x="15" y="4" width="3.5" height="14.5" rx="1"/>',
  export:
    '<path d="M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5"/>' +
    '<path d="M4 15v3a2.5 2.5 0 0 0 2.5 2.5h11A2.5 2.5 0 0 0 20 18v-3"/>',
  import:
    '<path d="M12 14.5v-11M7.5 8 12 3.5 16.5 8"/>' +
    '<path d="M4 15v3a2.5 2.5 0 0 0 2.5 2.5h11A2.5 2.5 0 0 0 20 18v-3"/>',
  notifications:
    '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2H4.5z"/>' +
    '<path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
  time: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9v4.25l2.75 1.75M9.5 3.5h5"/>',
  email: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="M4.5 7.5l7.5 5.5 7.5-5.5"/>',
};

export function icon(name: IconName): Html {
  return raw(
    '<svg class="icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" ' +
      `stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`,
  );
}
