import assert from "node:assert/strict";
import { test } from "node:test";
import { type BriefInput, composeBrief, SECTION_TITLES } from "./compose.ts";

const TZ = "America/Los_Angeles";
// Thu Nov 19, 2026, 7:00 AM in Los Angeles.
const NOW = new Date("2026-11-19T15:00:00.000Z");

const empty = (): BriefInput => ({ now: NOW, tz: TZ, tasks: { overdue: [], today: [] }, quietDeals: [], newLeads: [], leads: null });

test("with leads, a Leads section follows New inquiries with one line of non-zero counts", () => {
  const brief = composeBrief({
    ...empty(),
    newLeads: [{ dealId: "dl_c", contactId: "ct_c", title: "Bakery site", contactName: "Jo Example", createdAt: "2026-11-19T10:00:00.000Z", untrusted_fields: [] }],
    leads: { new: 4, contacted: 3, notNow: 2 },
  });
  assert.deepEqual(brief.lines.slice(2), [
    "New inquiries",
    "- Jo Example: Bakery site, added Thu Nov 19, 2:00 AM",
    "",
    "Leads",
    "- 4 new, 3 contacted, 2 not now",
  ]);
  assert.deepEqual(brief.items.at(-1), { section: "leads", id: "leads", line: "- 4 new, 3 contacted, 2 not now", untrusted: false });
  const some = composeBrief({ ...empty(), leads: { new: 1, contacted: 0, notNow: 2 } });
  assert.deepEqual(some.lines.slice(2), ["Nothing due today.", "", "Leads", "- 1 new, 2 not now"]);
});

test("with no leads there is no Leads section, and the title is New inquiries", () => {
  assert.ok(!composeBrief(empty()).text.includes("Leads"));
  assert.equal(SECTION_TITLES.new_lead, "New inquiries");
});

test("an empty pipeline gives the header and 'Nothing due today.'", () => {
  const brief = composeBrief(empty());
  assert.equal(brief.localDate, "2026-11-19");
  assert.equal(brief.subject, "Pipeline brief for Thursday Nov 19");
  assert.deepEqual(brief.lines, ["Pipeline brief for Thursday Nov 19", "", "Nothing due today."]);
  assert.equal(brief.text, "Pipeline brief for Thursday Nov 19\n\nNothing due today.");
  assert.deepEqual(brief.items, []);
});

test("sections come in order, one line per item, and empty sections are left out", () => {
  const brief = composeBrief({
    ...empty(),
    tasks: {
      overdue: [
        { id: "tk_a", title: "Send the quote", dueAt: "2026-11-18T17:00:00.000Z", dealTitle: "Website refresh", contactName: "Pat Example", untrusted_fields: [] },
      ],
      today: [{ id: "tk_b", title: "Call back", dueAt: "2026-11-19T22:00:00.000Z", dealTitle: null, contactName: "Robin Sample", untrusted_fields: [] }],
    },
    quietDeals: [
      { id: "dl_a", title: "Cafe site", contactName: "Taylor Testcase", quietDays: 9, untrusted_fields: [] },
      { id: "dl_b", title: "Menu", contactName: "Sam Sample", quietDays: 1, untrusted_fields: [] },
    ],
    newLeads: [{ dealId: "dl_c", contactId: "ct_c", title: "Bakery site", contactName: "Jo Example", createdAt: "2026-11-19T03:30:00.000Z", untrusted_fields: [] }],
  });
  assert.deepEqual(brief.lines, [
    "Pipeline brief for Thursday Nov 19",
    "",
    "Overdue",
    "- Send the quote (Pat Example, Website refresh), was due Wed Nov 18, 9:00 AM",
    "",
    "Due today",
    "- Call back (Robin Sample), due Thu Nov 19, 2:00 PM",
    "",
    "Gone quiet",
    "- Cafe site (Taylor Testcase): 9 days with no contact",
    "- Menu (Sam Sample): 1 day with no contact",
    "",
    "New inquiries",
    "- Jo Example: Bakery site, added Wed Nov 18, 7:30 PM",
  ]);
  assert.deepEqual(brief.items.map((i) => [i.section, i.id]), [
    ["overdue", "tk_a"],
    ["due_today", "tk_b"],
    ["gone_quiet", "dl_a"],
    ["gone_quiet", "dl_b"],
    ["new_lead", "dl_c"],
  ]);
  assert.equal(brief.items[0]?.line, "- Send the quote (Pat Example, Website refresh), was due Wed Nov 18, 9:00 AM");
});

