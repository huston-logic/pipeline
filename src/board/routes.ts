// Every board page path, and the board's navigation. The accessibility test, `npm run screenshots` and
// lighthouserc.cjs read `boardRoutes`, and lighthouserc.cjs loads it with require(), so keep this file free of imports
// and of TypeScript-only syntax beyond type annotations.
// The two deal pages and the contact page are fixed ids from the fake seed (scripts/seed-dev.ts): dl_seed02 came in
// through the website form, so its page shows outside text; ct_seed07 has an open and a won deal.

export type IconName = "today" | "pipeline" | "contacts" | "brief" | "more" | "rules" | "changes" | "export";

/** `hint` is read out after the label but not shown, where the label alone says too little ("More" alone fails
 * Lighthouse's descriptive-link-text audit). */
export type NavItem = { href: string; label: string; icon: IconName; description: string; hint?: string };

export const boardRoutes: string[] = [
  "/",
  "/pipeline",
  "/pipeline?view=list",
  "/contacts",
  "/companies",
  "/brief",
  "/more",
  "/rules",
  "/changes",
  "/export",
  "/deals/dl_seed01",
  "/deals/dl_seed02",
  "/contacts/ct_seed07",
];

/** The phone tab bar and the top of the side bar, in this order. */
export const navItems: NavItem[] = [
  { href: "/", label: "Today", icon: "today", description: "What is overdue and due today." },
  { href: "/pipeline", label: "Pipeline", icon: "pipeline", description: "Open deals by stage." },
  { href: "/contacts", label: "Contacts", icon: "contacts", description: "Everyone you are talking to." },
  { href: "/brief", label: "Brief", icon: "brief", description: "The latest daily brief." },
  { href: "/more", label: "More", icon: "more", description: "Rules, changes and export.", hint: " pages" },
];

/** Under More: on the /more page on phones, listed in the side bar on wide screens. */
export const moreItems: NavItem[] = [
  { href: "/rules", label: "Rules", icon: "rules", description: "Your follow-up rules, and whether each one is on." },
  { href: "/changes", label: "Changes", icon: "changes", description: "Every change from the last 30 days, with its change id." },
  { href: "/export", label: "Export", icon: "export", description: "Download a copy of everything, as JSON or CSV." },
];
