// A large fake copy for the CPU check (run 2, task R7; docs/PAID-PLAN.md): 2,000 deals, 1,500 contacts at 300
// companies, 20,000 activities, 3,000 tasks, five rules (run 4, task L9, adds 2,000 leads with their own activities,
// tasks, firings and a sixth rule, a lead_followup), rule firings, about 6,000 change-log rows and 60 briefs.
// Made-up people only (example.com, example.org and example.net addresses). Deterministic: the same `now` gives the
// same SQL, byte for byte (a fixed pseudo-random sequence, no Math.random, no new ids).
//   node scripts/seed-scale.ts --out <file>
// Load it onto a database with the migrations and seed/defaults.sql, instead of the demo seed (scripts/seed-dev.ts).
// The generated SQL is several megabytes; never commit it.
// The rules are set up so the next hourly run has exactly 50 firings due (30 from the Replied follow-up, 20 from the
// Proposal sent entry rule), twice MAX_FIRINGS_PER_RUN. The change-log rows have the shape and size of real ones
// (full row snapshots) but are not exact histories, so undo on them is not meaningful.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { composeBrief } from "../src/brief/compose.ts";
import { addDays, DEFAULT_TZ, localDate, zonedToUtc } from "../src/time.ts";
import { insert, type Row } from "./seed-dev.ts";

export const SCALE = {
  companies: 300,
  contacts: 1_500,
  deals: 2_000,
  activities: 20_000,
  tasks: 3_000,
  briefs: 60,
  leads: 2_000,
} as const;

export const SCALE_BUSINESS_NAME = "Scale test copy (demo)";

/**
 * Firings the next hourly run finds due: the Replied follow-up's, the Proposal sent entry rule's and (run 4) the lead
 * follow-up's. Deal firings are written first, so the lead ones wait behind the 25-firing budget.
 */
export const DUE_FIRINGS = { replied: 30, proposalSent: 20, leads: 40 } as const;

export interface ScaleSeed {
  fieldDefs: Row[];
  contacts: Row[];
  /** People with a lead status and no deal (run 4, task L9). */
  leads: Row[];
  deals: Row[];
  activities: Row[];
  tasks: Row[];
  rules: Row[];
  ruleFirings: Row[];
  briefs: Row[];
  audit: Row[];
}

const DAY = 86_400_000;
const OPEN_STAGES = ["new_inquiry", "replied", "call_booked", "call_done", "proposal_sent"] as const;
const STAGE_LABELS: Record<string, string> = {
  new_inquiry: "New inquiry",
  replied: "Replied",
  call_booked: "Call booked",
  call_done: "Call done",
  proposal_sent: "Proposal sent",
  won: "Won",
  lost: "Lost",
  not_now: "Not now",
};
const CONTACT_TYPES = ["email", "call", "meeting", "note", "email", "call"] as const;

const FIRST = ["Avery", "Blake", "Casey", "Dana", "Ellis", "Frankie", "Gray", "Harper", "Indy", "Jordan", "Kai", "Logan",
  "Morgan", "Noel", "Oakley", "Parker", "Quinn", "Reese", "Sage", "Taylor", "Umi", "Val", "Wren", "Yael", "Zion"];
const LAST = ["Abbott", "Barlow", "Carver", "Dunmore", "Easton", "Fairley", "Garland", "Hollis", "Ingram", "Jessup",
  "Kendall", "Larkin", "Merritt", "Norwood", "Oakes", "Prescott", "Quimby", "Radley", "Sutton", "Thorne", "Upton",
  "Vance", "Whitlock", "Yardley", "Zeller"];
const COMPANY_A = ["Harbor", "Cedar", "Summit", "River", "Maple", "Granite", "Willow", "North", "Copper", "Lake", "Pine",
  "Stone", "Iron", "Silver", "Meadow"];
