// `npm run check:config`: fails if client data could be tracked in git (decision 0002). It checks that
//   - no tracked file holds an email address outside the example domains (fake people only),
//   - wrangler.jsonc has no real database_id, account_id or KV namespace id (real ids live in /.copies/<name>/,
//     git-ignored),
//   - .gitignore keeps /.copies/ and /exports/ out of git, and nothing under them is tracked.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const EXAMPLE_DOMAINS = ["example.com", "example.test", "example.org", "example.net"];
// The commit trailer and GitHub's private commit addresses.
const ALLOWED_ADDRESSES = ["noreply@anthropic.com"];
const ALLOWED_DOMAINS = ["users.noreply.github.com"];
const PRIVATE_FOLDERS = [".copies", "exports"];
// Written by npm from registry metadata (for example a package's deprecation notice), never from client data.
const EMAIL_SCAN_SKIP = ["package-lock.json"];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// "id" and "preview_id" are KV namespace ids; "namespace_id" (rate limits) is a small per-account number, not checked.
const WRANGLER_ID = /"((?:preview_)?database_id|account_id|id|preview_id)"\s*:\s*"([^"]*)"/g;

export function findEmails(text) {
  return text.match(EMAIL) ?? [];
}

const inDomain = (domain, allowed) => domain === allowed || domain.endsWith(`.${allowed}`);

export function isAllowedEmail(email) {
  const address = email.toLowerCase();
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return (
    ALLOWED_ADDRESSES.includes(address) ||
    [...EXAMPLE_DOMAINS, ...ALLOWED_DOMAINS].some((allowed) => inDomain(domain, allowed))
  );
}

/** files: [{ path, text }] */
export function checkTrackedFiles(files) {
  const problems = [];
  for (const { path, text } of files) {
    if (PRIVATE_FOLDERS.some((folder) => path.startsWith(`${folder}/`))) {
      problems.push(`${path} is tracked, but ${path.split("/")[0]}/ is per-copy data. Remove it with "git rm --cached".`);
      continue;
    }
    if (EMAIL_SCAN_SKIP.includes(path)) continue;
    const found = [...new Set(findEmails(text).filter((email) => !isAllowedEmail(email)))];
    if (found.length > 0) {
      problems.push(
        `${path} holds ${found.join(", ")}. Use a fake address at ${EXAMPLE_DOMAINS.join(", ")} instead.`,
      );
    }
  }
  return problems;
}

export function isPlaceholderId(value) {
  return (
    /^\[\[[^\]]+\]\]$/.test(value) ||
    /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value) ||
    /^0{32}$/.test(value) ||
    value === "local"
  );
}

export function checkWranglerConfig(text) {
  const problems = [];
  for (const [, key, value] of text.matchAll(WRANGLER_ID)) {
    if (!isPlaceholderId(value)) {
      problems.push(
        `wrangler.jsonc has a real ${key} ("${value}"). Use a placeholder such as "[[...]]" or ` +
          `"00000000-0000-0000-0000-000000000000"; real ids belong in the git-ignored /.copies/<name>/ config.`,
      );
    }
  }
  return problems;
}

export function checkGitignore(text) {
  const lines = new Set(text.split(/\r?\n/).map((line) => line.trim()));
  return PRIVATE_FOLDERS.filter((folder) =>
    [`/${folder}/`, `/${folder}`, `${folder}/`, folder].every((form) => !lines.has(form)),
  ).map((folder) => `.gitignore must ignore /${folder}/ (per-copy data). Add the line "/${folder}/".`);
}

function trackedFiles() {
  const paths = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  const files = [];
  for (const path of paths) {
    let buffer;
    try {
      buffer = readFileSync(join(ROOT, path));
    } catch (error) {
      if (error.code === "ENOENT") continue; // deleted in the working tree, not yet staged
      throw error;
    }
    if (buffer.includes(0)) continue; // binary
    files.push({ path, text: buffer.toString("utf8") });
  }
  return files;
}

function main() {
  const files = trackedFiles();
  const problems = [
    ...checkTrackedFiles(files),
    ...checkWranglerConfig(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8")),
    ...checkGitignore(readFileSync(join(ROOT, ".gitignore"), "utf8")),
  ];
  if (problems.length > 0) {
    console.error(`check:config found ${problems.length} problem(s):\n${problems.map((p) => `- ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`check:config: no client data found (${files.length} tracked files checked).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
