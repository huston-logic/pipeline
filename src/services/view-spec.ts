// What a saved view can hold (decision 0042), per module: its filters, sorts, columns and the built-in views it sits
// after. Pure: no database. Stored filters use the keys of migration 0013 (person_status, sub_status, source, q,
// fields, stage); the MCP tools take and answer the same filters in camelCase, like every other tool input.
import type { ViewLayout, ViewModule } from "../db/db.ts";
import { UserError } from "./errors.ts";
import { parseObject, parseStringArray } from "./lookup.ts";

export const VIEW_MODULES = ["people", "deals", "projects"] as const satisfies readonly ViewModule[];
export const VIEW_LAYOUTS = ["cards", "table"] as const satisfies readonly ViewLayout[];

export type Dir = "asc" | "desc";

/** Each module's sorts, with the direction each one takes when none is given. */
export const VIEW_SORTS = {
  people: { name: "asc", business: "asc", last_activity: "desc", next_task: "asc", created: "desc" },
  deals: { days_in_stage: "desc", value: "desc", next_date: "asc", created: "desc" },
  projects: { target: "asc", name: "asc", newest: "desc", start: "asc" },
} as const satisfies Record<ViewModule, Record<string, Dir>>;

export type PeopleSort = keyof typeof VIEW_SORTS.people;
export type DealsSort = keyof typeof VIEW_SORTS.deals;
export type ProjectsSort = keyof typeof VIEW_SORTS.projects;
export type SortKey = PeopleSort | DealsSort | ProjectsSort;

/** Every sort key of every module, once each ("name" is both People's and Projects'). */
export const ALL_SORT_KEYS: readonly SortKey[] = [
  ...new Set([
    ...(Object.keys(VIEW_SORTS.people) as PeopleSort[]),
    ...(Object.keys(VIEW_SORTS.deals) as DealsSort[]),
    ...(Object.keys(VIEW_SORTS.projects) as ProjectsSort[]),
  ]),
];

export interface ViewSort {
  key: SortKey;
  dir: Dir;
}

export const DEFAULT_SORT: Record<ViewModule, ViewSort> = {
  people: { key: "name", dir: "asc" },
  deals: { key: "days_in_stage", dir: "desc" },
  projects: { key: "target", dir: "asc" },
};

export const sortText = (sort: ViewSort) => `${sort.key}-${sort.dir}`;

export const sortsOf = (module: ViewModule): Record<string, Dir> => VIEW_SORTS[module];

/** A stored sort, or the module's default when it can't be read (a row written by hand). */
export function parseSort(module: ViewModule, text: string): ViewSort {
  const [key = "", dir = ""] = text.split("-");
  const sorts = sortsOf(module);
  if (!Object.hasOwn(sorts, key) || (dir !== "asc" && dir !== "desc")) return DEFAULT_SORT[module];
  return { key: key as SortKey, dir };
}

/** How each sort reads: "by name, A to Z". */
export const SORT_WORDS: Record<SortKey, Record<Dir, string>> = {
  name: { asc: "by name, A to Z", desc: "by name, Z to A" },
  business: { asc: "by company, A to Z", desc: "by company, Z to A" },
  last_activity: { desc: "latest activity first", asc: "oldest activity first" },
  next_task: { asc: "soonest next task first", desc: "latest next task first" },
  created: { desc: "newest first", asc: "oldest first" },
  days_in_stage: { desc: "longest in their stage first", asc: "newest in their stage first" },
  value: { desc: "highest value first", asc: "lowest value first" },
  next_date: { asc: "soonest next date first", desc: "latest next date first" },
  target: { asc: "soonest target date first", desc: "latest target date first" },
  newest: { desc: "newest first", asc: "oldest first" },
  start: { asc: "earliest start first", desc: "latest start first" },
};

