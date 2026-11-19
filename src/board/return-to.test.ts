import assert from "node:assert/strict";
import { test } from "node:test";
import { boardReturnPath, withChange } from "./return-to.ts";

test("a board page path is kept, with its query and without a fragment", () => {
  assert.equal(boardReturnPath("/pipeline"), "/pipeline");
  assert.equal(boardReturnPath("/pipeline?view=list"), "/pipeline?view=list");
  assert.equal(boardReturnPath("/contacts?q=pat&sort=name-desc"), "/contacts?q=pat&sort=name-desc");
  assert.equal(boardReturnPath("/deals/dl_seed01#timeline"), "/deals/dl_seed01");
  assert.equal(boardReturnPath("/"), "/");
});

test("anything that is not a same-origin path to a board page is refused", () => {
  for (const bad of [
    null,
    "",
    "pipeline",
    "//evil.example",
    "//evil.example/pipeline",
    "https://evil.example/",
    "http://localhost:4821/pipeline",
    "/\\evil.example",
    "\\\\evil.example",
    "/%2F%2Fevil.example",
    "/%2f%2fevil.example",
    "/%70ipeline",
    "/%5Cevil.example",
    "/deals/%2e%2e/pipeline",
    "/deals/../pipeline",
    "/pipeline ",
    "/pipéline",
    "/./pipeline",
    "/nope",
    "/deals/not-a-deal",
    "/pipeline\n",
    "/pipeline\u0000",
    "/pipe\tline",
    "/api/pipeline",
    "/board.css",
    "/theme.css",
    "/mcp",
    `/contacts?q=${"x".repeat(3000)}`,
  ]) {
    assert.equal(boardReturnPath(bad), null, JSON.stringify(bad));
  }
});

test("a return path may be 2,000 characters long, not one more", () => {
  const at = (length: number) => `/contacts?q=${"x".repeat(length - "/contacts?q=".length)}`;
  assert.equal(boardReturnPath(at(2000)), at(2000));
  assert.equal(boardReturnPath(at(2001)), null);
});

test("withChange adds the change id, replacing one already there", () => {
  assert.equal(withChange("/pipeline", "chg_abc"), "/pipeline?change=chg_abc");
  assert.equal(withChange("/pipeline?view=list", "chg_abc"), "/pipeline?view=list&change=chg_abc");
  assert.equal(withChange("/pipeline?change=chg_old&view=list", "chg_new"), "/pipeline?view=list&change=chg_new");
});
