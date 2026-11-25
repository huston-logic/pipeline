// Lighthouse CI config (run with `npm run test:lighthouse`, after `npm run build`). LHCI reads .cjs, not .mjs or .ts.
// It audits the board as the Worker draws it: `npm run preview` runs `wrangler dev --local` on port 4822, so the
// Worker's own security headers (src/security.ts) apply.

// LHCI config files must be CommonJS. Node >= 22.19 loads the TypeScript route list natively (require of an ES
// module); keep src/board/routes.ts free of imports so this keeps working.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { lighthouseRoutes } = require("./src/board/routes.ts");

const origin = "http://localhost:4822";

module.exports = {
  ci: {
    collect: {
      // One of each kind of board page, at most 22 (src/board/routes.ts); the a11y test covers every page. The 404 page
      // is left out: it returns an error status, which Lighthouse scores as a failed page.
      url: lighthouseRoutes.map((route) => origin + route),
      // 3 runs: the median still ignores one bad run. Accessibility, SEO and best practices score the same every run;
      // only performance varies.
      numberOfRuns: 3,
      startServerCommand: "npm run preview",
      // wrangler dev prints "Ready on http://localhost:4822" once the Worker answers.
      startServerReadyPattern: "Ready on",
      startServerReadyTimeout: 60000,
      settings: {
        // Default preset is mobile. --no-sandbox: Chrome's sandbox can fail on CI runners (see the LHCI troubleshooting
        // guide); the runner is an ephemeral VM that only loads this site from localhost.
        chromeFlags: "--no-sandbox",
      },
    },
    assert: {
      // median of the 3 runs; LHCI's default ("optimistic") would pass if any single run passed.
      assertions: {
        "categories:accessibility": ["error", { minScore: 0.95, aggregationMethod: "median" }],
        "categories:best-practices": ["error", { minScore: 0.9, aggregationMethod: "median" }],
        "categories:seo": ["error", { minScore: 0.95, aggregationMethod: "median" }],
        "categories:performance": ["error", { minScore: 0.9, aggregationMethod: "median" }],
      },
    },
    upload: {
      target: "filesystem",
      outputDir: ".lighthouseci",
    },
  },
};
