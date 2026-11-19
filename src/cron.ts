// The hourly Cron Trigger ("0 * * * *" in wrangler.jsonc). Each job runs on its own, so one failing never stops the
// next. Logs hold fixed event names and counts only, never record data or error text.
import { runBrief } from "./brief/run.ts";
import type { Env } from "./env.ts";
import { runRules } from "./services/rules.ts";

export type CronJob = (env: Env, now: Date) => Promise<Record<string, number>>;

/** Run in order on every trigger. The brief comes after the rules, so tasks they just created are in it. */
export const CRON_JOBS: [name: string, job: CronJob][] = [
  ["rules", (env, now) => runRules(env.DB, now)],
  ["brief", (env, now) => runBrief(env, now)],
];

export async function runScheduled(env: Env, now: Date, jobs: [string, CronJob][] = CRON_JOBS): Promise<void> {
  for (const [name, job] of jobs) {
    try {
      const counts = await job(env, now);
      console.log(JSON.stringify({ event: `cron_${name}_done`, ...counts }));
    } catch {
      console.error(JSON.stringify({ event: `cron_${name}_failed` }));
    }
  }
}
