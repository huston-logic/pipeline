// The daily brief is a switch (run 12, migration 0028): off, the Brief and Notifications pages are 404s and have no nav
// item, and the notification posts are 404s; on, they are back.
import assert from "node:assert/strict";
import { test } from "node:test";
import { devEnv, load, post, seededDb } from "../../tests/helpers/board.ts";

const navOf = (body: string) => /<nav class="app-nav"[\s\S]*?<\/nav>/.exec(body)?.[0] ?? "";

test("off: /brief and /notifications are 404s and the nav and More list neither", async () => {
  const db = await seededDb();
  db.exec("UPDATE settings SET brief = 0");
  const env = devEnv(db);
  assert.equal((await load(env, "/brief")).res.status, 404);
  assert.equal((await load(env, "/notifications")).res.status, 404);
  const today = await load(env, "/");
  assert.equal(today.res.status, 200);
  assert.doesNotMatch(navOf(today.body), /href="\/brief"|href="\/notifications"/);
  const more = await load(env, "/more");
  assert.doesNotMatch(more.body, /href="\/brief"|href="\/notifications"/);
  assert.match(more.body, /href="\/rules"/, "the other More items stay");
});

test("off: the notification posts, Send a test included, are 404s and push nothing", async () => {
  const db = await seededDb();
  db.exec("UPDATE settings SET brief = 0");
  const env = devEnv(db);
  for (const path of ["/notifications/on", "/notifications/off", "/notifications/test", "/notifications/ps_abc/off"]) {
    assert.equal((await post(env, path, {})).res.status, 404, path);
  }
});

test("on: the pages and nav items are back", async () => {
  const db = await seededDb();
  db.exec("UPDATE settings SET brief = 1");
  const env = devEnv(db);
  assert.equal((await load(env, "/brief")).res.status, 200);
  assert.equal((await load(env, "/notifications")).res.status, 200);
  const more = await load(env, "/more");
  assert.match(more.body, /href="\/brief"/);
  assert.match(more.body, /href="\/notifications"/);
  assert.match(navOf((await load(env, "/")).body), /href="\/brief"/);
});
