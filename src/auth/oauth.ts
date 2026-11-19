// The /mcp sign-in pages that workers-oauth-provider leaves to the application (decision 0006): /authorize asks the
// owner whether the AI app may connect, then sends them to Cloudflare Access for SaaS (OIDC); /callback checks
// Access's answer and the owner email, then finishes the authorization so the library can issue the app its token.
// Nothing here logs a token, a code, an email or the props: only fixed event names and status codes.
import {
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { html, type Html } from "../board/html.ts";
import { renderPage } from "../board/layout.ts";
import type { Env } from "../env.ts";
import { withSecurityHeaders } from "../security.ts";
import { SIGN_IN_NOT_SET_UP } from "./access.ts";
import { emailClaim, type JwksFetcher, JwtError, verifyRs256Jwt } from "./jwt.ts";
import { AUTHORIZE_PATH, CALLBACK_PATH } from "./oauth-routes.ts";
import { isOwnerEmail } from "./owners.ts";

const MAX_FORM_BYTES = 4096;
const ACCESS_SCOPE = "openid email profile";

export interface AccessOidcConfig {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  authorizationUrl: string;
  jwksUrl: string;
}

export interface OAuthDeps {
  /** env.OAUTH_PROVIDER, which the library hands its default handler. */
  oauth: OAuthHelpers;
  fetch?: typeof fetch;
  fetchJwks?: JwksFetcher;
  now?: () => number;
}

/** What /authorize saves with the sign-in state (encrypted in OAUTH_KV by the library) for /callback. */
interface UpstreamData {
  verifier: string;
  nonce: string;
}

/** The five ACCESS_* secrets of the Access for SaaS application, or null when any is missing or not an https URL. */
export function accessOidcConfig(env: Env): AccessOidcConfig | null {
  const clientId = env.ACCESS_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.ACCESS_CLIENT_SECRET?.trim() ?? "";
  const urls = [env.ACCESS_TOKEN_URL, env.ACCESS_AUTHORIZATION_URL, env.ACCESS_JWKS_URL].map((value) => value?.trim() ?? "");
  if (clientId === "" || clientSecret === "" || !urls.every(isHttpsUrl)) return null;
  const [tokenUrl, authorizationUrl, jwksUrl] = urls as [string, string, string];
  return { clientId, clientSecret, tokenUrl, authorizationUrl, jwksUrl };
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The issuer an Access for SaaS id token may name: the application's OIDC base URL (its token endpoint without
 * "/token", `https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client id>`) or the team domain itself.
 * Both are this team's; the signature (keys from ACCESS_JWKS_URL) and `aud` (the client ID) bind it to this app.
 */
export function accessOidcIssuers(config: AccessOidcConfig): string[] {
  const base = config.tokenUrl.replace(/\/token\/?$/, "");
  return [...new Set([base, new URL(config.tokenUrl).origin])];
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** The grant's user id: a hash, so the email never appears in a KV key or in the token (which starts with it). */
export async function oauthUserId(email: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase())));
  return [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const log = (event: string, extra: Record<string, string | number> = {}) => console.log(JSON.stringify({ event, ...extra }));

function page(status: number, title: string, body: Html, headers: Headers = new Headers(), formAction: string[] = []): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  const document = renderPage({ title, description: "Connecting an AI app to this pipeline.", body });
  return withSecurityHeaders(new Response(document, { status, headers }), { formAction });
}

function messagePage(status: number, title: string, message: string, headers?: Headers): Response {
  return page(status, title, html`<h1>${title}</h1>
<p>${message}</p>`, headers);
}

function redirect(headers: Headers, location: string): Response {
  headers.set("Location", location);
  headers.set("Cache-Control", "no-store");
  return withSecurityHeaders(new Response(null, { status: 302, headers }));
}

const notSetUp = () => messagePage(500, "Sign-in isn't set up", SIGN_IN_NOT_SET_UP);
const startAgain = (headers?: Headers) =>
  messagePage(400, "Start again", "This sign-in link expired or was already used. Start connecting again from your AI app.", headers);

function originOf(url: string): string | null {
  try {
    const { protocol, origin } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? origin : null;
  } catch {
    return null;
  }
}

function consentPage(details: ConsentDescription, handle: string, headers: Headers, formAction: string[]): Response {
  const who = details.clientDomain
    ? html`<p>It is published by <strong>${details.clientDomain}</strong>.</p>`
    : html`<p>The app chose this name itself; it isn't verified.</p>`;
  const local = details.redirectIsLoopback
    ? html`<p><strong>The access goes to an app on this computer.</strong> Continue only if you just started connecting from it.</p>`
    : "";
  return page(
    200,
    "Connect an AI app",
    html`<h1>Allow ${details.clientName} to use your pipeline?</h1>
<p>An app called <strong>${details.clientName}</strong> wants to read and change your pipeline for you: contacts, deals, tasks and rules.</p>
${who}
<p>If you allow it, you sign in with Cloudflare Access next, and the access goes to <strong>${details.redirectHost}</strong>.</p>
${local}
<p>Only continue if you just asked your AI app to connect to this pipeline.</p>
<form method="post" action="${AUTHORIZE_PATH}" class="consent-actions">
<input type="hidden" name="handle" value="${handle}">
<button type="submit" name="decision" value="approve">Allow</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>`,
    headers,
    formAction,
  );
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_FORM_BYTES) return null;
  const text = await request.text();
  return text.length > MAX_FORM_BYTES ? null : new URLSearchParams(text);
}

