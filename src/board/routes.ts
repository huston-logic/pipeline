// Every board page path, and the board's navigation. The accessibility test, `npm run screenshots` and
// lighthouserc.cjs read `boardRoutes`, and lighthouserc.cjs loads it with require(), so keep this file free of imports
// and of TypeScript-only syntax beyond type annotations.
// The two deal pages and the contact page are fixed ids from the fake seed (scripts/seed-dev.ts): dl_seed02 came in
// through the website form, so its page shows outside text; ct_seed07 has an open and a won deal. The form pages
// (decisions 0018, 0028, 0041) are Add a lead, Add a deal, Add contact, editing the form lead's contact (ct_seed02,
// outside values labelled), a new deal for ct_seed07, editing dl_seed01 and Qualify for ct_lead03. ct_lead03 is a Contacted lead
// (decision 0029). The import pages (decision 0036) are the seed's drafts: im_seed01 at the matching step, im_seed02
// at the check step, im_seed03 applied; the deals and tasks imports' first steps are their own pages (decision 0037).
// The views (decision 0042) are Partner's default view and the seed's saved views: vw_seed01 (people), vw_seed02 (deals).

export type IconName =
  | "today"
  | "pipeline"
  | "contacts"
  | "brief"
  | "more"
  | "rules"
  | "changes"
  | "report"
  | "export"
  | "import"
  | "notifications"
  | "email";

/** `hint` is read out after the label but not shown, where the label alone says too little ("More" alone fails
 * Lighthouse's descriptive-link-text audit). */
export type NavItem = { href: string; label: string; icon: IconName; description: string; hint?: string };

export const boardRoutes: string[] = [
  "/",
  "/pipeline",
  "/pipeline?view=list",
  "/pipeline?view=list&stage=new_inquiry",
  "/contacts",
  "/companies",
  "/leads",
  "/leads?status=closed",
  "/people?status=partner",
  "/people?view=vw_seed01",
  "/pipeline?view=vw_seed02",
  "/brief",
  "/more",
  "/rules",
  "/changes",
  "/report",
  "/export",
  "/notifications",
  "/email-log",
  "/deals/dl_seed01",
  "/deals/dl_seed02",
  "/contacts/ct_seed07",
  "/contacts/ct_lead03",
  "/leads/new",
  "/deals/new",
  "/contacts/new",
  "/contacts/ct_seed02/edit",
  "/contacts/ct_seed07/deals/new",
  "/contacts/ct_lead03/qualify",
  "/deals/dl_seed01/edit",
  "/import",
  "/import?module=deals",
  "/import?module=tasks",
  "/import/im_seed01",
  "/import/im_seed02/preview",
  "/import/im_seed03",
];

/** The phone tab bar and the top of the side bar, in this order. */
export const navItems: NavItem[] = [
  { href: "/", label: "Today", icon: "today", description: "What is overdue and due today." },
  { href: "/pipeline", label: "Pipeline", icon: "pipeline", description: "Open deals by stage." },
  { href: "/contacts", label: "People", icon: "contacts", description: "Contacts, leads and companies." },
  { href: "/brief", label: "Brief", icon: "brief", description: "The latest daily brief." },
  {
    href: "/more",
    label: "More",
    icon: "more",
    description: "Rules, changes, the monthly report, export, import, notifications and email logging.",
    hint: " pages",
  },
];

/** Under More: on the /more page on phones, listed in the side bar on wide screens. */
export const moreItems: NavItem[] = [
  { href: "/rules", label: "Rules", icon: "rules", description: "Your follow-up rules, and whether each one is on." },
  { href: "/changes", label: "Changes", icon: "changes", description: "Every change from the last 30 days, with its change id." },
  { href: "/report", label: "What it caught", icon: "report", description: "Last month: what your rules did, and how many nudges you acted on." },
  { href: "/export", label: "Export", icon: "export", description: "Download a copy of everything, as JSON or CSV." },
  { href: "/import", label: "Import", icon: "import", description: "Bring in people, deals or tasks from a spreadsheet, as a CSV file." },
  { href: "/notifications", label: "Notifications", icon: "notifications", description: "A phone notification when the daily brief is ready." },
  { href: "/email-log", label: "Email logging", icon: "email", description: "The address to add in Bcc, so an email you send is logged." },
];
