// Client copies: `npm run copies:provision`, `npm run copies:update` and `npm run copies:export` (docs/INSTALL.md,
// docs/UPDATING.md, decision 0007). Each copy's config and state live only in the git-ignored /.copies/<name>/;
// exports go to the git-ignored /exports/. Every outside command goes through `run` (scripts/wrangler-run.mjs), which
// the tests replace with a recorder; `--dry-run` only prints what would run.
//   node scripts/copies.mjs provision --copy <name> [--resume] [--dry-run] [answers as flags, see parseArgs]
//   node scripts/copies.mjs update [--copy <name>] [--dry-run]
//   node scripts/copies.mjs export (--copy <name> | --local [--persist-to <dir>])
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { toCsv } from "../src/http/csv.ts";
import { EXPORT_TABLES, safeFileName } from "../src/http/export.ts";
import { sqlLiteral } from "../src/import/sql.ts";
import { parseFlags, UsageError } from "./cli-args.mjs";
import { DEFAULT_TZ, localDate } from "../src/time.ts";
import { formatCommand, parseJsonOutput, ROOT, run as defaultRun } from "./wrangler-run.mjs";

export const TEMPLATE = join(ROOT, "config", "wrangler.copy.template.jsonc");
export const SEED_FILE = "seed/defaults.sql";
export const LOCAL_STATE = ".wrangler/state";

const COPY_NAME = /^[a-z][a-z0-9-]{0,28}[a-z0-9]$/;

/** A copy name is also a folder name under /.copies/, so nothing like "../x" gets through. */
export const isCopyName = (name) => typeof name === "string" && COPY_NAME.test(name);
export const copyNameProblem = (name) =>
  `"${name}" can't be a copy name. Use 2 to 30 lowercase letters, digits and dashes, starting with a letter.`;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
// An apostrophe is fine before the @ (o'brien@example.com); the owners' SQL is escaped (ownerEmailsSql).
const EMAIL = /^[^\s@,;"]+@[^\s@,;"']+\.[^\s@,;"']+$/;
const TEAM_DOMAIN = /^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/;
const AUD = /^[A-Za-z0-9]{16,128}$/;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The steps of a provision, in order. copy.json records each one when it is done, so --resume skips it. */
export const PROVISION_STEPS = [
  "d1:prod",
  "d1:preview",
  "kv:prod",
  "kv:preview",
  "config",
  "migrate:prod",
  "migrate:preview",
  "seed:prod",
  "seed:preview",
  "owners",
  "owners:preview",
  "secrets",
];

/** What `copies:update` needs done before it will touch a copy: everything but the (skippable) secrets. */
const REQUIRED_FOR_UPDATE = PROVISION_STEPS.filter((step) => step !== "secrets");

// ---------------------------------------------------------------------------------------------------------- arguments

const FLAGS = {
  values: {
    "--copy": { key: "copy", example: "acme" },
    "--account-id": { key: "accountId", example: "<the 32-character account id>" },
    "--access-team-domain": { key: "accessTeamDomain", example: "example-team.cloudflareaccess.com" },
    "--access-aud": { key: "accessAud", example: "<the AUD tag>" },
    "--host": { key: "host", example: "pipeline.example.com" },
    // An empty --brief-from "" means "no brief address", so it is allowed.
    "--brief-from": { key: "briefFrom", example: "brief@example.com", allowEmpty: true },
    "--persist-to": { key: "persistTo", example: ".wrangler/state" },
  },
  switches: { "--resume": "resume", "--dry-run": "dryRun", "--local": "local", "--skip-secrets": "skipSecrets" },
  lists: { "--owner-email": { key: "ownerEmails", example: "owner@example.com" } },
};

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!["provision", "update", "export"].includes(command ?? "")) {
    throw new UsageError("Say what to do: provision, update or export (for example: npm run copies:update -- --dry-run).");
  }
  const flags = parseFlags(rest, FLAGS, "See the top of scripts/copies.mjs for the options.");
  const options = { command, ...flags, ownerEmails: (flags.ownerEmails ?? []).flatMap(splitList) };
  if (options.copy !== undefined && !isCopyName(options.copy)) throw new UsageError(copyNameProblem(options.copy));
  if (command === "provision" && options.copy === undefined) throw new UsageError("Name the copy: --copy <name>.");
  if (command === "export" && (options.copy === undefined) === !options.local) {
    throw new UsageError("Export one copy with --copy <name>, or the local dev database with --local.");
  }
  return options;
}

