// `npm run check:fast`: the quick local check while working: config guard, lint and typecheck (both cached), and only
// the unit tests the changed files can affect (scripts/test-select.mjs). It skips the e2e tests and the build, so
// `npm run check` still runs before every commit.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { selectTests } from "./test-select.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const UNIT_GLOBS = ["src/**/*.test.ts", "scripts/*.test.ts", "scripts/*.test.mjs"];
const WALKED = ["src", "scripts", "tests/helpers"];
const CODE = new Set([".ts", ".mjs", ".js"]);

function git(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.error?.message || "").trim()}`);
  return r.stdout.split("\n").filter(Boolean);
}

function changedFiles() {
  let base;
  for (const ref of ["main", "origin/main"]) {
    try {
      base = git(["merge-base", "HEAD", ref])[0];
      break;
    } catch {
      /* try the next ref */
    }
  }
  if (!base) throw new Error("no merge-base with main or origin/main");
  return [...new Set([...git(["diff", "--name-only", base]), ...git(["ls-files", "--others", "--exclude-standard"])])];
}

function readFiles() {
  const files = new Map();
  for (const dir of WALKED) {
    for (const entry of readdirSync(join(ROOT, dir), { recursive: true })) {
      const rel = `${dir}/${entry.split(sep).join("/")}`;
      if (rel.includes("node_modules") || !CODE.has(extname(rel))) continue;
      try {
        files.set(rel, readFileSync(join(ROOT, rel), "utf8"));
      } catch {
        /* a folder with a code-like name */
      }
    }
  }
  return files;
}

const start = Date.now();
const seconds = (from) => ((Date.now() - from) / 1000).toFixed(1);

function step(name, command, args) {
  const t = Date.now();
  console.log(`\n> ${name}`);
  const r = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  console.log(`  ${name}: ${seconds(t)} s`);
  if (r.status !== 0) {
    console.error(`check:fast stopped: ${name} failed`);
    process.exit(r.status ?? 1);
  }
}

let selection;
try {
  selection = selectTests({ changed: changedFiles(), files: readFiles() });
} catch (error) {
  selection = { mode: "all", tests: [], reasons: [`${error.message}, so run everything`] };
}
console.log(`Unit tests: ${selection.mode}`);
for (const line of selection.reasons) console.log(`  ${line}`);

const cache = "node_modules/.cache";
step("check:config", "npm", ["run", "check:config"]);
step("eslint", "npx", ["eslint", "--cache", "--cache-location", `${cache}/eslint/`, "."]);
step("tsc (worker)", "npx", ["tsc", "--noEmit", "--incremental", "--tsBuildInfoFile", `${cache}/tsc/worker.tsbuildinfo`]);
step("tsc (a11y)", "npx", ["tsc", "--noEmit", "--incremental", "--tsBuildInfoFile", `${cache}/tsc/a11y.tsbuildinfo`, "-p", "tests/a11y"]);

if (selection.mode !== "none") {
  const targets = selection.mode === "all" ? UNIT_GLOBS : selection.tests;
  step(`unit tests (${selection.mode === "all" ? "all" : `${targets.length} files`})`, process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "--import",
    "./tests/helpers/workers-runtime.mjs",
    "--test",
    ...targets,
  ]);
}
console.log(`\ncheck:fast passed in ${seconds(start)} s`);