const COMPANY_B = ["Point", "Row", "Ridge", "Bend", "Hollow", "Creek", "Gate", "Line", "Field", "Crest"];
const COMPANY_C = ["Logistics", "Builders", "Housing", "Brewing", "Clinic", "Storage"];
const PROJECTS = ["Structural review", "Foundation design", "Beam calculations", "Condition assessment",
  "Seismic retrofit", "Retaining wall design", "Slab repair", "Roof framing check", "Canopy foundations",
  "Peer review"];
const PLACES = ["warehouse", "office", "parking garage", "clinic", "taproom", "storage building", "school gym",
  "community hall", "hotel lobby", "loading dock"];

/** mulberry32: a small fixed pseudo-random sequence, so the seed is the same on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n: number, width = 5) => String(n).padStart(width, "0");

type DealPlan = {
  stage: string;
  /** Days before now the deal was added, and entered its current stage. */
  createdDaysAgo: number;
  enteredDaysAgo: number;
  /** Whether some contact is logged after the deal entered its stage (stage_followup rules look for none). */
  contactAfterEntry: boolean;
};

/**
 * Stage and dates for deal `i`. Open: 240 per open stage; closed: 400 won, 250 lost, 150 not now. Replied deals 0-29
 * are overdue for the Replied follow-up (entered 8 or more days ago, nothing since); Proposal sent deals 0-19 entered
 * within the Proposal sent rule's life (the last 10 days). No other open deal matches an active stage rule except the
 * New inquiry follow-up, whose matches are already fired (rule_firings rows).
 */
function planDeal(i: number, rand: () => number): DealPlan {
  const open = 1_200;
  if (i < open) {
    const stage = OPEN_STAGES[i % 5] ?? "new_inquiry";
    const nth = Math.floor(i / 5);
    if (stage === "new_inquiry") {
      // No moves, so entered = created. Half are older than 2 days with nothing since: fired by ru_scale05.
      const created = nth % 2 === 0 ? 3 + rand() * 40 : 0.1 + rand() * 1.8;
      return { stage, createdDaysAgo: created, enteredDaysAgo: created, contactAfterEntry: false };
    }
    if (stage === "replied") {
      if (nth < DUE_FIRINGS.replied) {
        const entered = 8 + rand() * 30;
        return { stage, createdDaysAgo: entered + 1 + rand() * 20, enteredDaysAgo: entered, contactAfterEntry: false };
      }
      // Either entered under 7 days ago, or entered earlier with contact since.
      const recent = nth % 3 === 0;
      const entered = recent ? 0.2 + rand() * 6 : 8 + rand() * 60;
      return { stage, createdDaysAgo: entered + 1 + rand() * 20, enteredDaysAgo: entered, contactAfterEntry: !recent };
    }
    if (stage === "proposal_sent") {
      const entered = nth < DUE_FIRINGS.proposalSent ? 0.5 + rand() * 9 : 10.5 + rand() * 120;
      return { stage, createdDaysAgo: entered + 2 + rand() * 40, enteredDaysAgo: entered, contactAfterEntry: rand() < 0.6 };
    }
    const entered = 0.5 + rand() * 60;
    return { stage, createdDaysAgo: entered + 1 + rand() * 30, enteredDaysAgo: entered, contactAfterEntry: rand() < 0.7 };
  }
  const closed = i - open;
  const stage = closed < 400 ? "won" : closed < 650 ? "lost" : "not_now";
  const entered = 1 + rand() * 600;
  return { stage, createdDaysAgo: entered + 5 + rand() * 90, enteredDaysAgo: entered, contactAfterEntry: false };
}

/** The open stages a deal passed through on its way to `stage` (closed deals close from a random open stage). */
function path(stage: string, rand: () => number): string[] {
  const openIndex = OPEN_STAGES.indexOf(stage as (typeof OPEN_STAGES)[number]);
  if (openIndex >= 0) return OPEN_STAGES.slice(0, openIndex + 1);
  return [...OPEN_STAGES.slice(0, 1 + Math.floor(rand() * 5)), stage];
}

