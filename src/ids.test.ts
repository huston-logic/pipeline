import assert from "node:assert/strict";
import { test } from "node:test";
import { ID_PREFIXES, isDealId, newId } from "./ids.ts";

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

test("isDealId accepts newId's deal ids and the dev seed's dl_seed01 style, nothing else", () => {
  for (let i = 0; i < 50; i++) assert.ok(isDealId(newId("dl")));
  assert.ok(isDealId("dl_seed01"));
  const bad = ["ct_seed01", newId("ct"), "dl_", "dl", "DL_SEED01", "dl_Seed01", "dl_a-b", "dl_a.b", "dl_a%2Fb", "dl_a/b"];
  for (const id of [...bad, ` ${newId("dl")}`, `dl_${"a".repeat(33)}`]) assert.equal(isDealId(id), false, id);
});
