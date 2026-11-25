// Start timer (decision 0050): a plain one-button form on a person, a deal and a task. It posts the subject's id as a
// hidden field to /timer/start, which calls start_timer. Offered only while time tracking is on and no timer runs.
import { type FormContext, hidden, postForm } from "./forms.ts";
import { type Html, html } from "./html.ts";

export const START_PATH = "/timer/start";

export type TimerSubject = { kind: "contact" | "deal" | "task" | "project"; id: string };

/** The button, or nothing. `name` is the record's safe name, read out after the button for a screen reader. */
export function startTimerForm(subject: TimerSubject, form: FormContext, name?: string): Html | "" {
  if (form.startTimer !== true) return "";
  const named = name === undefined ? "" : html`<span class="visually-hidden">: ${name}</span>`;
  return postForm(
    "timer-start",
    START_PATH,
    form,
    html`${hidden(subject.kind, subject.id)}<button class="button button-quiet button-small" type="submit">Start timer${named}</button>`,
  );
}