const splitList = (value) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

// -------------------------------------------------------------------------------------------------------- the config

/** JSON with // and /* comments and trailing commas, as wrangler reads it. */
export function parseJsonc(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i === -1) throw new Error("A /* comment is never closed.");
      i += 1;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const PLACEHOLDER = /^\[\[([A-Z_]+)\]\]$/;

/** The template with each "[[NAME]]" string replaced by values[NAME]; a null value removes its key. */
export function fillTemplate(template, values) {
  const fill = (node, path) => {
    if (typeof node === "string") {
      const match = PLACEHOLDER.exec(node);
      if (!match) return node;
      if (!Object.hasOwn(values, match[1])) throw new Error(`The template's ${path} needs a value for [[${match[1]}]].`);
      return values[match[1]];
    }
    if (Array.isArray(node)) return node.map((item, i) => fill(item, `${path}[${i}]`)).filter((item) => item !== null);
    if (node && typeof node === "object") {
      const out = {};
      for (const [key, value] of Object.entries(node)) {
        const filled = fill(value, `${path}.${key}`);
        if (filled !== null) out[key] = filled;
      }
      return out;
    }
    return node;
  };
  return fill(template, "config");
}

/** Paths in a copy's config are relative to its folder, so wrangler finds the repo's code from there. */
const fromCopy = (copyDir, root, path) => relative(copyDir, join(root, path)).split("\\").join("/");

export function configValues(state, { copyDir, root = ROOT }) {
  const custom = state.host.kind === "custom" ? state.host.hostname : null;
  const { resources: r } = state;
  return {
    SCHEMA: fromCopy(copyDir, root, "node_modules/wrangler/config-schema.json"),
    WORKER_NAME: r.workerName,
    ACCOUNT_ID: state.accountId,
    MAIN: fromCopy(copyDir, root, "src/index.ts"),
    ASSETS_DIR: fromCopy(copyDir, root, "out"),
    ROUTES: custom ? [{ pattern: custom, custom_domain: true }] : null,
    ACCESS_TEAM_DOMAIN: state.accessTeamDomain,
    ACCESS_AUD: state.accessAud,
    MCP_ALLOWED_HOSTNAMES: custom,
    BRIEF_FROM: state.briefFrom,
    DB_NAME: r.db.name,
    DB_ID: r.db.id,
    PREVIEW_DB_NAME: r.previewDb.name,
    PREVIEW_DB_ID: r.previewDb.id,
    MIGRATIONS_DIR: fromCopy(copyDir, root, "migrations"),
    KV_ID: r.kv.id,
    PREVIEW_KV_ID: r.previewKv.id,
    INTAKE_RATE_LIMIT_ID: r.rateLimits.intake,
    OAUTH_RATE_LIMIT_ID: r.rateLimits.oauth,
    PREVIEW_INTAKE_RATE_LIMIT_ID: r.rateLimits.previewIntake,
    PREVIEW_OAUTH_RATE_LIMIT_ID: r.rateLimits.previewOauth,
  };
}

export function renderCopyConfig(templateText, state, paths) {
  const config = fillTemplate(parseJsonc(templateText), configValues(state, paths));
  const leftover = JSON.stringify(config).match(/\[\[[A-Z_]+\]\]/);
  if (leftover) throw new Error(`The generated config still holds ${leftover[0]}.`);
  return (
    `// Generated by \`npm run copies:provision\` for the copy "${state.name}" from config/wrangler.copy.template.jsonc.\n` +
    "// Git-ignored: it holds this copy's account and resource ids. Never commit it.\n" +
    `${JSON.stringify(config, null, 2)}\n`
  );
}

/**
 * Rate Limiting namespace ids must be unique within a Cloudflare account. Copies in the same account get the next
 * free block of four: 1001-1004, 1011-1014, ...
 */
