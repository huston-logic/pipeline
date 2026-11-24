// A people or deals view drawn as cards or as a table (decision 0043). The table's columns come from the view (its
// validated keys, custom fields as "fields.<key>"), or the module's defaults; the first column is always the record's
// link. A header is a sort link only for a column the module can sort by (the fixed lists in view-spec.ts). Outside
// values are labelled in the cell, as on the cards, and a name or title from outside is never a link's text.
import type { FieldDefRow, ViewModule } from "../db/db.ts";
import type { DealViewItem, PersonViewItem } from "../services/view-read.ts";
import { columnsOf, FIELD_COLUMN, FIRST_COLUMN, type SortKey, VIEW_SORTS, type ViewSort, parseSort, sortText } from "../services/view-spec.ts";
import { sortLine } from "../services/views.ts";
import { formatLocal } from "../time.ts";
import { type Html, html } from "./html.ts";
import { contactLink, count, dealLink, formatNumber, labelled, tag, when } from "./parts.ts";
import { dataTable, type Layout, type TableColumn, withParams } from "./table.ts";
import { dealCard, personCard } from "./view-parts.ts";

/** The sort a visit asked for (`sort=<key>-<dir>`), or the view's own. An unknown one is not an error. */
export function sortFromQuery(module: ViewModule, query: URLSearchParams, own: ViewSort): ViewSort {
  const asked = query.get("sort");
  if (asked === null) return own;
  const sort = parseSort(module, asked);
  return sortText(sort) === asked ? sort : own;
}

/** "2 people, by name, A to Z." or "the first 200 of 1,240 people, by name, A to Z." */
export function tableSummary(shown: number, total: number, one: string, many: string, sort: ViewSort): string {
  const what = shown < total ? `the first ${formatNumber(shown)} of ${formatNumber(total)} ${many}` : count(total, one, many);
  return `${what}, ${sortLine(sort)}.`;
}

export interface ListOptions {
  layout: Layout;
  /** The page's path, for the header links. */
  path: string;
  query: URLSearchParams;
  sort: ViewSort;
  /** The view's column keys; the module's defaults when it has none. */
  columns: readonly string[];
  fields: readonly FieldDefRow[];
  tz: string;
  /** What the table is called: the view's name. */
  name: string;
  /** "2 people, by name, A to Z." as a sentence for the caption. */
  summary: string;
}

/** The first column, then the others once each; a key that is neither built in nor a custom field is dropped. */
function columnKeys(module: ViewModule, keys: readonly string[]): string[] {
  const builtIn = columnsOf(module);
  const first = FIRST_COLUMN[module];
  const others = keys.filter((key) => key !== first && (Object.hasOwn(builtIn, key) || key.startsWith(FIELD_COLUMN)));
  return [first, ...new Set(others)];
}

function headerOf(module: ViewModule, key: string, fields: readonly FieldDefRow[]): string {
  const builtIn = columnsOf(module);
  if (Object.hasOwn(builtIn, key)) return builtIn[key] ?? key;
  const field = key.slice(FIELD_COLUMN.length);
  const entity = module === "people" ? "contact" : "deal";
  return fields.find((def) => def.entity === entity && def.key === field)?.label ?? field;
}

function sortOf(module: ViewModule, key: string, options: ListOptions): TableColumn<unknown>["sort"] {
  const sorts: Record<string, "asc" | "desc"> = VIEW_SORTS[module];
  const first = sorts[key];
  if (first === undefined) return undefined;
  const current = options.sort.key === (key as SortKey);
  const next = current ? (options.sort.dir === "asc" ? "desc" : "asc") : first;
  return { href: withParams(options.path, options.query, { sort: `${key}-${next}` }), now: current ? options.sort.dir : undefined };
}

function columns<T>(module: ViewModule, options: ListOptions, cell: (key: string, item: T) => Html | string): TableColumn<T>[] {
  return columnKeys(module, options.columns).map((key) => ({
    key,
    header: headerOf(module, key, options.fields),
    sort: sortOf(module, key, options),
    cell: (item: T) => cell(key, item),
  }));
}