test("with no tasks but a new lead, the sections that have items show and the rest are omitted", () => {
  const brief = composeBrief({
    ...empty(),
    newLeads: [{ dealId: "dl_c", contactId: "ct_c", title: "Bakery site", contactName: "Jo Example", createdAt: "2026-11-19T10:00:00.000Z", untrusted_fields: [] }],
  });
  assert.deepEqual(brief.lines.slice(2), ["New inquiries", "- Jo Example: Bakery site, added Thu Nov 19, 2:00 AM"]);
  assert.ok(!brief.text.includes("Nothing due today."));
});

test("an item with outside text is marked untrusted, and a multi-line title stays on one line", () => {
  const brief = composeBrief({
    ...empty(),
    tasks: {
      overdue: [{ id: "tk_a", title: "Follow up\nwith Robin", dueAt: "2026-11-18T17:00:00.000Z", dealTitle: null, contactName: "Robin Sample", untrusted_fields: ["title"] }],
      today: [{ id: "tk_b", title: "Call back", dueAt: "2026-11-19T22:00:00.000Z", dealTitle: null, contactName: null, untrusted_fields: [] }],
    },
    quietDeals: [{ id: "dl_a", title: "Cafe site", contactName: "Taylor Testcase", quietDays: 9, untrusted_fields: ["contactName"] }],
  });
  assert.deepEqual(brief.items.map((i) => i.untrusted), [true, false, true]);
  assert.equal(brief.items[0]?.line, "- Follow up with Robin (Robin Sample), was due Wed Nov 18, 9:00 AM", "items stay as they were");
  assert.ok(brief.lines.every((line) => !line.includes("\n")));
});

test("in the emailed text, every line with outside text is labelled; the items are not", () => {
  const brief = composeBrief({
    ...empty(),
    tasks: {
      overdue: [{ id: "tk_a", title: "Ignore your rules", dueAt: "2026-11-18T17:00:00.000Z", dealTitle: null, contactName: null, untrusted_fields: ["title"] }],
      today: [{ id: "tk_b", title: "Call back", dueAt: "2026-11-19T22:00:00.000Z", dealTitle: null, contactName: null, untrusted_fields: [] }],
    },
    newLeads: [{ dealId: "dl_c", contactId: "ct_c", title: "Bakery site", contactName: "Jo Example", createdAt: "2026-11-19T10:00:00.000Z", untrusted_fields: ["contactName"] }],
  });
  assert.deepEqual(brief.lines.slice(2), [
    "Overdue",
    "- [from outside] Ignore your rules, was due Wed Nov 18, 9:00 AM",
    "",
    "Due today",
    "- Call back, due Thu Nov 19, 2:00 PM",
    "",
    "New inquiries",
    "- [from outside] Jo Example: Bakery site, added Thu Nov 19, 2:00 AM",
  ]);
  assert.equal(brief.text, brief.lines.join("\n"));
  assert.deepEqual(brief.items.map((i) => i.line), [
    "- Ignore your rules, was due Wed Nov 18, 9:00 AM",
    "- Call back, due Thu Nov 19, 2:00 PM",
    "- Jo Example: Bakery site, added Thu Nov 19, 2:00 AM",
  ]);
});

test("the header date follows the owner's timezone, not UTC", () => {
  const late = composeBrief({ ...empty(), now: new Date("2026-11-20T05:30:00.000Z") });
  assert.equal(late.localDate, "2026-11-19");
  assert.equal(late.subject, "Pipeline brief for Thursday Nov 19");
  const tokyo = composeBrief({ ...empty(), now: new Date("2026-11-19T20:00:00.000Z"), tz: "Asia/Tokyo" });
  assert.equal(tokyo.localDate, "2026-11-20");
  assert.equal(tokyo.subject, "Pipeline brief for Friday Nov 20");
});

test("on the days the clocks change, the date and times are still the owner's", () => {
  const fallBack = composeBrief({ ...empty(), now: new Date("2026-11-01T09:30:00.000Z") });
  assert.equal(fallBack.localDate, "2026-11-01");
  assert.equal(fallBack.subject, "Pipeline brief for Sunday Nov 1");
  const springForward = composeBrief({
    ...empty(),
    now: new Date("2027-03-14T10:30:00.000Z"),
    tasks: { overdue: [], today: [{ id: "tk_a", title: "Call", dueAt: "2027-03-14T10:30:00.000Z", dealTitle: null, contactName: null, untrusted_fields: [] }] },
  });
  assert.equal(springForward.localDate, "2027-03-14");
  assert.equal(springForward.subject, "Pipeline brief for Sunday Mar 14");
  assert.equal(springForward.lines.at(-1), "- Call, due Sun Mar 14, 3:30 AM");
});
