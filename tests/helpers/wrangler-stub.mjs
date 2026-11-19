#!/usr/bin/env node
// A stand-in for wrangler that never talks to Cloudflare, for the copy scripts' tests and dry demonstrations.
// Imported, `createFakeCloudflare()` answers wrangler commands from memory. Run as a program (point PIPELINE_WRANGLER at
// this file), it keeps its pretend account in the JSON file named by PIPELINE_STUB_STATE (a fresh one when unset) and
// appends each command it was given to PIPELINE_STUB_LOG. Every id it hands out is obviously fake.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const STUB_ACCOUNT_ID = "00000000000000000000000000000abc";

const fakeUuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fakeKvId = (n) => `f${String(n).padStart(31, "0")}`;

/**
 * @param {{ accounts?: { id: string, name: string }[], fail?: string[], tables?: Record<string, object[]> }} [options]
 *   `fail`: a command whose text contains one of these fails. `tables`: rows `d1 execute` returns per table.
 */
export function createFakeCloudflare(options = {}) {
  const state = {
    accounts: options.accounts ?? [{ id: STUB_ACCOUNT_ID, name: "Example Client" }],
    fail: options.fail ?? [],
    tables: options.tables ?? {},
    d1: [],
    kv: [],
    secrets: [],
    deployed: [],
    counter: 0,
  };
  return { state, handle: (args) => handle(state, args) };
}

const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const json = (value) => ok(`${JSON.stringify(value, null, 2)}\n`);
const flag = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

function handle(state, args) {
  const text = args.join(" ");
  if (state.fail.some((part) => text.includes(part))) return { status: 1, stdout: "", stderr: `stub: "${text}" failed on purpose\n` };
  const [a, b, c] = args;
  if (a === "whoami") {
    return json({ loggedIn: true, authType: "OAuth Token", email: "owner@example.com", accounts: state.accounts });
  }
  if (a === "d1" && b === "list") return json(state.d1);
  if (a === "d1" && b === "create") {
    state.d1.push({ uuid: fakeUuid(++state.counter), name: c, created_at: "2026-11-18T00:00:00.000Z" });
    return ok(`✅ Successfully created DB '${c}' (stub)\n`);
  }
  if (a === "kv" && b === "namespace" && c === "list") return json(state.kv);
  if (a === "kv" && b === "namespace" && c === "create") {
    state.kv.push({ id: fakeKvId(++state.counter), title: args[3] });
    return ok(`🌀 Creating namespace with title "${args[3]}" (stub)\n`);
  }
  if (a === "d1" && b === "execute" && args.includes("--json")) {
    const command = flag(args, "--command") ?? "";
    const select = /^SELECT \* FROM (\w+)/.exec(command);
    const pragma = /^PRAGMA table_info\((\w+)\)/.exec(command);
    let results = [];
    if (select) results = state.tables[select[1]] ?? [];
    if (pragma) results = [{ cid: 0, name: "id" }];
    return json([{ results, success: true, meta: {} }]);
  }
  if (a === "secret" && b === "put") {
    state.secrets.push(c);
    return ok(`✨ Uploaded secret ${c} (stub; no value was read)\n`);
  }
  if (a === "deploy") {
    state.deployed.push(flag(args, "-c"));
    return ok("Deployed (stub; nothing was uploaded)\n");
  }
  return ok(`stub: ${text}\n`);
}

function main() {
  const statePath = process.env.PIPELINE_STUB_STATE;
  const fake = createFakeCloudflare();
  if (statePath && existsSync(statePath)) Object.assign(fake.state, JSON.parse(readFileSync(statePath, "utf8")));
  const args = process.argv.slice(2);
  if (process.env.PIPELINE_STUB_LOG) appendFileSync(process.env.PIPELINE_STUB_LOG, `${JSON.stringify(args)}\n`);
  const result = fake.handle(args);
  if (statePath) writeFileSync(statePath, JSON.stringify(fake.state, null, 2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
