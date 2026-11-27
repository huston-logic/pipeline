// /projects/facts (run 12, ruling 8): choose which facts the project page shows and in what order. A checkbox and a
// position per fact; saved through update_settings as the owner. 404 while projects are off.
import { getSettings, listFieldDefs } from "../../db/queries.ts";
import { possibleFacts, projectFacts } from "../../services/view-spec.ts";
import type { PageContext } from "../context.ts";
import { hidden, postForm } from "../forms.ts";
import { html } from "../html.ts";
import { renderPage } from "../layout.ts";
import { factLabel } from "../project-fact-pairs.ts";

export const PROJECT_FACTS_PATH = "/projects/facts";
export const MAX_POSITION = 20;

export async function projectFactsPage(ctx: PageContext): Promise<string | null> {
  const row = await getSettings(ctx.db);
  if (row.projects !== 1) return null;
  const defs = await listFieldDefs(ctx.db, { entity: "project" });
  const live = defs.map((def) => def.key);
  const labels = new Map(defs.map((def) => [def.key, def.label]));
  const tracking = row.time_tracking === 1;
  const chosen = projectFacts(row, live, tracking);
  const rest = possibleFacts(live, tracking).filter((key) => !chosen.includes(key));
  const rows = [...chosen, ...rest].map((key, index) => {
    const label = factLabel(key, labels);
    return html`<tr>
<th scope="row">${label}</th>
<td><input type="checkbox" id="show-${key}" name="show.${key}" value="yes"${chosen.includes(key) ? " checked" : ""}> <label for="show-${key}">Show<span class="visually-hidden"> ${label}</span></label></td>
<td><input type="number" id="pos-${key}" name="pos.${key}" min="1" max="${MAX_POSITION}" value="${Math.min(index + 1, MAX_POSITION)}" inputmode="numeric"> <label for="pos-${key}">Position<span class="visually-hidden"> of ${label}</span></label></td>
</tr>`;
  });
  return renderPage({
    title: "Choose project facts",
    description: "Choose which facts the project page shows at the top, and in what order.",
    current: "/projects",
    frame: ctx,
    body: html`<h1>Choose project facts</h1>
<p class="lede">Pick what the project page shows at the top, and in what order.</p>
${postForm(
  "facts-form",
  PROJECT_FACTS_PATH,
  ctx,
  html`<div class="table-scroll" role="region" aria-label="Project facts" tabindex="0"><table class="facts-table">
<caption class="visually-hidden">Facts for the project page</caption>
<thead><tr><th scope="col">Fact</th><th scope="col">Show</th><th scope="col">Position</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
<p class="form-actions"><button class="button" type="submit">Save</button> <a href="/projects">Cancel</a></p>`,
)}
${postForm("facts-default", PROJECT_FACTS_PATH, ctx, html`${hidden("default", "1")}<button class="button button-quiet button-small" type="submit">Use the default</button>`)}`,
  });
}
