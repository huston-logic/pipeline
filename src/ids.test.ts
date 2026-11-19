import assert from "node:assert/strict";
import { test } from "node:test";
import { ID_PREFIXES, newId } from "./ids.ts";

test("ids are <prefix>_ plus 12 lowercase base32 characters", () => {
  for (const prefix of ID_PREFIXES) {
    assert.match(newId(prefix), new RegExp(`^${prefix}_[a-z2-7]{12}$`));
  }
});

test("the prefixes are the ones the plan lists", () => {
  assert.deepEqual([...ID_PREFIXES], ["ct", "dl", "ac", "tk", "ru", "rf", "fd", "br", "chg"]);
});

test("ids do not repeat", () => {
  const ids = new Set(Array.from({ length: 5000 }, () => newId("ct")));
  assert.equal(ids.size, 5000);
});

test("every base32 character turns up", () => {
  const seen = new Set(Array.from({ length: 400 }, () => newId("dl").slice(3)).join(""));
  assert.equal(seen.size, 32);
});
