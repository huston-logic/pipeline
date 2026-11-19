# Setting up sign-in with Cloudflare Access

This is for the owner of one copy of the pipeline, in their own Cloudflare account. It sets up the sign-in described
in decision 0006: Cloudflare Access sends you a one-time code by email, the board only opens for your email, and your
AI app connects to `/mcp` once through a sign-in page and then keeps its own token.

You set up two Access applications, a few bypass rules, five secrets, four settings and one KV namespace. Until they
exist, the board, `/api` and `/mcp` answer "Sign-in isn't set up yet." That is on purpose: nothing opens without them.

Steps marked **check in the dashboard** could not be confirmed from Cloudflare's docs when this was written
(2026-11-18). The dashboard may name or place them a little differently; the goal of the step is what matters.

Cloudflare Access and KV are on the free plans: Zero Trust Free covers up to 50 users, and a copy needs one or two.

Throughout, `<copy host>` is the address your copy answers on, for example `pipeline.example.com` (a custom domain) or
`pipeline-yourname.yourname.workers.dev`.

## Before you start

- Your Cloudflare account has Zero Trust turned on (the Zero Trust item in the dashboard's sidebar). The first time,
  Cloudflare asks you to pick a team name and the Free plan.
- You know `<copy host>`. A custom domain is recommended (see "workers.dev or a custom domain" at the end).
- You know the email address(es) that should be able to sign in (yours, and anyone you share the pipeline with).

## 1. The Access for SaaS application for `/mcp`

This is the sign-in your AI app sends you to when it connects.

1. In the Cloudflare dashboard, open **Zero Trust**, then **Access controls**, then **Applications**.
2. Select **Create new application**, then **SaaS application**.
3. Give it a name, for example `Pipeline MCP`.
4. Select the textbox below the name, choose **OIDC**, then select **Add application**.
5. Under **Redirect URLs**, enter `https://<copy host>/callback` (exactly: https, your host, `/callback`).
6. Copy these five values somewhere safe for a few minutes (a password manager, never a chat or a document). Each goes
   into one secret in step 6 below:

   | In the dashboard | Secret |
   |---|---|
   | Client ID | `ACCESS_CLIENT_ID` |
   | Client secret | `ACCESS_CLIENT_SECRET` |
   | Token endpoint | `ACCESS_TOKEN_URL` |
   | Authorization endpoint | `ACCESS_AUTHORIZATION_URL` |
   | Key endpoint | `ACCESS_JWKS_URL` |

   The three endpoints look like `https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client id>/token`,
   `.../authorization` and `.../jwks`.
7. **Refresh tokens** (under Advanced settings) can stay off: the pipeline issues its own tokens to your AI app.
8. **PKCE**: the pipeline sends a PKCE code challenge with every sign-in, as well as the client secret. If the
   application has a PKCE setting, leave it at its default or turn it on. **Check in the dashboard.**
9. Under **Policies**, add a policy: Action **Allow**, a rule **Include** > **Emails** with your owner email(s).
10. Under identity providers, choose **One-time PIN**. With one identity provider, turn on **Apply instant
    authentication** (Cloudflare recommends it).
11. Select **Create** (or **Save**).

## 2. The self-hosted application for the board

This puts the board and its JSON (`/api/...`) behind the one-time code.

1. In **Zero Trust** > **Access controls** > **Applications**, select **Create new application**, then
   **Self-hosted**. **Check in the dashboard:** the type may be called "Self-hosted" or "Self-hosted and private".
2. Name it, for example `Pipeline board`.
3. Add `<copy host>` as the application's domain (public hostname), with the path left empty so it covers the whole
   host.
4. Add a policy: Action **Allow**, **Include** > **Emails** with the same owner email(s).
5. Under identity providers, choose **One-time PIN** (and **Apply instant authentication** if offered).
6. Save the application.

The Worker checks Access's sign-in token itself as well, against the application's AUD tag (step 4 below) and your
owner emails, so the board stays closed even if a request reaches the Worker some other way.

## 3. Let the sign-in paths and `/intake` through (Bypass)

Access must not stand in front of the paths your AI app and your website talk to directly. The pipeline protects
them itself: `/intake` with its secret, `/mcp` with OAuth tokens, and the sign-in paths are the steps that issue them.

The paths:

| Path | Who calls it |
|---|---|
| `intake` | Your website's form handler (with the intake secret) |
| `mcp` | Your AI app (with its token) |
| `authorize` | Your browser, when your AI app connects (the "Allow this app?" page) |
| `callback` | Your browser, coming back from the Access sign-in |
| `token` | Your AI app, to get and renew its token |
| `register` | Your AI app, the first time it connects |
| `.well-known` | Your AI app, to find the sign-in addresses (`/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource/mcp`) |

For each path, create one more self-hosted application:

1. **Create new application** > **Self-hosted**.
2. Name it after the path, for example `Pipeline bypass: intake`.
3. Add `<copy host>` as the domain, and the path in the **Path** box next to it (`intake`, `mcp`, `authorize`,
   `callback`, `token`, `register` or `.well-known`).
4. Add a policy: Action **Bypass**, **Include** > **Everyone**.
5. Save.

Access uses the application with the most specific match, so these paths skip the board's sign-in while the rest of the
host keeps it. **Check in the dashboard:**

- whether one application can hold several hostname-and-path entries. If it can, one application named
  `Pipeline bypass` with all seven paths and the same Bypass policy does the same job as seven applications;
- that a path entry also covers what is below it (`.well-known` must cover `.well-known/oauth-protected-resource/mcp`);
- that a path is entered without the leading `/` (the dashboard shows the `/` between host and path).

## 4. Find the team domain and the AUD tag

- **Team domain:** `<team>.cloudflareaccess.com`. It is the start of the three endpoints you copied in step 1. It is
  also shown in **Zero Trust** > **Settings** (team name and domain). **Check in the dashboard** for the exact place.
- **AUD tag:** open the board application from step 2 (not the bypass ones, not the SaaS one). Its overview or basic
  information shows **Application Audience (AUD) Tag**, a long string of letters and digits. **Check in the
  dashboard** for the exact place.

## 5. The KV namespace

The pipeline keeps the OAuth state (registered AI apps, hashed tokens, the 10-minute sign-in state) in a KV namespace
bound as `OAUTH_KV`. Create one (Workers & Pages > KV > Create, or `npx wrangler kv namespace create OAUTH_KV`) and
put its id in your copy's own config (the copy's `kv_namespaces`, which provisioning writes, task 11). For preview
deployments, create a second one for `previews.kv_namespaces`.

