// Tells CI whether a pull request touches anything the board's a11y and Lighthouse checks can see. Prints
// `board=true|false` on stdout (appended to $GITHUB_OUTPUT) and the reason on stderr. Plain Node, no install needed.
// Whenever it is unsure (not a pull request, no base commit, git failing) it says true: never skip by mistake.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BOARD_FILES = new Set([
  "scripts/build.mjs",
  "scripts/dev.mjs",
  "scripts/seed-dev.ts",
  "scripts/lighthouse.mjs",
  "scripts/lighthouse-summary.mjs",
  "lighthouserc.cjs",
  "playwright.config.ts",
  "playwright.screenshots.config.ts",
  "wrangler.jsonc",
  "package.json",
  "package-lock.json",
  ".github/workflows/ci.yml",
]);
const BOARD_FOLDERS = ["public/", "tests/a11y/", "migrations/", "seed/"];

function isBoardFile(path) {
  if (BOARD_FILES.has(path) || BOARD_FOLDERS.some((d) => path.startsWith(d))) return true;
  return path.startsWith("src/") && !path.startsWith("src/mcp/") && !path.endsWith(".test.ts");
}

export function boardChanged({ event, labels, files }) {
  if (event !== "pull_request") return { board: true, reason: `${event || "unknown"} event: always run` };
  if (labels.includes("full-audit")) return { board: true, reason: "full-audit label: run" };
  if (files === null) return { board: true, reason: "changed files unknown: run" };
  const hit = files.find(isBoardFile);
  if (hit) return { board: true, reason: `board file changed: ${hit}` };
  return { board: false, reason: `no board file changed (${files.length} files)` };
}

function changedFiles(base) {
  if (!base) return null;
  const r = spawnSync("git", ["diff", "--name-only", "--no-renames", `${base}...HEAD`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const event = process.env.EVENT_NAME ?? "";
  const labels = (process.env.LABELS ?? "").split(",").map((l) => l.trim()).filter(Boolean);
  const files = event === "pull_request" ? changedFiles(process.env.BASE_SHA ?? "") : null;
  const { board, reason } = boardChanged({ event, labels, files });
  console.error(reason);
  console.log(`board=${board}`);
}
