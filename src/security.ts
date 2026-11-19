// One policy for every response. The board ships no JavaScript, so scripts are refused outright. public/_headers
// repeats these values for static files; scripts/build.test.mjs fails if the two drift apart.

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'none'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy":
    "accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export interface SecurityOptions {
  /**
   * Origins a form on this page may submit to besides 'self'. Browsers also apply form-action to the redirects that
   * follow a form post, so the /mcp consent page names where its Allow and Deny redirects go (decision 0006).
   */
  formAction?: readonly string[];
}

// Responses that already carry the headers, so wrapping them again (the router wraps every answer) keeps their policy.
const secured = new WeakSet<Response>();

/** Copies the response (asset responses have immutable headers) and sets every security header on it. */
export function withSecurityHeaders(response: Response, options: SecurityOptions = {}): Response {
  if (secured.has(response)) return response;
  const copy = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) copy.headers.set(name, value);
  const extra = (options.formAction ?? []).filter((origin) => /^https?:\/\/[A-Za-z0-9.:[\]-]+$/.test(origin));
  if (extra.length > 0) {
    copy.headers.set(
      "Content-Security-Policy",
      CONTENT_SECURITY_POLICY.replace("form-action 'self'", `form-action 'self' ${[...new Set(extra)].join(" ")}`),
    );
  }
  secured.add(copy);
  return copy;
}