const dateOr = (iso: string | null, tz: string, none: string): Html | string => (iso === null ? none : when(iso, formatLocal(iso, tz)));

/** A custom field's value as stored; a boolean as Yes or No. */
function fieldText(value: unknown): string {
  if (value === undefined || value === null || value === "") return "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return typeof value === "string" ? value : String(value);
}

const textOr = (value: string | null, outside: boolean, none = "None"): Html | string =>
  value === null || value.trim() === "" ? none : labelled(value, outside);

function personCell(key: string, person: PersonViewItem, tz: string): Html | string {
  const outside = new Set(person.untrusted_fields);
  switch (key) {
    case "name":
      return contactLink(person.id, person.name, outside.has("name"));
    case "business":
      return textOr(person.business, outside.has("business"));
    case "email":
      return textOr(person.email, outside.has("email"));
    case "phone":
      return textOr(person.phone, outside.has("phone"));
    case "source":
      return textOr(person.source, outside.has("source"));
    case "person_status":
      return person.personStatusLabel;
    case "sub_status":
      return person.subStatusLabel ?? "None";
    case "next_task":
      return dateOr(person.nextTaskAt, tz, "No task");
    case "last_activity":
      return dateOr(person.lastActivityAt, tz, "None logged yet");
    case "created":
      return when(person.createdAt, formatLocal(person.createdAt, tz));
    default: {
      const field = key.slice(FIELD_COLUMN.length);
      const value = person.fields[field];
      const shown = fieldText(value);
      return value === undefined || value === null || value === "" ? shown : labelled(shown, outside.has(field) || outside.has(`fields.${field}`));
    }
  }
}

function dealCell(key: string, deal: DealViewItem, tz: string): Html | string {
  const outside = new Set<string>(deal.untrusted_fields);
  switch (key) {
    case "deal":
      return dealLink(deal.id, deal.title, outside.has("title"));
    case "person":
      return contactLink(deal.contactId, deal.contactName, outside.has("contactName"));
    case "stage":
      return deal.stageLabel;
    case "value":
      return deal.value === null ? "None" : formatNumber(deal.value);
    case "next_step":
      return textOr(deal.nextStep, false);
    case "next_date":
      return deal.nextAt === null ? "None set" : html`${when(deal.nextAt, formatLocal(deal.nextAt, tz))}${deal.overdue ? html` ${tag("Overdue", true)}` : ""}`;
    case "days_in_stage":
      return count(deal.daysInStage, "day");
    case "source":
      return textOr(deal.source, outside.has("source"));
    case "created":
      return when(deal.createdAt, formatLocal(deal.createdAt, tz));
    default: {
      const value = deal.fields[key.slice(FIELD_COLUMN.length)];
      return fieldText(value);
    }
  }
}

const label = (options: ListOptions) => `${options.name}, as a table`;
const caption = (options: ListOptions) => `${options.name}: ${options.summary}`;

/** The people of a view, as cards or as a table. */
export function peopleList(items: readonly PersonViewItem[], options: ListOptions): Html {
  if (options.layout === "cards") return html`<ul class="cards">${items.map(personCard)}</ul>`;
  return dataTable({
    label: label(options),
    caption: caption(options),
    columns: columns<PersonViewItem>("people", options, (key, person) => personCell(key, person, options.tz)),
    rows: items,
  });
}

/** The deals of a view, as cards or as a table. */
export function dealsList(items: readonly DealViewItem[], options: ListOptions): Html {
  if (options.layout === "cards") return html`<ul class="cards">${items.map(dealCard)}</ul>`;
  return dataTable({
    label: label(options),
    caption: caption(options),
    columns: columns<DealViewItem>("deals", options, (key, deal) => dealCell(key, deal, options.tz)),
    rows: items,
  });
}