export function scaleSeed(now: Date, tz: string = DEFAULT_TZ): ScaleSeed {
  const rand = prng(20261119);
  const at = (daysAgo: number) => new Date(now.getTime() - Math.round(daysAgo * DAY)).toISOString();
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;

  const fieldDefs: Row[] = [
    {
      id: "fd_scale01",
      entity: "deal",
      key: "project_type",
      label: "Project type",
      type: "choice",
      choices: '["Commercial","Industrial","Residential","Public"]',
      archived: 0,
      version: 1,
      created_at: at(800),
      updated_at: at(800),
    },
  ];

  const companies = Array.from({ length: SCALE.companies }, (_, k) => {
    const a = COMPANY_A[k % COMPANY_A.length];
    const b = COMPANY_B[Math.floor(k / COMPANY_A.length) % COMPANY_B.length];
    const c = COMPANY_C[Math.floor(k / (COMPANY_A.length * COMPANY_B.length)) % COMPANY_C.length];
    return `${a} ${b} ${c}`;
  });

  const contacts: Row[] = Array.from({ length: SCALE.contacts }, (_, k) => {
    const first = FIRST[k % FIRST.length] ?? "Avery";
    const last = LAST[Math.floor(k / FIRST.length) % LAST.length] ?? "Abbott";
    const domain = ["example.com", "example.org", "example.net"][k % 3];
    const fromForm = k % 10 === 0;
    const created = at(700 - (k * 700) / SCALE.contacts);
    return {
      id: `ct_scale${pad(k)}`,
      name: `${first} ${last}`,
      email: `${first}.${last}.${k}@${domain}`.toLowerCase(),
      phone: `555-01${pad(k % 100, 2)}`,
      // About one contact in 47 has no company; the rest share 300 companies, about five people each.
      business: k % 47 === 46 ? null : (companies[k % SCALE.companies] ?? null),
      source: fromForm ? "website form" : pick(["referral", "repeat client", "trade show", "phone call"]),
      notes: k % 7 === 0 ? "Prefers email. Usually replies within a day." : null,
      fields: "{}",
      untrusted_fields: fromForm ? '["name","email","phone","business"]' : "[]",
      archived: 0,
      version: 1,
      created_at: created,
      updated_at: created,
    };
  });

  const deals: Row[] = [];
  const activities: Row[] = [];
  type Built = { deal: Row; moves: Row[]; contactTimes: number[]; contactAfterEntry: boolean };
  const built: Built[] = [];
  let activityN = 0;
  const activity = (deal: Row, type: string, summary: string, when: number, extra: Row = {}): Row => {
    const row: Row = {
      id: `ac_scale${pad(activityN++, 6)}`,
      deal_id: String(deal.id),
      contact_id: String(deal.contact_id),
      type,
      summary,
      untrusted_text: null,
      data: null,
      occurred_at: new Date(when).toISOString(),
      actor: "owner",
      version: 1,
      created_at: new Date(when).toISOString(),
      ...extra,
    };
    activities.push(row);
    return row;
  };

  // Pass 1: deals, their first contact and their stage moves.
  for (let i = 0; i < SCALE.deals; i++) {
    const plan = planDeal(i, rand);
    const contact = contacts[i % SCALE.contacts] as Row;
    const created = now.getTime() - Math.round(plan.createdDaysAgo * DAY);
    const entered = now.getTime() - Math.round(plan.enteredDaysAgo * DAY);
    const outside = String(contact.untrusted_fields) !== "[]";
    const deal: Row = {
      id: `dl_scale${pad(i)}`,
      contact_id: String(contact.id),
      title: outside ? `${String(contact.name)} inquiry` : `${pick(PROJECTS)} for the ${pick(PLACES)}`,
      stage_key: plan.stage,
      value: rand() < 0.15 ? null : Math.round(800 + rand() * 30_000),
      next_step: null,
      next_at: null,
      status: OPEN_STAGES.includes(plan.stage as (typeof OPEN_STAGES)[number]) ? "open" : plan.stage,
      fields: JSON.stringify({ project_type: pick(["Commercial", "Industrial", "Residential", "Public"]) }),
      stage_entered_at: new Date(entered).toISOString(),
      last_activity_at: null,
      untrusted_fields: outside ? '["title"]' : "[]",
      archived: 0,
      version: 1,
      created_at: new Date(created).toISOString(),
      updated_at: new Date(created).toISOString(),
    };
    deals.push(deal);
    const first = outside
      ? activity(deal, "form", "Form submission", created, {
          actor: "system",
          untrusted_text: "A made-up test message from the website form about a crack in a floor slab. (Scale seed.)",
        })
      : activity(deal, pick(["email", "call"]), `${String(contact.name)} asked about ${String(deal.title).toLowerCase()}.`, created);
    const stages = path(plan.stage, rand);
    const moves: Row[] = [];
    for (let s = 1; s < stages.length; s++) {
      // Spread between created and entered; the last move is the stage entry.
      const when = s === stages.length - 1 ? entered : created + Math.round(((entered - created) * s) / (stages.length - 1));
      const from = stages[s - 1] ?? "new_inquiry";
      const to = stages[s] ?? plan.stage;
      moves.push(
        activity(deal, "stage_change", `Moved from ${STAGE_LABELS[from]} to ${STAGE_LABELS[to]}.`, when, {
          data: JSON.stringify({ from, to }),
          actor: rand() < 0.3 ? "ai" : "owner",
        }),
      );
    }
    built.push({ deal, moves, contactTimes: [Date.parse(String(first.occurred_at))], contactAfterEntry: plan.contactAfterEntry && deal.status === "open" });
  }

  // Pass 2: the rest of the 20,000 activities, round-robin over the deals. An open deal that must have contact after
  // its stage entry gets one in the first round; a deal that must not keeps every entry at or before its entry.
  const remaining = SCALE.activities - activities.length;
  for (let k = 0; k < remaining; k++) {
    const b = built[k % built.length] as Built;
    const created = Date.parse(String(b.deal.created_at));
    const entered = Date.parse(String(b.deal.stage_entered_at));
    const after = b.contactAfterEntry && (k < built.length || rand() < 0.5);
    const when = after
      ? entered + 1 + Math.round(rand() * (now.getTime() - 60_000 - entered))
      : created + Math.round(rand() * (entered - created));
    const type = pick(CONTACT_TYPES);
    activity(b.deal, type, `${type === "note" ? "Note" : "Logged"}: talked through scope and timing.`, when);
    b.contactTimes.push(when);
  }

  // last_activity_at and updated_at follow from the activities, the way the services keep them.
  for (const b of built) {
    const last = Math.max(...b.contactTimes);
    b.deal.last_activity_at = new Date(last).toISOString();
    b.deal.updated_at = [String(b.deal.created_at), String(b.deal.stage_entered_at), new Date(last).toISOString()].sort().at(-1) ?? null;
  }

  // About a third of open deals have a next step, from five days ago to two weeks ahead.
  for (const b of built) {
    if (b.deal.status !== "open" || rand() > 0.33) continue;
    b.deal.next_step = pick(["Send the proposal", "Site visit", "Follow-up call", "Send revised calculations"]);
    b.deal.next_at = at(5 - rand() * 19);
  }

  const rules: Row[] = [
    rule(1, "gone_quiet", { type: "gone_quiet", days: 14 }, "Flag any open deal with no activity for 14 days in the daily brief.", 1, at(400)),
    rule(2, "stage_followup", { type: "stage_followup", stage: "replied", days: 7 }, "When a deal has been in Replied for 7 days with no activity, add a follow-up task.", 1, at(300)),
    rule(3, "on_stage_enter", { type: "on_stage_enter", stage: "proposal_sent", title: "Check {contact} got the proposal for {deal}", dueInDays: 3 }, "When a deal enters Proposal sent, add a task due in 3 days.", 1, at(10)),
    rule(4, "stage_followup", { type: "stage_followup", stage: "call_done", days: 3 }, "When a deal has been in Call done for 3 days with no activity, add a follow-up task. (Paused.)", 0, at(200)),
    rule(5, "stage_followup", { type: "stage_followup", stage: "new_inquiry", days: 2 }, "When a deal has been in New inquiry for 2 days with no activity, add a follow-up task.", 1, at(500)),
  ];

  // Tasks: the New inquiry follow-up's firings (already done by earlier runs), then owner tasks up to 3,000.
  const contactById = new Map(contacts.map((c) => [String(c.id), c]));
  const tasks: Row[] = [];
  const ruleFirings: Row[] = [];
  let taskN = 0;
  const task = (deal: Row, title: string, due: string | null, created: string, extra: Row = {}): Row => {
    const row: Row = {
      id: `tk_scale${pad(taskN++)}`,
      deal_id: String(deal.id),
      contact_id: String(deal.contact_id),
      title,
      due_at: due,
      done_at: null,
      snoozed_until: null,
      source: "owner",
      untrusted_fields: "[]",
      version: 1,
      created_at: created,
      updated_at: created,
      ...extra,
    };
    tasks.push(row);
    return row;
  };
  for (const b of built) {
    const d = b.deal;
    const entered = Date.parse(String(d.stage_entered_at));
    const last = d.last_activity_at === null ? null : Date.parse(String(d.last_activity_at));
    const overdue = d.status === "open" && d.stage_key === "new_inquiry" && entered + 2 * DAY < now.getTime();
    if (!overdue || (last !== null && last > entered)) continue;
    const firedAt = new Date(entered + 2 * DAY + 30 * 60_000).toISOString();
    const c = contactById.get(String(d.contact_id)) as Row;
    const outside = String(d.untrusted_fields) !== "[]" || String(c.untrusted_fields) !== "[]";
    const t = task(d, `Follow up with ${String(c.name)} about ${String(d.title)}`, new Date(entered + 2 * DAY).toISOString(), firedAt, {
      source: "ru_scale05",
      untrusted_fields: outside ? '["title"]' : "[]",
    });
    ruleFirings.push({
      id: `rf_scale${pad(ruleFirings.length)}`,
      rule_id: "ru_scale05",
      deal_id: String(d.id),
      fire_key: `ru_scale05:${String(d.id)}:${String(d.stage_entered_at)}`,
      task_id: String(t.id),
      fired_at: firedAt,
    });
  }
  while (tasks.length < SCALE.tasks) {
    const b = built[Math.floor(rand() * built.length)] as Built;
    const dueDays = 30 - rand() * 60;
    const created = at(Math.max(dueDays, 0) + 1 + rand() * 10);
    // Most tasks are done; the open ones are spread around today.
    const done = rand() < 0.8;
    task(b.deal, pick(["Send the fee range", "Pull the drawings", "Call back about access", "Check the soil report"]), at(dueDays), created, done
      ? { done_at: created, version: 2 }
      : {});
  }

  // Change log: one add_lead per deal and one update_deal per stage move, with full-row snapshots.
  const audit: Row[] = [];
  for (const b of built) {
    const d = b.deal;
    const c = contactById.get(String(d.contact_id)) as Row;
    const created = String(d.created_at);
    audit.push(change(audit.length, created, "owner", "add_lead", "deals", String(d.id), {}, {
      [`contacts:${String(c.id)}`]: c,
      [`deals:${String(d.id)}`]: d,
    }, `Added lead "${String(d.title)}"`));
    for (const m of b.moves) {
      const data = JSON.parse(String(m.data)) as { from: string; to: string };
      audit.push(change(audit.length, String(m.occurred_at), String(m.actor), "update_deal", "deals", String(d.id),
        { [`deals:${String(d.id)}`]: { ...d, stage_key: data.from } },
        { [`deals:${String(d.id)}`]: { ...d, stage_key: data.to } },
        `Moved deal ${String(d.id)} from ${STAGE_LABELS[data.from]} to ${STAGE_LABELS[data.to]}`));
    }
  }
  audit.sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id)));

  const leads = scaleLeads(now, { activities, tasks, ruleFirings, rules, audit });

  const briefs: Row[] = Array.from({ length: SCALE.briefs }, (_, k) => {
    const when = new Date(now.getTime() - (k + 1) * DAY);
    const sample = built.slice(k * 5, k * 5 + 5).map((b) => b.deal);
    const brief = composeBrief({
      now: when,
      tz,
      tasks: {
        overdue: sample.slice(0, 2).map((d, j) => ({ id: `tk_scale${pad(j)}`, title: "Send the fee range", dueAt: at(k + 3), dealTitle: String(d.title), contactName: "Avery Abbott", untrusted_fields: [] })),
        today: sample.slice(2, 3).map((d) => ({ id: "tk_scale00009", title: "Pull the drawings", dueAt: when.toISOString(), dealTitle: String(d.title), contactName: "Blake Abbott", untrusted_fields: [] })),
      },
      quietDeals: sample.slice(3, 5).map((d) => ({ id: String(d.id), title: String(d.title), contactName: "Casey Abbott", quietDays: 15, untrusted_fields: [] })),
      newLeads: [],
      leads: null,
    });
    return {
      id: `br_scale${pad(k, 3)}`,
      local_date: localDate(when, tz),
      composed_at: when.toISOString(),
      text: brief.text,
      items: JSON.stringify(brief.items),
      sent_at: null,
      send_status: "off: brief_enabled is off",
    };
  });

  return { fieldDefs, contacts, leads, deals, activities, tasks, rules, ruleFirings, briefs, audit };
}

