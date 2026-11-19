// The Worker's bindings, vars and secrets. Later tasks add D1, rate limits, OAuth KV and secrets here.

/** The part of the static-assets binding the Worker uses, so tests can pass a plain object. */
export type AssetFetcher = { fetch(request: Request): Promise<Response> };

export type Env = {
  ASSETS: AssetFetcher;
  /** "production" from wrangler.jsonc; `npm run dev` and `npm run preview` set "development". */
  ENVIRONMENT: string;
  /** "dev" only in local development (scripts/dev.mjs). */
  AUTH_MODE?: string;
};
