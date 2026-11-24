// `npm run test:lighthouse`: Lighthouse CI's healthcheck, collect, upload and assert (settings in lighthouserc.cjs),
// as `lhci autorun` does, with one change: when a run crashes (on CI machines Chrome's trace sometimes misses its
// start, NO_NAVSTART, and Lighthouse CI's own three quick tries all hit it), the pages that did not get all their runs
// are collected again after a pause, at most RETRIES times. Scores are checked only by `lhci assert`, after every page
// has its runs, so a retry can never hide a low score; a page that keeps crashing still fails the job.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const RETRIES = 2;
const PAUSE_MS = 10_000;
const DIR = ".lighthouseci";
const RESULT = /^(lhr-\d+(?:-\d+)?)\.json$/;

/**
 * The pages to collect again: every URL with fewer than `runs` saved results, and the saved results of those URLs
 * (removed first, so each page ends with exactly `runs`). `saved` is each result's file base name and requested URL.
 */
export function unfinished(urls, saved, runs) {
  const retry = urls.filter((url) => saved.filter((result) => result.url === url).length < runs);
  const stale = saved.filter((result) => retry.includes(result.url)).map((result) => result.base);
  return { urls: retry, stale };
}

function savedResults() {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).flatMap((name) => {
    const base = RESULT.exec(name)?.[1];
    if (base === undefined) return [];
    const { requestedUrl } = JSON.parse(readFileSync(join(DIR, name), "utf8"));
    return [{ base, url: String(requestedUrl) }];
  });
}

const lhci = (args) => spawnSync(resolve("node_modules/.bin/lhci"), args, { stdio: "inherit" }).status ?? 1;

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function main() {
  const { collect } = createRequire(import.meta.url)("../lighthouserc.cjs").ci;
  if (lhci(["healthcheck"]) !== 0) return 1;
  let status = lhci(["collect"]);
  for (let attempt = 1; status !== 0 && attempt <= RETRIES; attempt += 1) {
    const { urls, stale } = unfinished(collect.url, savedResults(), collect.numberOfRuns);
    if (urls.length === 0) break;
    for (const base of stale) {
      rmSync(join(DIR, `${base}.json`), { force: true });
      rmSync(join(DIR, `${base}.html`), { force: true });
    }
    console.log(`\nA Lighthouse run crashed. Collecting ${urls.length} page(s) again in ${PAUSE_MS / 1000} s (retry ${attempt} of ${RETRIES}).`);
    await pause(PAUSE_MS);
    status = lhci(["collect", "--additive", ...urls.map((url) => `--url=${url}`)]);
  }
  if (status !== 0) return status;
  // Upload (to .lighthouseci, for the job summary and the reports artifact) before the check, so a failed check still
  // leaves its reports behind.
  if (lhci(["upload"]) !== 0) return 1;
  return lhci(["assert"]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
