import assert from "node:assert/strict";
import { test } from "node:test";
import { checkProcess, runCli } from "./check-process.mjs";

const PROCESS_MD = [
  "# Process",
  "",
  "## Where facts live",
  "Status in STATUS.md.",
  "",
  "## Rules",
  "",
  "### Small commits",
  "**What:** Commit often.",
  "**Why:** Easy to undo.",
  "**Decided:** 0052",
  "**Enforced by:** check:process",
  "",
  "## Other",
  "text",
].join("\n");

const HOOK_OK = 'const A = 1;\nconst COMMIT_SCRIPT = "check:fast";\nconst PUSH_SCRIPT = "check";\n';

const lines = (n, line = "x") => Array.from({ length: n }, () => line).join("\n");

function baseFiles() {
  return {
    ".claude/hooks/precommit-check.mjs": HOOK_OK,
    "docs/STATUS.md": "# Status\n\n## Current state\nok\n\n## For the master\nScope grew a little.\n\n## Changelog\nnone\n",
    "docs/superpowers/plans/2026-01-01-old.md": lines(400),
    "docs/superpowers/plans/2026-02-01-new.md": lines(20),
    "docs/decisions/README.md": "- [0001](0001-one.md) one\n- [0002](0002-two.md) two\n",
    "docs/decisions/0001-one.md": "x",
    "docs/decisions/0002-two.md": "x",
    ".claude/agents/review-code.md": "---\nname: review-code\nmodel: sonnet\n---\nbody",
    "docs/PROCESS.md": PROCESS_MD,
  };
}

function run(overrides = {}) {
  const files = { ...baseFiles(), ...overrides };
  for (const [path, text] of Object.entries(files)) if (text === null) delete files[path];
  const read = (path) => files[path] ?? null;
  const list = (dir) =>
    Object.keys(files)
      .filter((path) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes("/"))
      .map((path) => path.slice(dir.length + 1));
  return { read, list };
}

const problemsFor = (overrides) => checkProcess(run(overrides));

function statusWithMaster(masterLines) {
  return `# Status\n\n## For the master\n${masterLines.join("\n")}\n\n## Changelog\nnone\n`;
}

test("a fully passing fixture has no problems", () => {
  assert.deepEqual(problemsFor(), []);
});

test("hook must set COMMIT_SCRIPT to check:fast", () => {
  const problems = problemsFor({ ".claude/hooks/precommit-check.mjs": HOOK_OK.replace('"check:fast"', '"check"') });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /full suite/);
  assert.match(problems[0], /check:fast/);
});

test("hook must set PUSH_SCRIPT to check, as its own problem", () => {
  const problems = problemsFor({ ".claude/hooks/precommit-check.mjs": HOOK_OK.replace('PUSH_SCRIPT = "check"', 'PUSH_SCRIPT = "check:fast"') });
  assert.equal(problems.length, 1);
  assert.equal(
    problems[0],
    'The hook must run the full check before git push and gh pr create: .claude/hooks/precommit-check.mjs must set PUSH_SCRIPT to "check" (owner-only file; see docs/PROCESS.md).',
  );
  assert.equal(problemsFor({ ".claude/hooks/precommit-check.mjs": 'const COMMIT_SCRIPT = "check:fast";\n' }).length, 1);
});

test("a missing hook file has its own message", () => {
  const problems = problemsFor({ ".claude/hooks/precommit-check.mjs": null });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /precommit-check\.mjs is missing/);
});

test("STATUS.md at exactly 150 lines passes and 151 fails", () => {
  const head = "## For the master\nok\n\n## Changelog";
  const pad = (total) => `${head}\n${lines(total - 4)}\n`;
  assert.equal(pad(150).split("\n").length - 1, 150);
  assert.deepEqual(problemsFor({ "docs/STATUS.md": pad(150) }), []);
  const problems = problemsFor({ "docs/STATUS.md": pad(151) });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /151 lines/);
  assert.match(problems[0], /STATUS-history\.md/);
});

test("For the master: missing section fails", () => {
  const problems = problemsFor({ "docs/STATUS.md": "# Status\n\n## Changelog\nnone\n" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /For the master/);
});

test("For the master at 12 non-empty lines passes and 13 fails", () => {
  const twelve = Array.from({ length: 12 }, (_, i) => `Decision ${i}`);
  assert.deepEqual(problemsFor({ "docs/STATUS.md": statusWithMaster(twelve) }), []);
  const problems = problemsFor({ "docs/STATUS.md": statusWithMaster([...twelve, "One more"]) });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /13 lines/);
});

test("For the master rejects PR references but not plain numbers", () => {
  for (const line of ["Shipped in #12", "See PR 71", "pr #5 landed", "https://x.test/pull/9"]) {
    const problems = problemsFor({ "docs/STATUS.md": statusWithMaster(["fine", line]) });
    assert.equal(problems.length, 1, line);
    assert.match(problems[0], /PR numbers/, line);
    assert.match(problems[0], /line 5/, line);
  }
  assert.deepEqual(problemsFor({ "docs/STATUS.md": statusWithMaster(["Added 12 lines of scope"]) }), []);
});

