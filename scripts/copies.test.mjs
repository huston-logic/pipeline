// The copy scripts against a recorder and an in-memory fake of Cloudflare (tests/helpers/wrangler-stub.mjs): exact
// command sequences, what lands in the git-ignored copy folder, and nothing ever run for real.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createFakeCloudflare, STUB_ACCOUNT_ID } from "../tests/helpers/wrangler-stub.mjs";
import { createTestDb } from "../src/db/sqlite-d1.ts";
import { EXPORT_TABLES, exportSelect } from "../src/http/export.ts";
import { parseCsv } from "../src/http/csv.ts";
import { checkWranglerConfig } from "./check-config.mjs";
import {
  copyPaths,
  exportData,
  ownerEmailsSql,
  parseArgs,
  parseJsonc,
  pickRateLimitIds,
  provision,
  PROVISION_STEPS,
  readCopyState,
  secretNames,
  TEMPLATE,
  update,
} from "./copies.mjs";
import { ROOT, formatCommand, parseJsonOutput, wranglerCommand } from "./wrangler-run.mjs";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const OTHER_ACCOUNT = "00000000000000000000000000000def";

const ANSWERS = [
  "--account-id",
  STUB_ACCOUNT_ID,
  "--owner-email",
  "owner@example.com, o'brien@example.com",
  "--access-team-domain",
  "example-team.cloudflareaccess.com",
  "--access-aud",
  "0123456789abcdef0123456789abcdef",
  "--host",
  "pipeline.example.com",
  "--brief-from",
  "",
];