export function pickRateLimitIds(otherStates, accountId) {
  const used = new Set(
    otherStates
      .filter((other) => other.accountId === accountId && other.resources?.rateLimits)
      .map((other) => Number(other.resources.rateLimits.intake)),
  );
  let base = 1001;
  while (used.has(base)) base += 10;
  return {
    intake: String(base),
    previewIntake: String(base + 1),
    oauth: String(base + 2),
    previewOauth: String(base + 3),
  };
}

/** Writes the owner emails into the settings row (decision 0005). The version bump makes a stale undo refuse. */
export function ownerEmailsSql(emails, now) {
  return (
    `UPDATE settings SET owner_emails = ${sqlLiteral(JSON.stringify(emails))}, version = version + 1, ` +
    `updated_at = ${sqlLiteral(now.toISOString())} WHERE id = 1`
  );
}

/** The secrets in docs/SECRETS.md this copy needs. RESEND_API_KEY only matters once the brief can be emailed. */
export function secretNames(state) {
  return [
    "ACCESS_CLIENT_ID",
    "ACCESS_CLIENT_SECRET",
    "ACCESS_TOKEN_URL",
    "ACCESS_AUTHORIZATION_URL",
    "ACCESS_JWKS_URL",
    "INTAKE_SECRET",
    ...(state.briefFrom ? ["RESEND_API_KEY"] : []),
  ];
}

// ------------------------------------------------------------------------------------------------------- copy folders

export function copyPaths(copiesDir, name) {
  const dir = join(copiesDir, name);
  return { dir, config: join(dir, "wrangler.jsonc"), state: join(dir, "copy.json") };
}

export function readCopyState(copiesDir, name) {
  const { state } = copyPaths(copiesDir, name);
  if (!existsSync(state)) return null;
  return JSON.parse(readFileSync(state, "utf8"));
}

/** Every copy with a copy.json, by name. */
export function listCopies(copiesDir) {
  if (!existsSync(copiesDir)) return [];
  return readdirSync(copiesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(copyPaths(copiesDir, entry.name).state))
    .map((entry) => entry.name)
    .sort();
}

function saveState(copiesDir, state) {
  const { dir, state: path } = copyPaths(copiesDir, state.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

// ------------------------------------------------------------------------------------------------------ wrangler calls

export function makeRunner(deps, accountId) {
  const env = accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {};
  return {
    show(cmd) {
      deps.log(`  $ ${formatCommand(cmd)}`);
    },
    /**
     * Runs a command, throwing a plain error when it fails.
     * @param {string[]} cmd
     * @param {{ capture?: boolean, what?: string }} [options]
     */
    must(cmd, { capture = false, what } = {}) {
      const result = deps.run(cmd, { env, capture });
      if (result.status !== 0) {
        const detail = capture ? `\n${(result.stderr || result.stdout).trim()}` : "";
        throw new Error(`${what ?? formatCommand(cmd)} failed (exit ${result.status}).${detail}`);
      }
      return result;
    },
    json(cmd, what) {
      return parseJsonOutput(this.must(cmd, { capture: true, what }).stdout, what);
    },
  };
}

/** The account ids this wrangler login can act in (`wrangler whoami --json`). */
export function loginAccounts(deps) {
  const result = deps.run(["wrangler", "whoami", "--json"], { capture: true });
  if (result.status !== 0) {
    throw new Error(
      "wrangler isn't logged in, or can't reach Cloudflare. Log in with `npx wrangler login` in your own terminal, then try again.",
    );
  }
  const info = parseJsonOutput(result.stdout, "wrangler whoami --json");
  return Array.isArray(info?.accounts)
    ? info.accounts.filter((a) => typeof a?.id === "string").map((a) => ({ id: a.id, name: String(a.name ?? "") }))
    : [];
}

const notMember = (accountId) =>
  `This wrangler login isn't a member of account ${accountId}. Ask the client to invite your Cloudflare user to their ` +
  "account (docs/INSTALL.md, step 2), accept the invitation, then try again.";

function remote(cfg, { preview = false } = {}) {
  return ["--remote", "-c", cfg, ...(preview ? ["--preview"] : [])];
}

const applyMigrations = (cfg, preview = false) => ["wrangler", "d1", "migrations", "apply", "DB", ...remote(cfg, { preview })];
const listMigrations = (cfg, preview = false) => ["wrangler", "d1", "migrations", "list", "DB", ...remote(cfg, { preview })];

/**
 * Whether `wrangler d1 migrations list` says every migration is applied. The apply asks the owner to confirm, and a
 * "no" still exits 0, so the apply's exit code alone can't tell; anything but wrangler's "No migrations to apply" counts
 * as pending.
 */
export const migrationsAllApplied = (output) => /No migrations to apply/.test(output);

const NOT_APPLIED = "migrations not applied; not deployed";

// ---------------------------------------------------------------------------------------------------------- provision

async function askUntil(deps, question, check) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const answer = (await deps.ask(question)).trim();
    const problem = check(answer);
    if (problem === null) return answer;
    deps.log(problem);
  }
  throw new UsageError("Too many answers that didn't fit. Start again when you have the value to hand.");
}

