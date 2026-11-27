// list_views, add_view, update_view and archive_view (decision 0042). A saved view is a name, a module (people or
// deals), filters, a sort, a layout and its columns. Every filter is checked when it is written (a live status,
// sub-status, stage or custom field, by key or label) and stored by key, so a rename never breaks a view. Positions
// count among the live views of one module and are renumbered 1..n inside the change that moves one, as stages are.
// Every person status other than Lead and Contact (whose views are the built-in Leads and Contacts) also has a default
// view, worked out when it is read, with no row: a new status shows on the board with no code.
import type { Db, FieldDefRow, FieldEntity, ViewLayout, ViewModule, ViewRow } from "../db/db.ts";
import { listFieldDefs } from "../db/queries.ts";
import { newId } from "../ids.ts";
import { type ChangeResult, commitChange, type Ctx, type RowChange, updatedRow } from "./change.ts";
import { joinAnd, short } from "./describe.ts";
import { UserError } from "./errors.ts";
import { findField, validateFieldValues } from "./fields.ts";
import { clean } from "./input.ts";
import { findContact, findStage, stageLabels } from "./lookup.ts";
import { projectStatusRows, settingsRow } from "./memo.ts";
import { CONTACT, LEAD } from "./person-move.ts";
import { findPersonStatus, findSubStatus } from "./person-status.ts";
import { findProjectStatus } from "./projects.ts";
import { requireProjects } from "./settings.ts";
import { type StatusLabels, statusLabels } from "./status-labels.ts";
import {
  BUILT_IN_VIEWS,
  columnsOf,
  DEFAULT_COLUMNS,
  DEFAULT_SORT,
  type Dir,
  FIELD_COLUMN,
  FILTER_KEYS,
  filtersForTools,
  FIRST_COLUMN,
  MAX_COLUMNS,
  MAX_FILTER_FIELDS,
  MAX_FILTER_TEXT,
  parseColumns,
  parseFilters,
  parseSort,
  SORT_WORDS,
  type SortKey,
  sortsOf,
  sortText,
  VIEW_LAYOUTS,
  type ViewFilterInput,
  type ViewFilters,
  type ViewSort,
} from "./view-spec.ts";

const MAX_NAME = 60;

const ENTITY: Record<ViewModule, FieldEntity> = { people: "contact", deals: "deal", projects: "project" };
const MODULE_WORDS: Record<ViewModule, string> = { people: "people", deals: "deals", projects: "projects" };
const RECORD_WORD: Record<ViewModule, string> = { people: "person", deals: "deal", projects: "project" };

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function viewRows(db: Db, module?: ViewModule): Promise<ViewRow[]> {
  const sql = "SELECT * FROM views";
  const order = " ORDER BY archived, position, created_at, id";
  const found =
    module === undefined
      ? await db.prepare(sql + order).all<ViewRow>()
      : await db.prepare(`${sql} WHERE module = ?${order}`).bind(module).all<ViewRow>();
  return found.results;
}

// --- Checking what a view holds ---------------------------------------------------------------------------------

function cleanName(name: string | undefined, module: ViewModule, live: readonly ViewRow[], except?: string): string {
  const text = clean(name);
  if (text === null) throw new UserError('A view needs a name. Say what to call it, for example "Partners".');
  if (text.length > MAX_NAME) throw new UserError(`A view name can be at most ${MAX_NAME} characters (got ${text.length}).`);
  const builtIn = BUILT_IN_VIEWS[module].find((view) => sameText(view.name, text));
  if (builtIn) throw new UserError(`${builtIn.name} is a built-in view of ${MODULE_WORDS[module]}. Pick a different name.`);
  const clash = live.find((view) => view.id !== except && sameText(view.name, text));
  if (clash) throw new UserError(`There's already a ${MODULE_WORDS[module]} view called ${clash.name} (${clash.id}). Pick a different name.`);
  return text;
}

function filterText(value: string, what: string): string {
  const text = clean(value);
  if (text === null) throw new UserError(`The ${what} filter can't be empty. Leave it out to show everyone.`);
  if (text.length > MAX_FILTER_TEXT) throw new UserError(`The ${what} filter can be at most ${MAX_FILTER_TEXT} characters (got ${text.length}).`);
  return text;
}

