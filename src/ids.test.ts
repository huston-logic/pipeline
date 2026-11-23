import assert from "node:assert/strict";
import { test } from "node:test";
import { ID_PREFIXES, isChangeId, isContactId, isDealId, isImportId, isPushId, isTaskId, newId } from "./ids.ts";

test("ids are <prefix>_ plus 12 lowercase base32 characters", () => {
  for (const prefix of ID_PREFIXES) {
    assert.match(newId(prefix), new RegExp(`^${prefix}_[a-z2-7]{12}$`));
  }
});

test("the prefixes are the ones the plan lists", () => {
  assert.deepEqual([...ID_PREFIXES], ["ct", "dl", "ac", "tk", "ru", "rf", "fd", "br", "chg", "ps", "im"]);
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

test("isContactId accepts newId's contact ids and the dev seed's ct_seed01 style, nothing else", () => {
  for (let i = 0; i < 50; i++) assert.ok(isContactId(newId("ct")));
  assert.ok(isContactId("ct_seed01"));
  const bad = ["dl_seed01", newId("dl"), "ct_", "ct", "CT_SEED01", "ct_Seed01", "ct_a-b", "ct_a.b", "ct_a%2Fb", "ct_a/b"];
  for (const id of [...bad, ` ${newId("ct")}`, `ct_${"a".repeat(33)}`]) assert.equal(isContactId(id), false, id);
});

test("isChangeId accepts newId's change ids and the demo seed's chg_seed00000013 style, nothing else", () => {
  for (let i = 0; i < 50; i++) assert.ok(isChangeId(newId("chg")));
  assert.ok(isChangeId("chg_seed00000013"));
  const bad = ["dl_seed01", "chg_", "chg", "CHG_ABC", "chg_a-b", "chg_a%2Fb", "chg_a/b", "<script>"];
  for (const id of [...bad, ` ${newId("chg")}`, `chg_${"a".repeat(33)}`]) assert.equal(isChangeId(id), false, id);
});

test("isTaskId accepts newId's task ids and the seed's tk_seed01 style, nothing else", () => {
  for (let i = 0; i < 50; i++) assert.ok(isTaskId(newId("tk")));
  assert.ok(isTaskId("tk_seed01"));
  const bad = ["dl_seed01", "tk_", "tk", "TK_SEED01", "tk_a-b", "tk_a%2Fb", "tk_a/b", "<script>"];
  for (const id of [...bad, ` ${newId("tk")}`, `tk_${"a".repeat(33)}`]) assert.equal(isTaskId(id), false, id);
});

test("isPushId accepts newId's push subscription ids, nothing else", () => {
  for (let i = 0; i < 50; i++) assert.ok(isPushId(newId("ps")));
  const bad = ["tk_seed01", "ps_", "ps", "PS_ABC", "ps_a-b", "ps_a%2Fb", "ps_a/b", "<script>"];
  for (const id of [...bad, ` ${newId("ps")}`, `ps_${"a".repeat(33)}`]) assert.equal(isPushId(id), false, id);
});

test("isImportId accepts newId's import draft ids and the seed's im_seed01 style, nothing else", () => {
  for (let i = 0; i < 50; i++) assert.ok(isImportId(newId("im")));
  assert.ok(isImportId("im_seed01"));
  const bad = ["ct_seed01", "im_", "im", "IM_SEED01", "im_a-b", "im_a%2Fb", "im_a/b", "<script>"];
  for (const id of [...bad, ` ${newId("im")}`, `im_${"a".repeat(33)}`]) assert.equal(isImportId(id), false, id);
});