/** The built-in columns of each module, with the header each one has. A custom field's column is "fields.<key>". */
export const VIEW_COLUMNS = {
  people: {
    name: "Name",
    business: "Company",
    email: "Email",
    phone: "Phone",
    source: "Source",
    person_status: "Person status",
    sub_status: "Sub-status",
    next_task: "Next task",
    last_activity: "Last activity",
    created: "Added",
  },
  deals: {
    deal: "Deal",
    person: "Person",
    stage: "Stage",
    value: "Value",
    next_step: "Next step",
    next_date: "Next date",
    days_in_stage: "Days in stage",
    source: "Source",
    created: "Added",
  },
  projects: {
    project: "Project",
    status: "Status",
    person: "Person",
    deal: "Deal",
    start: "Start",
    target: "Target",
    open_tasks: "Open tasks",
  },
} as const satisfies Record<ViewModule, Record<string, string>>;

export const columnsOf = (module: ViewModule): Record<string, string> => VIEW_COLUMNS[module];

/** The facts a project page can show (run 12, ruling 8): the projects columns but the name, plus the total time. */
export const PROJECT_FACT_KEYS = [...(Object.keys(VIEW_COLUMNS.projects) as (keyof typeof VIEW_COLUMNS.projects)[]).filter((key) => key !== "project"), "time"] as const;
export const PROJECT_FACT_LABELS: Record<string, string> = { ...VIEW_COLUMNS.projects, time: "Time" };
export const MAX_PROJECT_FACTS = 20;
const FACT_FIELD = "fields.";

/** The facts shown with nothing chosen: the standard ones, then every live custom project field. */
const defaultFacts = (liveFieldKeys: readonly string[], timeTracking: boolean): string[] => [
  "status", "person", "deal", "start", "target",
  ...(timeTracking ? ["time"] : []),
  ...liveFieldKeys.map((key) => `${FACT_FIELD}${key}`),
];

/** Every fact that can be chosen now, in the order the chooser lists the unchosen ones. */
export const possibleFacts = (liveFieldKeys: readonly string[], timeTracking: boolean): string[] => [
  ...PROJECT_FACT_KEYS.filter((key) => key !== "time" || timeTracking),
  ...liveFieldKeys.map((key) => `${FACT_FIELD}${key}`),
];

/** The facts the project page shows, in order: the stored list without keys that no longer apply, or the default. */
export function projectFacts(stored: { project_facts: string | null }, liveFieldKeys: readonly string[], timeTracking: boolean): string[] {
  const fallback = defaultFacts(liveFieldKeys, timeTracking);
  if (stored.project_facts === null) return fallback;
  let keys: string[];
  try {
    keys = parseStringArray(stored.project_facts);
  } catch {
    return fallback;
  }
  const live = new Set(liveFieldKeys.map((key) => `${FACT_FIELD}${key}`));
  const known = new Set<string>(PROJECT_FACT_KEYS);
  return keys.filter((key) => (known.has(key) && (key !== "time" || timeTracking)) || live.has(key));
}

/** The keys as given when each is a project fact, listed once, at most 20; a UserError in plain words otherwise. */
export function checkProjectFacts(keys: readonly string[], liveFieldKeys: readonly string[]): string[] {
  if (keys.length > MAX_PROJECT_FACTS) throw new UserError(`Choose at most ${MAX_PROJECT_FACTS} facts for the project page.`);
  const allowed = new Set<string>([...PROJECT_FACT_KEYS, ...liveFieldKeys.map((key) => `${FACT_FIELD}${key}`)]);
  const seen = new Set<string>();
  for (const key of keys) {
    if (!allowed.has(key)) {
      throw new UserError(`Unknown fact: ${key}. Choose from ${PROJECT_FACT_KEYS.join(", ")}, or fields.<key> of a project field.`);
    }
    if (seen.has(key)) throw new UserError(`The fact ${key} is listed twice. List each fact once.`);
    seen.add(key);
  }
  return [...keys];
}

/** The column every view of the module starts with: it links to the record. */
export const FIRST_COLUMN: Record<ViewModule, string> = { people: "name", deals: "deal", projects: "project" };

export const DEFAULT_COLUMNS: Record<ViewModule, readonly string[]> = {
  people: ["name", "business", "person_status", "sub_status", "next_task", "last_activity"],
  deals: ["deal", "person", "stage", "value", "next_step", "days_in_stage"],
  projects: ["project", "status", "person", "start", "target", "open_tasks"],
};

