// `npm run check:process`: fails if the written working rules (docs/PROCESS.md) are not kept. It checks that
//   - the pre-commit hook runs check:fast, not the full suite,
//   - docs/STATUS.md stays short and "For the master" holds no PR numbers,
//   - the newest plan stays short, every decision is in the decisions index, every agent names a model,
//   - docs/PROCESS.md says where facts live and gives each rule its What, Why, Decided and Enforced by.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const HOOK = ".claude/hooks/precommit-check.mjs";
const HOOK_LINE = 'const COMMIT_SCRIPT = "check:fast";';
const STATUS = "docs/STATUS.md";
const PLANS = "docs/superpowers/plans";
const DECISIONS = "docs/decisions";
const AGENTS = ".claude/agents";
const PROCESS = "docs/PROCESS.md";
const MAX_STATUS_LINES = 150;
const MAX_PLAN_LINES = 150;
const MAX_MASTER_LINES = 12;
const RULE_FIELDS = ["What", "Why", "Decided", "Enforced by"];
const PR_REFERENCE = [/#\d+/, /\bPRs? ?#?\d+/i, /\/pull\/\d+/];

function lineCount(text) {
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

function checkHook(read) {
  const text = read(HOOK);
  if (text === null) return [`${HOOK} is missing. Restore it (owner-only file; see docs/PROCESS.md).`];
  if (text.split("\n").some((line) => line.replace(/\r$/, "") === HOOK_LINE)) return [];
  return [
    `The pre-commit hook would run the full suite on every commit: ${HOOK} must set COMMIT_SCRIPT to "check:fast" (owner-only file; see docs/PROCESS.md).`,
  ];
}

function masterSection(lines) {
  const start = lines.findIndex((line) => line === "## For the master");
  if (start === -1) return null;
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return { start: start + 1, lines: lines.slice(start + 1, end === -1 ? undefined : end) };
}

function checkMaster(lines) {
  const section = masterSection(lines);
  if (section === null) return [`${STATUS} has no "## For the master" section. Add it, for scope, product and business decisions.`];
  const problems = [];
  const filled = section.lines.filter((line) => line.trim() !== "");
  if (filled.length > MAX_MASTER_LINES) {
    problems.push(
      `"For the master" in ${STATUS} has ${filled.length} lines; keep it to ${MAX_MASTER_LINES}. Move the rest to the changelog.`,
    );
  }
  section.lines.forEach((line, i) => {
    if (PR_REFERENCE.some((pattern) => pattern.test(line))) {
      problems.push(
        `"For the master" is for scope, product and business decisions only, no PR numbers: ${STATUS} line ${section.start + i + 1} ("${line.trim()}"). Move it to the changelog.`,
      );
    }
  });
  return problems;
}

function checkStatus(read) {
  const text = read(STATUS);
  if (text === null) return [`${STATUS} is missing. Restore it.`];
  const problems = [];
  const count = lineCount(text);
  if (count > MAX_STATUS_LINES) {
    problems.push(
      `${STATUS} has ${count} lines; the limit is ${MAX_STATUS_LINES}. Move older runs to docs/history/STATUS-history.md.`,
    );
  }
  return [...problems, ...checkMaster(text.split("\n"))];
}

function newestPlan(list) {
  const names = list(PLANS).filter((name) => name.endsWith(".md")).sort();
  return names.length === 0 ? null : `${PLANS}/${names[names.length - 1]}`;
}

function checkPlan(read, list) {
  const path = newestPlan(list);
  if (path === null) return [];
  const count = lineCount(read(path) ?? "");
  if (count <= MAX_PLAN_LINES) return [];
  return [`${path} has ${count} lines; the limit is ${MAX_PLAN_LINES}. Split it into a shorter plan.`];
}

const decisionNames = (list) => list(DECISIONS).filter((name) => /^\d{4}-.+\.md$/.test(name));

function checkDecisions(read, list) {
  const readme = read(`${DECISIONS}/README.md`);
  if (readme === null) return [`${DECISIONS}/README.md is missing. Add the decisions index and link every decision.`];
  return decisionNames(list)
    .filter((name) => !readme.includes(`(${name})`))
    .map((name) => `Decision ${name} is not in ${DECISIONS}/README.md. Add a link "(${name})" to the index.`);
}

function agentProblem(name, text) {
  const lines = (text ?? "").split("\n").map((line) => line.replace(/\r$/, ""));
  const close = lines.indexOf("---", 1);
  if (lines[0] !== "---" || close === -1) {
    return `Agent ${AGENTS}/${name} has no YAML frontmatter. Start the file with "---", a "model:" line and a closing "---".`;
  }
  if (!lines.slice(1, close).some((line) => /^model:\s*\S+/.test(line))) {
    return `Agent ${AGENTS}/${name} has no model line. Add "model: <name>" to its frontmatter.`;
  }
  return null;
}

const agentNames = (list) => list(AGENTS).filter((name) => name.endsWith(".md"));

function checkAgents(read, list) {
  return agentNames(list)
    .map((name) => agentProblem(name, read(`${AGENTS}/${name}`)))
    .filter((problem) => problem !== null);
}

function rulesIn(lines) {
  const start = lines.indexOf("## Rules");
  if (start === -1) return [];
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  const rules = [];
  for (const line of lines.slice(start + 1, end === -1 ? undefined : end)) {
    if (line.startsWith("### ")) rules.push({ title: line.slice(4).trim(), lines: [] });
    else rules.at(-1)?.lines.push(line);
  }
  return rules;
}

function ruleProblems({ title, lines }) {
  return RULE_FIELDS.filter((field) => !lines.some((line) => new RegExp(`^\\*\\*${field}:\\*\\*\\s*\\S`).test(line))).map(
    (field) => `PROCESS.md rule "${title}" has no ${field}. Add a line starting "**${field}:**" with text after it.`,
  );
}

function checkProcessDoc(read) {
  const text = read(PROCESS);
  if (text === null) return [`${PROCESS} is missing. Add it (where facts live, then the rules).`];
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  const problems = [];
  const facts = lines.indexOf("## Where facts live");
  const rulesAt = lines.indexOf("## Rules");
  if (facts === -1 || (rulesAt !== -1 && facts > rulesAt)) {
    problems.push(`${PROCESS} needs a "## Where facts live" heading before the "## Rules" heading.`);
  }
  const rules = rulesIn(lines);
  if (rules.length === 0) problems.push(`${PROCESS} has no rules. Add a "### <name>" subsection under "## Rules" for each rule.`);
  return [...problems, ...rules.flatMap(ruleProblems)];
}

export function checkProcess({ read, list }) {
  return [
    ...checkHook(read),
    ...checkStatus(read),
    ...checkPlan(read, list),
    ...checkDecisions(read, list),
    ...checkAgents(read, list),
    ...checkProcessDoc(read),
  ];
}

function summary({ read, list }) {
  const plan = newestPlan(list);
  const statusLines = lineCount(read(STATUS) ?? "");
  const planLines = plan === null ? 0 : lineCount(read(plan) ?? "");
  return `process rules hold (STATUS.md ${statusLines} lines, plan ${planLines} lines, ${decisionNames(list).length} decisions indexed, ${agentNames(list).length} agents).`;
}

export function runCli({ read, list, log }) {
  const problems = checkProcess({ read, list });
  if (problems.length === 0) {
    log(`check:process: ${summary({ read, list })}`);
    return 0;
  }
  for (const problem of problems) log(`check:process: ${problem}`);
  log(`check:process: ${problems.length} problem(s). See docs/PROCESS.md.`);
  return 1;
}

function realFiles() {
  const read = (path) => {
    try {
      return readFileSync(join(ROOT, path), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
  const list = (dir) => {
    try {
      return readdirSync(join(ROOT, dir), { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  };
  return { read, list };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(runCli({ ...realFiles(), log: (line) => console.log(line) }));
}
