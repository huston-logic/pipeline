// Every board page path, and the board's navigation. The accessibility test and `npm run screenshots` read
// `boardRoutes`; lighthouserc.cjs reads `lighthouseRoutes` with require(), so keep this file free of imports
// and of TypeScript-only syntax beyond type annotations.
// The two deal pages and the contact page are fixed ids from the fake seed (scripts/seed-dev.ts): dl_seed02 came in
// through the website form, so its page shows outside text; ct_seed07 has an open and a won deal. The form pages
// (decisions 0018, 0028, 0041) are Add a lead, Add a deal, Add contact, editing the form lead's contact (ct_seed02,
// outside values labelled), a new deal for ct_seed07, editing dl_seed01 and Qualify for ct_lead03. ct_lead03 is a Contacted lead
// (decision 0029). The import pages (decision 0036) are the seed's drafts: im_seed01 at the matching step, im_seed02
// at the check step, im_seed03 applied; the deals and tasks imports' first steps are their own pages (decision 0037).
// The views (decision 0042) are Partner's default view and the seed's saved views: vw_seed01 (people), vw_seed02 (deals),
// vw_seed03 (projects).
// The table layout (decision 0043) is the Pipeline's List (a table by default), Contacts and a saved people view.
// The timer pages (decision 0050): /timer/stop with no timer running (the seed starts none) and the seed's finished entry
// te_seed01 on /timer/done.
// The time pages (decision 0051): this week, another week by address, Add time and editing the seed's te_seed01.
// The campaign pages (decision 0053) are the seed's three: cp_seed01 (a draft to Partners: its review page and edit form),
// cp_seed02 (sent: its results, and the bounced filter) and cp_seed03 (a draft to people picked by hand: the picker).
// ct_seed08 unsubscribed from cp_seed02: her page shows the block and its "Allow campaign emails again" confirm page.

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
  | "email"
  | "time"
  | "projects"
  | "campaigns";

/** `hint` is read out after the label but not shown, where the label alone says too little ("More" alone fails
 * Lighthouse's descriptive-link-text audit). */
export type NavItem = { href: string; label: string; icon: IconName; description: string; hint?: string };

export const boardRoutes: string[] = [
  "/",
  "/?sort=newest",
  "/?show=standalone",
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
  "/contacts?layout=table",
  "/people?view=vw_seed01&layout=table",
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
  "/timer/stop",
  "/timer/done?entry=te_seed01",
  "/time",
  "/time?week=2026-11-16",
  "/time/new",
  "/time/te_seed01/edit",
  "/projects",
  "/projects?view=vw_seed03",
  "/projects/new",
  "/projects/pj_seed01",
  "/projects/pj_seed01/edit",
  "/contacts/ct_seed07/projects/new",
  "/deals/dl_seed07/projects/new",
  "/campaigns",
  "/campaigns/settings",
  "/campaigns/new",
  "/campaigns/cp_seed01",
  "/campaigns/cp_seed01/edit",
  "/campaigns/cp_seed02",
  "/campaigns/cp_seed02?status=bounced",
  "/campaigns/cp_seed03/people",
  "/contacts/ct_seed08",
  "/contacts/ct_seed08/campaign-emails/allow",
];

// Pages anyone can open, with no sign-in (the unsubscribe page, decision 0053). GET only, so a scan writes nothing. The
// token is the demo seed's fake one for rc_seed01, a delivered recipient of cp_seed02 (scripts/seed-dev.ts).
export const publicRoutes: string[] = ["/unsubscribe/test", "/unsubscribe/rcseed01FakeSeedTokenFakeSeedTokenFakeSeedT"];

/** At most this many pages go through Lighthouse, so the CI job's time stops growing with the board. */
export const LIGHTHOUSE_MAX_ROUTES = 20;

/**
 * The pages Lighthouse scores: one of each kind of board page (a list, a record page, a form, an import step, ...),
 * all from `boardRoutes`. Near-copies (another stage filter, the deals and tasks import's first step, a second saved
 * view) are left out; the accessibility test still covers every page in `boardRoutes`. A new kind of page takes a slot
 * here, swapping out a weaker one if the list is full.
 */
export const lighthouseRoutes: string[] = [
  "/",
  "/pipeline",
  "/pipeline?view=list",
  "/contacts",
  "/leads",
  "/people?view=vw_seed01",
  "/brief",
  "/more",
  "/rules",
  "/changes",
  "/report",
  "/notifications",
  "/deals/dl_seed02",
  "/contacts/ct_seed07",
  "/contacts/ct_seed02/edit",
  "/timer/done?entry=te_seed01",
  "/time",
  "/import",
  "/import/im_seed01",
  "/campaigns/cp_seed01",
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

/** Time, under More only while time tracking is on (decision 0051). */
export const timeItem: NavItem = {
  href: "/time",
  label: "Time",
  icon: "time",
  description: "The week's time entries and totals, adding time by hand, and the month's CSV.",
};

/** Projects, under More only while projects are on (decision 0055). */
export const projectsItem: NavItem = {
  href: "/projects",
  label: "Projects",
  icon: "projects",
  description: "Delivery work after a sale: each project's tasks, notes and time.",
};

/** Campaigns, under More only while campaigns are on (decision 0053). */
export const campaignsItem: NavItem = {
  href: "/campaigns",
  label: "Campaigns",
  icon: "campaigns",
  description: "Email newsletters and invites: drafts, review, sending and results.",
};

/** The More items for this copy: Time, Projects, then Campaigns, sit after "What it caught" when each is on. */
export function moreItemsFor(on: { timeTracking: boolean; campaigns: boolean; projects?: boolean }): NavItem[] {
  const extra = [...(on.timeTracking ? [timeItem] : []), ...(on.projects === true ? [projectsItem] : []), ...(on.campaigns ? [campaignsItem] : [])];
  if (extra.length === 0) return moreItems;
  const at = moreItems.findIndex((item) => item.href === "/report") + 1;
  return [...moreItems.slice(0, at), ...extra, ...moreItems.slice(at)];
}