async function chooseAccount(options, deps) {
  if (options.accountId !== undefined) {
    if (!ACCOUNT_ID.test(options.accountId)) throw new UsageError("--account-id must be the 32-character account id.");
    return options.accountId;
  }
  const accounts = options.dryRun ? [] : loginAccounts(deps);
  if (accounts.length > 0) {
    deps.log("Accounts this wrangler login can use:");
    accounts.forEach((account, i) => deps.log(`  ${i + 1}. ${account.name || "(no name)"}  ${account.id}`));
  }
  const answer = await askUntil(deps, "Which account is the client's? Type its number, or paste its account id: ", (text) => {
    const n = Number(text);
    if (Number.isInteger(n) && n >= 1 && n <= accounts.length) return null;
    return ACCOUNT_ID.test(text) ? null : "That isn't one of the numbers above or a 32-character account id.";
  });
  const n = Number(answer);
  return Number.isInteger(n) && n >= 1 && n <= accounts.length ? accounts[n - 1].id : answer;
}

const emailProblem = (list) =>
  list.length > 0 && list.every((email) => EMAIL.test(email)) ? null : "Give one or more email addresses, comma-separated.";

async function gatherAnswers(options, deps) {
  const accountId = await chooseAccount(options, deps);
  let ownerEmails = options.ownerEmails;
  if (ownerEmails.length === 0) {
    ownerEmails = splitList(
      await askUntil(deps, "Owner email(s) who may sign in, comma-separated: ", (text) => emailProblem(splitList(text))),
    );
  } else if (emailProblem(ownerEmails)) throw new UsageError(`--owner-email: ${emailProblem(ownerEmails)}`);

  const valueOf = async (given, flag, question, pattern, hint) => {
    if (given !== undefined) {
      if (!pattern.test(given)) throw new UsageError(`${flag}: ${hint}`);
      return given;
    }
    return askUntil(deps, question, (text) => (pattern.test(text) ? null : hint));
  };
  const accessTeamDomain = (
    await valueOf(
      options.accessTeamDomain?.toLowerCase(),
      "--access-team-domain",
      "Access team domain (<team>.cloudflareaccess.com, docs/ACCESS-SETUP.md step 4): ",
      TEAM_DOMAIN,
      "give the team domain, like example-team.cloudflareaccess.com.",
    )
  ).toLowerCase();
  const accessAud = await valueOf(
    options.accessAud,
    "--access-aud",
    "The board application's AUD tag (docs/ACCESS-SETUP.md step 4): ",
    AUD,
    "give the Application Audience (AUD) tag: letters and digits only.",
  );
  const hostAnswer = (
    await valueOf(
      options.host?.toLowerCase(),
      "--host",
      'Where will the copy answer? Type "workers.dev", or the custom hostname (like pipeline.example.com): ',
      /^(workers\.dev|.+)$/,
      "type workers.dev or a hostname.",
    )
  ).toLowerCase();
  if (hostAnswer !== "workers.dev" && !HOSTNAME.test(hostAnswer)) {
    throw new UsageError(`"${hostAnswer}" isn't a hostname. Use something like pipeline.example.com, or workers.dev.`);
  }
  let briefFrom = options.briefFrom;
  if (briefFrom === undefined) {
    briefFrom = await askUntil(deps, "Daily brief \"from\" address (optional; press Enter to leave the brief unsent): ", (text) =>
      text === "" || EMAIL.test(text) ? null : "Give an email address, or press Enter to skip.",
    );
  } else if (briefFrom !== "" && !EMAIL.test(briefFrom)) throw new UsageError("--brief-from must be an email address.");
  return {
    accountId,
    ownerEmails,
    accessTeamDomain,
    accessAud,
    host: hostAnswer === "workers.dev" ? { kind: "workers.dev" } : { kind: "custom", hostname: hostAnswer },
    briefFrom: briefFrom === "" ? null : briefFrom,
  };
}

