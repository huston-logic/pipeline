// The status corner's Close (run 12): a post that writes no data, only remembers for five minutes which change the
// owner closed, in a cookie the corner reads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { auditCount, devEnv, post } from "../../tests/helpers/board.ts";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import { CORNER_COOKIE, closedChangeFrom } from "./corner-actions.ts";

test("POST /corner/close sets the cookie for the change and goes back, writing nothing", async () => {
  const db = await timeDb(new Date());
  const before = await auditCount(db);
  const { res, location } = await post(devEnv(db), "/corner/close", { change: "chg_abc123def456", return_to: "/pipeline" });
  assert.equal(res.status, 303);
  assert.equal(location, "/pipeline");
  assert.equal(res.headers.get("Set-Cookie"), "pipeline_corner=chg_abc123def456; HttpOnly; SameSite=Strict; Path=/; Max-Age=300");
  assert.equal(await auditCount(db), before);
});

test("a bad change id sets no cookie, and a bad return_to goes to Today", async () => {
  const db = await timeDb(new Date());
  const { res, location } = await post(devEnv(db), "/corner/close", { change: "<b>", return_to: "https://evil.example/" });
  assert.equal(res.status, 303);
  assert.equal(location, "/");
  assert.equal(res.headers.get("Set-Cookie"), null);
});

test("closedChangeFrom reads the cookie and ignores anything that is not a change id", () => {
  const request = (cookie: string) => new Request("http://localhost/", { headers: { Cookie: cookie } });
  assert.equal(CORNER_COOKIE, "pipeline_corner");
  assert.equal(closedChangeFrom(request("a=b; pipeline_corner=chg_abc123; c=d")), "chg_abc123");
  assert.equal(closedChangeFrom(request("pipeline_corner=nope")), null);
  assert.equal(closedChangeFrom(request("other=chg_abc123")), null);
  assert.equal(closedChangeFrom(new Request("http://localhost/")), null);
});
