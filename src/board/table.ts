// The table layout every list shares (decision 0043): a real <table> in a wrapper that scrolls sideways, a caption, scoped
// headers, the first cell of each row its header, and headers that sort as plain links. No JavaScript. Pages build the
// columns; nothing here knows about people or deals. The layout choice and its Show as switch live here too.
import type { ViewLayout } from "../db/db.ts";
import { type Html, html } from "./html.ts";

export type Layout = ViewLayout;

/** The layout a visit asked for in its address (`layout=cards` or `layout=table`), or the page's own. Never writes. */
export function pickLayout(query: URLSearchParams, own: Layout): Layout {
  const asked = query.get("layout");
  return asked === "cards" || asked === "table" ? asked : own;
}

/** This page's address with some parameters set (null removes one), every other one kept in its place. `change` goes. */
export function withParams(path: string, query: URLSearchParams, set: Record<string, string | null>): string {
  const params = new URLSearchParams(query);
  params.delete("change");
  for (const [name, value] of Object.entries(set)) {
    if (value === null) params.delete(name);
    else params.set(name, value);
  }
  const text = params.toString();
  return text === "" ? path : `${path}?${text}`;
}

/** "Show as: Cards | Table": a labelled list of two links, the shown one aria-current="page". */
export function layoutSwitch(path: string, query: URLSearchParams, shown: Layout): Html {
  const item = (layout: Layout, label: string) =>
    html`<li><a href="${withParams(path, query, { layout })}"${shown === layout ? html` aria-current="page"` : ""}>${label}</a></li>\n`;
  return html`<ul class="view-switch layout-switch" aria-label="Show as">
${item("cards", "Cards")}${item("table", "Table")}</ul>`;
}

/** A page's title and description say when the layout is not the one the page opens in. */
export function layoutTitle(title: string, shown: Layout, usual: Layout): string {
  if (shown === usual) return title;
  return `${title} ${shown === "table" ? "as a table" : "as cards"}`;
}

export function layoutDescription(description: string, shown: Layout, usual: Layout): string {
  if (shown === usual) return description;
  return `${description.replace(/\.$/, "")}, shown as ${shown === "table" ? "a table" : "cards"}.`;
}

export interface TableColumn<T> {
  key: string;
  header: string;
  /** On a sortable column: where its header link goes, and which way the table is sorted by it now. */
  sort?: { href: string; now?: "asc" | "desc" };
  /** The cell. In the first column it is the row's header: the record's link. */
  cell: (item: T) => Html | string;
}

/**
 * The table, in its sideways-scrolling region. `label` names the region and `caption` the table for a screen reader
 * (the caption is visually hidden: the page's lede says it in words). The first column stays in view while the others
 * scroll (public/board.css).
 */
export function dataTable<T>(options: { label: string; caption: string; columns: readonly TableColumn<T>[]; rows: readonly T[] }): Html {
  const { columns, rows } = options;
  const head = columns.map((column) => {
    if (column.sort === undefined) return html`<th scope="col">${column.header}</th>`;
    const { href, now } = column.sort;
    if (now === undefined) return html`<th scope="col"><a href="${href}">${column.header}</a></th>`;
    const arrow = now === "asc" ? html`&uarr;` : html`&darr;`;
    return html`<th scope="col" aria-sort="${now === "asc" ? "ascending" : "descending"}"><a href="${href}">${column.header} <span aria-hidden="true">${arrow}</span></a></th>`;
  });
  const body = rows.map(
    (row) =>
      html`<tr>${columns.map((column, i) => (i === 0 ? html`<th scope="row">${column.cell(row)}</th>` : html`<td>${column.cell(row)}</td>`))}</tr>\n`,
  );
  return html`<div class="table-scroll" role="region" aria-label="${options.label}" tabindex="0">
<table class="data-table">
<caption class="visually-hidden">${options.caption}</caption>
<thead>
<tr>${head}</tr>
</thead>
<tbody>
${body}</tbody>
</table>
</div>`;
}
