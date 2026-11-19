// Every board page path, and the board's navigation. The accessibility test, `npm run screenshots` and
// lighthouserc.cjs read `boardRoutes`, and lighthouserc.cjs loads it with require(), so keep this file free of imports
// and of TypeScript-only syntax beyond type annotations.
// The two deal pages are fixed ids from the fake seed (scripts/seed-dev.ts): dl_seed02 came in through the website
// form, so its page shows outside text.

export type IconName = "today" | "pipeline" | "contacts" | "brief" | "more" | "rules" | "changes" | "export";

export type NavItem = { href: string; label: string; icon: IconName; description: string };

export const boardRoutes: string[] = [
  "/",
  "/pipeline",
  "/contacts",
  "/brief",
  "/more",
  "/rules",
  "/changes",
  "/export",
  "/deals/dl_seed01",
  "/deals/dl_seed02",
];

/** The phone tab bar and the top of the side bar, in this order. */
export const navItems: NavItem[] = [
  { href: "/", label: "Today", icon: "today", description: "What is overdue and due today." },
  { href: "/pipeline", label: "Pipeline", icon: "pipeline", description: "Open deals by stage." },
  { href: "/contacts", label: "Contacts", icon: "contacts", description: "Everyone you are talking to." },
  { href: "/brief", label: "Brief", icon: "brief", description: "The latest daily brief." },
  { href: "/more", label: "More", icon: "more", description: "Rules, changes and export." },
];

/** Under More: on the /more page on phones, listed in the side bar on wide screens. */
export const moreItems: NavItem[] = [
  { href: "/rules", label: "Rules", icon: "rules", description: "Your follow-up rules, and whether each one is on." },
  { href: "/changes", label: "Changes", icon: "changes", description: "Every change from the last 30 days, with its change id." },
  { href: "/export", label: "Export", icon: "export", description: "Download a copy of everything, as JSON or CSV." },
];