/** Finds a D1 database by name, creating it first when it isn't there (so a resumed run never makes two). */
function ensureDatabase(runner, name, dryRun) {
  const list = ["wrangler", "d1", "list", "--json"];
  const create = ["wrangler", "d1", "create", name, "--update-config=false"];
  if (dryRun) {
    runner.show(list);
    runner.show(create);
    return { name, id: `<id of ${name}>` };
  }
  const find = () => {
    const dbs = runner.json(list, "wrangler d1 list --json");
    return Array.isArray(dbs) ? dbs.find((db) => db?.name === name && typeof db.uuid === "string") : undefined;
  };
  let db = find();
  if (!db) {
    runner.must(create);
    db = find();
  }
  if (!db) throw new Error(`The database ${name} was created but isn't listed yet. Run the same command with --resume.`);
  return { name, id: db.uuid };
}

function ensureKv(runner, title, dryRun) {
  const list = ["wrangler", "kv", "namespace", "list"];
  const create = ["wrangler", "kv", "namespace", "create", title, "--update-config=false"];
  if (dryRun) {
    runner.show(list);
    runner.show(create);
    return { title, id: `<id of ${title}>` };
  }
  const find = () => {
    const namespaces = runner.json(list, "wrangler kv namespace list");
    return Array.isArray(namespaces) ? namespaces.find((ns) => ns?.title === title && typeof ns.id === "string") : undefined;
  };
  let ns = find();
  if (!ns) {
    runner.must(create);
    ns = find();
  }
  if (!ns) throw new Error(`The KV namespace ${title} was created but isn't listed yet. Run again with --resume.`);
  return { title, id: ns.id };
}