const LEAD_SOURCES = ["trade show", "referral", "drove past", "cold outreach", "website visit", "chamber directory", "import", "phone call"];
const LEAD_KIND = ["Bakery", "Salon", "Florist", "Dental", "Garage", "Cafe", "Print Shop", "Pet Care"];
const LEAD_WORDS = ["Bluebird", "Larkspur", "Fernhill", "Alder", "Quillmoor", "Tamarack", "Juniper", "Marlow", "Thistle", "Cobble",
  "Harrow", "Wicker", "Sparrow", "Ember", "Linden"];
const LEAD_PLACES = ["Corner", "Row", "Square", "Court", "Yard", "Lane", "Walk", "Mews", "Terrace", "Arcade"];
const TASK_TITLES = ["Call to ask about a free structural check", "Send the short intro email", "Drop by with a card"];

/** Same as the engine's lead fire key (src/rules/engine.ts `leadFireKeyOf`); a test checks they agree. */
export const leadFireKey = (ruleId: string, contactId: string, statusAt: string) => `${ruleId}:${contactId}:${statusAt}`;

type LeadParts = { activities: Row[]; tasks: Row[]; ruleFirings: Row[]; rules: Row[]; audit: Row[] };

/**
 * 2,000 leads (people with a lead status and no deal) and what hangs off them: reach activities, tasks, one add_lead
 * change each, and a lead_followup rule (Contacted, 5 days) with DUE_FIRINGS.leads leads owing a task and 100 more
 * already fired. Uses its own random sequence, so the deals above come out the same as before leads existed.
 * New 40%, Contacted 30%, Not now 15%, Not a fit 10%, Bad lead 5%.
 */