function harness(t, fakeOptions = {}, answers = []) {
  const copiesDir = mkdtempSync(join(tmpdir(), "copies-"));
  const exportsDir = mkdtempSync(join(tmpdir(), "exports-"));
  t.after(() => {
    rmSync(copiesDir, { recursive: true, force: true });
    rmSync(exportsDir, { recursive: true, force: true });
  });
  const fake = createFakeCloudflare(fakeOptions);
  const calls = [];
  const lines = [];
  const asked = [];
  const queue = [...answers];
  const deps = {
    copiesDir,
    exportsDir,
    now: () => NOW,
    log: (line) => lines.push(line),
    ask: async (question) => {
      asked.push(question);
      return queue.shift() ?? "";
    },
    run: (cmd, opts = {}) => {
      calls.push({ cmd, env: opts.env ?? {}, capture: Boolean(opts.capture) });
      if (cmd[0] === "wrangler") return fake.handle(cmd.slice(1));
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  const cfg = (name) => relative(ROOT, copyPaths(copiesDir, name).config);
  return { deps, fake, calls, lines, asked, copiesDir, exportsDir, cfg };
}

const commands = (calls) => calls.map((call) => call.cmd);

test("provision runs the exact commands, in order, all in the client's account", async (t) => {
  const h = harness(t, {}, ["y", "y", "y", "s", "y", "y"]);
  const code = await provision(parseArgs(["provision", "--copy", "acme", ...ANSWERS]), h.deps);
  assert.equal(code, 0);
  const cfg = h.cfg("acme");
  const remote = ["--remote", "-c", cfg];
  const owners = ownerEmailsSql(["owner@example.com", "o'brien@example.com"], NOW);
  assert.deepEqual(commands(h.calls), [
    ["wrangler", "whoami", "--json"],
    ["wrangler", "d1", "list", "--json"],
    ["wrangler", "d1", "create", "pipeline-acme", "--update-config=false"],
    ["wrangler", "d1", "list", "--json"],
    ["wrangler", "d1", "list", "--json"],
    ["wrangler", "d1", "create", "pipeline-acme-preview", "--update-config=false"],
    ["wrangler", "d1", "list", "--json"],
    ["wrangler", "kv", "namespace", "list"],
    ["wrangler", "kv", "namespace", "create", "pipeline-acme-oauth", "--update-config=false"],
    ["wrangler", "kv", "namespace", "list"],
    ["wrangler", "kv", "namespace", "list"],
    ["wrangler", "kv", "namespace", "create", "pipeline-acme-oauth-preview", "--update-config=false"],
    ["wrangler", "kv", "namespace", "list"],
    ["wrangler", "d1", "migrations", "apply", "DB", ...remote],
    ["wrangler", "d1", "migrations", "list", "DB", ...remote],
    ["wrangler", "d1", "migrations", "apply", "DB", ...remote, "--preview"],
    ["wrangler", "d1", "migrations", "list", "DB", ...remote, "--preview"],
    ["wrangler", "d1", "execute", "DB", ...remote, "--file", "seed/defaults.sql", "--yes"],
    ["wrangler", "d1", "execute", "DB", ...remote, "--preview", "--file", "seed/defaults.sql", "--yes"],
    ["wrangler", "d1", "execute", "DB", ...remote, "--command", owners, "--yes"],
    ["wrangler", "d1", "execute", "DB", ...remote, "--preview", "--command", owners, "--yes"],
    ["wrangler", "secret", "put", "ACCESS_CLIENT_ID", "-c", cfg],
    ["wrangler", "secret", "put", "ACCESS_CLIENT_SECRET", "-c", cfg],
    ["wrangler", "secret", "put", "ACCESS_TOKEN_URL", "-c", cfg],
    ["wrangler", "secret", "put", "ACCESS_JWKS_URL", "-c", cfg],
    ["wrangler", "secret", "put", "INTAKE_SECRET", "-c", cfg],
  ]);
  for (const call of h.calls.slice(1)) assert.deepEqual(call.env, { CLOUDFLARE_ACCOUNT_ID: STUB_ACCOUNT_ID });
  assert.ok(!commands(h.calls).some((cmd) => cmd.includes("deploy") || cmd.includes("login")), "provision never deploys");
  assert.ok(h.lines.some((line) => line.includes(`npx wrangler secret put ACCESS_AUTHORIZATION_URL -c ${cfg}`)));
  assert.deepEqual(readCopyState(h.copiesDir, "acme").done, PROVISION_STEPS);
  assert.deepEqual(readCopyState(h.copiesDir, "acme").secrets.skipped, ["ACCESS_AUTHORIZATION_URL"]);
});

test("the generated config holds the copy's ids and answers, with paths that reach the repo from its folder", async (t) => {
  const h = harness(t, {}, []);
  await provision(parseArgs(["provision", "--copy", "acme", ...ANSWERS, "--skip-secrets"]), h.deps);
  const { dir, config } = copyPaths(h.copiesDir, "acme");
  const text = readFileSync(config, "utf8");
  assert.match(text, /^\/\/ Generated by/);
  assert.doesNotMatch(text, /\[\[/);
  const cfg = parseJsonc(text);
  const [prodDb, previewDb] = h.fake.state.d1;
  const [prodKv, previewKv] = h.fake.state.kv;
  assert.equal(cfg.name, "pipeline-acme");
  assert.equal(cfg.account_id, STUB_ACCOUNT_ID);
  assert.deepEqual(cfg.routes, [{ pattern: "pipeline.example.com", custom_domain: true }]);
  assert.deepEqual(cfg.vars, {
    ENVIRONMENT: "production",
    ACCESS_TEAM_DOMAIN: "example-team.cloudflareaccess.com",
    ACCESS_AUD: "0123456789abcdef0123456789abcdef",
    MCP_ALLOWED_HOSTNAMES: "pipeline.example.com",
  });
  assert.deepEqual(cfg.d1_databases, [
    {
      binding: "DB",
      database_name: "pipeline-acme",
      database_id: prodDb.uuid,
      preview_database_id: previewDb.uuid,
      migrations_dir: relative(dir, join(ROOT, "migrations")),
    },
  ]);
  assert.deepEqual(cfg.previews.d1_databases[0], {
    binding: "DB",
    database_name: "pipeline-acme-preview",
    database_id: previewDb.uuid,
    migrations_dir: relative(dir, join(ROOT, "migrations")),
  });
  assert.deepEqual(cfg.kv_namespaces, [{ binding: "OAUTH_KV", id: prodKv.id }]);
  assert.deepEqual(cfg.previews.kv_namespaces, [{ binding: "OAUTH_KV", id: previewKv.id }]);
  assert.deepEqual(
    [...cfg.ratelimits, ...cfg.previews.ratelimits].map((limit) => [limit.name, limit.namespace_id]),
    [
      ["INTAKE_RATE_LIMIT", "1001"],
      ["OAUTH_RATE_LIMIT", "1003"],
      ["INTAKE_RATE_LIMIT", "1002"],
      ["OAUTH_RATE_LIMIT", "1004"],
    ],
  );
  for (const path of [cfg.main, cfg.assets.directory, cfg.d1_databases[0].migrations_dir, cfg.$schema]) {
    assert.ok(resolve(dir, path).startsWith(ROOT), `${path} points into the repo`);
  }
  assert.equal(resolve(dir, cfg.main), join(ROOT, "src", "index.ts"));
  assert.deepEqual(readdirSync(dir).sort(), ["copy.json", "wrangler.jsonc"], "nothing else is written");
});

test("workers.dev leaves out routes and MCP_ALLOWED_HOSTNAMES; BRIEF_FROM is set when given and adds RESEND_API_KEY", async (t) => {
  const h = harness(t);
  const args = ANSWERS.map((arg) => (arg === "pipeline.example.com" ? "workers.dev" : arg === "" ? "brief@example.com" : arg));
  await provision(parseArgs(["provision", "--copy", "acme", ...args, "--skip-secrets"]), h.deps);
  const cfg = parseJsonc(readFileSync(copyPaths(h.copiesDir, "acme").config, "utf8"));
  assert.equal(cfg.routes, undefined);
  assert.equal(cfg.vars.MCP_ALLOWED_HOSTNAMES, undefined);
  assert.equal(cfg.vars.BRIEF_FROM, "brief@example.com");
  assert.ok(secretNames(readCopyState(h.copiesDir, "acme")).includes("RESEND_API_KEY"));
});

test("an existing copy is refused without --resume; --resume skips what is done and creates nothing twice", async (t) => {
  const h = harness(t, { fail: ["migrations apply DB --remote"] });
  await assert.rejects(provision(parseArgs(["provision", "--copy", "acme", ...ANSWERS, "--skip-secrets"]), h.deps), /migrations apply/);
  assert.deepEqual(readCopyState(h.copiesDir, "acme").done, ["d1:prod", "d1:preview", "kv:prod", "kv:preview", "config"]);

  await assert.rejects(provision(parseArgs(["provision", "--copy", "acme", ...ANSWERS]), h.deps), /already exists.*--resume/s);

  h.fake.state.fail = [];
  h.calls.length = 0;
  assert.equal(await provision(parseArgs(["provision", "--copy", "acme", "--resume", "--skip-secrets"]), h.deps), 0);
  assert.deepEqual(commands(h.calls)[0], ["wrangler", "whoami", "--json"]);
  assert.deepEqual(commands(h.calls)[1].slice(0, 4), ["wrangler", "d1", "migrations", "apply"]);
  assert.ok(!commands(h.calls).some((cmd) => cmd.includes("create")));
  assert.equal(h.fake.state.d1.length, 2);
  assert.deepEqual(readCopyState(h.copiesDir, "acme").done, PROVISION_STEPS);

  await assert.rejects(provision(parseArgs(["provision", "--copy", "other", "--resume"]), h.deps), /no copy "other" to resume/);
});

test("a database that already exists (an interrupted run) is found, not created again", async (t) => {
  const h = harness(t);
  h.fake.state.d1.push({ uuid: "00000000-0000-4000-8000-000000000099", name: "pipeline-acme" });
  await provision(parseArgs(["provision", "--copy", "acme", ...ANSWERS, "--skip-secrets"]), h.deps);
  assert.ok(!commands(h.calls).some((cmd) => cmd.join(" ") === "wrangler d1 create pipeline-acme --update-config=false"));
  assert.equal(readCopyState(h.copiesDir, "acme").resources.db.id, "00000000-0000-4000-8000-000000000099");
});

test("the account is chosen from the login's accounts, and an account the login can't use stops before anything is made", async (t) => {
  const h = harness(t, { accounts: [{ id: OTHER_ACCOUNT, name: "Another" }, { id: STUB_ACCOUNT_ID, name: "Example Client" }] }, ["2"]);
  const args = ANSWERS.slice(2);
  await provision(parseArgs(["provision", "--copy", "acme", ...args, "--skip-secrets"]), h.deps);
  assert.equal(readCopyState(h.copiesDir, "acme").accountId, STUB_ACCOUNT_ID);
  assert.match(h.asked[0], /Which account/);
  assert.ok(h.lines.some((line) => line.includes("2. Example Client")));

  const h2 = harness(t, { accounts: [{ id: OTHER_ACCOUNT, name: "Another" }] });
  await assert.rejects(provision(parseArgs(["provision", "--copy", "acme", ...ANSWERS]), h2.deps), /isn't a member of account/);
  assert.equal(h2.fake.state.d1.length, 0);
});

test("missing answers are asked for, and bad ones are refused with how to fix them", async (t) => {
  const h = harness(t, {}, ["not-an-email", "owner@example.com", "example-team.cloudflareaccess.com", "abc123def456ghi789", "workers.dev", ""]);
  await provision(parseArgs(["provision", "--copy", "acme", "--account-id", STUB_ACCOUNT_ID, "--skip-secrets"]), h.deps);
  const state = readCopyState(h.copiesDir, "acme");
  assert.deepEqual(state.ownerEmails, ["owner@example.com"]);
  assert.deepEqual(state.host, { kind: "workers.dev" });
  assert.equal(state.briefFrom, null);
  assert.ok(h.lines.includes("Give one or more email addresses, comma-separated."));

  assert.throws(() => parseArgs(["provision", "--copy", "Bad Name"]), /can't be a copy name/);
  assert.throws(() => parseArgs(["provision"]), /--copy/);
  assert.throws(() => parseArgs(["deploy"]), /provision, update or export/);
  assert.throws(() => parseArgs(["update", "--remote"]), /Unknown option/);
  const badAud = ANSWERS.map((arg) => (arg === "0123456789abcdef0123456789abcdef" ? "x" : arg));
  await assert.rejects(provision(parseArgs(["provision", "--copy", "acme2", ...badAud]), h.deps), /--access-aud/);
});

test("arguments: --flag=value works; a missing value, a repeat or a value on a switch is refused in plain English", () => {
  assert.equal(parseArgs(["update", "--copy=acme"]).copy, "acme");
  assert.equal(parseArgs(["export", "--local", "--persist-to=.wrangler/other"]).persistTo, ".wrangler/other");
  assert.deepEqual(parseArgs(["provision", "--copy", "acme", "--owner-email", "a@example.com", "--owner-email=b@example.com"]).ownerEmails, [
    "a@example.com",
    "b@example.com",
  ]);
  const refuse = (argv, pattern) => assert.throws(() => parseArgs(argv), { message: pattern }, argv.join(" "));
  refuse(["update", "--copy"], /^--copy needs a value, like --copy acme\.$/);
  refuse(["update", "--copy="], /^--copy needs a value/);
  refuse(["update", "--copy", "--dry-run"], /^--copy needs a value/);
  refuse(["export", "--local", "--persist-to", "--dry-run"], /^--persist-to needs a value/);
  refuse(["update", "--copy", "acme", "--copy", "other"], /^--copy is given twice\. Give it once\.$/);
  refuse(["update", "--copy=acme", "--copy", "acme"], /^--copy is given twice/);
  refuse(["update", "--dry-run", "--dry-run"], /^--dry-run is given twice/);
  refuse(["update", "--dry-run=yes"], /^--dry-run takes no value\. Use --dry-run on its own\.$/);
  refuse(["update", "--remote"], /^Unknown option "--remote"\./);
  refuse(["update", "acme"], /^Unknown option "acme"\./);
});

test("a provision dry run prints the commands and runs and writes nothing", async (t) => {
  const h = harness(t);
  assert.equal(await provision(parseArgs(["provision", "--copy", "acme", ...ANSWERS, "--dry-run"]), h.deps), 0);
  assert.deepEqual(h.calls, []);
  assert.equal(existsSync(copyPaths(h.copiesDir, "acme").dir), false);
  const printed = h.lines.join("\n");
  assert.match(printed, /Dry run/);
  assert.match(printed, /\$ wrangler d1 create pipeline-acme --update-config=false/);
  assert.match(printed, /\$ wrangler secret put INTAKE_SECRET -c /);
});

test("owner emails are written as escaped SQL that stores exactly the JSON list", async () => {
  const db = await createTestDb();
  const emails = ["owner@example.com", "o'brien@example.com"];
  db.exec(ownerEmailsSql(emails, NOW));
  const row = await db.prepare("SELECT owner_emails, version, updated_at FROM settings").first();
  assert.deepEqual(JSON.parse(row.owner_emails), emails);
  assert.equal(row.version, 2);
  assert.equal(row.updated_at, NOW.toISOString());
});

test("rate-limit ids are unique per account: a second copy in the same account gets the next block", () => {
  const first = pickRateLimitIds([], STUB_ACCOUNT_ID);
  assert.deepEqual(first, { intake: "1001", previewIntake: "1002", oauth: "1003", previewOauth: "1004" });
  const others = [{ accountId: STUB_ACCOUNT_ID, resources: { rateLimits: first } }];
  assert.equal(pickRateLimitIds(others, STUB_ACCOUNT_ID).intake, "1011");
  assert.equal(pickRateLimitIds(others, OTHER_ACCOUNT).intake, "1001");
});

async function provisioned(h, name, accountId = STUB_ACCOUNT_ID) {
  const args = ANSWERS.map((arg) => (arg === STUB_ACCOUNT_ID ? accountId : arg));
  h.fake.state.accounts = [{ id: STUB_ACCOUNT_ID, name: "A" }, { id: OTHER_ACCOUNT, name: "B" }];
  await provision(parseArgs(["provision", "--copy", name, ...args, "--skip-secrets"]), h.deps);
}

test("update: whoami, one build, then migrations and deploy per copy; a copy the login can't use fails alone", async (t) => {
  const h = harness(t);
  await provisioned(h, "acme");
  await provisioned(h, "beta", OTHER_ACCOUNT);
  await provisioned(h, "gamma");
  h.fake.state.accounts = [{ id: STUB_ACCOUNT_ID, name: "Example Client" }];
  h.calls.length = 0;
  h.lines.length = 0;

  assert.equal(await update(parseArgs(["update"]), h.deps), 1);
  const steps = (name) => [
    ["wrangler", "d1", "migrations", "apply", "DB", "--remote", "-c", h.cfg(name)],
    ["wrangler", "d1", "migrations", "list", "DB", "--remote", "-c", h.cfg(name)],
    ["wrangler", "deploy", "-c", h.cfg(name)],
  ];
  assert.deepEqual(commands(h.calls), [["wrangler", "whoami", "--json"], ["npm", "run", "build"], ...steps("acme"), ...steps("gamma")]);
  assert.deepEqual(h.calls[2].env, { CLOUDFLARE_ACCOUNT_ID: STUB_ACCOUNT_ID });
  assert.deepEqual(h.lines, [
    "acme: updated",
    `beta: FAILED: This wrangler login isn't a member of account ${OTHER_ACCOUNT}. Ask the client to invite your Cloudflare user to their account (docs/INSTALL.md, step 2), accept the invitation, then try again.`,
    "gamma: updated",
    "2 of 3 copies updated.",
  ]);
});

test("update: failed migrations skip that copy's deploy and the run goes on; --copy updates one", async (t) => {
  const h = harness(t);
  await provisioned(h, "acme");
  await provisioned(h, "gamma");
  h.fake.state.fail = [`apply DB --remote -c ${h.cfg("acme")}`];
  h.calls.length = 0;
  h.lines.length = 0;
  assert.equal(await update(parseArgs(["update"]), h.deps), 1);
  assert.ok(!commands(h.calls).some((cmd) => cmd[1] === "deploy" && cmd.includes(h.cfg("acme"))));
  assert.deepEqual(h.fake.state.deployed, [h.cfg("gamma")]);
  assert.equal(h.lines[0], "acme: FAILED: migrations failed (exit 1); not deployed");

  h.fake.state.fail = [];
  h.calls.length = 0;
  assert.equal(await update(parseArgs(["update", "--copy", "acme"]), h.deps), 0);
  assert.deepEqual(commands(h.calls).at(-1), ["wrangler", "deploy", "-c", h.cfg("acme")]);
  await assert.rejects(update(parseArgs(["update", "--copy", "nope"]), h.deps), /no copy "nope"/);
});

/** Rewrites a provisioned copy's config as an older version made it: one cron, plus a var the owner set by hand. */
function makeOld(h, name) {
  const path = copyPaths(h.copiesDir, name).config;
  const text = readFileSync(path, "utf8");
  const config = JSON.parse(text.replace(/^\/\/.*\n/gm, ""));
  config.triggers = { crons: ["0 * * * *"] };
  config.vars = { ...config.vars, CAMPAIGN_FROM: "News <news@mail.example.com>" };
  const header = text.match(/^(\/\/.*\n)+/)?.[0] ?? "";
  writeFileSync(path, `${header}${JSON.stringify(config, null, 2)}\n`);
  return { path, header };
}

test("update brings an older copy's cron triggers in step with the template and keeps its other values", async (t) => {
  const h = harness(t);
  await provisioned(h, "acme");
  const { path, header } = makeOld(h, "acme");
  h.lines.length = 0;
  assert.equal(await update(parseArgs(["update"]), h.deps), 0);
  const after = readFileSync(path, "utf8");
  assert.ok(after.startsWith(header));
  const config = JSON.parse(after.replace(/^\/\/.*\n/gm, ""));
  assert.deepEqual(config.triggers.crons, ["0 * * * *", "5,20,35,50 * * * *"]);
  assert.equal(config.vars.CAMPAIGN_FROM, "News <news@mail.example.com>");
  assert.equal(config.account_id, STUB_ACCOUNT_ID);
  assert.deepEqual(h.lines.slice(0, 2), ["- acme: cron triggers updated from the template", "acme: updated"]);
});

test("an update dry run says it would update the cron triggers and writes nothing", async (t) => {
  const h = harness(t);
  await provisioned(h, "acme");
  const { path } = makeOld(h, "acme");
  const before = readFileSync(path, "utf8");
  h.lines.length = 0;
  assert.equal(await update(parseArgs(["update", "--dry-run"]), h.deps), 0);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.ok(h.lines.includes("  would update the cron triggers from the template"));
});

test("a config already in step is not rewritten and says nothing", async (t) => {
  const h = harness(t);
  await provisioned(h, "acme");
  const path = copyPaths(h.copiesDir, "acme").config;
  const before = readFileSync(path, "utf8");
  h.lines.length = 0;
  await update(parseArgs(["update"]), h.deps);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.deepEqual(h.lines, ["acme: updated", "1 of 1 copy updated."]);
});

test("update stops before building when wrangler isn't logged in, and when the build fails", async (t) => {
  const h = harness(t);
  await provisioned(h, "acme");
  h.calls.length = 0;
  h.fake.state.fail = ["whoami"];
  await assert.rejects(update(parseArgs(["update"]), h.deps), /isn't logged in/);
  assert.equal(h.calls.length, 1);

  h.fake.state.fail = [];
  h.calls.length = 0;
  const failingBuild = { ...h.deps, run: (cmd, opts) => (cmd[0] === "npm" ? { status: 1, stdout: "", stderr: "" } : h.deps.run(cmd, opts)) };
  await assert.rejects(update(parseArgs(["update"]), failingBuild), /build failed, so no copy was updated/);
  assert.ok(!h.fake.state.deployed.length);
});

test("an update dry run prints every command and runs nothing", async (t) => {
  const h = harness(t);
  await provisioned(h, "acme");
  h.calls.length = 0;
  h.lines.length = 0;
  assert.equal(await update(parseArgs(["update", "--dry-run"]), h.deps), 0);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.lines, [
    "Dry run: nothing runs. An update would run:",
    "  $ wrangler whoami --json",
    "  $ npm run build",
    `- acme (account ${STUB_ACCOUNT_ID}; stops here if the login isn't a member)`,
    `  $ wrangler d1 migrations apply DB --remote -c ${h.cfg("acme")}`,
    `  $ wrangler d1 migrations list DB --remote -c ${h.cfg("acme")}   (stops here if any migration is still pending)`,
    `  $ wrangler deploy -c ${h.cfg("acme")}`,
  ]);
  const empty = harness(t);
  await assert.rejects(update(parseArgs(["update"]), empty.deps), /no copies yet/);
});

test("export reads every export table and writes JSON, CSV and all.json in the board's export shape", async (t) => {
  const contacts = [
    { id: "ct_1", name: "Pat, Example", email: "pat@example.com", notes: "=SUM(A1)\nline two" },
    { id: "ct_2", name: "Casey 🌱", email: null, notes: null },
  ];
  const h = harness(t, { tables: { contacts, settings: [{ id: 1, timezone: "Pacific/Auckland" }] } });
  await provisioned(h, "acme");
  h.calls.length = 0;
  assert.equal(await exportData(parseArgs(["export", "--copy", "acme"]), h.deps), 0);

  const remote = ["--remote", "-c", h.cfg("acme"), "--json", "--yes", "--command"];
  const selects = commands(h.calls).filter((cmd) => cmd.at(-1).startsWith("SELECT"));
  assert.deepEqual(
    selects,
    EXPORT_TABLES.map((table) => ["wrangler", "d1", "execute", "DB", ...remote, exportSelect(table)]),
  );
  assert.ok(commands(h.calls).some((cmd) => cmd.at(-1) === "PRAGMA table_info(deals)"), "an empty table still gets its header");
  assert.ok(!commands(h.calls).some((cmd) => cmd.at(-1) === "PRAGMA table_info(contacts)"));
  for (const call of h.calls) assert.deepEqual(call.env, { CLOUDFLARE_ACCOUNT_ID: STUB_ACCOUNT_ID });

  const dir = join(h.exportsDir, "acme-2026-11-20");
  assert.deepEqual(
    readdirSync(dir).sort(),
    ["all.json", ...EXPORT_TABLES.flatMap((table) => [`${table}.csv`, `${table}.json`])].sort(),
  );
  const all = JSON.parse(readFileSync(join(dir, "all.json"), "utf8"));
  assert.deepEqual(Object.keys(all), ["exportedAt", "tables"]);
  assert.equal(all.exportedAt, NOW.toISOString());
  assert.deepEqual(Object.keys(all.tables), [...EXPORT_TABLES]);
  assert.deepEqual(all.tables.contacts, contacts);
  assert.deepEqual(parseCsv(readFileSync(join(dir, "contacts.csv"), "utf8")), [
    ["id", "name", "email", "notes"],
    ["ct_1", "Pat, Example", "pat@example.com", "'=SUM(A1)\nline two"],
    ["ct_2", "Casey 🌱", "", ""],
  ]);
  assert.equal(readFileSync(join(dir, "deals.csv"), "utf8"), "id\r\n");
});

test("export --local reads the local dev database and needs no account", async (t) => {
  const h = harness(t);
  await exportData(parseArgs(["export", "--local"]), h.deps);
  assert.deepEqual(commands(h.calls)[0].slice(0, 8), ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", ".wrangler/state", "--json"]);
  for (const call of h.calls) assert.deepEqual(call.env, {});
  assert.ok(existsSync(join(h.exportsDir, "local-2026-11-19", "all.json")));
  assert.throws(() => parseArgs(["export"]), /--copy <name>, or the local dev database with --local/);
  assert.throws(() => parseArgs(["export", "--local", "--copy", "acme"]), /--local/);
});

test("a second export on the same day goes to a new folder (-2, -3, ...) and never overwrites the first", async (t) => {
  const h = harness(t);
  await exportData(parseArgs(["export", "--local"]), h.deps);
  const first = join(h.exportsDir, "local-2026-11-19");
  writeFileSync(join(first, "all.json"), "the first export\n");
  await exportData(parseArgs(["export", "--local"]), h.deps);
  await exportData(parseArgs(["export", "--local"]), h.deps);
  assert.equal(readFileSync(join(first, "all.json"), "utf8"), "the first export\n");
  assert.deepEqual(readdirSync(h.exportsDir).sort(), ["local-2026-11-19", "local-2026-11-19-2", "local-2026-11-19-3"]);
  assert.ok(existsSync(join(h.exportsDir, "local-2026-11-19-3", "all.json")));
  assert.match(h.lines.filter((line) => line.startsWith("Exported")).at(-1), /local-2026-11-19-3/);
});

test("the template holds placeholders only and keeps the shared settings in step with wrangler.jsonc", () => {
  const text = readFileSync(TEMPLATE, "utf8");
  assert.deepEqual(checkWranglerConfig(text), []);
  const template = parseJsonc(text);
  const dev = parseJsonc(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"));
  for (const key of ["compatibility_date", "compatibility_flags", "triggers", "observability"]) {
    assert.deepEqual(template[key], dev[key], key);
  }
  assert.deepEqual({ ...template.assets, directory: "" }, { ...dev.assets, directory: "" });
  const limits = (list) => list.map(({ name, simple }) => ({ name, simple }));
  assert.deepEqual(limits(template.ratelimits), limits(dev.ratelimits));
  assert.deepEqual(limits(template.previews.ratelimits), limits(dev.previews.ratelimits));
  const bindings = (cfg) => [cfg.d1_databases.map((d) => d.binding), cfg.kv_namespaces.map((k) => k.binding)];
  assert.deepEqual(bindings(template), bindings(dev));
  assert.deepEqual(bindings(template.previews), bindings(dev.previews));
});

test("the template turns off version preview URLs, which would run on the production bindings", () => {
  const template = parseJsonc(readFileSync(TEMPLATE, "utf8"));
  assert.equal(template.preview_urls, false);
});

test("every secret provisioning asks for is listed in docs/SECRETS.md", () => {
  const doc = readFileSync(join(ROOT, "docs", "SECRETS.md"), "utf8");
  for (const name of secretNames({ briefFrom: "brief@example.com" })) {
    assert.match(doc, new RegExp(`\\| \`${name}\` \\|`), name);
  }
});

test("the runner: PIPELINE_WRANGLER points at a stub, output JSON is found after a banner, commands print pasteably", () => {
  assert.deepEqual(wranglerCommand({}), [join(ROOT, "node_modules", ".bin", "wrangler")]);
  assert.deepEqual(wranglerCommand({ PIPELINE_WRANGLER: "tests/helpers/wrangler-stub.mjs" }), [
    process.execPath,
    resolve("tests/helpers/wrangler-stub.mjs"),
  ]);
  assert.deepEqual(parseJsonOutput('⛅️ wrangler 4\n─────\n[\n  {"a": 1}\n]\n'), [{ a: 1 }]);
  assert.throws(() => parseJsonOutput("not json"), /didn't print the JSON/);
  assert.equal(formatCommand(["wrangler", "d1", "execute", "--command", "SELECT 'x'"]), `wrangler d1 execute --command 'SELECT '\\''x'\\'''`);
});


test("update: declining wrangler's migration prompt (exit 0, nothing applied) stops that copy before the deploy", async (t) => {
  const h = harness(t);
  await provisioned(h, "acme");
  // A new release: the database has a migration it hasn't applied, and the owner answers "no" to the prompt.
  h.fake.state.migrated = [];
  h.fake.state.declineMigrations = true;
  h.calls.length = 0;
  h.lines.length = 0;
  assert.equal(await update(parseArgs(["update"]), h.deps), 1);
  assert.deepEqual(h.fake.state.deployed, []);
  assert.ok(!commands(h.calls).some((cmd) => cmd[1] === "deploy"));
  assert.equal(h.lines[0], "acme: FAILED: migrations not applied; not deployed");

  h.fake.state.declineMigrations = false;
  assert.equal(await update(parseArgs(["update"]), h.deps), 0);
  assert.deepEqual(h.fake.state.deployed, [h.cfg("acme")]);
});

test("provision: a declined migration prompt isn't marked done, so --resume asks again", async (t) => {
  const h = harness(t, { declineMigrations: true });
  await assert.rejects(
    provision(parseArgs(["provision", "--copy", "acme", ...ANSWERS, "--skip-secrets"]), h.deps),
    /production database still has migrations to apply.*--resume/s,
  );
  assert.ok(!readCopyState(h.copiesDir, "acme").done.includes("migrate:prod"));
  h.fake.state.declineMigrations = false;
  assert.equal(await provision(parseArgs(["provision", "--copy", "acme", "--resume", "--skip-secrets"]), h.deps), 0);
  assert.deepEqual(readCopyState(h.copiesDir, "acme").done, PROVISION_STEPS);
});

test("update checks the account the config deploys to, and refuses a copy whose config and copy.json disagree", async (t) => {
  const h = harness(t);
  await provisioned(h, "acme");
  const { config } = copyPaths(h.copiesDir, "acme");
  writeFileSync(config, readFileSync(config, "utf8").replace(STUB_ACCOUNT_ID, OTHER_ACCOUNT));
  h.calls.length = 0;
  h.lines.length = 0;
  assert.equal(await update(parseArgs(["update"]), h.deps), 1);
  assert.match(h.lines[0], new RegExp(`^acme: FAILED: its wrangler.jsonc names account ${OTHER_ACCOUNT} but copy.json names ${STUB_ACCOUNT_ID}`));
  assert.deepEqual(commands(h.calls), [["wrangler", "whoami", "--json"], ["npm", "run", "build"]]);
});

test("update refuses a copy with any provisioning step but the secrets still to do", async (t) => {
  const h = harness(t);
  await provisioned(h, "acme");
  const state = readCopyState(h.copiesDir, "acme");
  writeFileSync(copyPaths(h.copiesDir, "acme").state, JSON.stringify({ ...state, done: state.done.filter((s) => s !== "seed:prod") }));
  h.lines.length = 0;
  assert.equal(await update(parseArgs(["update"]), h.deps), 1);
  assert.match(h.lines[0], /^acme: FAILED: not fully provisioned; run npm run copies:provision -- --copy acme --resume$/);

  writeFileSync(copyPaths(h.copiesDir, "acme").state, JSON.stringify({ ...state, done: state.done.filter((s) => s !== "secrets") }));
  h.lines.length = 0;
  assert.equal(await update(parseArgs(["update"]), h.deps), 0, "skipped or unfinished secrets don't block an update");
});
