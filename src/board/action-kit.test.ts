import assert from "node:assert/strict";
import { test } from "node:test";
import { type ActionContext, AT_PATTERN, redirectBack } from "./action-kit.ts";

const ctxWith = (fields: Record<string, string>): ActionContext => ({ form: new URLSearchParams(fields) }) as ActionContext;

test("AT_PATTERN takes a plain lowercase anchor and nothing else", () => {
  for (const good of ["task-tk_seed01", "a", "row_2"]) assert.match(good, AT_PATTERN, good);
  for (const bad of ["", "Task", "1abc", "a b", "a#b", "a/b", "x".repeat(82), "-a"]) assert.doesNotMatch(bad, AT_PATTERN, bad);
});

test("redirectBack appends #at when the form carries a valid at", () => {
  const result = redirectBack(ctxWith({ at: "task-tk_seed01" }), "/?change=chg_abc123");
  assert.deepEqual(result, { kind: "redirect", location: "/?change=chg_abc123#task-tk_seed01" });
});

test("redirectBack ignores a missing or invalid at", () => {
  assert.deepEqual(redirectBack(ctxWith({}), "/pipeline"), { kind: "redirect", location: "/pipeline" });
  assert.deepEqual(redirectBack(ctxWith({ at: "x y" }), "/pipeline"), { kind: "redirect", location: "/pipeline" });
  assert.deepEqual(redirectBack(ctxWith({ at: "//evil.example" }), "/pipeline"), { kind: "redirect", location: "/pipeline" });
});
