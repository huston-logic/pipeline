// /campaigns/<id>/people (decision 0053): pick the people a draft goes to, without JavaScript. A GET search lists people
// with checkboxes, Add selected adds the ticked ones, and each picked person has a Remove button of their own. Only a
// live draft sent to "People I pick" has this page; every other campaign is a 404.
import { type PickPerson, peopleByIds, searchPeople } from "../../campaigns/pick.ts";
import { untrustedFields } from "../../services/labels.ts";
import type { PageContext } from "../context.ts";
import { hidden, postForm } from "../forms.ts";
import { type Html, html } from "../html.ts";
import { errorSummary } from "../inputs.ts";
import { renderPage } from "../layout.ts";
import { count, formatNumber, labelled, section } from "../parts.ts";
import { campaignPath, CAMPAIGNS_PATH } from "./campaigns.ts";
import { editableCampaign } from "./campaign-form.ts";

export const campaignPeoplePath = (id: string): string => `${campaignPath(id)}/people`;
export const QUERY_MAX = 100;

/** The people a draft's list holds, or null when the campaign isn't a live draft sent to people I pick. */
export async function pickedOf(db: PageContext["db"], id: string): Promise<string[] | null> {
  const found = await editableCampaign(db, id);
  if (found === null) return null;
  const audience = JSON.parse(found.campaign.audience) as { kind: string; people?: string[] };
  return audience.kind === "people" ? (audience.people ?? []) : null;
}

const isOutside = (person: PickPerson) => untrustedFields(person).has("name");
const nameOf = (person: PickPerson): Html => labelled(person.name, isOutside(person));
/** What a button says about its person: the name only when it is the owner's own. */
const callOf = (person: PickPerson | undefined, id: string) => (person === undefined || isOutside(person) ? id : person.name);

function searchForm(path: string, query: string): Html {
  return html`<form class="search" action="${path}" method="get" role="search" aria-label="Find people">
<div class="field field-grow">
<label for="people-q">Find people</label>
<p id="people-q-hint" class="field-hint">Name, email or company</p>
<input id="people-q" type="search" name="q" value="${query}" aria-describedby="people-q-hint" maxlength="${QUERY_MAX}" autocomplete="off" enterkeyhint="search">
</div>
<button class="button" type="submit">Find people</button>
</form>`;
}

function countLine(shown: number, total: number, query: string, alreadyPicked: number): string {
  const quoted = `"${query}"`;
  const picked = alreadyPicked === 0 ? "" : ` Already picked: ${formatNumber(alreadyPicked)}.`;
  if (total === 0) return `${query === "" ? "No one else to pick." : `No one matches ${quoted}.`}${picked}`;
  if (shown < total) return `Showing the first ${formatNumber(shown)} of ${formatNumber(total)}${query === "" ? "" : ` that match ${quoted}`}. Search to narrow it down.${picked}`;
  return `${count(total, "person", "people")}${query === "" ? "" : ` ${total === 1 ? "matches" : "match"} ${quoted}`}.${picked}`;
}

function choice(person: PickPerson): Html {
  const id = `people-person-${person.id}`;
  return html`<div class="check">
<input id="${id}" name="person" type="checkbox" value="${person.id}">
<label for="${id}">${nameOf(person)}</label>
</div>
`;
}

export async function campaignPeoplePage(ctx: PageContext, id: string, errors: string[] = []): Promise<string | null> {
  const picked = await pickedOf(ctx.db, id);
  if (picked === null) return null;
  const path = campaignPeoplePath(id);
  const query = (ctx.query.get("q") ?? "").trim().slice(0, QUERY_MAX);
  const [found, names] = await Promise.all([searchPeople(ctx.db, query, picked), peopleByIds(ctx.db, picked)]);
  const here = query === "" ? path : `${path}?${new URLSearchParams({ q: query }).toString()}`;
  const form = { csrf: ctx.csrf, here };
  const keep = query === "" ? "" : hidden("q", query);
  const results =
    found.people.length === 0
      ? ""
      : postForm(
          "people-add",
          `${path}/add`,
          form,
          html`${keep}<fieldset>
<legend>People found</legend>
${found.people.map(choice)}</fieldset>
<div class="form-actions"><button class="button" type="submit">Add selected</button></div>`,
        );
  const pickedList =
    picked.length === 0
      ? html`<p>No one picked yet.</p>`
      : html`<ul class="cards">${picked.map((personId) => {
          const person = names.get(personId);
          return html`<li class="card">
<p>${person === undefined ? html`Person ${personId} (archived or gone)` : nameOf(person)}</p>
${postForm(
  "people-remove",
  `${path}/remove`,
  form,
  html`${keep}${hidden("person", personId)}<button class="button button-quiet" type="submit">Remove<span class="visually-hidden"> ${callOf(person, personId)}</span></button>`,
)}</li>`;
        })}</ul>`;
  return renderPage({
    title: "Pick people",
    description: "Find people and choose who a campaign draft goes to.",
    current: CAMPAIGNS_PATH,
    frame: ctx,
    body: html`<p class="back"><a href="${campaignPath(id)}">Back to the campaign</a></p>
<h1>Pick people</h1>
<p class="lede">Find people and tick the ones this campaign goes to. Nothing is sent from this page. At most ${formatNumber(500)} people.</p>
${errorSummary(errors.map((message) => ({ message })))}
${searchForm(path, query)}
<p class="lede">${countLine(found.people.length, found.total, query, picked.length)}</p>
${results}
${section("campaign-picked", `Picked (${picked.length})`, pickedList)}`,
  });
}