/** A custom field filter's value, as the field's type holds it: a number field takes a number or digits. */
function fieldValue(def: FieldDefRow, value: string | number): string | number {
  const given = typeof value === "string" ? value.trim() : value;
  if (given === "") throw new UserError(`Give a value for ${def.label}, or leave it out.`);
  const typed = def.type === "number" && typeof given === "string" ? Number(given.replace(/,/g, "")) : given;
  if (def.type === "number" && (typeof typed !== "number" || !Number.isFinite(typed))) {
    throw new UserError(`${def.label} is a number field. Give a number as its value, for example 1500.`);
  }
  validateFieldValues([def], def.entity, { [def.key]: typed });
  return typed;
}

async function liveField(db: Db, module: ViewModule, ref: string): Promise<FieldDefRow> {
  const entity = ENTITY[module];
  let def: FieldDefRow;
  try {
    def = await findField(db, ref, entity);
  } catch (error) {
    // Named after a field of the other entity: say so, rather than "there's no custom field".
    const other = await findField(db, ref).catch(() => null);
    if (other === null || other.entity === entity) throw error;
    def = other;
  }
  if (def.entity !== entity) {
    throw new UserError(`${def.label} is a ${def.entity} field. A ${MODULE_WORDS[module]} view uses ${entity} fields (see list_fields).`);
  }
  if (def.archived === 1) throw new UserError(`${def.label} is archived. Bring it back with update_field first, or leave it out.`);
  return def;
}

/** A projects view's status: "open" or "closed" (every live status of that kind), or one live status by key or label. */
async function projectStatusFilter(db: Db, ref: string): Promise<{ key: string; label: string }> {
  const text = filterText(ref, "status").toLowerCase();
  if (text === "open" || text === "closed") return { key: text, label: text };
  const found = await findProjectStatus(db, ref);
  return { key: found.key, label: found.label };
}

const WRONG_MODULE: Record<keyof ViewFilterInput, string | null> = {
  personStatus: "Person status filters people, not deals. Make a people view for it, or leave personStatus out.",
  subStatus: "A sub-status filters people, not deals. Make a people view for it, or leave subStatus out.",
  stage: "Stage filters deals, not people. Make a deals view for it, or leave stage out.",
  status: "Status filters projects. Make a projects view for it, or leave status out.",
  contact: "Contact filters projects. Make a projects view for it, or leave contact out.",
  archived: "Archived filters projects. Make a projects view for it, or leave archived out.",
  source: null,
  q: null,
  fields: null,
};

