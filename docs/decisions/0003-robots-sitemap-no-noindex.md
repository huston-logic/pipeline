# 0003: robots.txt allows crawling, no noindex, and an empty sitemap

## Context

The board is private, so hiding it from search engines looks natural: `noindex` meta tags, an `X-Robots-Tag` header or
`Disallow: /`. But the required `lighthouse` check asserts an SEO score of at least 0.95 (thresholds must not be
lowered), and Lighthouse's `is-crawlable` audit fails on any of those. The required `check` job also fails unless
`out/sitemap.xml` and `out/robots.txt` exist and are non-empty.

## Decision

- `public/robots.txt` allows crawling (`User-agent: *`, `Allow: /`).
- No page has a `noindex` meta tag and no response sends `X-Robots-Tag`.
- `out/sitemap.xml` is a valid, empty `<urlset>`.

## Why

In production the whole board and `/api` sit behind a Cloudflare Access self-hosted application, so a crawler gets the
Access login page and never sees board content. Access is the gate, not robots rules; `noindex` would add no privacy
and would fail a required check. An empty sitemap lists no URLs, so it reveals nothing.

## Consequences

- If a copy is ever deployed without Access in front of the board, nothing stops indexing. The install docs (task 11)
  and Access setup docs (task 10) must make Access a required step before the board shows data.
- `/intake` bypasses Access but returns no HTML, so it has nothing to index.
