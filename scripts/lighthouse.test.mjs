import assert from "node:assert/strict";
import { test } from "node:test";
import { RETRIES, unfinished } from "./lighthouse.mjs";

const A = "http://localhost:4822/";
const B = "http://localhost:4822/pipeline";
const C = "http://localhost:4822/import/im_seed01";

test("a crash leaves the page it hit and every page after it to collect again; finished pages stay", () => {
  const saved = [
    { base: "lhr-1", url: A },
    { base: "lhr-2", url: A },
    { base: "lhr-3", url: A },
    { base: "lhr-4", url: B },
  ];
  assert.deepEqual(unfinished([A, B, C], saved, 3), { urls: [B, C], stale: ["lhr-4"] });
});

test("nothing to collect again when every page has all its runs", () => {
  const saved = [A, A, B, B].map((url, i) => ({ base: `lhr-${i}`, url }));
  assert.deepEqual(unfinished([A, B], saved, 2), { urls: [], stale: [] });
});

test("at most two retries, so a page that keeps crashing still fails the job", () => {
  assert.equal(RETRIES, 2);
});
