import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkGitignore,
  checkTrackedFiles,
  checkWranglerConfig,
  findEmails,
  isAllowedEmail,
  isPlaceholderId,
} from "./check-config.mjs";

// Built at runtime so this file never holds a real-looking address for the guard to find.
const at = "@";
const realLooking = `jane.doe${at}acme-plumbing.io`;

test("finds email addresses in text", () => {
  assert.deepEqual(findEmails(`Write to ${realLooking} or sam${at}example.com.`), [realLooking, `sam${at}example.com`]);
  assert.deepEqual(findEmails('"@types/node": "^20", typescript-eslint@8.72.2, @example.com'), []);
});

test("allows example domains and the commit trailer addresses only", () => {
  for (const ok of [
    `sam${at}example.com`,
    `sam${at}example.test`,
    `sam${at}example.org`,
    `sam${at}example.net`,
    `sam${at}mail.example.com`,
    `noreply${at}anthropic.com`,
    `12345+someone${at}users.noreply.github.com`,
  ]) {
    assert.equal(isAllowedEmail(ok), true, ok);
  }
  for (const bad of [realLooking, `team${at}anthropic.com`, `sam${at}example.co`, `sam${at}notexample.com`]) {
    assert.equal(isAllowedEmail(bad), false, bad);
  }
});

test("reports each tracked file that holds a non-example address", () => {
  const problems = checkTrackedFiles([
    { path: "docs/ok.md", text: `Fake person: sam${at}example.test` },
    { path: "seed/leads.sql", text: `INSERT INTO contacts VALUES ('${realLooking}');` },
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /seed\/leads\.sql/);
  assert.match(problems[0], /acme-plumbing\.io/);
});

test("skips only the root package-lock.json, whose text comes from the npm registry", () => {
  const text = `"deprecated": "contact ${realLooking}"`;
  assert.deepEqual(checkTrackedFiles([{ path: "package-lock.json", text }]), []);
  assert.equal(checkTrackedFiles([{ path: "seed/package-lock.json", text }]).length, 1);
});

test("reports any tracked file under /.copies/ or /exports/", () => {
  const problems = checkTrackedFiles([
    { path: ".copies/acme/wrangler.jsonc", text: "{}" },
    { path: "exports/contacts.csv", text: "name" },
    { path: "docs/exports.md", text: "fine" },
  ]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^\.copies\/acme\/wrangler\.jsonc/);
  assert.match(problems[1], /^exports\/contacts\.csv/);
});

test("database_id and account_id must be placeholders", () => {
  assert.equal(isPlaceholderId("[[Production database id]]"), true);
  assert.equal(isPlaceholderId("00000000-0000-0000-0000-000000000000"), true);
  assert.equal(isPlaceholderId("local"), true);
  assert.equal(isPlaceholderId("3f2b9c1e-7a4d-4e8b-9c2a-1d5e6f7a8b9c"), false);

  assert.deepEqual(checkWranglerConfig('{ "name": "pipeline-dev", "main": "src/index.ts" }'), []);
  assert.deepEqual(
    checkWranglerConfig('{ "d1_databases": [{ "binding": "DB", "database_id": "00000000-0000-0000-0000-000000000000" }] }'),
    [],
  );
  const problems = checkWranglerConfig(
    '{\n  "account_id": "0123456789abcdef0123456789abcdef",\n  "previews": { "d1_databases": [{ "database_id": "3f2b9c1e-7a4d-4e8b-9c2a-1d5e6f7a8b9c" }] }\n}',
  );
  assert.equal(problems.length, 2);
  assert.match(problems[0], /account_id/);
  assert.match(problems[1], /database_id/);
});

test("KV namespace ids must be placeholders too", () => {
  assert.equal(isPlaceholderId("00000000000000000000000000000000"), true);
  assert.deepEqual(
    checkWranglerConfig(
      '{ "kv_namespaces": [{ "binding": "OAUTH_KV", "id": "00000000000000000000000000000000" }],\n' +
        '  "previews": { "kv_namespaces": [{ "binding": "OAUTH_KV", "id": "[[PREVIEW_OAUTH_KV_ID]]" }] } }',
    ),
    [],
  );
  const problems = checkWranglerConfig(
    '{ "kv_namespaces": [{ "binding": "OAUTH_KV", "id": "0f1e2d3c4b5a69788796a5b4c3d2e1f0", "preview_id": "abcdefabcdefabcdefabcdefabcdefab" }] }',
  );
  assert.equal(problems.length, 2);
  assert.match(problems[0], /real id/);
  assert.match(problems[1], /real preview_id/);
});

test(".gitignore must ignore /.copies/ and /exports/", () => {
  assert.deepEqual(checkGitignore("/node_modules\n/.copies/\n/exports/\n"), []);
  const problems = checkGitignore("/node_modules\n# /.copies/\n");
  assert.equal(problems.length, 2);
  assert.match(problems[0], /\/\.copies\//);
  assert.match(problems[1], /\/exports\//);
});

test("a real id is reported with the file it is in, so the copy template is checked like wrangler.jsonc", () => {
  const [problem] = checkWranglerConfig('{ "account_id": "0123456789abcdef0123456789abcdef" }', "config/wrangler.copy.template.jsonc");
  assert.match(problem, /^config\/wrangler\.copy\.template\.jsonc has a real account_id/);
  assert.deepEqual(checkWranglerConfig('{ "account_id": "[[ACCOUNT_ID]]", "id": "[[KV_ID]]" }', "x"), []);
});
