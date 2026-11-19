// The fixed fake data the unit tests run on: eight made-up contacts and deals, their activities, tasks, two rules and
// a brief. It is the dev seed as it was before run 2 (task R2), kept here so tests that need exact names, ids and counts
// don't depend on scripts/seed-dev.ts, which is the demo and may change. Obviously fake people only (example.com
// addresses, 555-01xx phone numbers). Dates are relative to `now`, so "overdue", "due today" and "gone quiet" always
// have something to show.
import { insert, type Row } from "../../scripts/seed-dev.ts";
import { composeBrief } from "../../src/brief/compose.ts";
import { addDays, dayBoundsUtc, localDate, zonedToUtc } from "../../src/time.ts";

export function buildFixtureSeed(now: Date, tz: string): string {
  const today = localDate(now, tz);
  /** Owner's local time `hhmm` on the day `days` from today (negative is the past), as a UTC ISO string. */
  const day = (days: number, hhmm: string) => zonedToUtc(`${addDays(today, days)}T${hhmm}`, tz).toISOString();

  const { end } = dayBoundsUtc(today, tz);
  const fivePm = zonedToUtc(`${today}T17:00`, tz).getTime();
  const lastMinute = end.getTime() - 60_000;
  const dueToday = new Date(
    fivePm > now.getTime() ? fivePm : lastMinute > now.getTime() ? lastMinute : end.getTime() - 1,
  ).toISOString();

  const contact = (n: string, name: string, business: string, created: string, extra: Row = {}): Row => ({
    id: `ct_seed${n}`,
    name,
    email: `${name.split(" ")[0]?.toLowerCase()}@example.com`,
    phone: `555-01${n}`,
    business,
    source: "referral",
    notes: null,
    untrusted_fields: "[]",
    created_at: created,
    updated_at: created,
    ...extra,
  });

  const deal = (n: string, title: string, stage: string, entered: string, lastActivity: string | null, extra: Row = {}) => ({
    id: `dl_seed${n}`,
    contact_id: `ct_seed${n}`,
    title,
    stage_key: stage,
    value: null,
    next_step: null,
    next_at: null,
    status: "open",
    stage_entered_at: entered,
    last_activity_at: lastActivity,
    created_at: entered,
    updated_at: entered,
    ...extra,
  });

  const activity = (n: string, dealN: string, type: string, summary: string, at: string, extra: Row = {}): Row => ({
    id: `ac_seed${n}`,
    deal_id: `dl_seed${dealN}`,
    contact_id: `ct_seed${dealN}`,
    type,
    summary,
    untrusted_text: null,
    data: null,
    occurred_at: at,
    actor: "owner",
    created_at: at,
    ...extra,
  });

  const task = (n: string, dealN: string, title: string, dueAt: string | null, created: string, extra: Row = {}) => ({
    id: `tk_seed${n}`,
    deal_id: `dl_seed${dealN}`,
    contact_id: `ct_seed${dealN}`,
    title,
    due_at: dueAt,
    done_at: null,
    snoozed_until: null,
    source: "owner",
    created_at: created,
    updated_at: created,
    ...extra,
  });

  const contacts = [
    contact("01", "Pat Example", "Example Plumbing", day(-9, "09:00")),
    contact("02", "Robin Sample", "Sample Bakery", day(-1, "08:40"), {
      source: "website form",
      untrusted_fields: '["name","email","business"]',
    }),
    contact("03", "Casey Placeholder", "Placeholder Landscaping", day(-6, "13:00")),
    contact("04", "Jordan Fake", "Fake Street Bikes", day(-3, "15:00")),
    contact("05", "Taylor Testcase", "Testcase Cafe", day(-14, "10:00")),
    contact("06", "Morgan Demo", "Demo Hardware", day(-12, "09:00"), {
      source: "trade fair",
      notes: "Met at a (fake) trade fair. Wants a quote in the spring.",
    }),
    contact("07", "Alex Sample", "Sample Salon", day(-20, "11:00")),
    contact("08", "Sam Example", "Example Auto Repair", day(-21, "16:00")),
  ];

  const deals = [
    deal("01", "Website refresh for Example Plumbing", "call_booked", day(-2, "10:15"), day(-2, "10:10"), {
      value: 1500,
      next_step: "Discovery call",
      next_at: day(2, "14:00"),
      created_at: day(-9, "09:00"),
    }),
    // From the website form, so its title is outside text.
    deal("02", "New website for Sample Bakery", "new_inquiry", day(-1, "08:40"), day(-1, "08:40"), {
      untrusted_fields: '["title"]',
    }),
    deal("03", "Landscaping site with a quote form", "replied", day(-4, "15:00"), day(-4, "15:00"), {
      created_at: day(-6, "13:00"),
    }),
    deal("04", "Online store for Fake Street Bikes", "call_done", day(-3, "16:00"), day(-3, "15:00"), {
      value: 2400,
      next_step: "Send the proposal",
      next_at: day(1, "12:00"),
      created_at: day(-3, "15:00"),
    }),
    deal("05", "Cafe website and menu", "proposal_sent", day(-6, "11:00"), day(-6, "11:00"), {
      value: 750,
      created_at: day(-14, "10:00"),
    }),
    deal("06", "Hardware store website", "new_inquiry", day(-12, "09:00"), null),
    deal("07", "Salon booking site", "won", day(-10, "14:00"), day(-10, "14:00"), {
      status: "won",
      value: 1800,
      created_at: day(-20, "11:00"),
    }),
    deal("08", "Auto repair landing page", "lost", day(-15, "10:00"), day(-15, "10:00"), {
      status: "lost",
      created_at: day(-21, "16:00"),
    }),
  ];

  const activities = [
    activity("01", "01", "email", "Pat asked about a new website for the plumbing business.", day(-8, "09:30")),
    activity("02", "01", "call", "Short intro call. Pat wants online booking.", day(-5, "11:00")),
    activity("03", "01", "email", "Sent two times for a call. Pat picked one.", day(-2, "10:10")),
    activity("04", "01", "stage_change", "Moved from Replied to Call booked.", day(-2, "10:15"), {
      data: '{"from":"replied","to":"call_booked"}',
      actor: "ai",
    }),
    activity("05", "02", "form", "Website form: new inquiry.", day(-1, "08:40"), {
      untrusted_text:
        "Hi! This is a fake test message from Robin Sample at Sample Bakery. We would like a simple website " +
        "with our menu and opening hours. (Seed data, not a real person.)",
      actor: "system",
    }),
    activity("06", "03", "email", "Casey asked what a website costs.", day(-6, "13:00")),
    activity("07", "03", "email", "Replied with the starting price and two examples.", day(-4, "15:00")),
    activity("08", "04", "meeting", "Video call. Jordan wants an online store for about 40 bikes.", day(-3, "15:00")),
    activity("09", "05", "email", "Sent the proposal.", day(-6, "11:00")),
    activity("10", "07", "call", "Alex said yes.", day(-10, "14:00")),
    activity("11", "08", "note", "Sam went with a cheaper option.", day(-15, "10:00")),
  ];

  const tasks = [
    task("01", "01", "Prepare questions for Pat's call", dueToday, day(-2, "10:15")),
    task("02", "03", "Send Casey the price sheet", day(-1, "09:00"), day(-4, "15:00")),
    task("03", "04", "Write the proposal for Jordan", day(4, "10:00"), day(-3, "16:00")),
    task("04", "05", "Check in with Taylor about the proposal", day(-1, "16:00"), day(-6, "11:00"), {
      snoozed_until: day(1, "09:00"),
    }),
    task("05", "06", "Find Morgan's business card", null, day(-12, "09:00"), { deal_id: null }),
    task("06", "07", "Send Alex the welcome pack", day(-9, "09:00"), day(-10, "14:00"), {
      done_at: day(-9, "10:00"),
      updated_at: day(-9, "10:00"),
    }),
  ];

  const rules: Row[] = [
    {
      id: "ru_seed01",
      type: "gone_quiet",
      params: '{"type":"gone_quiet","days":5}',
      description: "Flag any open deal with no activity for 5 days in the daily brief.",
      active: 1,
      created_by: "owner",
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
      created_at: day(-20, "09:05"),
      updated_at: day(-19, "09:00"),
    },
  ];

  // Yesterday's brief, so the board shows one (with an outside line) and today's is still composed by the cron.
  const briefAt = day(-1, "09:30");
  const brief = composeBrief({
    now: new Date(briefAt),
    tz,
    tasks: {
      overdue: [],
      today: [
        {
          id: "tk_seed02",
          title: "Send Casey the price sheet",
          dueAt: day(-1, "09:00"),
          dealTitle: "Landscaping site with a quote form",
          contactName: "Casey Placeholder",
          untrusted_fields: [],
        },
      ],
    },
    quietDeals: [
      { id: "dl_seed06", title: "Hardware store website", contactName: "Morgan Demo", quietDays: 11, untrusted_fields: [] },
    ],
    newLeads: [
      {
        dealId: "dl_seed02",
        contactId: "ct_seed02",
        title: "New website for Sample Bakery",
        contactName: "Robin Sample",
        createdAt: day(-1, "08:40"),
        untrusted_fields: ["title", "contactName"],
      },
    ],
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

  return [
    "-- Fake test data from tests/helpers/fixture-seed.ts. Not real people.",
    ...contacts.map((row) => insert("contacts", row)),
    ...deals.map((row) => insert("deals", row)),
    ...activities.map((row) => insert("activities", row)),
    ...tasks.map((row) => insert("tasks", row)),
    ...rules.map((row) => insert("rules", row)),
    ...briefs.map((row) => insert("briefs", row)),
    "",
  ].join("\n");
}