export async function provision(options, deps) {
  const { copiesDir, root = ROOT, now = () => new Date() } = deps;
  const name = options.copy;
  const paths = copyPaths(copiesDir, name);
  const existing = readCopyState(copiesDir, name);
  if (existing && !options.resume) {
    throw new UsageError(
      `The copy "${name}" already exists (${relative(root, paths.state)}). To finish an interrupted provision, run it ` +
        "again with --resume. To change an existing copy, edit its config or use copies:update.",
    );
  }
  if (!existing && options.resume) throw new UsageError(`There's no copy "${name}" to resume. Run it without --resume.`);

  let state = existing;
  if (!state) {
    const answers = await gatherAnswers(options, deps);
    const others = listCopies(copiesDir).map((other) => readCopyState(copiesDir, other));
    state = {
      name,
      ...answers,
      resources: { workerName: `pipeline-${name}`, rateLimits: pickRateLimitIds(others, answers.accountId) },
      done: [],
      secrets: { set: [], skipped: [] },
      createdAt: now().toISOString(),
    };
  }
  const dryRun = Boolean(options.dryRun);
  deps.log(
    `${dryRun ? "Dry run: nothing is created or written. These commands would run" : existing ? "Resuming" : "Provisioning"}` +
      ` for the copy "${name}" in account ${state.accountId}:`,
  );
  if (!dryRun) {
    const accounts = loginAccounts(deps);
    if (!accounts.some((account) => account.id === state.accountId)) throw new Error(notMember(state.accountId));
  } else {
    deps.log("  $ wrangler whoami --json   (checks the login can use the account)");
  }

  const runner = makeRunner(deps, state.accountId);
  const cfg = relative(root, paths.config);
  const seed = SEED_FILE;
  const step = async (key, action) => {
    if (state.done.includes(key)) {
      deps.log(`- ${key}: already done`);
      return;
    }
    deps.log(`- ${key}`);
    await action();
    if (!dryRun) {
      state.done.push(key);
      state.updatedAt = now().toISOString();
      saveState(copiesDir, state);
    }
  };
  const exec = (cmd) => (dryRun ? runner.show(cmd) : runner.must(cmd));

  if (!dryRun && !existing) saveState(copiesDir, state);
  const r = state.resources;
  await step("d1:prod", () => {
    r.db = ensureDatabase(runner, `pipeline-${name}`, dryRun);
  });
  await step("d1:preview", () => {
    r.previewDb = ensureDatabase(runner, `pipeline-${name}-preview`, dryRun);
  });
  await step("kv:prod", () => {
    r.kv = ensureKv(runner, `pipeline-${name}-oauth`, dryRun);
  });
  await step("kv:preview", () => {
    r.previewKv = ensureKv(runner, `pipeline-${name}-oauth-preview`, dryRun);
  });
  await step("config", () => {
    const text = renderCopyConfig(deps.template ?? readFileSync(TEMPLATE, "utf8"), state, { copyDir: paths.dir, root });
    if (dryRun) deps.log(`  would write ${cfg} and ${relative(root, paths.state)}`);
    else {
      mkdirSync(dirname(paths.config), { recursive: true });
      writeFileSync(paths.config, text);
    }
  });
  const migrate = (preview) => {
    exec(applyMigrations(cfg, preview));
    if (dryRun) return runner.show(listMigrations(cfg, preview));
    const listed = runner.must(listMigrations(cfg, preview), { capture: true });
    if (!migrationsAllApplied(`${listed.stdout}\n${listed.stderr}`)) {
      throw new Error(
        `The ${preview ? "preview" : "production"} database still has migrations to apply (the apply was declined or ` +
          "stopped). Run the same command with --resume and confirm them.",
      );
    }
  };
  await step("migrate:prod", () => migrate(false));
  await step("migrate:preview", () => migrate(true));
  await step("seed:prod", () => exec(["wrangler", "d1", "execute", "DB", ...remote(cfg), "--file", seed, "--yes"]));
  await step("seed:preview", () =>
    exec(["wrangler", "d1", "execute", "DB", ...remote(cfg, { preview: true }), "--file", seed, "--yes"]),
  );
  // The preview database gets the same owners, so a preview deployment can be signed in to.
  for (const preview of [false, true]) {
    await step(preview ? "owners:preview" : "owners", () =>
      exec([
        "wrangler",
        "d1",
        "execute",
        "DB",
        ...remote(cfg, { preview }),
        "--command",
        ownerEmailsSql(state.ownerEmails, now()),
        "--yes",
      ]),
    );
  }
  await step("secrets", async () => {
    for (const secret of secretNames(state)) {
      if (state.secrets.set.includes(secret)) continue;
      const cmd = ["wrangler", "secret", "put", secret, "-c", cfg];
      if (dryRun) {
        runner.show(cmd);
        continue;
      }
      const answer = options.skipSecrets
        ? "s"
        : (await deps.ask(`Set ${secret} now? wrangler will ask for the value, which nobody else sees. [Y/s(kip)] `)).trim();
      if (/^s/i.test(answer)) {
        if (!state.secrets.skipped.includes(secret)) state.secrets.skipped.push(secret);
        continue;
      }
      runner.must(cmd);
      state.secrets.set.push(secret);
      state.secrets.skipped = state.secrets.skipped.filter((other) => other !== secret);
      saveState(copiesDir, state);
    }
  });

  if (dryRun) return 0;
  deps.log(`\nThe copy "${name}" is provisioned. Its config: ${cfg}`);
  if (state.secrets.skipped.length > 0) {
    deps.log("Secrets still to set (run each in your own terminal):");
    for (const secret of state.secrets.skipped) deps.log(`  npx wrangler secret put ${secret} -c ${cfg}`);
  }
  deps.log(`Next: npm run copies:update -- --copy ${name}   (the first deploy; docs/INSTALL.md)`);
  return 0;
}

