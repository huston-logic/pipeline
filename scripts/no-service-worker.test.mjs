// One service worker, for the brief notification only (decision 0030, which replaces 0019's "no service worker" for
// push): public/sw.js, registered only by public/push.js. It caches nothing, has no fetch handler and loads no other
// script, so no private data is ever kept on the phone and every page still comes from the Worker.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REGISTER = /serviceWorker\s*\.\s*register|["'`]serviceWorker["'`]\s*\]/;
/** What would make a service worker more than a notifier: a fetch handler, a cache, or more code loaded into it. */
const SW_FORBIDDEN = /addEventListener\(\s*["'`]fetch["'`]|\bonfetch\b|\bcaches\b|\bimportScripts\b|\bfetch\(|\beval\(|new Function|https?:\/\//;
const ALLOWED_REGISTRATIONS = ["public/push.js"];

/** Text files under `dir` (recursively) whose contents register a service worker, relative to `base`. */
function registrations(dir, base = dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.endsWith(".png"))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => REGISTER.test(readFileSync(file, "utf8")))
    .map((file) => relative(base, file));
}

test("the check finds a service worker registration when there is one", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-sw-"));
  try {
    writeFileSync(join(dir, "app.js"), "navigator.serviceWorker.register('/sw.js');\n");
    writeFileSync(join(dir, "other.js"), "navigator['serviceWorker'].register('/sw.js');\n");
    writeFileSync(join(dir, "fine.js"), "console.log('no worker here');\n");
    assert.deepEqual(registrations(dir).toSorted(), ["app.js", "other.js"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only public/push.js registers a service worker, and only /sw.js", () => {
  const found = [...registrations(join(ROOT, "public"), ROOT), ...registrations(join(ROOT, "src"), ROOT)];
  assert.deepEqual(found, ALLOWED_REGISTRATIONS);
  const push = readFileSync(join(ROOT, "public/push.js"), "utf8");
  assert.deepEqual(push.match(/serviceWorker\.register\([^)]*\)/g), ['serviceWorker.register("/sw.js")']);
});

test("the forbidden-code check catches a fetch handler, a cache and importScripts", () => {
  for (const bad of [
    'self.addEventListener("fetch", (e) => e.respondWith(fetch(e.request)));',
    "self.onfetch = () => {};",
    'caches.open("board");',
    'importScripts("/more.js");',
  ]) {
    assert.match(bad, SW_FORBIDDEN, bad);
  }
});

test("public/sw.js only shows the fixed notification and opens /brief: no fetch handler, cache or importScripts", () => {
  const sw = readFileSync(join(ROOT, "public/sw.js"), "utf8");
  assert.doesNotMatch(sw, SW_FORBIDDEN);
  const listeners = [...sw.matchAll(/addEventListener\(\s*["'`]([a-z]+)["'`]/g)].map((m) => m[1]);
  assert.deepEqual(listeners, ["push", "notificationclick"]);
  assert.match(sw, /showNotification\("Your daily brief is ready", \{\s*body: "Open the Brief tab\.",\s*icon: "\/icons\/icon-192\.png",\s*tag: "brief",\s*\}\)/);
  assert.match(sw, /openWindow\("\/brief"\)/);
  assert.match(sw, /navigate\("\/brief"\)/);
});

test("sw.js and push.js stay small and plain: under 3 KB gzipped, no innerHTML, fetch or eval", () => {
  for (const name of ["sw.js", "push.js"]) {
    const script = readFileSync(join(ROOT, "public", name), "utf8");
    assert.ok(gzipSync(script).length < 3 * 1024, `${name}: ${gzipSync(script).length} bytes gzipped`);
    assert.doesNotMatch(script, /\beval\(|new Function|innerHTML|outerHTML|insertAdjacentHTML|document\.write|\bfetch\(|XMLHttpRequest|import\(|https?:\/\//, name);
  }
});

test("push.js asks for permission on the tap, subscribes with userVisibleOnly and sends the form as a page load", () => {
  const push = readFileSync(join(ROOT, "public/push.js"), "utf8");
  assert.match(push, /addEventListener\("submit"/);
  assert.match(push, /Notification\.requestPermission\(\)/);
  assert.match(push, /const options = \{ userVisibleOnly: true, applicationServerKey: /);
  assert.deepEqual(push.match(/pushManager\.subscribe\([^)]*\)/g), ["pushManager.subscribe(options)", "pushManager.subscribe(options)"]);
  assert.match(push, /form\.submit\(\)/);
  assert.doesNotMatch(push, /\balert\(|\bconfirm\(|\bprompt\(/);
  // Permission is asked before anything else is awaited, so the phone still counts it as part of the tap.
  assert.ok(push.indexOf("requestPermission") < push.indexOf("serviceWorker.register"));
});
