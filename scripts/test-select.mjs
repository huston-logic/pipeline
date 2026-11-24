// Picks the unit tests worth running for a set of changed files (`npm run check:fast`). When unsure it picks all of them.
import { posix } from "node:path";

const CODE_DIRS = ["src/", "scripts/", "tests/helpers/"];
const CODE_FILE = /\.(ts|mjs|js)$/;
const RUN_ALL_FILES = [
  /^package(-lock)?\.json$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /^eslint\.config\./,
  /^wrangler\.jsonc$/,
  /^(config|migrations|seed)\//,
  /^tests\/helpers\/(workers-runtime|cloudflare-workers-stub)\.mjs$/,
];
const NAMED_ONLY = [/\.md$/, /^tests\/(e2e|a11y)\//, /^\.claude\//, /^\.github\//];
const IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*(["'])([^"']+)\1/g;
const MAX_SHARE = 0.6;

const isCode = (p) => CODE_FILE.test(p) && CODE_DIRS.some((d) => p.startsWith(d));
export const isUnitTest = (p) => /^src\/.+\.test\.ts$/.test(p) || /^scripts\/[^/]+\.test\.(ts|mjs)$/.test(p);

// Repo-relative paths of the relative imports in `text`; package names are ignored.
export function importsOf(path, text) {
  const found = new Set();
  for (const m of text.matchAll(IMPORT)) {
    if (m[2].startsWith(".")) found.add(posix.normalize(posix.join(posix.dirname(path), m[2])));
  }
  return [...found];
}

function siblingTests(path, files) {
  const base = path.replace(CODE_FILE, "");
  return [`${base}.test.ts`, `${base}.test.mjs`].filter((t) => t !== path && files.has(t));
}

export function selectTests({ changed, files }) {
  if (changed.length === 0) return { mode: "none", tests: [], reasons: ["nothing changed"] };
  const unitTests = [...files.keys()].filter(isUnitTest);
  const importers = new Map();
  for (const [path, text] of files) {
    if (!CODE_FILE.test(path)) continue;
    for (const target of importsOf(path, text)) importers.set(target, [...(importers.get(target) ?? []), path]);
  }
  const textsHaving = (needle) => unitTests.filter((t) => files.get(t).includes(needle));

  const picked = new Set();
  const reasons = [];
  let all = false;
  const runAll = (why) => {
    all = true;
    reasons.push(why);
  };

  for (const path of changed) {
    if (isCode(path) && !files.has(path)) runAll(`${path}: deleted, so run everything`);
    else if (RUN_ALL_FILES.some((re) => re.test(path))) runAll(`${path}: shared setup or config, so run everything`);
    else if (isUnitTest(path)) {
      picked.add(path);
      reasons.push(`${path}: a unit test, runs itself`);
    } else if (isCode(path)) {
      const own = siblingTests(path, files);
      const direct = importers.get(path) ?? [];
      const others = direct.filter((p) => !own.includes(p));
      for (const t of [...own, ...direct.filter(isUnitTest)]) picked.add(t);
      for (const importer of direct.filter((p) => !isUnitTest(p))) {
        for (const t of siblingTests(importer, files)) picked.add(t);
        for (const t of importers.get(importer) ?? []) if (isUnitTest(t)) picked.add(t);
      }
      reasons.push(`${path}: ${own.length ? "own test + " : "no own test + "}${others.length} importers`);
    } else if (NAMED_ONLY.some((re) => re.test(path))) {
      const named = textsHaving(path);
      named.forEach((t) => picked.add(t));
      reasons.push(`${path}: runs the ${named.length} test(s) that name it`);
    } else {
      const named = textsHaving(path);
      const byName = named.length ? named : textsHaving(posix.basename(path));
      if (byName.length === 0) runAll(`${path}: no test names it, so run everything`);
      else {
        byName.forEach((t) => picked.add(t));
        reasons.push(`${path}: runs the ${byName.length} test(s) that name it`);
      }
    }
  }

  if (all) return { mode: "all", tests: [], reasons };
  if (picked.size > MAX_SHARE * unitTests.length) {
    reasons.push(`${picked.size} of ${unitTests.length} unit tests picked (over 60%), so run everything`);
    return { mode: "all", tests: [], reasons };
  }
  return { mode: picked.size ? "some" : "none", tests: [...picked].sort(), reasons };
}
