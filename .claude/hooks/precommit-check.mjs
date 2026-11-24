// HOOK 2: precommit-check (runs before a Bash command that contains `git commit`, `git push` or `gh pr create`).
//
// WHAT IT BLOCKS, and why:
//   - Rule 1, a real `git commit`: runs the fast check (`npm run check:fast`, COMMIT_SCRIPT). The
//     project rule is "run the checks before every commit; if they fail, stop and show the error".
//   - Rule 2, a real `git push` or `gh pr create`: runs the full check (`npm run check`, PUSH_SCRIPT)
//     so nothing reaches GitHub unless everything passes locally.
//   - If one command holds both (for example `git commit ... && git push`), only the full check runs, once.
//   - Either rule blocks when the script is missing from package.json, or package.json is
//     unreadable (fail closed: no check means no commit or push).
//   When it blocks, it prints the last lines of the real error output.
//
// It does not run on main/master (Hook 1 already blocks commits and pushes there, so a long
// build would be wasted), and it ignores commands that are not real: `git commit --help`/`--dry-run`,
// `git push --help`/`--dry-run`, `gh pr create --help`.
//
// On success it tells the owner how long the check took, as a one-line notice.
//
// Known limits: it checks the working folder, not only staged files; and for
// `git add . && git commit` the check runs before the add. Fine for this repo.

import { spawnSync } from "node:child_process";
import {
  PROTECTED_BRANCHES,
  block,
  commandsOf,
  currentBranch,
  guard,
  parseGit,
  projectDirOf,
  readPackageJson,
} from "./lib.mjs";

const COMMIT_SCRIPT = "check:fast";
const PUSH_SCRIPT = "check";
const TAIL_LINES = 60;
const SKIP_FLAGS = ["--help", "-h", "--dry-run"];

const isRealGit = (g, sub) => g.sub === sub && !g.rest.some((a) => SKIP_FLAGS.includes(a));
const isPrCreate = (c) => {
  const i = c.args.indexOf("pr");
  return i >= 0 && c.args[i + 1] === "create" && !c.args.some((a) => a === "--help" || a === "-h");
};

guard("precommit-check", (input) => {
  const command = input.tool_input?.command;
  if (typeof command !== "string") throw new Error("no Bash command in the hook input");

  const all = commandsOf(command);
  const gits = all.filter((c) => c.prog === "git").map(parseGit);
  const commits = gits.filter((g) => isRealGit(g, "commit"));
  const pushes = gits.filter((g) => isRealGit(g, "push"));
  const prCreates = all.filter((c) => c.prog === "gh").filter(isPrCreate);
  const wantsFull = pushes.length > 0 || prCreates.length > 0;
  if (commits.length === 0 && !wantsFull) return;

  const SCRIPT = wantsFull ? PUSH_SCRIPT : COMMIT_SCRIPT;
  const what = wantsFull ? "push" : "commit";

  const projectDir = projectDirOf(input);
  let branch = "";
  try {
    branch = currentBranch(input.cwd);
  } catch {
    branch = "";
  }
  if (branch && PROTECTED_BRANCHES.includes(branch)) return; // Hook 1 blocks this one.

  const pkg = readPackageJson(projectDir);
  if (!pkg.scripts?.[SCRIPT]) {
    block(
      `Blocked: package.json has no "${SCRIPT}" script, so I can't run the pre-${what} check. ` +
        `Do this instead: add a "${SCRIPT}" script, then try again.`,
    );
  }

  const started = Date.now();
  const run = spawnSync("npm", ["run", SCRIPT], {
    cwd: projectDir,
    encoding: "utf8",
    timeout: 570_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (run.error || run.status !== 0) {
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().split("\n").slice(-TAIL_LINES).join("\n");
    block(
      `Blocked: "npm run ${SCRIPT}" failed after ${seconds}s${run.error ? ` (${run.error.message})` : ""}, so the ${what} did not happen.\n` +
        `Last ${TAIL_LINES} lines of output:\n${output}\n` +
        `Do this instead: fix the error above, then try the ${what} again. Do not use --no-verify.`,
    );
  }

  process.stdout.write(JSON.stringify({ systemMessage: `Pre-${what} check passed: npm run ${SCRIPT} took ${seconds}s.` }));
});