/** The filters checked against the copy, stored by key, with how they read ("person status Partner"). */
export async function resolveFilters(db: Db, module: ViewModule, input: ViewFilterInput): Promise<{ filters: ViewFilters; words: string[] }> {
  const allowed = FILTER_KEYS[module];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (!Object.hasOwn(WRONG_MODULE, key)) {
      throw new UserError(`"${key}" isn't a view filter. A ${MODULE_WORDS[module]} view filters by ${joinAnd([...allowed])}.`);
    }
    if (!allowed.includes(key as keyof ViewFilterInput)) {
      throw new UserError(
        module === "projects"
          ? `"${key}" isn't a filter of a projects view. A projects view filters by ${joinAnd([...allowed])}.`
          : (WRONG_MODULE[key as keyof ViewFilterInput] ?? ""),
      );
    }
  }
  const filters: ViewFilters = {};
  const words: string[] = [];
  if (input.status !== undefined) {
    const status = await projectStatusFilter(db, input.status);
    filters.status = status.key;
    words.push(`status ${status.label}`);
  }
  if (input.contact !== undefined) {
    filters.contact = (await findContact(db, input.contact)).id;
    words.push(`person ${filters.contact}`);
  }
  if (input.archived === true) {
    filters.archived = true;
    words.push("archived projects");
  }
  if (input.subStatus !== undefined && input.personStatus === undefined) {
    throw new UserError("A sub-status belongs to one person status. Give personStatus too, for example personStatus contact and subStatus client.");
  }
  if (input.personStatus !== undefined) {
    const status = await findPersonStatus(db, input.personStatus);
    if (status.archived === 1) throw new UserError(`${status.label} is archived. Bring it back with update_person_status first, or pick another status.`);
    filters.person_status = status.key;
    let label = status.label;
    if (input.subStatus !== undefined) {
      const sub = await findSubStatus(db, status, input.subStatus);
      if (sub.archived === 1) throw new UserError(`${sub.label} is archived. Bring it back with update_sub_status first, or pick another.`);
      filters.sub_status = sub.key;
      label = `${status.label} (${sub.label})`;
    }
    words.push(`person status ${label}`);
  }
  if (input.stage !== undefined) {
    const stage = await findStage(db, input.stage);
    filters.stage = stage.key;
    words.push(`stage ${stage.label}`);
  }
  if (input.source !== undefined) {
    filters.source = filterText(input.source, "source");
    words.push(`source ${short(filters.source, 40)}`);
  }
  if (input.fields !== undefined) {
    const entries = Object.entries(input.fields);
    if (entries.length > MAX_FILTER_FIELDS) throw new UserError(`A view can filter by at most ${MAX_FILTER_FIELDS} custom fields (got ${entries.length}).`);
    const fields: Record<string, string | number> = {};
    for (const [ref, value] of entries) {
      const def = await liveField(db, module, ref);
      if (Object.hasOwn(fields, def.key)) throw new UserError(`${def.label} is in the filters twice. Give it once.`);
      fields[def.key] = fieldValue(def, value);
      words.push(`${def.label} ${short(String(fields[def.key]), 40)}`);
    }
    if (entries.length > 0) filters.fields = fields;
  }
  if (input.q !== undefined) {
    filters.q = filterText(input.q, "search");
    words.push(`search "${short(filters.q, 40)}"`);
  }
  return { filters, words };
}

function resolveSort(module: ViewModule, key: string | undefined, dir: Dir | undefined, current?: ViewSort): ViewSort {
  const sorts = sortsOf(module);
  const chosen = key ?? current?.key ?? DEFAULT_SORT[module].key;
  if (!Object.hasOwn(sorts, chosen)) {
    throw new UserError(`A ${MODULE_WORDS[module]} view sorts by ${joinAnd(Object.keys(sorts))}. "${chosen}" isn't one of them.`);
  }
  const direction = dir ?? (key === undefined && current !== undefined ? current.dir : sorts[chosen]) ?? "asc";
  return { key: chosen as SortKey, dir: direction };
}

function resolveLayout(layout: string | undefined): ViewLayout {
  if (layout === undefined) return "cards";
  const found = VIEW_LAYOUTS.find((value) => value === layout);
  if (!found) throw new UserError(`A view's layout is cards or table (got "${layout}").`);
  return found;
}