function scaleLeads(now: Date, out: LeadParts): Row[] {
  const rand = prng(20261120);
  const at = (daysAgo: number) => new Date(now.getTime() - Math.round(daysAgo * DAY)).toISOString();
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
  const ruleId = "ru_scale06";
  out.rules.push(
    rule(6, "lead_followup", { type: "lead_followup", status: "contacted", days: 5 }, "When a lead has been Contacted for 5 days with no contact logged, add a follow-up task.", 1, at(30)),
  );
  let activityN = 0;
  let taskN = out.tasks.length;
  const reach = (id: string, type: string, summary: string, daysAgo: number) => {
    const when = at(daysAgo);
    out.activities.push({
      id: `ac_scalelead${pad(activityN++, 6)}`,
      deal_id: null,
      contact_id: id,
      type,
      summary,
      untrusted_text: null,
      data: null,
      occurred_at: when,
      actor: "owner",
      version: 1,
      created_at: when,
    });
  };
  const task = (id: string, title: string, dueDaysAgo: number, createdDaysAgo: number, extra: Row = {}): Row => {
    const created = at(createdDaysAgo);
    const row: Row = {
      id: `tk_scale${pad(taskN++)}`,
      deal_id: null,
      contact_id: id,
      title,
      due_at: at(dueDaysAgo),
      done_at: null,
      snoozed_until: null,
      source: "owner",
      untrusted_fields: "[]",
      version: 1,
      created_at: created,
      updated_at: created,
      ...extra,
    };
    out.tasks.push(row);
    return row;
  };

  let contacted = 0;
  return Array.from({ length: SCALE.leads }, (_, k) => {
    const first = FIRST[k % FIRST.length] ?? "Avery";
    const last = LAST[(k * 7 + 3) % LAST.length] ?? "Abbott";
    const domain = ["example.com", "example.org", "example.net"][k % 3];
    const id = `ct_leadscale${pad(k)}`;
    const business = `${LEAD_WORDS[k % LEAD_WORDS.length]} ${LEAD_PLACES[Math.floor(k / LEAD_WORDS.length) % LEAD_PLACES.length]} ${LEAD_KIND[Math.floor(k / 150) % LEAD_KIND.length]}${k >= 1_200 ? " II" : ""}`;
    const roll = rand();
    const status = roll < 0.4 ? "new" : roll < 0.7 ? "contacted" : roll < 0.85 ? "not_now" : roll < 0.95 ? "not_a_fit" : "bad";
    const fromImport = k % 9 === 0;

    // Days ago the status began, and the lead was added (never later than the status).
    let statusDays = 1 + rand() * 120;
    let dueNow = false;
    if (status === "contacted") {
      const nth = contacted++;
      if (nth < DUE_FIRINGS.leads) {
        // Owes a task: 6 or more days in the status with nothing since.
        statusDays = 6 + rand() * 40;
        dueNow = true;
        reach(id, pick(["call", "email"]), "Called and left a message about a free structural check.", statusDays);
      } else if (nth < DUE_FIRINGS.leads + 100) {
        // Already fired by an earlier run.
        statusDays = 6 + rand() * 50;
        reach(id, "email", "Sent a short intro about free structural checks.", statusDays);
        const firedAt = new Date(now.getTime() - Math.round(statusDays * DAY) + 5 * DAY + 30 * 60_000).toISOString();
        const statusAt = at(statusDays);
        const t = task(id, `Follow up with ${first} ${last}`, statusDays - 5, statusDays - 5, { source: ruleId, created_at: firedAt, updated_at: firedAt, done_at: firedAt, version: 2 });
        out.ruleFirings.push({
          id: `rf_scalelead${pad(out.ruleFirings.length)}`,
          rule_id: ruleId,
          deal_id: null,
          contact_id: id,
          fire_key: leadFireKey(ruleId, id, statusAt),
          task_id: String(t.id),
          fired_at: firedAt,
        });
      } else if (nth % 3 === 0) {
        statusDays = 0.2 + rand() * 4.5;
        reach(id, "call", "Called about a free structural check.", statusDays);
      } else {
        statusDays = 6 + rand() * 60;
        reach(id, "call", "Called about a free structural check.", statusDays);
        reach(id, pick(["email", "call"]), "They replied and asked for more detail.", rand() * (statusDays - 1));
      }
    } else if (status === "not_now") {
      statusDays = 5 + rand() * 200;
      reach(id, "call", "Said to try again after the busy season.", statusDays);
      // Mostly dated ahead; about 4% are late.
      if (rand() < 0.8) task(id, `Check back with ${first} ${last}`, 5 - rand() * 150, statusDays, {});
    } else if (status !== "new") {
      statusDays = 10 + rand() * 300;
      if (rand() < 0.3) reach(id, "note", "Does only cosmetic work; no structural need.", statusDays);
    }
    // A few New and Contacted leads have an open or finished call task of their own.
    if (!dueNow && (status === "new" || status === "contacted") && rand() < 0.25) {
      const done = rand() < 0.3;
      task(id, pick(TASK_TITLES), 3 - rand() * 30, statusDays, done ? { done_at: at(rand() * 5), version: 2 } : {});
    }
    const createdDays = statusDays + (status === "new" ? 0 : rand() * 30);
    const row: Row = {
      id,
      name: `${first} ${last}`,
      email: `${first}.${last}.lead${k}@${domain}`.toLowerCase(),
      phone: `555-02${pad(k % 100, 2)}`,
      business,
      source: pick(LEAD_SOURCES),
      notes: k % 11 === 0 ? "Found in the directory. Small shop, one building." : null,
      fields: "{}",
      untrusted_fields: fromImport ? '["name","email","phone","business","source"]' : "[]",
      archived: 0,
      version: 1,
      created_at: at(createdDays),
      updated_at: at(statusDays),
      lead_status: status,
      lead_status_at: at(statusDays),
      // Every one is an unqualified lead: Lead, with the same sub-status (decision 0040).
      person_status: "lead",
      sub_status: status,
    };
    out.audit.push(
      change(out.audit.length, String(row.created_at), "owner", "add_lead", "contacts", id, {}, { [`contacts:${id}`]: row }, `Added lead ${first} ${last} (New)`),
    );
    return row;
  });
}

