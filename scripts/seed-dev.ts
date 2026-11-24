// Fake seed data for local development, the demo and the board's accessibility and Lighthouse checks: the pipeline
// of an obviously made-up small structural engineering firm. Made-up people only (example.com, example.org and
// example.net addresses, 555-01xx phone numbers). Fixed ids and INSERT OR IGNORE make it safe to load twice; dates
// are relative to `now`, so "overdue", "due today" and "gone quiet" always have something to show.
//   node scripts/seed-dev.ts --out <file> [--tz <IANA timezone>]
// `npm run dev` and `npm run preview` load it after seed/defaults.sql (scripts/dev.mjs). Unit tests use their own
// fixture (tests/helpers/fixture-seed.ts), so this file can change without breaking them.
// The audit_log rows are real snapshots. The newest change on a row matches the row as seeded, so undo_change undoes
// it. Three are refused, each with its own plain-English answer: an older move whose deal has changed since, Dana's
// first add_lead (records added later depend on it), and a move that was already undone (plus its undo entry).
// scripts/seed-dev.test.ts checks every answer; decision 0016.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { composeBrief } from "../src/brief/compose.ts";
import { periodOf } from "../src/services/time-read.ts";
import { nextPart } from "../src/services/describe.ts";
import { TEXT_DATA } from "../src/services/lead-change.ts";
import { addDays, dayBoundsUtc, DEFAULT_TZ, formatLocal, localDate, zonedToUtc } from "../src/time.ts";

export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

export const DEMO_BUSINESS_NAME = "Fernbrook Engineering (demo)";

export interface DevSeed {
  fieldDefs: Row[];
  contacts: Row[];
  deals: Row[];
  activities: Row[];
  tasks: Row[];
  rules: Row[];
  briefs: Row[];
  audit: Row[];
  /** The board import's drafts (decision 0036): one at each step, never expiring. */
  importDrafts: Row[];
  importDraftParts: Row[];
  /** Saved views (decision 0042): one of people, one of deals. */
  views: Row[];
  /** Time tracking (decisions 0049, 0050, 0051): two work types, one client rate and nine finished entries; no timer runs. */
  workTypes: Row[];
  clientRates: Row[];
  timeEntries: Row[];
}

/** The seed's drafts never expire, so the import pages in boardRoutes always have one to show. */
export const SEED_DRAFT_EXPIRES = "2999-01-01T00:00:00.000Z";

function sqlValue(value: SqlValue): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

export function insert(table: string, row: Row): string {
  const columns = Object.keys(row);
  return `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${columns
    .map((column) => sqlValue(row[column] ?? null))
    .join(", ")});`;
}

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

const CLOSED = new Set(["won", "lost", "not_now"]);
/** Activity types that count as contact with the lead (they move last_activity_at); stage changes don't. */
const CONTACT_TYPES = new Set(["form", "email", "call", "meeting", "note"]);

const n2 = (n: number) => String(n).padStart(2, "0");

