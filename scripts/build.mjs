// `npm run build`: writes the static files the Worker serves through its ASSETS binding into out/.
// The board itself is drawn by the Worker (decision 0001); out/ holds public/ plus the files CI and Cloudflare expect.
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { notFoundPage } from "../src/board/pages/not-found.ts";
import { offlinePage } from "../src/board/pages/offline.ts";

// Empty on purpose: the board sits behind Cloudflare Access and has no public pages (decision 0003).
const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>
`;

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export function build({ outDir = join(ROOT, "out"), publicDir = join(ROOT, "public") } = {}) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(publicDir, outDir, { recursive: true });
  writeFileSync(join(outDir, "index.html"), offlinePage());
  writeFileSync(join(outDir, "404.html"), notFoundPage());
  writeFileSync(join(outDir, "sitemap.xml"), SITEMAP);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  build();
  console.log("Built out/ (static files for the Worker's ASSETS binding).");
}
