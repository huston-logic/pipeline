// Every board page path. The accessibility test and lighthouserc.cjs read this list, and lighthouserc.cjs loads it
// with require(), so keep this file free of imports and of TypeScript-only syntax beyond type annotations.
// The two deal pages are fixed ids from the fake seed (scripts/seed-dev.ts): dl_seed02 came in through the website
// form, so its page shows outside text.

export type NavItem = { href: string; label: string };

export const boardRoutes: string[] = ["/", "/deals/dl_seed01", "/deals/dl_seed02", "/brief", "/rules", "/changes", "/export"];

export const navItems: NavItem[] = [
  { href: "/", label: "Board" },
  { href: "/brief", label: "Brief" },
  { href: "/rules", label: "Rules" },
  { href: "/changes", label: "Changes" },
  { href: "/export", label: "Export" },
];