export function devSeed(now: Date, tz: string): DevSeed {
  const today = localDate(now, tz);
  /** Owner's local time `hhmm` on the day `days` from today (negative is the past), as a UTC ISO string. */
  const day = (days: number, hhmm: string) => zonedToUtc(`${addDays(today, days)}T${hhmm}`, tz).toISOString();

  // Later today, whatever time the seed is made: 5 p.m., or the last minute of the day after that.
  const { end } = dayBoundsUtc(today, tz);
  const fivePm = zonedToUtc(`${today}T17:00`, tz).getTime();
  const lastMinute = end.getTime() - 60_000;
  const laterToday = new Date(
    fivePm > now.getTime() ? fivePm : lastMinute > now.getTime() ? lastMinute : end.getTime() - 1,
  ).toISOString();

  const fieldDefs: Row[] = [
    {
      id: "fd_seed01",
      entity: "contact",
      key: "role",
      label: "Role",
      type: "text",
      choices: null,
      archived: 0,
      version: 1,
      created_at: day(-60, "09:00"),
      updated_at: day(-60, "09:00"),
    },
    {
      id: "fd_seed02",
      entity: "deal",
      key: "project_type",
      label: "Project type",
      type: "choice",
      choices: '["Commercial","Industrial","Residential","Public"]',
      archived: 0,
      version: 1,
      created_at: day(-60, "09:05"),
      updated_at: day(-60, "09:05"),
    },
  ];

  const contact = (
    n: number,
    name: string,
    email: string,
    business: string | null,
    source: string,
    created: string,
    extra: Row = {},
  ): Row => ({
    id: `ct_seed${n2(n)}`,
    name,
    email,
    phone: `555-01${n2(n)}`,
    business,
    source,
    notes: null,
    fields: "{}",
    untrusted_fields: "[]",
    archived: 0,
    version: 1,
    created_at: created,
    updated_at: created,
    person_status: "contact",
    sub_status: null,
    ...extra,
  });
  const role = (text: string) => JSON.stringify({ role: text });

  const contacts: Row[] = [
    contact(1, "Dana Whitfield", "dana.whitfield@example.com", "Harbor Point Logistics", "referral", day(-9, "09:00"), {
      notes: "Referred by Luis Ortega at Riverbend Self Storage.",
      fields: role("Operations manager"),
    }),
    // Came in through the website form: what the form wrote is outside text.
    contact(2, "Jamie Lindqvist", "jamie.lindqvist@example.net", "Oak Hollow Veterinary Clinic", "website form", day(-1, "06:40"), {
      untrusted_fields: '["name","email","phone","business"]',
    }),
    contact(3, "Priya Raman", "priya.raman@example.org", "Cedar Row Housing Co-op", "referral", day(-7, "14:20"), {
      fields: role("Board treasurer"),
    }),
    contact(4, "Elena Novak", "elena@example.com", "Lakeside Brewing Co.", "repeat client", day(-62, "10:00"), {
      fields: role("Head brewer and co-owner"),
    }),
    contact(5, "Grace Liu", "grace.liu@example.org", "Northgate Medical Offices", "referral", day(-21, "10:00"), {
      fields: role("Facilities manager"),
    }),
    contact(6, "Owen Price", "owen.price@example.net", "Alder & Finch Architects", "trade show", day(-12, "18:30"), {
      notes: "Met at the regional architects' mixer. Does a lot of timber work.",
      fields: role("Project architect"),
    }),
    contact(7, "Luis Ortega", "luis@example.com", "Riverbend Self Storage", "repeat client", day(-31, "09:00"), {
      fields: role("Owner"),
    }),
    contact(8, "Ruth Adams", "ruth.adams@example.org", "Willow Creek Community Center", "phone call", day(-25, "10:00")),
    contact(9, "Marcus Bell", "marcus.bell@example.com", "Harbor Point Logistics", "referral", day(-8, "13:00"), {
      fields: role("Site lead"),
    }),
    contact(10, "Tom Okafor", "tom.okafor@example.org", "Cedar Row Housing Co-op", "referral", day(-28, "09:00")),
    contact(11, "Ben Hartley", "ben.hartley@example.org", "Northgate Medical Offices", "referral", day(-10, "08:30"), {
      fields: role("Imaging department lead"),
    }),
    contact(12, "Sofia Marin", "sofia.marin@example.org", "Northgate Medical Offices", "referral", day(-40, "10:00")),
    // A Partner (decision 0040): an architect who sends the firm work, not a customer.
    contact(13, "Hannah Cole", "hannah@example.net", "Alder & Finch Architects", "referral", day(-7, "10:00"), {
      person_status: "partner",
    }),
    contact(14, "Jake Moreno", "jake@example.com", "Summit Ridge Builders", "repeat client", day(-14, "08:00"), {
      fields: role("Site superintendent"),
    }),
    // Typed in lower case with a trailing space: the Companies view still groups it with Summit Ridge Builders.
    contact(15, "Nina Patel", "nina.patel@example.com", "summit ridge builders ", "repeat client", day(-6, "09:00"), {
      phone: "555-0115",
      version: 2,
      updated_at: day(-2, "16:00"),
    }),
    contact(16, "Aaron Brooks", "aaron.brooks@example.net", "Pinecrest Hotel", "phone call", day(-2, "17:45")),
    contact(17, "Mei Tanaka", "mei.tanaka@example.com", "Copperline Fabrication", "trade show", day(-30, "13:00")),
    contact(18, "Chris Dalton", "chris.dalton@example.net", null, "neighbour referral", day(-5, "18:00"), {
      notes: "Homeowner. Lives two streets from the office.",
    }),
  ];

  const leadColumns = (status: string): Row =>
    status === "qualified" ? { person_status: "contact", sub_status: null } : { person_status: "lead", sub_status: status };
  // Leads (decision 0022): people the firm means to approach, one of each kind of status. Only the contacts have
  // `lead_status`; the other 18 people stay as they were.
  const lead = (
    n: number,
    name: string,
    email: string,
    business: string,
    source: string,
    status: string,
    statusDaysAgo: number,
    createdDaysAgo: number,
    extra: Row = {},
  ): Row => ({
    id: `ct_lead${n2(n)}`,
    name,
    email,
    phone: `555-01${20 + n}`,
    business,
    source,
    notes: null,
    fields: "{}",
    untrusted_fields: "[]",
    archived: 0,
    version: 1,
    created_at: day(-createdDaysAgo, "10:00"),
    updated_at: day(-statusDaysAgo, "10:00"),
    lead_status: status,
    lead_status_at: day(-statusDaysAgo, "10:00"),
    // A Lead with the same sub-status; Qualified is a Contact now (decision 0040).
    ...leadColumns(status),
    ...extra,
  });
  contacts.push(
    lead(1, "Wren Calloway", "wren.calloway@example.com", "Bluebird Bakery", "trade show", "new", 2, 2),
    // Came in through a CSV import: the import's text is outside text.
    lead(2, "Theo Marsh", "theo.marsh@example.net", "Marsh & Daughters Plumbing", "import", "new", 3, 3, {
      untrusted_fields: '["name","email","phone","business","source"]',
    }),
    lead(3, "Imani Okoye", "imani.okoye@example.org", "Greenleaf Daycare", "referral", "contacted", 6, 8, { version: 2 }),
    lead(4, "Dev Patel-Shaw", "dev.patelshaw@example.com", "Ridgeline Climbing Gym", "cold outreach", "contacted", 12, 12),
    lead(5, "Noor Haddad", "noor.haddad@example.org", "Eastside Food Pantry", "neighbour referral", "contacted", 4, 6),
    lead(6, "Colin Reyes", "colin.reyes@example.net", "Reyes Auto Body", "phone call", "not_now", 9, 14, {
      version: 3,
    }),
    lead(7, "Priscilla Voss", "priscilla.voss@example.com", "Voss Family Orchard", "website visit", "new", 40, 40),
    lead(8, "Hector Alvarez", "hector.alvarez@example.org", "Alvarez Tile & Stone", "trade show", "not_a_fit", 20, 24),
    lead(9, "Lena Fischer", "lena.fischer@example.net", "Fischer Print Shop", "referral", "bad", 30, 30, {
      notes: "Phone disconnected; the shop has closed.",
    }),
    lead(10, "Omar Rashid", "omar.rashid@example.com", "Rashid Mobile Detailing", "referral", "not_now", 15, 20),
    // Set to Contacted by hand (update_contact) with only a plain note, so the lead_followup rule catches it too.
    lead(11,"Sasha Lindgren", "sasha.lindgren@example.org", "Lindgren Landscape Design", "chamber directory", "contacted", 7, 9),
    lead(12, "Gwen Ashby", "gwen.ashby@example.net", "Ashby Veterinary Hospital", "referral", "qualified", 3, 10, {
      version: 3,
    }),
  );

  /** A contact id: a number is a ct_seedNN person, a string is the id itself (a lead). */
  const cid = (contact: number | string) => (typeof contact === "string" ? contact : `ct_seed${n2(contact)}`);
  type DealSpec = {
    n: number;
    contact: number | string;
    title: string;
    stage: string;
    value: number | null;
    created: string;
    extra?: Row;
  };
  const dealSpecs: DealSpec[] = [
    { n: 1, contact: 1, title: "Structural review for warehouse mezzanine", stage: "call_booked", value: 8500, created: day(-9, "09:00"), extra: { next_step: "Site walk and discovery call", next_at: day(2, "14:00"), fields: '{"project_type":"Industrial"}', version: 3, updated_at: day(-2, "10:15") } },
    { n: 2, contact: 2, title: "Jamie Lindqvist inquiry", stage: "new_inquiry", value: null, created: day(-1, "06:40"), extra: { untrusted_fields: '["title"]' } },
    { n: 3, contact: 3, title: "Balcony condition assessment, 24 units", stage: "replied", value: 12000, created: day(-7, "14:20"), extra: { fields: '{"project_type":"Residential"}' } },
    { n: 4, contact: 4, title: "Foundations for three new fermentation tanks", stage: "call_done", value: 14200, created: day(-6, "10:00"), extra: { next_step: "Send the proposal", next_at: day(1, "12:00"), fields: '{"project_type":"Industrial"}', version: 3 } },
    { n: 5, contact: 5, title: "Rooftop HVAC support framing", stage: "proposal_sent", value: 6800, created: day(-21, "10:00"), extra: { fields: '{"project_type":"Commercial"}' } },
    { n: 6, contact: 6, title: "Peer review of a timber-frame library design", stage: "new_inquiry", value: null, created: day(-11, "09:00"), extra: { fields: '{"project_type":"Public"}' } },
    { n: 7, contact: 7, title: "Seismic retrofit of storage building B", stage: "won", value: 22000, created: day(-31, "09:00"), extra: { fields: '{"project_type":"Commercial"}' } },
    { n: 8, contact: 8, title: "Roof truss inspection after the storm", stage: "lost", value: 3200, created: day(-25, "10:00"), extra: { fields: '{"project_type":"Public"}' } },
    { n: 9, contact: 9, title: "Loading dock slab repair", stage: "proposal_sent", value: 9400, created: day(-8, "13:00"), extra: { next_step: "Follow up on the proposal", next_at: day(3, "10:00"), fields: '{"project_type":"Industrial"}', version: 2, updated_at: day(-1, "11:20") } },
    { n: 10, contact: 10, title: "Parking garage crack survey", stage: "not_now", value: 7500, created: day(-28, "09:00"), extra: { fields: '{"project_type":"Residential"}' } },
    { n: 11, contact: 11, title: "Structural letter for the new MRI suite", stage: "call_booked", value: 4800, created: day(-10, "08:30"), extra: { next_step: "Call with Ben and the MRI vendor", next_at: laterToday, fields: '{"project_type":"Commercial"}' } },
    { n: 12, contact: 12, title: "Parking canopy foundations", stage: "won", value: 11500, created: day(-40, "10:00"), extra: { fields: '{"project_type":"Commercial"}' } },
    { n: 13, contact: 13, title: "Steel stair and landing for an office fit-out", stage: "replied", value: 3900, created: day(-7, "10:00"), extra: { next_step: "Send Hannah a fee range", next_at: day(-2, "12:00") } },
    { n: 14, contact: 14, title: "Beam calculations for a two-storey addition", stage: "call_done", value: 2600, created: day(-14, "08:00"), extra: { next_step: "Send the revised calculations", next_at: day(5, "17:00"), fields: '{"project_type":"Residential"}', version: 4, updated_at: day(-3, "11:05") } },
    { n: 15, contact: 15, title: "Retaining wall design for Hillcrest lot 7", stage: "proposal_sent", value: 5200, created: day(-6, "09:00"), extra: { fields: '{"project_type":"Residential"}' } },
    { n: 16, contact: 16, title: "Pool deck and entrance canopy assessment", stage: "new_inquiry", value: null, created: day(-2, "17:45"), extra: { fields: '{"project_type":"Commercial"}' } },
    { n: 17, contact: 17, title: "Crane runway beam check", stage: "lost", value: 6300, created: day(-30, "13:00"), extra: { fields: '{"project_type":"Industrial"}' } },
    { n: 18, contact: 18, title: "Leaning timber retaining wall behind a deck", stage: "replied", value: 950, created: day(-5, "18:00"), extra: { fields: '{"project_type":"Residential"}' } },
    { n: 19, contact: 7, title: "Seismic retrofit of storage building C", stage: "call_booked", value: 18000, created: day(-8, "10:00"), extra: { next_step: "Site visit for building C", next_at: day(6, "10:00"), fields: '{"project_type":"Commercial"}' } },
    { n: 20, contact: 4, title: "Taproom mezzanine", stage: "won", value: 4400, created: day(-60, "11:00"), extra: { fields: '{"project_type":"Commercial"}' } },
    // Gwen Ashby, qualified from a lead (change 19): a deal with no activity of its own yet.
    { n: 21, contact: "ct_lead12", title: "Equipment mezzanine for a surgery suite", stage: "new_inquiry", value: 6500, created: day(-3, "10:00") },
  ];

  type ActivitySpec = { deal: number | null; contact?: number | string; type: string; summary: string; at: string; extra?: Row };
  const move = (deal: number, from: string, to: string, at: string, actor = "owner"): ActivitySpec => ({
    deal,
    type: "stage_change",
    summary: `Moved from ${STAGE_LABELS[from]} to ${STAGE_LABELS[to]}.`,
    at,
    extra: { data: JSON.stringify({ from, to }), actor },
  });
  const said = (deal: number, type: string, summary: string, at: string, extra: Row = {}): ActivitySpec => ({ deal, type, summary, at, extra });

  const activitySpecs: ActivitySpec[] = [
    said(1, "email", "Dana asked whether the warehouse mezzanine can take a second level of pallet racking.", day(-9, "09:00")),
    said(1, "call", "Intro call. They want the extra racking in by spring and need a stamped letter for the landlord.", day(-6, "11:00")),
    move(1, "new_inquiry", "replied", day(-6, "11:05")),
    said(1, "email", "Sent two times for a site walk. Dana picked the first one.", day(-2, "10:10")),
    move(1, "replied", "call_booked", day(-2, "10:15"), "ai"),
    said(2, "form", "Form submission", day(-1, "06:40"), {
      actor: "system",
      untrusted_text:
        "Hello, this is a made-up test message from Jamie at Oak Hollow Veterinary Clinic. There is a long crack in " +
        "the floor slab of our back kennel room and we would like someone to look at it. (Seed data, not a real person.)",
    }),
    said(3, "email", "Priya asked for a condition assessment of the balconies on all 24 units before the board meeting.", day(-7, "14:20")),
    said(3, "email", "Replied with our approach and a rough fee range.", day(-4, "15:00")),
    move(3, "new_inquiry", "replied", day(-4, "15:05")),
    said(4, "email", "Elena is adding three 60-barrel fermentation tanks and needs new foundations.", day(-6, "10:00")),
    move(4, "new_inquiry", "call_booked", day(-6, "10:05"), "ai"),
    said(4, "meeting", "Site visit at the brewery. Checked the existing slab and marked where the tanks will go.", day(-3, "15:00")),
    move(4, "call_booked", "call_done", day(-3, "16:00")),
    said(5, "meeting", "Walked the roof with Grace and the mechanical contractor.", day(-14, "10:00")),
    said(5, "email", "Sent the proposal for the HVAC support framing.", day(-6, "11:00")),
    move(5, "call_done", "proposal_sent", day(-6, "11:05")),
    // Before the deal was added, so it doesn't count as contact on it.
    { deal: null, contact: 6, type: "note", summary: "Met Owen at the architects' mixer. He wants a peer review of a timber-frame library.", at: day(-12, "18:30") },
    said(7, "call", "Luis asked us to price the seismic retrofit of storage building B.", day(-31, "09:00")),
    said(7, "email", "Sent the proposal for building B.", day(-20, "16:00")),
    move(7, "new_inquiry", "proposal_sent", day(-20, "16:05")),
    said(7, "call", "Luis had questions about the permit drawings.", day(-18, "10:00")),
    said(7, "call", "Luis said yes. Work starts once the permit comes through.", day(-10, "14:00")),
    move(7, "proposal_sent", "won", day(-10, "14:05")),
    said(8, "call", "Ruth called after the storm about sagging roof trusses in the main hall.", day(-25, "10:00")),
    said(8, "email", "Sent our fee for a truss inspection.", day(-22, "09:30")),
    move(8, "new_inquiry", "proposal_sent", day(-22, "09:35")),
    said(8, "call", "Ruth said their insurer wants a second opinion.", day(-20, "14:00")),
    said(8, "note", "Ruth went with the engineer their insurer suggested.", day(-15, "10:00")),
    move(8, "proposal_sent", "lost", day(-15, "10:05")),
    said(9, "email", "Marcus sent photos of the cracked slab at dock doors 4 to 7.", day(-8, "13:00")),
    said(9, "meeting", "Looked at the dock slab with Marcus. Two panels need replacing; the rest can be patched.", day(-5, "09:00")),
    said(9, "email", "Sent the proposal for the dock slab repair.", day(-2, "15:30")),
    move(9, "call_done", "proposal_sent", day(-2, "15:35")),
    said(9, "call", "Called Marcus. He is going through the proposal with their finance team this week.", day(-1, "11:20")),
    said(10, "email", "Tom asked about a crack survey of the parking garage.", day(-28, "09:00")),
    said(10, "meeting", "Walked the garage with Tom. Mostly shrinkage cracks, a few to keep an eye on.", day(-20, "10:00")),
    said(10, "note", "The co-op board wants to revisit this after its spring budget meeting.", day(-18, "16:00")),
    move(10, "call_done", "not_now", day(-18, "16:05")),
    said(11, "email", "Ben needs a structural letter for the floor under the new MRI machine.", day(-10, "08:30")),
    said(11, "call", "Booked a call with Ben and the MRI vendor for today.", day(-1, "13:00")),
    move(11, "replied", "call_booked", day(-1, "13:05"), "ai"),
    said(12, "meeting", "Sofia showed us the parking lot where the canopies go.", day(-40, "10:00")),
    said(12, "email", "Sent the proposal for the canopy foundations.", day(-38, "11:00")),
    move(12, "call_done", "proposal_sent", day(-38, "11:05")),
    said(12, "call", "Sofia approved the proposal.", day(-26, "15:00")),
    move(12, "proposal_sent", "won", day(-26, "15:05")),
    said(13, "email", "Hannah asked us to design a steel stair and landing for a client's office fit-out.", day(-7, "10:00")),
    said(13, "email", "Asked Hannah for the architectural drawings.", day(-3, "11:30")),
    move(13, "new_inquiry", "replied", day(-3, "11:35")),
    said(14, "call", "Jake needs beam calculations for a two-storey addition.", day(-14, "08:00")),
    said(14, "meeting", "Went through the framing plan with Jake on site.", day(-4, "10:00")),
    move(14, "call_booked", "call_done", day(-4, "10:30")),
    said(15, "email", "Nina asked for a retaining wall design on Hillcrest lot 7.", day(-6, "09:00")),
    said(15, "call", "Talked through the soil report with Nina.", day(-4, "13:00")),
    said(15, "email", "Sent the proposal for the retaining wall.", day(-2, "14:00"), { actor: "ai" }),
    move(15, "call_done", "proposal_sent", day(-2, "14:05"), "ai"),
    said(16, "email", "Aaron asked for an assessment of the pool deck and the entrance canopy before summer.", day(-2, "17:45")),
    said(17, "meeting", "Looked at the crane runway with Mei. The rails are worn at the east end.", day(-30, "13:00")),
    said(17, "email", "Sent the proposal for the runway beam check.", day(-27, "10:00")),
    move(17, "call_done", "proposal_sent", day(-27, "10:05")),
    said(17, "call", "Mei asked how long the check would take.", day(-25, "15:00")),
    said(17, "note", "Mei went with the crane supplier's in-house engineer.", day(-21, "09:00")),
    move(17, "proposal_sent", "lost", day(-21, "09:05")),
    said(18, "call", "Chris called about a leaning timber retaining wall behind his deck.", day(-5, "18:00")),
    said(18, "email", "Replied with what a site visit covers and our fee.", day(-3, "09:15")),
    move(18, "new_inquiry", "replied", day(-3, "09:20")),
    said(19, "email", "Luis wants to talk about retrofitting building C next.", day(-8, "10:00")),
    said(19, "call", "Agreed on a site visit for building C.", day(-4, "14:00")),
    move(19, "replied", "call_booked", day(-4, "14:10")),
    said(20, "email", "Elena asked about a mezzanine for the taproom.", day(-60, "11:00")),
    said(20, "call", "Elena approved the taproom mezzanine.", day(-45, "11:00")),
    move(20, "proposal_sent", "won", day(-45, "11:05")),
    // The leads' history. A text is logged as a note whose data says so (decision 0022); a plain note is not contact.
    { deal: null, contact: "ct_lead03", type: "note", summary: "Texted Imani about a walkthrough of the daycare's play structure.", at: day(-6, "10:00"), extra: { data: TEXT_DATA } },
    { deal: null, contact: "ct_lead04", type: "call", summary: "Called the gym and left a voicemail about the climbing wall anchors.", at: day(-12, "10:00") },
    { deal: null, contact: "ct_lead05", type: "email", summary: "Sent a short intro about free seismic checks for small nonprofits.", at: day(-4, "10:00") },
    { deal: null, contact: "ct_lead06", type: "call", summary: "Colin said to try again in the spring, after the busy season.", at: day(-10, "11:00") },
    { deal: null, contact: "ct_lead08", type: "note", summary: "Does only cosmetic tile work; no structural need.", at: day(-20, "10:00") },
    { deal: null, contact: "ct_lead10", type: "email", summary: "Omar likes the idea but wants to wait until after the busy season.", at: day(-16, "10:00") },
    { deal: null, contact: "ct_lead11", type: "note", summary: "Found in the chamber of commerce directory. Does a lot of retaining walls.", at: day(-9, "10:00") },
    { deal: null, contact: "ct_lead12", type: "email", summary: "Gwen asked about a mezzanine for the surgery suite.", at: day(-5, "09:00") },
    // The note the seed's finished time entry logged (decision 0050); on the won taproom deal, older than its last call, so no deal's last contact moves.
    said(20, "note", "Walked Elena through the taproom mezzanine drawings.", day(-46, "15:00")),
  ];

  const dealContact = new Map(dealSpecs.map((d) => [d.n, d.contact]));
  const activities: Row[] = activitySpecs.map((spec, i) => ({
    id: `ac_seed${n2(i + 1)}`,
    deal_id: spec.deal === null ? null : `dl_seed${n2(spec.deal)}`,
    contact_id: cid(spec.contact ?? dealContact.get(spec.deal ?? 0) ?? 0),
    type: spec.type,
    summary: spec.summary,
    untrusted_text: null,
    data: null,
    occurred_at: spec.at,
    actor: "owner",
    version: 1,
    created_at: spec.at,
    ...spec.extra,
  }));

  // last_activity_at and stage_entered_at follow from the activities, the way the services keep them.
  const deals: Row[] = dealSpecs.map((spec) => {
    const id = `dl_seed${n2(spec.n)}`;
    const own = activities.filter((a) => a.deal_id === id);
    const contactTimes = own.filter((a) => CONTACT_TYPES.has(String(a.type))).map((a) => String(a.occurred_at)).sort();
    const moves = own.filter((a) => a.type === "stage_change").map((a) => String(a.occurred_at)).sort();
    const entered = moves.at(-1) ?? spec.created;
    const last = contactTimes.at(-1) ?? null;
    return {
      id,
      contact_id: cid(spec.contact),
      title: spec.title,
      stage_key: spec.stage,
      value: spec.value,
      next_step: null,
      next_at: null,
      status: CLOSED.has(spec.stage) ? spec.stage : "open",
      fields: "{}",
      stage_entered_at: entered,
      last_activity_at: last,
      untrusted_fields: "[]",
      archived: 0,
      version: 1,
      created_at: spec.created,
      updated_at: [spec.created, entered, last ?? spec.created].sort().at(-1) ?? spec.created,
      ...spec.extra,
    };
  });

  const task = (n: number, where: { deal?: number; contact?: number | string }, title: string, dueAt: string | null, created: string, extra: Row = {}): Row => ({
    id: `tk_seed${n2(n)}`,
    deal_id: where.deal === undefined ? null : `dl_seed${n2(where.deal)}`,
    contact_id: cid(where.contact ?? dealContact.get(where.deal ?? 0) ?? 0),
    title,
    due_at: dueAt,
    done_at: null,
    snoozed_until: null,
    source: "owner",
    untrusted_fields: "[]",
    version: 1,
    created_at: created,
    updated_at: created,
    ...extra,
  });

  const tasks: Row[] = [
    task(1, { deal: 1 }, "Pull the 1998 mezzanine drawings before Dana's call", laterToday, day(-2, "10:15")),
    task(2, { deal: 3 }, "Send Priya the balcony inspection checklist", day(-1, "09:00"), day(-4, "15:05")),
    task(3, { deal: 4 }, "Write the tank foundation proposal", day(4, "10:00"), day(-3, "16:00")),
    task(4, { deal: 5 }, "Check in with Grace about the proposal", day(-1, "16:00"), day(-6, "11:05"), {
      snoozed_until: day(1, "09:00"),
      version: 2,
      updated_at: day(-4, "09:10"),
    }),
    task(5, { contact: 6 }, "Find Owen's card from the architects' mixer", null, day(-12, "18:30")),
    task(6, { deal: 7 }, "Send Luis the signed retrofit agreement", day(-9, "09:00"), day(-10, "14:05"), {
      done_at: day(-9, "10:00"),
      version: 2,
      updated_at: day(-9, "10:00"),
    }),
    task(7, { deal: 18 }, "Ask Chris for photos of the wall", day(-2, "17:00"), day(-3, "09:20")),
    task(8, { deal: 9 }, "Check Marcus has what their finance team needs", laterToday, day(-1, "11:25")),
    task(9, { deal: 19 }, "Pull the as-built drawings for building C", day(5, "09:00"), day(-4, "14:10")),
    task(10, { deal: 16 }, "Reply to Aaron with two times for a call", day(1, "09:00"), day(-2, "17:50")),
    task(11, { deal: 12 }, "Send Sofia the stamped drawings", day(-22, "12:00"), day(-26, "15:05"), {
      done_at: day(-22, "11:00"),
      updated_at: day(-22, "11:00"),
    }),
    // A lead's next step is a task on the person. Set to Not now with a follow-up date, so Check back is future;
    // the other came due two days ago.
    task(12, { contact: "ct_lead06" }, "Check back with Colin Reyes", day(10, "09:00"), day(-9, "10:00")),
    task(13, { contact: "ct_lead10" }, "Check back with Omar Rashid", day(-2, "09:00"), day(-15, "10:00")),
    // Standalone to-dos (decision 0046): on no person or deal, one with a due date and one without.
    task(14, {}, "Renew the van insurance", day(3, "09:00"), day(-1, "08:30"), { contact_id: null }),
    task(15, {}, "Order business cards", null, day(-2, "13:45"), { contact_id: null }),
  ];

  const rules: Row[] = [
    {
      id: "ru_seed01",
      type: "gone_quiet",
      params: '{"type":"gone_quiet","days":5}',
      description: "Flag any open deal with no activity for 5 days in the daily brief.",
      active: 1,
      created_by: "owner",
      version: 1,
      created_at: day(-20, "09:00"),
      updated_at: day(-20, "09:00"),
    },
    {
      id: "ru_seed02",
      type: "stage_followup",
      params: '{"type":"stage_followup","stage":"call_done","days":2,"title":"Follow up with {contact}"}',
      description: "When a deal has been in Call done for 2 days with no activity, add a follow-up task. (Paused.)",
      active: 0,
      created_by: "owner",
      version: 2,
      created_at: day(-20, "09:05"),
      updated_at: day(-19, "09:00"),
    },
    {
      id: "ru_seed03",
      type: "lead_followup",
      params: '{"type":"lead_followup","status":"contacted","days":5}',
      description: "When a lead has been Contacted for 5 days with no contact logged, add a follow-up task.",
      active: 1,
      created_by: "owner",
      version: 1,
      created_at: day(-18, "09:00"),
      updated_at: day(-18, "09:00"),
    },
  ];

  const byId = (rows: Row[], id: string): Row => {
    const row = rows.find((r) => r.id === id);
    if (!row) throw new Error(`The seed has no row ${id}.`);
    return row;
  };
  const C = (id: string) => byId(contacts, id);
  const D = (id: string) => byId(deals, id);
  const T = (id: string) => byId(tasks, id);
  const R = (id: string) => byId(rules, id);
  /** A deal as the services name it in change summaries: "Title" (Contact name). */
  const dealLabel = (dealId: string) => {
    const deal = D(dealId);
    return `"${String(deal.title)}" (${String(C(String(deal.contact_id)).name)})`;
  };
  /** `row` as it was one change earlier: `patch` applied and the version one lower. */
  const earlier = (row: Row, patch: Row): Row => ({ ...row, ...patch, version: Number(row.version) - 1 });
  const activityOf = (what: string, test: (a: Row) => boolean): Row => {
    const found = activities.find(test);
    if (!found) throw new Error(`The seed has no ${what}.`);
    return found;
  };

  type Touch = { table: string; id: string; before: Row | null; after: Row | null };
  const audit: Row[] = [];
  const change = (
    n: number,
    at: string,
    actor: string,
    tool: string,
    target: [string, string],
    summary: string,
    touches: Touch[],
    extra: Row = {},
  ) => {
    const id = `chg_seed${String(n).padStart(8, "0")}`;
    const snapshot = (side: "before" | "after") =>
      JSON.stringify(Object.fromEntries(touches.map((t) => [`${t.table}:${t.id}`, t[side]])));
    audit.push({
      id,
      at,
      actor,
      tool,
      target_table: target[0],
      target_id: target[1],
      before_json: snapshot("before"),
      after_json: snapshot("after"),
      summary: `${summary} (change ${id})`,
      undone_at: null,
      undone_by: null,
      undo_of: null,
      ...extra,
    });
  };

  // Rule ru_seed01 is still as it was added, so this change can be undone.
  change(1, day(-20, "09:00"), "owner", "add_rule", ["rules", "ru_seed01"], `Added rule ru_seed01: ${R("ru_seed01").description}`, [
    { table: "rules", id: "ru_seed01", before: null, after: R("ru_seed01") },
  ]);
  change(2, day(-19, "09:00"), "owner", "pause_rule", ["rules", "ru_seed02"], "Paused rule ru_seed02", [
    { table: "rules", id: "ru_seed02", before: earlier(R("ru_seed02"), { active: 1, updated_at: day(-20, "09:05") }), after: R("ru_seed02") },
  ]);
  // Dana's lead as it was first added. Undo would remove the contact, and the activities and task added since depend
  // on it, so undo refuses ("other records now depend on it").
  const dana = C("ct_seed01");
  const danaDeal = D("dl_seed01");
  change(3, day(-9, "09:00"), "owner", "add_lead", ["deals", "dl_seed01"], `Added lead Dana Whitfield with deal "${danaDeal.title}" in New inquiry`, [
    { table: "contacts", id: "ct_seed01", before: null, after: dana },
    {
      table: "deals",
      id: "dl_seed01",
      before: null,
      after: {
        ...danaDeal,
        stage_key: "new_inquiry",
        next_step: null,
        next_at: null,
        stage_entered_at: String(danaDeal.created_at),
        last_activity_at: null,
        version: 1,
        updated_at: String(danaDeal.created_at),
      },
    },
  ]);
  change(4, day(-9, "10:00"), "owner", "complete_task", ["tasks", "tk_seed06"], `Completed task "${T("tk_seed06").title}" for ${dealLabel("dl_seed07")}`, [
    { table: "tasks", id: "tk_seed06", before: earlier(T("tk_seed06"), { done_at: null, updated_at: String(T("tk_seed06").created_at) }), after: T("tk_seed06") },
  ]);
  change(5, day(-4, "09:10"), "ai", "snooze_task", ["tasks", "tk_seed04"], `Snoozed task "${T("tk_seed04").title}" for ${dealLabel("dl_seed05")} until ${formatLocal(day(1, "09:00"), tz)}`, [
    { table: "tasks", id: "tk_seed04", before: earlier(T("tk_seed04"), { snoozed_until: null, updated_at: String(T("tk_seed04").created_at) }), after: T("tk_seed04") },
  ]);

  // A move made by mistake and undone a few minutes later: both entries stay in the log, neither can be undone again.
  const jake = D("dl_seed14");
  const jakeLabel = dealLabel("dl_seed14");
  const wrongMove: Row = {
    id: "ac_seedundone1",
    deal_id: "dl_seed14",
    contact_id: "ct_seed14",
    type: "stage_change",
    summary: "Moved from Call done to Proposal sent.",
    untrusted_text: null,
    data: '{"from":"call_done","to":"proposal_sent"}',
    occurred_at: day(-3, "11:00"),
    actor: "ai",
    version: 1,
    created_at: day(-3, "11:00"),
  };
  const jakeBefore = { ...jake, version: 2, updated_at: day(-4, "10:30") };
  const jakeMoved = { ...jake, stage_key: "proposal_sent", stage_entered_at: day(-3, "11:00"), version: 3, updated_at: day(-3, "11:00") };
  change(6, day(-3, "11:00"), "ai", "update_deal", ["deals", "dl_seed14"], `Moved ${jakeLabel} to Proposal sent`, [
    { table: "deals", id: "dl_seed14", before: jakeBefore, after: jakeMoved },
    { table: "activities", id: "ac_seedundone1", before: null, after: wrongMove },
  ], { undone_at: day(-3, "11:05"), undone_by: "chg_seed00000007" });
  change(7, day(-3, "11:05"), "owner", "undo_change", ["deals", "dl_seed14"], `Undid chg_seed00000006: Moved ${jakeLabel} back to Call done`, [
    { table: "activities", id: "ac_seedundone1", before: wrongMove, after: null },
    { table: "deals", id: "dl_seed14", before: jakeMoved, after: jake },
  ], { undo_of: "chg_seed00000006" });

  const danaMove = activityOf("move of dl_seed01", (a) => a.deal_id === "dl_seed01" && a.occurred_at === day(-2, "10:15"));
  const danaNext = nextPart(String(danaDeal.next_step), String(danaDeal.next_at), tz);
  change(8, day(-2, "10:15"), "ai", "update_deal", ["deals", "dl_seed01"], `Moved ${dealLabel("dl_seed01")} to Call booked${danaNext}`, [
    {
      table: "deals",
      id: "dl_seed01",
      before: earlier(danaDeal, { stage_key: "replied", stage_entered_at: day(-6, "11:05"), next_step: null, next_at: null, updated_at: day(-2, "10:10") }),
      after: danaDeal,
    },
    { table: "activities", id: String(danaMove.id), before: null, after: danaMove },
  ]);
  change(9, day(-2, "16:00"), "owner", "update_contact", ["contacts", "ct_seed15"], "Updated Nina Patel: phone", [
    { table: "contacts", id: "ct_seed15", before: earlier(C("ct_seed15"), { phone: null, updated_at: String(C("ct_seed15").created_at) }), after: C("ct_seed15") },
  ]);
  const form = activityOf("form on dl_seed02", (a) => a.deal_id === "dl_seed02" && a.type === "form");
  change(10, day(-1, "06:40"), "system", "intake", ["deals", "dl_seed02"], "Form submission: new lead, deal dl_seed02 (contact ct_seed02) in New inquiry", [
    { table: "contacts", id: "ct_seed02", before: null, after: C("ct_seed02") },
    { table: "deals", id: "dl_seed02", before: null, after: D("dl_seed02") },
    { table: "activities", id: String(form.id), before: null, after: form },
  ]);
  const marcusDeal = D("dl_seed09");
  const marcusCall = activityOf("call on dl_seed09", (a) => a.deal_id === "dl_seed09" && a.occurred_at === day(-1, "11:20"));
  change(11, day(-1, "11:20"), "owner", "log_activity", ["activities", String(marcusCall.id)], `Logged a call on ${dealLabel("dl_seed09")}: ${marcusCall.summary}`, [
    { table: "activities", id: String(marcusCall.id), before: null, after: marcusCall },
    { table: "deals", id: "dl_seed09", before: earlier(marcusDeal, { last_activity_at: day(-2, "15:30"), updated_at: day(-2, "15:35") }), after: marcusDeal },
  ]);
  change(12, day(-1, "11:25"), "ai", "add_task", ["tasks", "tk_seed08"], `Added task "${T("tk_seed08").title}" for ${dealLabel("dl_seed09")}, due ${formatLocal(laterToday, tz)}`, [
    { table: "tasks", id: "tk_seed08", before: null, after: T("tk_seed08") },
  ]);

  // Elena's deal moved to Call booked by the AI; it has moved on to Call done since, so undo refuses with "changed since"
  // (nothing depends on what the change added, so that is the answer the owner sees).
  const elena = D("dl_seed04");
  const elenaMove = activityOf("move of dl_seed04", (a) => a.deal_id === "dl_seed04" && a.occurred_at === day(-6, "10:05"));
  const elenaBooked: Row = {
    ...elena,
    stage_key: "call_booked",
    stage_entered_at: day(-6, "10:05"),
    last_activity_at: day(-6, "10:00"),
    next_step: null,
    next_at: null,
    version: 2,
    updated_at: day(-6, "10:05"),
  };
  change(13, day(-6, "10:05"), "ai", "update_deal", ["deals", "dl_seed04"], `Moved ${dealLabel("dl_seed04")} to Call booked`, [
    { table: "deals", id: "dl_seed04", before: { ...elenaBooked, stage_key: "new_inquiry", stage_entered_at: String(elena.created_at), version: 1, updated_at: String(elena.created_at) }, after: elenaBooked },
    { table: "activities", id: String(elenaMove.id), before: null, after: elenaMove },
  ]);

  // The leads. Each of these is still the newest change on its rows, so undo takes it back; nothing else was done to
  // these rows since (no later activity or task depends on what a change added).
  change(14, day(-18, "09:00"), "owner", "add_rule", ["rules", "ru_seed03"], `Added rule ru_seed03: ${R("ru_seed03").description}`, [
    { table: "rules", id: "ru_seed03", before: null, after: R("ru_seed03") },
  ]);
  const wren = C("ct_lead01");
  change(15, day(-2, "10:00"), "owner", "add_lead", ["contacts", "ct_lead01"], `Added lead ${wren.name} (New), from ${wren.source}`, [
    { table: "contacts", id: "ct_lead01", before: null, after: wren },
  ]);
  // The import's summary counts only; it never quotes the file.
  change(16, day(-3, "10:00"), "owner", "import", ["contacts", "ct_lead02"], "Imported 1 contact and filled details on 0", [
    { table: "contacts", id: "ct_lead02", before: null, after: C("ct_lead02") },
  ]);
  const imani = C("ct_lead03");
  const imaniText = activityOf("text to ct_lead03", (a) => a.contact_id === "ct_lead03");
  change(17, day(-6, "10:00"), "owner", "log_activity", ["activities", String(imaniText.id)], `Logged a note on ${imani.name}: ${imaniText.summary}; moved to Contacted`, [
    { table: "activities", id: String(imaniText.id), before: null, after: imaniText },
    { table: "contacts", id: "ct_lead03", before: earlier(imani, { lead_status: "new", ...leadColumns("new"), lead_status_at: String(imani.created_at), updated_at: String(imani.created_at) }), after: imani },
  ]);
  const colin = C("ct_lead06");
  change(18, day(-9, "10:00"), "owner", "update_contact", ["contacts", "ct_lead06"], `Updated ${colin.name}: lead status to Not now; added task "${T("tk_seed12").title}", due ${formatLocal(day(10, "09:00"), tz)}`, [
    { table: "contacts", id: "ct_lead06", before: earlier(colin, { lead_status: "contacted", ...leadColumns("contacted"), lead_status_at: day(-10, "11:00"), updated_at: day(-10, "11:00") }), after: colin },
    { table: "tasks", id: "tk_seed12", before: null, after: T("tk_seed12") },
  ]);
  const gwen = C("ct_lead12");
  change(19, day(-3, "10:00"), "owner", "qualify_lead", ["contacts", "ct_lead12"], `Qualified ${gwen.name}; added deal "${D("dl_seed21").title}" in New inquiry`, [
    { table: "contacts", id: "ct_lead12", before: earlier(gwen, { lead_status: "contacted", ...leadColumns("contacted"), lead_status_at: day(-5, "09:00"), updated_at: day(-5, "09:00") }), after: gwen },
    { table: "deals", id: "dl_seed21", before: null, after: D("dl_seed21") },
  ]);

  // Yesterday's brief, so the board shows one (with an outside line) and today's is still composed by the cron.
  const briefAt = day(-1, "07:00");
  const brief = composeBrief({
    now: new Date(briefAt),
    tz,
    tasks: {
      overdue: [
        { id: "tk_seed07", title: String(T("tk_seed07").title), dueAt: day(-2, "17:00"), dealTitle: String(D("dl_seed18").title), contactName: "Chris Dalton", untrusted_fields: [] },
      ],
      today: [
        { id: "tk_seed02", title: String(T("tk_seed02").title), dueAt: day(-1, "09:00"), dealTitle: String(D("dl_seed03").title), contactName: "Priya Raman", untrusted_fields: [] },
      ],
    },
    quietDeals: [
      { id: "dl_seed06", title: String(D("dl_seed06").title), contactName: "Owen Price", quietDays: 9, untrusted_fields: [] },
      { id: "dl_seed11", title: String(D("dl_seed11").title), contactName: "Ben Hartley", quietDays: 8, untrusted_fields: [] },
    ],
    newLeads: [
      {
        dealId: "dl_seed02",
        contactId: "ct_seed02",
        title: String(D("dl_seed02").title),
        contactName: String(C("ct_seed02").name),
        createdAt: day(-1, "06:40"),
        untrusted_fields: ["title", "contactName"],
      },
      {
        dealId: "dl_seed16",
        contactId: "ct_seed16",
        title: String(D("dl_seed16").title),
        contactName: "Aaron Brooks",
        createdAt: day(-2, "17:45"),
        untrusted_fields: [],
      },
    ],
    leads: null,
  });
  const briefs: Row[] = [
    {
      id: "br_seed01",
      local_date: brief.localDate,
      composed_at: briefAt,
      text: brief.text,
      items: JSON.stringify(brief.items),
      sent_at: null,
      send_status: "off: brief_enabled is off",
    },
  ];

  // Board import drafts (decision 0036): fake files at the matching step, the check step and applied. The applied one
  // is the seed's import change above.
  const csv = (lines: string[]) => `${lines.join("\r\n")}\r\n`;
  const draft = (n: number, mapping: unknown[], asLeads: boolean, result: Row | null, changeId: string | null, created: string): Row => ({
    id: `im_seed${n2(n)}`,
    module: "people",
    created_at: created,
    expires_at: SEED_DRAFT_EXPIRES,
    mapping: JSON.stringify(mapping),
    options: JSON.stringify({ asLeads }),
    result: result === null ? null : JSON.stringify(result),
    change_id: changeId,
    version: 1,
  });
  const to = (key: string) => ({ kind: "builtin", key });
  const importDrafts: Row[] = [
    draft(1, [to("name"), to("email"), to("phone"), to("business"), { kind: "notes", label: "How we met" }, { kind: "new_field", label: "Budget" }], false, null, null, day(0, "08:00")),
    draft(2, [to("name"), to("email"), to("phone"), to("business"), { kind: "notes", label: "Referred by" }, { kind: "skip" }], false, null, null, day(0, "08:10")),
    draft(3, [to("name"), to("email"), to("business"), to("source")], true, { created: 1, filled: 0, unchanged: 0, skipped: 0, duplicates: 0, fields: 0 }, "chg_seed00000016", day(-3, "09:55")),
  ];
  const importDraftParts: Row[] = [
    {
      draft_id: "im_seed01",
      seq: 1,
      text: csv([
        "Full name,E-mail,Mobile,Company,How we met,Budget",
        "Nadia Fenwick,nadia.fenwick@example.com,555-0141,Fenwick Bakery,Trade show,5000",
        "Oscar Lindqvist,oscar.lindqvist@example.net,,Lindqvist Joinery,Referral,",
      ]),
    },
    {
      draft_id: "im_seed02",
      seq: 1,
      text: csv([
        "Name,Email,Phone,Company,Referred by,Colour",
        "Nadia Fenwick,nadia.fenwick@example.com,555-0141,Fenwick Bakery,Pat at the fair,blue",
        "Oscar Lindqvist,oscar.lindqvist@example.net,,Lindqvist Joinery,,green",
        "Ruth Adams,ruth.adams@example.org,,,Hannah Cole,",
        "Bea Quinn,not-an-email,555-0144,Quinn Studio,,",
        ",,555-0145,,,",
      ]),
    },
  ];

  // Saved views (decision 0042): everyone who came by referral, latest activity first; open commercial jobs by value.
  const view = (n: number, name: string, module: string, filters: unknown, sort: string, created: string): Row => ({
    id: `vw_seed${n2(n)}`,
    name,
    module,
    filters: JSON.stringify(filters),
    sort,
    layout: "cards",
    columns: JSON.stringify(
      module === "people"
        ? ["name", "business", "person_status", "sub_status", "next_task", "last_activity"]
        : ["deal", "person", "stage", "value", "next_step", "days_in_stage"],
    ),
    position: 1,
    archived: 0,
    version: 1,
    created_at: created,
    updated_at: created,
  });
  const views: Row[] = [
    view(1, "Referrals", "people", { source: "referral" }, "last_activity-desc", day(-4, "09:00")),
    view(2, "Commercial jobs", "deals", { fields: { project_type: "Commercial" } }, "value-desc", day(-4, "09:05")),
  ];

  // Time tracking is on in the demo (decision 0049): two work types and one finished entry with its note, no timer running.
  const workTypes: Row[] = [
    { id: "wt_seed01", name: "Design", hourly_rate: 95, billable_default: 1, position: 1, archived: 0, version: 1, created_at: day(-8, "09:00"), updated_at: day(-8, "09:00") },
    { id: "wt_seed02", name: "Admin", hourly_rate: null, billable_default: 0, position: 2, archived: 0, version: 1, created_at: day(-8, "09:00"), updated_at: day(-8, "09:00") },
  ];
  const noteId = `ac_seed${n2(activities.length)}`;
  const spent = day(-46, "14:00");
  const timeEntries: Row[] = [
    {
      id: "te_seed01",
      contact_id: "ct_seed04",
      deal_id: "dl_seed20",
      task_id: null,
      started_at: spent,
      ended_at: day(-46, "15:00"),
      minutes: 60,
      work_type_id: "wt_seed01",
      billable: 1,
      rate: 95,
      notes: "Walked Elena through the taproom mezzanine drawings.",
      activity_id: noteId,
      archived: 0,
      untrusted_fields: "[]",
      version: 1,
      created_at: day(-46, "15:00"),
      updated_at: day(-46, "15:00"),
    },
  ];

  // The time pages' week (decision 0051): Elena has her own Design rate ($110 an hour, the others pay $95), and eight finished
  // entries for three people and two deals, anchored to this week's Monday so /time is never empty: three on that Monday
  // (one may be later than the seed's "now" on a Monday morning) and five in the previous week. One is Admin, so not
  // billable. dl_seed01 stays untouched.
  const monday = periodOf("this_week", now, tz).from;
  const at = (offset: number, hhmm: string) => zonedToUtc(`${addDays(monday, offset)}T${hhmm}`, tz).toISOString();
  const clientRates: Row[] = [
    { id: "cr_seed01", work_type_id: "wt_seed01", contact_id: "ct_seed04", hourly_rate: 110, archived: 0, version: 1, created_at: day(-8, "09:00"), updated_at: day(-8, "09:00") },
  ];
  const spans: [n: number, offset: number, from: string, minutes: number, contact: string, deal: string | null, type: "wt_seed01" | "wt_seed02", rate: number | null, notes: string][] = [
    [2, 0, "09:00", 90, "ct_seed04", "dl_seed04", "wt_seed01", 110, "Reworked the tank footing drawings."],
    [3, 0, "11:00", 120, "ct_seed07", "dl_seed19", "wt_seed01", 95, "Marked up the building C retrofit plan."],
    [4, 0, "14:00", 30, "ct_seed03", null, "wt_seed02", null, "Filed the balcony survey paperwork."],
    [5, -1, "14:00", 60, "ct_seed07", "dl_seed19", "wt_seed01", 95, "Site visit prep for building C."],
    [6, -2, "09:30", 45, "ct_seed04", "dl_seed04", "wt_seed01", 110, "Checked the tank loads with Elena."],
    [7, -4, "10:00", 150, "ct_seed07", "dl_seed19", "wt_seed01", 95, "Surveyed the storage building C slab."],
    [8, -5, "11:00", 60, "ct_seed03", null, "wt_seed01", 95, "Balcony condition notes."],
    [9, -6, "15:00", 75, "ct_seed04", "dl_seed04", "wt_seed01", 110, "First pass at the tank foundations."],
  ];
  timeEntries.push(
    ...spans.map(([n, ago, from, minutes, contact, deal, type, rate, notes]): Row => {
      const started = at(ago, from);
      const ended = new Date(new Date(started).getTime() + minutes * 60_000).toISOString();
      return {
        id: `te_seed${n2(n)}`,
        contact_id: contact,
        deal_id: deal,
        task_id: null,
        started_at: started,
        ended_at: ended,
        minutes,
        work_type_id: type,
        billable: rate === null ? 0 : 1,
        rate,
        notes,
        activity_id: null,
        archived: 0,
        untrusted_fields: "[]",
        version: 1,
        created_at: ended,
        updated_at: ended,
      };
    }),
  );

  return { fieldDefs, contacts, deals, activities, tasks, rules, briefs, audit, importDrafts, importDraftParts, views, workTypes, clientRates, timeEntries };
}