/** GET shows the consent page for a validated request; POST is the owner's answer to it. */
export async function handleAuthorize(request: Request, env: Env, deps: OAuthDeps): Promise<Response> {
  const config = accessOidcConfig(env);
  if (!config) return notSetUp();
  const { oauth } = deps;
  try {
    if (request.method === "GET" || request.method === "HEAD") {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      // A HEAD shows no page, so it must not start a consent (a cookie and a stored handle per request).
      if (request.method === "HEAD") {
        return withSecurityHeaders(
          new Response(null, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }),
        );
      }
      const consent = await oauth.beginConsent(authRequest);
      const formAction = [originOf(config.authorizationUrl), originOf(details.redirectUri)].filter((o): o is string => o !== null);
      return consentPage(details, consent.handle, consent.headers, formAction);
    }
    if (request.method !== "POST") {
      return withSecurityHeaders(new Response("Send GET or POST.\n", { status: 405, headers: { Allow: "GET, HEAD, POST" } }));
    }
    const form = await readForm(request);
    if (!form) return messagePage(413, "Too large", "That request is too large.");
    const handle = form.get("handle") ?? "";
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      log("oauth_consent_denied");
      return redirect(denied.headers, denied.redirectTo);
    }
    const approved = await oauth.approveConsent(request, handle);
    const data: UpstreamData = { verifier: randomToken(), nonce: randomToken() };
    const { state, headers } = await oauth.beginUpstream(approved.request, { data, headers: approved.headers });
    const target = new URL(config.authorizationUrl);
    target.searchParams.set("response_type", "code");
    target.searchParams.set("client_id", config.clientId);
    target.searchParams.set("redirect_uri", `${new URL(request.url).origin}${CALLBACK_PATH}`);
    target.searchParams.set("scope", ACCESS_SCOPE);
    target.searchParams.set("state", state);
    target.searchParams.set("nonce", data.nonce);
    target.searchParams.set("code_challenge", await pkceChallenge(data.verifier));
    target.searchParams.set("code_challenge_method", "S256");
    return redirect(headers, target.href);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      // Only a request whose client and redirect URI the library validated may be sent back to the client.
      if (error.redirectTo) return redirect(new Headers(), error.redirectTo);
      log("oauth_authorize_refused", { code: error.code });
      return page(400, "This app can't connect", html`<h1>This app can't connect</h1>
<p>${error.description}</p>
<p>Start connecting again from your AI app.</p>`);
    }
    if (error instanceof CimdFetchError) return messagePage(400, "This app can't connect", "This app could not be verified.");
    throw error;
  }
}

async function exchangeCode(config: AccessOidcConfig, code: string, redirectUri: string, verifier: string, fetcher: typeof fetch) {
  const res = await fetcher(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    await res.body?.cancel();
    log("oauth_token_exchange_failed", { status: res.status });
    return null;
  }
  const body: unknown = await res.json().catch(() => null);
  const idToken = typeof body === "object" && body !== null ? (body as { id_token?: unknown }).id_token : undefined;
  if (typeof idToken !== "string") {
    log("oauth_token_exchange_failed", { status: res.status });
    return null;
  }
  return idToken;
}

/** Access sends the owner back here with a code; on success the AI app gets its authorization code. */
export async function handleCallback(request: Request, env: Env, deps: OAuthDeps): Promise<Response> {
  const config = accessOidcConfig(env);
  if (!config) return notSetUp();
  if (request.method !== "GET") {
    return withSecurityHeaders(new Response("Send a GET request.\n", { status: 405, headers: { Allow: "GET" } }));
  }
  let resumed;
  try {
    resumed = await deps.oauth.finishUpstream<UpstreamData>(request);
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    log("oauth_callback_state_refused");
    return startAgain();
  }
  const { request: original, data, headers } = resumed;
  const params = new URL(request.url).searchParams;
  if (params.get("error")) {
    log("oauth_access_declined");
    return redirect(headers, authorizationErrorRedirect(original, "access_denied"));
  }
  const code = params.get("code");
  if (!code) return startAgain(headers);

  const redirectUri = `${new URL(request.url).origin}${CALLBACK_PATH}`;
  const idToken = await exchangeCode(config, code, redirectUri, data.verifier, deps.fetch ?? fetch);
  if (!idToken) {
    return messagePage(502, "Sign-in didn't finish", "Cloudflare Access didn't finish the sign-in. Start connecting again from your AI app.", headers);
  }
  let email: string;
  try {
    const claims = await verifyRs256Jwt(idToken, {
      jwksUrl: config.jwksUrl,
      issuers: accessOidcIssuers(config),
      audience: config.clientId,
      ...(deps.fetchJwks ? { fetchJwks: deps.fetchJwks } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    if (claims.nonce !== data.nonce) throw new JwtError("nonce");
    email = emailClaim(claims);
  } catch (error) {
    if (!(error instanceof JwtError)) {
      log("oauth_keys_unavailable");
      return messagePage(503, "Try again", "Sign-in couldn't be checked just now. Try again in a minute.", headers);
    }
    log("oauth_id_token_invalid", { reason: error.reason });
    return messagePage(401, "Sign-in failed", "The sign-in couldn't be verified. Start connecting again from your AI app.", headers);
  }
  if (!(await isOwnerEmail(env.DB, env, email))) {
    log("oauth_not_owner");
    return messagePage(403, "Not allowed", "This account isn't allowed to use this pipeline. Sign in with an owner's email.", headers);
  }
  const { redirectTo } = await deps.oauth.completeAuthorization({
    request: original,
    userId: await oauthUserId(email),
    metadata: {},
    scope: original.scope,
    props: { email },
  });
  log("oauth_authorized");
  return redirect(headers, redirectTo);
}
