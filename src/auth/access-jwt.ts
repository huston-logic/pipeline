// The Cf-Access-Jwt-Assertion token Cloudflare Access adds to every request it lets through to the board and /api.
// The Worker checks it itself, so a request that reaches the Worker another way (say, the workers.dev host while
// Access only covers the custom domain) is still refused.
import { emailClaim, type JwksFetcher, JwtError, verifyRs256Jwt } from "./jwt.ts";

export { JwtError };

const TEAM_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/;

/** `https://<team>.cloudflareaccess.com` for "<team>.cloudflareaccess.com" (an https:// prefix or trailing / is fine). */
export function accessIssuer(teamDomain: string): string | null {
  const host = teamDomain.trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/$/, "");
  return TEAM_HOST.test(host) ? `https://${host}` : null;
}

export function accessCertsUrl(teamDomain: string): string {
  const issuer = accessIssuer(teamDomain);
  if (!issuer) throw new TypeError("ACCESS_TEAM_DOMAIN must look like <team>.cloudflareaccess.com.");
  return `${issuer}/cdn-cgi/access/certs`;
}

export interface AccessJwtOptions {
  /** ACCESS_TEAM_DOMAIN, for example "example-team.cloudflareaccess.com". */
  teamDomain: string;
  /** ACCESS_AUD: the Application Audience (AUD) tag of the board's Access application. */
  aud: string;
  fetchJwks?: JwksFetcher;
  now?: () => number;
}

/** Throws JwtError for a bad token, TypeError for bad settings, and anything else when the keys can't be fetched. */
export async function verifyAccessJwt(token: string, options: AccessJwtOptions): Promise<{ email: string }> {
  const issuer = accessIssuer(options.teamDomain);
  if (!issuer) throw new TypeError("ACCESS_TEAM_DOMAIN must look like <team>.cloudflareaccess.com.");
  if (options.aud.trim() === "") throw new TypeError("ACCESS_AUD is empty.");
  const claims = await verifyRs256Jwt(token, {
    jwksUrl: `${issuer}/cdn-cgi/access/certs`,
    issuers: [issuer],
    audience: options.aud.trim(),
    ...(options.fetchJwks ? { fetchJwks: options.fetchJwks } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return { email: emailClaim(claims) };
}

/** The Access token from the Cf-Access-Jwt-Assertion header, or else the CF_Authorization cookie. */
export function accessToken(request: Request): string | null {
  const header = request.headers.get("Cf-Access-Jwt-Assertion")?.trim();
  if (header) return header;
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator !== -1 && part.slice(0, separator).trim() === "CF_Authorization") {
      const value = part.slice(separator + 1).trim();
      if (value) return value;
    }
  }
  return null;
}