## 6. Settings and secrets

**Settings** (plain variables, in your copy's own config `vars`; provisioning writes them, task 11):

| Name | Value |
|---|---|
| `ACCESS_TEAM_DOMAIN` | The team domain from step 4, for example `example-team.cloudflareaccess.com` |
| `ACCESS_AUD` | The AUD tag from step 4 |
| `OWNER_EMAILS` | Your owner email(s), comma-separated, for example `owner@example.com` |
| `MCP_ALLOWED_HOSTNAMES` | On a custom domain: `<copy host>`. On workers.dev: leave it out |

**Secrets** (each one: run the command, then paste the value when it asks; nobody else ever sees them):

```bash
npx wrangler secret put ACCESS_CLIENT_ID
npx wrangler secret put ACCESS_CLIENT_SECRET
npx wrangler secret put ACCESS_TOKEN_URL
npx wrangler secret put ACCESS_AUTHORIZATION_URL
npx wrangler secret put ACCESS_JWKS_URL
```

For preview deployments, set the same five with `npx wrangler preview base-config secret put <NAME>` if you want to
sign in on previews too.

Owner emails can also live in the database (`settings.owner_emails`, set at provisioning); either list lets an email
in. They are never changeable through the AI app (decision 0005).

## 7. Check it

1. Open `https://<copy host>/` in a browser. Access asks for your email and sends a code; after it, the board opens.
   Another email gets "This account isn't allowed to open this board."
2. `https://<copy host>/.well-known/oauth-authorization-server` shows a short JSON document without asking you to sign
   in (the bypass works).
3. In your AI app, add a custom connector (remote MCP server) with the address `https://<copy host>/mcp`. The app
   opens a page "Allow <app name> to use your pipeline?". Check that it names your AI app and the place the access goes,
   then select **Allow**. Access asks for your email and code, and you're sent back to the app, connected.
4. If your website's form posts to `/intake`, send a test enquiry: it should arrive as a new lead.

## workers.dev or a custom domain

- **Custom domain (recommended).** Every step above works as written. Set `MCP_ALLOWED_HOSTNAMES` to the custom
  hostname: `/mcp` and its sign-in then answer only there (anywhere else they say "/mcp isn't set up for this
  hostname"). If the copy is also reachable on its workers.dev address, the board there stays closed (the Worker
  refuses requests without a valid Access token for your board application), but you can also turn the workers.dev
  route off in the Worker's settings.
- **workers.dev only.** Leave `MCP_ALLOWED_HOSTNAMES` out; `/mcp` then answers on `*.workers.dev` addresses (preview
  URLs included). Access applications are normally created for a domain in your account. For workers.dev, the
  Worker's settings have a switch that puts Cloudflare Access in front of the workers.dev and preview addresses
  (Workers & Pages > your Worker > Settings > Domains & Routes). **Check in the dashboard:** whether that switch's
  application accepts the bypass paths of step 3, and which AUD tag it uses for step 4. If it doesn't accept bypass
  paths, use a custom domain.
