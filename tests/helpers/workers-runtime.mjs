// Preloaded by `npm run test:unit` (`node --import`). @cloudflare/workers-oauth-provider imports `cloudflare:workers`,
// a module only the Workers runtime has; the library uses it only to tell a WorkerEntrypoint class from a handler
// object, so the unit tests resolve it to a stub with an empty class. It also reads the `Cloudflare` global for the
// compatibility flags, which mirror wrangler.jsonc here. Nothing else about the runtime is faked.
import { registerHooks } from "node:module";

const STUB = new URL("./cloudflare-workers-stub.mjs", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

globalThis.Cloudflare ??= { compatibilityFlags: { nodejs_compat: true, global_fetch_strictly_public: true } };