// ------------------------------------------------------------------------------------------------------------- update

export async function update(options, deps) {
  const { copiesDir, root = ROOT } = deps;
  const names = options.copy ? [options.copy] : listCopies(copiesDir);
  if (names.length === 0) throw new UsageError("There are no copies yet. Create one with npm run copies:provision -- --copy <name>.");
  const copies = names.map((name) => {
    const state = readCopyState(copiesDir, name);
    if (!state) throw new UsageError(`There's no copy "${name}". The copies are: ${listCopies(copiesDir).join(", ") || "none"}.`);
    const config = copyPaths(copiesDir, name).config;
    // wrangler deploys to the config's account_id, so that is the account the membership check must use.
    const configAccount = existsSync(config) ? parseJsonc(readFileSync(config, "utf8")).account_id : undefined;
    return { name, state, cfg: relative(root, config), accountId: configAccount ?? state.accountId, configAccount };
  });
  const dryRun = Boolean(options.dryRun);
  const show = (cmd) => deps.log(`  $ ${formatCommand(cmd)}`);
  const build = ["npm", "run", "build"];
  const deploy = (copy) => ["wrangler", "deploy", "-c", copy.cfg];

  if (dryRun) {
    deps.log("Dry run: nothing runs. An update would run:");
    show(["wrangler", "whoami", "--json"]);
    show(build);
    for (const copy of copies) {
      deps.log(`- ${copy.name} (account ${copy.accountId}; stops here if the login isn't a member)`);
      show(applyMigrations(copy.cfg));
      deps.log("  $ " + formatCommand(listMigrations(copy.cfg)) + "   (stops here if any migration is still pending)");
      show(deploy(copy));
    }
    return 0;
  }

  const accounts = new Set(loginAccounts(deps).map((account) => account.id));
  const built = deps.run(build, {});
  if (built.status !== 0) throw new Error("npm run build failed, so no copy was updated. Fix the build and try again.");

  const results = [];
  for (const copy of copies) {
    const env = { CLOUDFLARE_ACCOUNT_ID: copy.accountId };
    let failure = null;
    if (!REQUIRED_FOR_UPDATE.every((step) => copy.state.done?.includes(step)) || copy.configAccount === undefined) {
      failure = `not fully provisioned; run npm run copies:provision -- --copy ${copy.name} --resume`;
    } else if (copy.configAccount !== copy.state.accountId) {
      failure =
        `its wrangler.jsonc names account ${copy.configAccount} but copy.json names ${copy.state.accountId}; ` +
        "make them match, then update again";
    } else if (!accounts.has(copy.accountId)) {
      failure = notMember(copy.accountId);
    } else {
      const applied = deps.run(applyMigrations(copy.cfg), { env, capture: false });
      const listed = applied.status === 0 ? deps.run(listMigrations(copy.cfg), { env, capture: true }) : null;
      if (applied.status !== 0) failure = `migrations failed (exit ${applied.status}); not deployed`;
      else if (listed?.status !== 0) failure = `checking the migrations failed (exit ${listed?.status}); not deployed`;
      else if (!migrationsAllApplied(`${listed.stdout}\n${listed.stderr}`)) failure = NOT_APPLIED;
      else {
        const deployed = deps.run(deploy(copy), { env, capture: false });
        if (deployed.status !== 0) failure = `deploy failed (exit ${deployed.status})`;
      }
    }
    results.push({ name: copy.name, failure });
    deps.log(failure ? `${copy.name}: FAILED: ${failure}` : `${copy.name}: updated`);
  }
  const failed = results.filter((result) => result.failure);
  deps.log(`${results.length - failed.length} of ${results.length} ${results.length === 1 ? "copy" : "copies"} updated.`);
  return failed.length > 0 ? 1 : 0;
}

// ------------------------------------------------------------------------------------------------------------- export

/** Where `wrangler d1 execute` should read: one copy's remote database, or the local dev database. */
export function databaseTarget(options, deps) {
  const { copiesDir, root = ROOT } = deps;
  if (options.local) {
    return { label: "local", accountId: null, flags: ["--local", "--persist-to", options.persistTo ?? LOCAL_STATE] };
  }
  const state = readCopyState(copiesDir, options.copy);
  if (!state) throw new UsageError(`There's no copy "${options.copy}". The copies are: ${listCopies(copiesDir).join(", ") || "none"}.`);
  return { label: options.copy, accountId: state.accountId, flags: remote(relative(root, copyPaths(copiesDir, options.copy).config)) };
}