/** Column keys checked against the module: built-in ones by key or header, custom fields as "fields.<key>". */
export async function resolveColumns(db: Db, module: ViewModule, input: readonly string[]): Promise<string[]> {
  if (input.length === 0) throw new UserError("Give at least one column, or leave columns out for the usual ones.");
  if (input.length > MAX_COLUMNS) throw new UserError(`A view can show at most ${MAX_COLUMNS} columns (got ${input.length}).`);
  const builtIn = columnsOf(module);
  const out: string[] = [];
  for (const raw of input) {
    const text = raw.trim();
    let key = Object.keys(builtIn).find((column) => column === text || sameText(builtIn[column] ?? "", text));
    // The people column was headed "Company" before run 12; saved instructions that say so still work.
    if (key === undefined && module === "people" && sameText(text, "Company")) key = "business";
    if (key === undefined) {
      const ref = text.startsWith(FIELD_COLUMN) ? text.slice(FIELD_COLUMN.length) : text;
      let def: FieldDefRow;
      try {
        def = await liveField(db, module, ref);
      } catch (error) {
        if (!(error instanceof UserError) || !/^There's no custom field/.test(error.message)) throw error;
        throw new UserError(
          `"${short(text, 40)}" isn't a column of a ${MODULE_WORDS[module]} view. Use ${joinAnd(Object.keys(builtIn))}, or a ` +
            `${ENTITY[module]} field's key (see list_fields).`,
        );
      }
      key = `${FIELD_COLUMN}${def.key}`;
    }
    if (out.includes(key)) throw new UserError(`The column ${key} is listed twice. Give each column once.`);
    out.push(key);
  }
  if (out[0] !== FIRST_COLUMN[module]) {
    throw new UserError(`Start the columns with ${FIRST_COLUMN[module]}: it links to each ${RECORD_WORD[module]}.`);
  }
  return out;
}

// --- Positions ------------------------------------------------------------------------------------------------

function renumber(ordered: readonly ViewRow[], now: Date, edited: Map<string, Partial<ViewRow>> = new Map()): RowChange[] {
  const changes: RowChange[] = [];
  ordered.forEach((row, index) => {
    const patch: Partial<ViewRow> = { ...edited.get(row.id), position: index + 1 };
    const differs = Object.entries(patch).some(([column, value]) => row[column as keyof ViewRow] !== value);
    if (differs) changes.push({ table: "views", id: row.id, before: row, after: updatedRow(row, patch, now) });
  });
  return changes;
}

const withArchivedLast = (live: readonly ViewRow[], all: readonly ViewRow[]) => [
  ...live,
  ...all.filter((row) => row.archived === 1 && !live.some((placed) => placed.id === row.id)),
];

function checkPosition(position: number, count: number): void {
  if (!Number.isInteger(position) || position < 1 || position > count) {
    throw new UserError(`The position must be a whole number between 1 and ${count} (got ${position}).`);
  }
}

// --- Writes ---------------------------------------------------------------------------------------------------

export interface ViewInput {
  name: string;
  module: ViewModule;
  filters?: ViewFilterInput;
  /** One of the module's sort keys; default name for people, days_in_stage for deals. */
  sort?: string;
  /** Default: the sort's own direction. */
  direction?: Dir;
  layout?: ViewLayout;
  columns?: readonly string[];
  /** 1-based place among the module's live views; default last. */
  position?: number;
}

export interface ViewPatch {
  name?: string;
  /** Replaces every filter. {} shows everyone (people) or every open deal (deals). */
  filters?: ViewFilterInput;
  sort?: string;
  direction?: Dir;
  layout?: ViewLayout;
  columns?: readonly string[];
  position?: number;
}

const sortWords = (sort: ViewSort) => SORT_WORDS[sort.key][sort.dir];

const filterLine = (words: string[]) => (words.length === 0 ? "no filters" : words.join(", "));

export async function addView(ctx: Ctx, input: ViewInput): Promise<ChangeResult & { viewId: string }> {
  const { db } = ctx;
  const module = input.module;
  if (module !== "people" && module !== "deals" && module !== "projects") {
    throw new UserError(`A view's module is people, deals or projects (got "${String(module)}").`);
  }
  if (module === "projects") await requireProjects(db);
  const all = await viewRows(db, module);
  const live = all.filter((row) => row.archived === 0);
  const name = cleanName(input.name, module, live);
  const { filters, words } = await resolveFilters(db, module, input.filters ?? {});
  const sort = resolveSort(module, input.sort, input.direction);
  const layout = resolveLayout(input.layout);
  const columns = input.columns === undefined ? [...DEFAULT_COLUMNS[module]] : await resolveColumns(db, module, input.columns);
  const position = input.position ?? live.length + 1;
  checkPosition(position, live.length + 1);

  const now = ctx.now.toISOString();
  const added: ViewRow = {
    id: newId("vw"),
    name,
    module,
    filters: JSON.stringify(filters),
    sort: sortText(sort),
    layout,
    columns: JSON.stringify(columns),
    position,
    archived: 0,
    version: 1,
    created_at: now,
    updated_at: now,
  };
  const ordered = withArchivedLast([...live.slice(0, position - 1), added, ...live.slice(position - 1)], all);
  const result = await commitChange(ctx, {
    target: { table: "views", id: added.id },
    summary: `Added ${MODULE_WORDS[module]} view ${name} (${added.id}): ${filterLine(words)}; ${sortWords(sort)}`,
    // The new view is already in its place, so renumber() leaves it out and moves only the others.
    changes: [{ table: "views", id: added.id, before: null, after: added }, ...renumber(ordered, ctx.now)],
  });
  return { ...result, viewId: added.id };
}

/** A view by id (archived ones too), else by name among the live ones. */
async function pickView(db: Db, ref: string): Promise<{ view: ViewRow; all: ViewRow[] }> {
  const text = ref.trim();
  const every = await viewRows(db);
  const view = every.find((row) => row.id === text) ?? every.find((row) => row.archived === 0 && sameText(row.name, text));
  if (view?.module === "projects") await requireProjects(db);
  if (!view) {
    const shown = (await settingsRow(db)).projects === 1 ? every : every.filter((row) => row.module !== "projects");
    const live = shown.filter((row) => row.archived === 0).map((row) => `${row.name} (${row.id})`);
    throw new UserError(
      live.length === 0 ? `There's no saved view "${short(text, 60)}". There are none yet.` : `There's no saved view "${short(text, 60)}". Views: ${live.join(", ")}.`,
    );
  }
  return { view, all: every.filter((row) => row.module === view.module) };
}

export async function updateView(ctx: Ctx, ref: string, patch: ViewPatch): Promise<ChangeResult & { viewId: string }> {
  const { db } = ctx;
  const { view, all } = await pickView(db, ref);
  if (view.archived === 1) throw new UserError(`${view.name} is archived. Undo the change that archived it to bring it back.`);
  const module = view.module;
  const live = all.filter((row) => row.archived === 0);
  const edit: Partial<ViewRow> = {};
  const parts: string[] = [];

  if (patch.name !== undefined) {
    const name = cleanName(patch.name, module, live, view.id);
    if (name !== view.name) {
      edit.name = name;
      parts.push(`name to ${name}`);
    }
  }
  if (patch.filters !== undefined) {
    const { filters, words } = await resolveFilters(db, module, patch.filters);
    const stored = JSON.stringify(filters);
    if (stored !== JSON.stringify(parseFilters(view.filters))) {
      edit.filters = stored;
      parts.push(`filters to ${filterLine(words)}`);
    }
  }
  if (patch.sort !== undefined || patch.direction !== undefined) {
    const sort = resolveSort(module, patch.sort, patch.direction, parseSort(module, view.sort));
    if (sortText(sort) !== view.sort) {
      edit.sort = sortText(sort);
      parts.push(`sort to ${sortWords(sort)}`);
    }
  }
  if (patch.layout !== undefined) {
    const layout = resolveLayout(patch.layout);
    if (layout !== view.layout) {
      edit.layout = layout;
      parts.push(`layout to ${layout}`);
    }
  }
  if (patch.columns !== undefined) {
    const columns = await resolveColumns(db, module, patch.columns);
    if (JSON.stringify(columns) !== JSON.stringify(parseColumns(module, view.columns))) {
      edit.columns = JSON.stringify(columns);
      parts.push(`columns to ${columns.join(", ")}`);
    }
  }
  let ordered = live;
  if (patch.position !== undefined) {
    checkPosition(patch.position, live.length);
    if (live.indexOf(view) !== patch.position - 1) {
      ordered = live.filter((row) => row.id !== view.id);
      ordered.splice(patch.position - 1, 0, view);
      parts.push(`position ${patch.position} of ${live.length}`);
    }
  }
  const changes = renumber(withArchivedLast(ordered, all), ctx.now, new Map([[view.id, edit]]));
  if (parts.length === 0 || changes.length === 0) {
    throw new UserError(`Nothing to change on ${view.name}: give a new name, filters, sort, layout, columns or position.`);
  }
  const result = await commitChange(ctx, {
    target: { table: "views", id: view.id },
    summary: `Updated view ${view.name}: ${parts.join("; ")}`,
    changes,
  });
  return { ...result, viewId: view.id };
}

export async function archiveView(ctx: Ctx, ref: string): Promise<ChangeResult & { viewId: string }> {
  const { view, all } = await pickView(ctx.db, ref);
  if (view.archived === 1) throw new UserError(`${view.name} is already archived. Nothing to do.`);
  const live = all.filter((row) => row.archived === 0 && row.id !== view.id);
  const ordered = [...live, view, ...all.filter((row) => row.archived === 1)];
  const result = await commitChange(ctx, {
    target: { table: "views", id: view.id },
    summary: `Archived view ${view.name}`,
    changes: renumber(ordered, ctx.now, new Map([[view.id, { archived: 1 }]])),
  });
  return { ...result, viewId: view.id };
}

// --- Reads ----------------------------------------------------------------------------------------------------

export type ViewKind = "built_in" | "status" | "saved";

export interface ViewItem {
  kind: ViewKind;
  /** A saved view's id (vw_...); null for the others. */
  id: string | null;
  /** A built-in view's key, or the person status of a default view; null for a saved one. */
  key: string | null;
  name: string;
  module: ViewModule;
  /** Where the board shows it. */
  path: string;
  /** Built-in views have none. */
  filters: ViewFilterInput | null;
  /** How the filters read, with the owner's current labels: "person status Partner, source referral". */
  shows: string | null;
  sort: SortKey | null;
  direction: Dir | null;
  layout: ViewLayout | null;
  columns: string[] | null;
  /** A saved view's place among its module's live views. */
  position: number | null;
  archived: boolean;
}

export const statusViewPath = (key: string) => `/people?status=${encodeURIComponent(key)}`;
export const projectStatusViewPath = (key: string) => `/projects?status=${encodeURIComponent(key)}`;
const VIEW_PAGE: Record<ViewModule, string> = { people: "/people", deals: "/pipeline", projects: "/projects" };
export const savedViewPath = (view: Pick<ViewRow, "id" | "module">) => `${VIEW_PAGE[view.module]}?view=${encodeURIComponent(view.id)}`;

/** Labels for reading stored filters back: statuses, stages, project statuses and custom fields. */
export interface FilterLabels {
  statuses: StatusLabels;
  stages: Map<string, string>;
  projectStatuses: Map<string, string>;
  fields: FieldDefRow[];
}

export async function filterLabels(db: Db): Promise<FilterLabels> {
  const [statuses, stages, fields, projectStatuses] = await Promise.all([
    statusLabels(db),
    stageLabels(db),
    listFieldDefs(db, { includeArchived: true }),
    projectStatusRows(db, { includeArchived: true }),
  ]);
  return { statuses, stages, fields, projectStatuses: new Map(projectStatuses.map((s) => [s.key, s.label])) };
}

/** How stored filters read: "person status Partner (Architect)", "stage Won", "Project type Commercial". */
export function filterWords(module: ViewModule, filters: ViewFilters, labels: FilterLabels): string[] {
  const words: string[] = [];
  if (filters.person_status !== undefined) words.push(`person status ${labels.statuses.both(filters.person_status, filters.sub_status ?? null)}`);
  if (filters.stage !== undefined) words.push(`stage ${labels.stages.get(filters.stage) ?? filters.stage}`);
  if (filters.status !== undefined) words.push(`status ${labels.projectStatuses.get(filters.status) ?? filters.status}`);
  if (filters.contact !== undefined) words.push(`person ${filters.contact}`);
  if (filters.archived === true) words.push("archived projects");
  if (filters.source !== undefined) words.push(`source ${short(filters.source, 40)}`);
  for (const [key, value] of Object.entries(filters.fields ?? {})) {
    const def = labels.fields.find((field) => field.entity === ENTITY[module] && field.key === key);
    words.push(`${def?.label ?? key} ${short(String(value), 40)}`);
  }
  if (filters.q !== undefined) words.push(`search "${short(filters.q, 40)}"`);
  return words;
}

export const sortLine = (sort: ViewSort) => sortWords(sort);

/** A live status's default view: everyone with that status, by name. */
function statusItem(key: string, label: string): ViewItem {
  return {
    kind: "status",
    id: null,
    key,
    name: label,
    module: "people",
    path: statusViewPath(key),
    filters: { personStatus: key },
    shows: `person status ${label}`,
    sort: DEFAULT_SORT.people.key,
    direction: DEFAULT_SORT.people.dir,
    layout: "cards",
    columns: [...DEFAULT_COLUMNS.people],
    position: null,
    archived: false,
  };
}

function savedItem(row: ViewRow, labels: FilterLabels): ViewItem {
  const filters = parseFilters(row.filters);
  const sort = parseSort(row.module, row.sort);
  return {
    kind: "saved",
    id: row.id,
    key: null,
    name: row.name,
    module: row.module,
    path: savedViewPath(row),
    filters: filtersForTools(filters),
    shows: filterLine(filterWords(row.module, filters, labels)),
    sort: sort.key,
    direction: sort.dir,
    layout: row.layout,
    columns: parseColumns(row.module, row.columns),
    position: row.position,
    archived: row.archived === 1,
  };
}

/** The live person statuses that have a default view (all but Lead and Contact), in board order. */
async function statusViewRows(db: Db): Promise<{ key: string; label: string }[]> {
  const found = await db
    .prepare("SELECT key, label FROM person_statuses WHERE archived = 0 AND key NOT IN (?, ?) ORDER BY position, key")
    .bind(LEAD, CONTACT)
    .all<{ key: string; label: string }>();
  return found.results;
}

/** list_views: each module's built-in views, then the default view of each person status, then the saved views. */
export async function listViews(db: Db, options: { module?: ViewModule; includeArchived?: boolean } = {}): Promise<ViewItem[]> {
  const [statuses, rows, labels, settings] = await Promise.all([statusViewRows(db), viewRows(db, options.module), filterLabels(db), settingsRow(db)]);
  const builtIn = (module: ViewModule): ViewItem[] =>
    BUILT_IN_VIEWS[module].map((view) => ({
      kind: "built_in",
      id: null,
      key: view.key,
      name: view.name,
      module,
      path: view.path,
      filters: null,
      shows: null,
      sort: null,
      direction: null,
      layout: null,
      columns: null,
      position: null,
      archived: false,
    }));
  const saved = (module: ViewModule) =>
    rows.filter((row) => row.module === module && (options.includeArchived === true || row.archived === 0)).map((row) => savedItem(row, labels));
  const all: readonly ViewModule[] = options.module === undefined ? ["people", "deals", "projects"] : [options.module];
  // While projects are off nothing about them shows, not even the built-in Open view.
  const modules = all.filter((module) => module !== "projects" || settings.projects === 1);
  return modules.flatMap((module) => [
    ...builtIn(module),
    ...(module === "people" ? statuses.map((status) => statusItem(status.key, status.label)) : []),
    ...saved(module),
  ]);
}

/** One entry of a view switch on the board, after the built-in ones. */
export interface SwitchItem {
  kind: "status" | "saved";
  /** The status key or the view id. */
  id: string;
  name: string;
  path: string;
}

/** The People switch's extra entries (each live status but Lead and Contact, then saved people views), or the
 * Pipeline's (saved deals views). One query. */
export async function switchItems(db: Db, module: ViewModule): Promise<SwitchItem[]> {
  const found = await db
    .prepare(
      `SELECT 'status' AS kind, key AS id, label AS name, 0 AS saved, position FROM person_statuses
         WHERE ? = 'people' AND archived = 0 AND key NOT IN (?, ?)
       UNION ALL SELECT 'status', key, label, 0, position FROM project_statuses WHERE ? = 'projects' AND archived = 0
       UNION ALL SELECT 'saved', id, name, 1, position FROM views WHERE module = ? AND archived = 0
       ORDER BY saved, position, id`,
    )
    .bind(module, LEAD, CONTACT, module, module)
    .all<{ kind: "status" | "saved"; id: string; name: string }>();
  const statusPath = module === "projects" ? projectStatusViewPath : statusViewPath;
  return found.results.map((row) => ({
    kind: row.kind,
    id: row.id,
    name: row.name,
    path: row.kind === "status" ? statusPath(row.id) : savedViewPath({ id: row.id, module }),
  }));
}

/** A live saved view of the module by id, or null (the board's 404). */
export async function liveView(db: Db, id: string, module: ViewModule): Promise<ViewRow | null> {
  return db.prepare("SELECT * FROM views WHERE id = ? AND module = ? AND archived = 0").bind(id, module).first<ViewRow>();
}

/** A live person status by key, or null (the board's 404). */
export async function liveStatus(db: Db, key: string): Promise<{ key: string; label: string } | null> {
  return db.prepare("SELECT key, label FROM person_statuses WHERE key = ? AND archived = 0").bind(key).first<{ key: string; label: string }>();
}
