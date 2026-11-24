// /timer/stop (decision 0050): "What did you do?", the form a running timer is stopped with. The Stop bar links here
// (a link, not a post, because Stop opens this form); POST /timer/stop (time-actions.ts) calls stop_timer. With no timer
// running the page says so. 404 while time tracking is off.
import type { WorkTypeRow } from "../../db/db.ts";
import { getSettings } from "../../db/queries.ts";
import { ownerTimezone, workTypeById } from "../../services/lookup.ts";
import { runningTimer } from "../../services/time-entries.ts";
import { listWorkTypes } from "../../services/work-types.ts";
import { localWhen } from "../../time.ts";
import type { PageContext } from "../context.ts";
import { postForm } from "../forms.ts";
import { html } from "../html.ts";
import { checkbox } from "../inputs.ts";
import { renderPage } from "../layout.ts";
import { formErrorSummary, specField } from "../record-fields.ts";
import { type FormError, line, type Shown, type Spec } from "../record-form.ts";
import { timerState } from "../timer-bar.ts";

export const TIMER_STOP_PATH = "/timer/stop";
export const STOP_PREFIX = "stop";

export const stopSpecs = (types: Pick<WorkTypeRow, "id" | "name">[]): Spec[] => [
  line("notes", "Notes", "textarea", "deal"),
  line("work_type", "Work type", "choice", "deal", {
    column: undefined,
    prop: "workType",
    options: [{ value: "", label: "None" }, ...types.map((type) => ({ value: type.id, label: type.name }))],
  }),
  line("next_step", "Next step date (optional)", "date", "deal", { column: undefined, prop: "nextStepDate" }),
  line("started", "Start", "when", "deal", { column: undefined, prop: "startedAt" }),
  line("ended", "End", "when", "deal", { column: undefined, prop: "endedAt" }),
];

/** A refused stop's form as it was posted, with what went wrong. */
export type StopState = { shown: Map<string, Shown>; billable: boolean; errors: FormError[] };

/** The page, or null while time tracking is off. `state` is a refused post: the form again with its values and errors. */
export async function timerStopPage(ctx: PageContext, state?: StopState): Promise<string | null> {
  const { db, now } = ctx;
  const settings = await getSettings(db);
  if (settings.time_tracking !== 1) return null;
  const { timer } = await timerState(db, now, settings);
  const running = await runningTimer(db);
  const frame = { ...ctx, timer };
  if (running === null) {
    return renderPage({
      title: "Timer",
      description: "No timer is running.",
      frame,
      body: html`<h1>Timer</h1>
<p class="lede">No timer is running.</p>
<p><a class="button" href="/">Back to Today</a></p>`,
    });
  }
  const tz = await ownerTimezone(db);
  const types = (await listWorkTypes(db)).map(({ id, name }) => ({ id, name }));
  const specs = stopSpecs(types);
  let shown = state?.shown;
  let billable = state?.billable ?? false;
  if (shown === undefined) {
    const start = localWhen(running.started_at, tz);
    const end = localWhen(now, tz);
    const own = running.work_type_id === null ? null : await workTypeById(db, running.work_type_id);
    billable = own?.billable_default === 1;
    shown = new Map<string, Shown>([
      ["notes", { value: "", outside: false }],
      ["work_type", { value: own?.id ?? "", outside: false }],
      ["next_step", { value: "", outside: false }],
      ["started", { value: start, was: start, outside: false }],
      ["ended", { value: end, was: end, outside: false }],
    ]);
  }
  const field = (name: string) => {
    const spec = specs.find((item) => item.name === name);
    return spec === undefined ? "" : specField(spec, shown.get(name), STOP_PREFIX);
  };
  const errors = state?.errors ?? [];
  return renderPage({
    title: state === undefined ? "What did you do?" : "Error: What did you do?",
    description: "Say what you did, then save the time.",
    frame,
    body: html`<h1>What did you do?</h1>
${errors.length === 0 ? "" : formErrorSummary(errors, specs, STOP_PREFIX)}
${postForm(
  "stop-form",
  TIMER_STOP_PATH,
  { csrf: ctx.csrf, here: "/" },
  html`${field("notes")}
${field("work_type")}
${checkbox({ id: "stop-billable", name: "billable", label: "Billable", value: "yes", checked: billable })}
${field("next_step")}
${field("started")}
${field("ended")}
<button class="button" type="submit">Save time</button>`,
  { novalidate: true },
)}`,
  });
}
