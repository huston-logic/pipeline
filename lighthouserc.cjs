// Lighthouse CI config (run with `npm run test:lighthouse`, after `npm run build`). LHCI reads .cjs, not .mjs or .ts.
// It audits the board as the Worker draws it: `npm run preview` runs `wrangler dev --local` on port 4822, so the
// Worker's own security headers (src/security.ts) apply.

// LHCI config files must be CommonJS. Node >= 22.19 loads the TypeScript route list natively (require of an ES
// module); keep src/board/routes.ts free of imports so this keeps working.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { boardRoutes } = require("./src/board/routes.ts");

const origin = "http://localhost:4822";

module.exports = {
  ci: {
    collect: {
      // Board pages only: the 404 page returns an error status, which Lighthouse scores as a failed page.
      url: boardRoutes.map((route) => origin + route),
      numberOfRuns: 5,
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
      // median of the 5 runs; LHCI's default ("optimistic") would pass if any single run passed.
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