function rule(n: number, type: string, params: object, description: string, active: number, created: string): Row {
  return {
    id: `ru_scale${pad(n, 2)}`,
    type,
    params: JSON.stringify(params),
    description,
    active,
    created_by: "owner",
    version: 1,
    created_at: created,
    updated_at: created,
  };
}

function change(n: number, at: string, actor: string, tool: string, table: string, id: string, before: object, after: object, summary: string): Row {
  const changeId = `chg_scale${pad(n, 6)}`;
  return {
    id: changeId,
    at,
    actor,
    tool,
    target_table: table,
    target_id: id,
    before_json: JSON.stringify(before),
    after_json: JSON.stringify(after),
    summary: `${summary} (change ${changeId})`,
    undone_at: null,
    undone_by: null,
    undo_of: null,
  };
}

export function buildScaleSeed(now: Date, tz: string = DEFAULT_TZ): string {
  const seed = scaleSeed(now, tz);
  return [
    "-- Fake scale-test data from scripts/seed-scale.ts. Not real people. Never commit this file.",
    `UPDATE settings SET business_name = '${SCALE_BUSINESS_NAME}' WHERE id = 1 AND business_name IS NULL;`,
    ...seed.fieldDefs.map((row) => insert("field_defs", row)),
    ...seed.contacts.map((row) => insert("contacts", row)),
    ...seed.leads.map((row) => insert("contacts", row)),
    ...seed.deals.map((row) => insert("deals", row)),
    ...seed.activities.map((row) => insert("activities", row)),
    ...seed.rules.map((row) => insert("rules", row)),
    ...seed.tasks.map((row) => insert("tasks", row)),
    ...seed.ruleFirings.map((row) => insert("rule_firings", row)),
    ...seed.briefs.map((row) => insert("briefs", row)),
    ...seed.audit.map((row) => insert("audit_log", row)),
    "",
  ].join("\n");
}

/**
 * The latest 07:00 (the default brief hour) in the owner's timezone at or before `now`. The CPU check seeds at this
 * moment and runs the cron at it, so the timed hourly run composes the daily brief.
 */
export function lastBriefHour(now: Date, tz: string = DEFAULT_TZ): Date {
  const today = zonedToUtc(`${localDate(now, tz)}T07:00`, tz);
  return today.getTime() <= now.getTime() ? today : zonedToUtc(`${addDays(localDate(now, tz), -1)}T07:00`, tz);
}

export function parseScaleArgs(argv: string[]): { out: string } {
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") out = argv[++i];
    else throw new Error(`Unknown option "${arg}". seed-scale.ts takes --out <file>.`);
  }
  if (!out) throw new Error("Pass the output file as --out <file>, for example --out .wrangler/scale-seed.sql.");
  return { out };
}

function main(): void {
  let options: { out: string };
  try {
    options = parseScaleArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
  writeFileSync(options.out, buildScaleSeed(new Date()));
  console.log(`Wrote the scale-test seed to ${options.out}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