export function buildDevSeed(now: Date, tz: string): string {
  const seed = devSeed(now, tz);
  return [
    "-- Fake development data from scripts/seed-dev.ts. Not real people.",
    // Only when the owner hasn't named the local copy already.
    `UPDATE settings SET business_name = ${sqlValue(DEMO_BUSINESS_NAME)} WHERE id = 1 AND business_name IS NULL;`,
    ...seed.fieldDefs.map((row) => insert("field_defs", row)),
    ...seed.contacts.map((row) => insert("contacts", row)),
    ...seed.deals.map((row) => insert("deals", row)),
    ...seed.activities.map((row) => insert("activities", row)),
    ...seed.tasks.map((row) => insert("tasks", row)),
    ...seed.rules.map((row) => insert("rules", row)),
    ...seed.briefs.map((row) => insert("briefs", row)),
    ...seed.audit.map((row) => insert("audit_log", row)),
    ...seed.importDrafts.map((row) => insert("import_drafts", row)),
    ...seed.importDraftParts.map((row) => insert("import_draft_parts", row)),
    ...seed.views.map((row) => insert("views", row)),
    "UPDATE settings SET time_tracking = 1 WHERE id = 1;",
    ...seed.workTypes.map((row) => insert("work_types", row)),
    ...seed.clientRates.map((row) => insert("client_rates", row)),
    ...seed.timeEntries.map((row) => insert("time_entries", row)),
    "",
  ].join("\n");
}

export function parseSeedArgs(argv: string[]): { out: string; tz: string } {
  let out: string | undefined;
  let tz = DEFAULT_TZ;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") out = argv[++i];
    else if (arg === "--tz") tz = argv[++i] ?? "";
    else throw new Error(`Unknown option "${arg}". seed-dev.ts takes --out <file> and --tz <timezone>.`);
  }
  if (!out) throw new Error("Pass the output file as --out <file>, for example --out .wrangler/dev-seed.sql.");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`"${tz}" is not a timezone. Use an IANA name such as America/Los_Angeles.`);
  }
  return { out, tz };
}

function main(): void {
  let options: { out: string; tz: string };
  try {
    options = parseSeedArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
  writeFileSync(options.out, buildDevSeed(new Date(), options.tz));
  console.log(`Wrote fake seed data to ${options.out}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
