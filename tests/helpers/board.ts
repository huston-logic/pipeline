// Driving the board through the Worker in unit tests: a fixture-seeded database, the dev sign-in, a page load that
// returns its CSRF cookie and token, and a form post the way a browser on the board sends it (decisions 0014, 0017).
import { buildFixtureSeed } from "./fixture-seed.ts";
import type { AuditRow } from "../../src/db/db.ts";
import { createTestDb, type SqliteD1 } from "../../src/db/sqlite-d1.ts";
import type { Env } from "../../src/env.ts";
import worker from "../../src/index.ts";
import { DEFAULT_TZ } from "../../src/time.ts";

export { formFields } from "./form-fields.ts";

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
export const ORIGIN = "http://localhost:4821";

export async function seededDb(now = new Date()): Promise<SqliteD1> {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(now, DEFAULT_TZ));
  return db;
}

export const devEnv = (db: SqliteD1): Env => ({
  ENVIRONMENT: "development",
  AUTH_MODE: "dev",
  DB: db,
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
});

export const send = (env: Env, path: string, init?: RequestInit) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);

/** A board page, with the CSRF cookie it set (or the one sent) and the token in its forms. */
export async function load(env: Env, path: string, cookie?: string) {
  const res = await send(env, path, cookie === undefined ? undefined : { headers: { Cookie: cookie } });
  const body = await res.text();
  const set = (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  const token = /<input type="hidden" name="csrf" value="([^"]*)">/.exec(body)?.[1] ?? "";
  return { res, body, cookie: cookie ?? set, token };
}

export type PostOptions = { origin?: string | null; cookie?: string | null; token?: string };

/** A form post from a board page: same origin, the page's cookie and token, no redirect followed. */
export async function post(env: Env, path: string, fields: URLSearchParams | Record<string, string>, options: PostOptions = {}) {
  const page = options.token === undefined || options.cookie === undefined ? await load(env, "/pipeline") : null;
  const cookie = options.cookie === undefined ? (page?.cookie ?? "") : options.cookie;
  const token = options.token ?? page?.token ?? "";
  const body = new URLSearchParams(fields);
  if (!body.has("csrf")) body.set("csrf", token);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin !== null) headers.Origin = origin;
  if (cookie !== null) headers.Cookie = cookie;
  const res = await send(env, path, { method: "POST", headers, body: body.toString(), redirect: "manual" });
  return { res, body: await res.text(), location: res.headers.get("Location") ?? "", cookie: cookie ?? "", token };
}

export const auditRows = async (db: SqliteD1) => (await db.prepare("SELECT * FROM audit_log ORDER BY at, id").all<AuditRow>()).results;
export const auditCount = async (db: SqliteD1) => (await auditRows(db)).length;
export const changeIdOf = (location: string) => /[?&]change=(chg_[a-z0-9]+)/.exec(location)?.[1] ?? "";
export const auditOf = async (db: SqliteD1, id: string) =>
  db.prepare("SELECT * FROM audit_log WHERE id = ?").bind(id).first<AuditRow>();
export const h1Count = (body: string) => body.match(/<h1[\s>]/g)?.length ?? 0;