export const MAX_COLUMNS = 12;
export const FIELD_COLUMN = "fields.";

/** The views every copy has, before any saved one: People's three and the Pipeline's two. */
export const BUILT_IN_VIEWS: Record<ViewModule, readonly { key: string; name: string; path: string }[]> = {
  people: [
    { key: "contacts", name: "Contacts", path: "/contacts" },
    { key: "leads", name: "Leads", path: "/leads" },
    { key: "companies", name: "Companies", path: "/companies" },
  ],
  deals: [
    { key: "board", name: "Board", path: "/pipeline" },
    { key: "list", name: "List", path: "/pipeline?view=list" },
  ],
  projects: [{ key: "open", name: "Open", path: "/projects" }],
};

/** Stored filters (migration 0013). Keys, never labels. */
export interface ViewFilters {
  person_status?: string;
  sub_status?: string;
  source?: string;
  q?: string;
  fields?: Record<string, string | number>;
  stage?: string;
  /** Projects: a live status key, or "open" / "closed" for every live status of that kind. */
  status?: string;
  /** Projects: a person's id. */
  contact?: string;
  /** Projects: only archived ones. Without it archived projects are left out. */
  archived?: boolean;
}

/** The same filters as the MCP tools take and answer them. */
export interface ViewFilterInput {
  personStatus?: string;
  subStatus?: string;
  source?: string;
  q?: string;
  fields?: Record<string, string | number>;
  stage?: string;
  status?: string;
  contact?: string;
  archived?: boolean;
}

export const FILTER_KEYS: Record<ViewModule, readonly (keyof ViewFilterInput)[]> = {
  people: ["personStatus", "subStatus", "source", "q", "fields"],
  deals: ["stage", "source", "q", "fields"],
  projects: ["status", "contact", "archived", "fields"],
};

export const MAX_FILTER_FIELDS = 10;
export const MAX_FILTER_TEXT = 100;

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);

/** Stored filters, read leniently: anything of the wrong shape is left out (a row written by hand). */
export function parseFilters(json: string): ViewFilters {
  let raw: Record<string, unknown>;
  try {
    raw = parseObject(json);
  } catch {
    return {};
  }
  const out: ViewFilters = {};
  for (const key of ["person_status", "sub_status", "source", "q", "stage", "status", "contact"] as const) {
    const value = text(raw[key]);
    if (value !== undefined) out[key] = value;
  }
  if (raw.archived === true) out.archived = true;
  const fields = raw.fields;
  if (typeof fields === "object" && fields !== null && !Array.isArray(fields)) {
    const kept = Object.entries(fields).filter(
      (entry): entry is [string, string | number] => typeof entry[1] === "number" || text(entry[1]) !== undefined,
    );
    if (kept.length > 0) out.fields = Object.fromEntries(kept);
  }
  return out;
}

/** Stored filters as the MCP tools answer them. */
export function filtersForTools(filters: ViewFilters): ViewFilterInput {
  const out: ViewFilterInput = {};
  if (filters.person_status !== undefined) out.personStatus = filters.person_status;
  if (filters.sub_status !== undefined) out.subStatus = filters.sub_status;
  if (filters.stage !== undefined) out.stage = filters.stage;
  if (filters.status !== undefined) out.status = filters.status;
  if (filters.contact !== undefined) out.contact = filters.contact;
  if (filters.archived !== undefined) out.archived = filters.archived;
  if (filters.source !== undefined) out.source = filters.source;
  if (filters.q !== undefined) out.q = filters.q;
  if (filters.fields !== undefined) out.fields = filters.fields;
  return out;
}

/** Stored columns, or the module's defaults when there are none. */
export function parseColumns(module: ViewModule, json: string): string[] {
  try {
    const columns = parseStringArray(json);
    return columns.length > 0 ? columns : [...DEFAULT_COLUMNS[module]];
  } catch {
    return [...DEFAULT_COLUMNS[module]];
  }
}