/** Rows from one statement, through `wrangler d1 execute --json`. */
export function query(runner, target, sql) {
  const cmd = ["wrangler", "d1", "execute", "DB", ...target.flags, "--json", "--yes", "--command", sql];
  const output = runner.json(cmd, "wrangler d1 execute --json");
  const first = Array.isArray(output) ? output[0] : undefined;
  if (!first || !Array.isArray(first.results)) throw new Error("wrangler d1 execute didn't return rows. Run it yourself to see why.");
  return first.results;
}

/**
 * Makes and returns exports/<base>, or <base>-2, <base>-3, ... when an earlier export took the name (a second export
 * on the same day), so an export never overwrites another. mkdir without `recursive` fails on an existing folder, so
 * the check and the claim are one step.
 */
function newExportFolder(exportsDir, base) {
  mkdirSync(exportsDir, { recursive: true });
  for (let n = 1; n <= 999; n++) {
    const dir = join(exportsDir, n === 1 ? base : `${base}-${n}`);
    try {
      mkdirSync(dir);
      return dir;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`exports/ already holds 999 exports named ${base}. Move some of them elsewhere, then try again.`);
}

/** Every table as JSON and CSV, plus all.json in the board's /api/export.json shape (decision 0013). */
export async function exportData(options, deps) {
  const { root = ROOT, now = () => new Date(), exportsDir = join(root, "exports") } = deps;
  const target = databaseTarget(options, deps);
  const runner = makeRunner(deps, target.accountId);
  const tables = {};
  const columns = {};
  for (const table of EXPORT_TABLES) {
    // Table names come only from EXPORT_TABLES, never from input.
    const rows = query(runner, target, `SELECT * FROM ${table} ORDER BY rowid`);
    tables[table] = rows;
    columns[table] =
      rows.length > 0
        ? [...new Set(rows.flatMap((row) => Object.keys(row)))]
        : query(runner, target, `PRAGMA table_info(${table})`).map((column) => String(column.name));
  }
  const at = now();
  const timezone = typeof tables.settings?.[0]?.timezone === "string" ? tables.settings[0].timezone : DEFAULT_TZ;
  const dir = newExportFolder(exportsDir, safeFileName(`${target.label}-${localDate(at, timezone)}`));
  for (const table of EXPORT_TABLES) {
    writeFileSync(join(dir, safeFileName(`${table}.json`)), `${JSON.stringify(tables[table], null, 2)}\n`);
    writeFileSync(join(dir, safeFileName(`${table}.csv`)), toCsv(tables[table], columns[table]));
  }
  writeFileSync(join(dir, "all.json"), `${JSON.stringify({ exportedAt: at.toISOString(), tables }, null, 2)}\n`);
  deps.log(`Exported ${EXPORT_TABLES.length} tables to ${relative(root, dir)} (JSON and CSV per table, plus all.json).`);
  deps.log("It holds the copy's data: keep it private and never commit it (exports/ is git-ignored).");
  return 0;
}

// --------------------------------------------------------------------------------------------------------------- main

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const deps = {
    run: defaultRun,
    ask: (question) => rl.question(question),
    log: (line) => console.log(line),
    // Both overrides are for tests and demonstrations; the defaults are the git-ignored folders in the repo.
    copiesDir: process.env.PIPELINE_COPIES_DIR ? resolve(process.env.PIPELINE_COPIES_DIR) : join(ROOT, ".copies"),
    ...(process.env.PIPELINE_EXPORTS_DIR ? { exportsDir: resolve(process.env.PIPELINE_EXPORTS_DIR) } : {}),
  };
  try {
    const options = parseArgs(process.argv.slice(2));
    const command = { provision, update, export: exportData }[options.command];
    process.exitCode = await command(options, deps);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof UsageError ? 2 : 1;
  } finally {
    rl.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
