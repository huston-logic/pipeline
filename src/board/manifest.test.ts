import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PAGE_SILVER } from "../services/accent.ts";
import { DEFAULT_THEME_COLOR } from "./layout.ts";
import { manifestJson, webManifest } from "./manifest.ts";

const unset = { business_name: null, accent_color: null };

test("with no settings the manifest says Pipeline in the default green on the page silver", () => {
  assert.deepEqual(webManifest(unset), {
    name: "Pipeline",
    short_name: "Pipeline",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f3f5f4",
    theme_color: "#2b6455",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  });
});

test("the default theme colour is the --green token and the background is the --silver token", () => {
  const css = readFileSync(new URL("../../public/board.css", import.meta.url), "utf8");
  assert.match(css, new RegExp(`--green: ${DEFAULT_THEME_COLOR};`));
  assert.equal(webManifest(unset).background_color, PAGE_SILVER);
});

test("the business name is the app's name; it is the short name too when it has 12 characters or fewer", () => {
  const short = webManifest({ business_name: "Fernwood Co", accent_color: null });
  assert.equal(short.name, "Fernwood Co");
  assert.equal(short.short_name, "Fernwood Co");
  const twelve = webManifest({ business_name: "Abcdefghijkl", accent_color: null });
  assert.equal(twelve.short_name, "Abcdefghijkl");
  const long = webManifest({ business_name: "Fernwood Engineering", accent_color: null });
  assert.equal(long.name, "Fernwood Engineering");
  assert.equal(long.short_name, "Pipeline");
});

test("a usable accent is the theme colour; a stored value that fails the checks falls back to the default", () => {
  assert.equal(webManifest({ business_name: null, accent_color: "#1e4a3d" }).theme_color, "#1e4a3d");
  for (const bad of ["#d0e8dc", "#1E4A3D", "red", '#1e4a3d","x":"']) {
    assert.equal(webManifest({ business_name: null, accent_color: bad }).theme_color, DEFAULT_THEME_COLOR, bad);
  }
});

test("manifestJson is JSON.stringify of the manifest, so any name comes back exactly as stored", () => {
  const name = `Quote "co" </script> \\   & <b>`;
  const text = manifestJson({ business_name: name, accent_color: null });
  assert.equal(text, JSON.stringify(webManifest({ business_name: name, accent_color: null })));
  assert.equal((JSON.parse(text) as { name: string }).name, name);
});
