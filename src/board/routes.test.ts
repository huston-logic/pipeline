import assert from "node:assert/strict";
import { test } from "node:test";
import { boardRoutes, LIGHTHOUSE_MAX_ROUTES, lighthouseRoutes } from "./routes.ts";

test("Lighthouse scores at most 20 pages, each one a board page, none twice", () => {
  assert.ok(
    lighthouseRoutes.length <= LIGHTHOUSE_MAX_ROUTES,
    `lighthouseRoutes has ${lighthouseRoutes.length} pages; keep it at ${LIGHTHOUSE_MAX_ROUTES} or fewer by swapping one out.`,
  );
  assert.equal(LIGHTHOUSE_MAX_ROUTES, 20);
  assert.equal(new Set(lighthouseRoutes).size, lighthouseRoutes.length);
  for (const route of lighthouseRoutes) assert.ok(boardRoutes.includes(route), `${route} is not in boardRoutes`);
});
