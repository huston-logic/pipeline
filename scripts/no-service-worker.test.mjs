// The board installs to a home screen without a service worker, so no private data is ever cached on the phone
// (decision 0019). This test fails if anything in public/ or src/ registers one.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REGISTER = /serviceWorker\s*\.\s*register|["'`]serviceWorker["'`]\s*\]/;

/** Text files under `dir` (recursively) whose contents register a service worker. */
function registrations(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.endsWith(".png"))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => REGISTER.test(readFileSync(file, "utf8")));
}

test("the check finds a service worker registration when there is one", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-sw-"));
  try {
    writeFileSync(join(dir, "app.js"), "navigator.serviceWorker.register('/sw.js');\n");
    writeFileSync(join(dir, "other.js"), "navigator['serviceWorker'].register('/sw.js');\n");
    writeFileSync(join(dir, "fine.js"), "console.log('no worker here');\n");
    assert.deepEqual(registrations(dir).toSorted(), [join(dir, "app.js"), join(dir, "other.js")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nothing in public/ or src/ registers a service worker", () => {
  for (const dir of ["public", "src"]) assert.deepEqual(registrations(join(ROOT, dir)), [], dir);
});