test("the newest plan by name is checked; an older long plan is ignored", () => {
  assert.deepEqual(problemsFor(), []);
  const problems = problemsFor({ "docs/superpowers/plans/2026-03-01-newest.md": lines(151) });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /2026-03-01-newest\.md/);
  assert.match(problems[0], /151 lines/);
});

test("only dated plan names count as the newest plan", () => {
  assert.deepEqual(problemsFor({ "docs/superpowers/plans/README.md": lines(400), "docs/superpowers/plans/zzz.md": lines(400) }), []);
});

test("no plans is fine", () => {
  assert.deepEqual(
    problemsFor({
      "docs/superpowers/plans/2026-01-01-old.md": null,
      "docs/superpowers/plans/2026-02-01-new.md": null,
    }),
    [],
  );
});

test("a decision missing from the index fails", () => {
  const problems = problemsFor({ "docs/decisions/0003-three.md": "x" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /0003-three\.md/);
});

test("a decision counts as indexed only by a line starting with its number link", () => {
  const readme = "- [0001](0001-one.md) one\nSee also (0002-two.md) in text\n- [two](0002-two.md)\n";
  const problems = problemsFor({ "docs/decisions/README.md": readme });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /0002-two\.md/);
});

test("an index line whose file does not exist fails", () => {
  const readme = "- [0001](0001-one.md)\n- [0002](0002-two.md)\n- [0009](0009-gone.md)\n";
  const problems = problemsFor({ "docs/decisions/README.md": readme });
  assert.equal(problems.length, 1);
  assert.equal(problems[0], "docs/decisions/README.md links 0009-gone.md, which does not exist.");
});

test("non-decision files in docs/decisions are ignored", () => {
  assert.deepEqual(problemsFor({ "docs/decisions/NOTES.md": "x", "docs/decisions/template.md": "x" }), []);
});

test("a missing decisions README fails", () => {
  const problems = problemsFor({ "docs/decisions/README.md": null });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /README\.md/);
});

test("an agent without frontmatter or without a model fails", () => {
  const noFront = problemsFor({ ".claude/agents/bad.md": "just text\nmodel: sonnet" });
  assert.equal(noFront.length, 1);
  assert.match(noFront[0], /bad\.md/);
  const noModel = problemsFor({ ".claude/agents/bad.md": "---\nname: bad\n---\nbody" });
  assert.equal(noModel.length, 1);
  assert.match(noModel[0], /bad\.md/);
  assert.match(noModel[0], /model/);
});

test("PROCESS.md must exist", () => {
  const problems = problemsFor({ "docs/PROCESS.md": null });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /PROCESS\.md/);
});

test("PROCESS.md needs Where facts live before Rules", () => {
  const swapped = PROCESS_MD.replace("## Where facts live", "## Elsewhere");
  const problems = problemsFor({ "docs/PROCESS.md": swapped });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Where facts live/);
  const late = PROCESS_MD.replace("## Where facts live\nStatus in STATUS.md.\n\n", "") + "\n## Where facts live\nx\n";
  assert.equal(problemsFor({ "docs/PROCESS.md": late }).length, 1);
});

test("an empty Where facts live section fails", () => {
  const empty = PROCESS_MD.replace("Status in STATUS.md.\n", "  \n");
  const problems = problemsFor({ "docs/PROCESS.md": empty });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Where facts live/);
});

test("a rule with an empty Why fails and names the rule", () => {
  const problems = problemsFor({ "docs/PROCESS.md": PROCESS_MD.replace("**Why:** Easy to undo.", "**Why:**   ") });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /rule "Small commits" has no Why/);
});

test("each missing field is its own problem", () => {
  const text = PROCESS_MD.replace("**What:** Commit often.\n", "").replace("**Enforced by:** check:process\n", "");
  const problems = problemsFor({ "docs/PROCESS.md": text });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /no What/);
  assert.match(problems[1], /no Enforced by/);
});

test("PROCESS.md with no rules fails", () => {
  const problems = problemsFor({ "docs/PROCESS.md": "## Where facts live\nx\n\n## Rules\nnothing\n" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no rules/i);
});

test("runCli prints each problem and returns 1", () => {
  const out = [];
  const code = runCli({ ...run({ ".claude/hooks/precommit-check.mjs": "nope" }), log: (line) => out.push(line) });
  assert.equal(code, 1);
  assert.equal(out.length, 3);
  assert.match(out[0], /^check:process: The pre-commit hook/);
  assert.match(out[1], /^check:process: The hook must run the full check/);
  assert.equal(out[2], "check:process: 2 problem(s). See docs/PROCESS.md.");
});

test("runCli prints a summary and returns 0 on a pass", () => {
  const out = [];
  const code = runCli({ ...run(), log: (line) => out.push(line) });
  assert.equal(code, 0);
  assert.equal(out.length, 1);
  assert.match(out[0], /^check:process: process rules hold \(STATUS\.md \d+ lines, plan 20 lines, 2 decisions indexed, 1 agents\)\.$/);
});
