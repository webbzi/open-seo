---
status: active
superseded_by:
date: 2026-10-27
branch: feat/selfhost-custom-domain
revisit_on: a second hostname must serve the app, or this fork switches the self-host stage to AUTH_MODE=password (upstream v0.1.19+)
---

## Context

The owner wants the self-hosted deployment at `https://openseo.webbzi.com` instead of `https://open-seo-selfhost.webbzi.workers.dev`. Today the deployment is the Alchemy `selfhost` stage (`pnpm deploy:selfhost`). `.env.selfhost` sets no `AUTH_MODE`, so it runs `cloudflare_access`, and the Access application is provisioned by `deploy/alchemy/alchemy.run.ts` (`emailAccessGate`). Codex reaches MCP at `https://open-seo-selfhost.webbzi.workers.dev/mcp` through Access Managed OAuth. `webbzi.com` is on Cloudflare nameservers, and `openseo.webbzi.com` has no DNS record yet (checked 2026-10-27).

What depends on the hostname, traced through the code:

- **Alchemy stack (needs a change).** Only `hosted-prod` attaches domains (`domain: prod ? [...] : undefined`). The Access application's hostname is hardcoded to `${workerName(stage)}.${workersSubdomain}`. The app worker keeps `url` at its default (`true`), so workers.dev stays enabled. In password mode (upstream v0.1.19+), `BETTER_AUTH_URL` is also derived from workers.dev.
- **App runtime (no change in `cloudflare_access`).** Every origin is derived from the request: `getPublicOrigin` for MCP deep links, `window.location.origin` in the client, `publicOrigin` for the Google OAuth redirect URIs (`/api/gsc/oauth/callback`, `/api/ga4/oauth/callback`), and per-connection storage in `SamChatAgent`. Access JWT validation uses `TEAM_DOMAIN` (issuer) and `POLICY_AUD`, and both are hostname-independent. Report share links store only paths. `BETTER_AUTH_URL` and `getHostedBaseUrl` are read only in hosted and password modes.
- **MCP transport (no change).** The agents SDK (`handler-stateless-*.js`) and our legacy port in `src/server/mcp/transport.ts` accept the request's own hostname as Host and Origin only for `*.workers.dev`. A custom hostname skips Host validation, and Origin falls back to localhost-only. MCP clients send no Origin, so they are unaffected. Only a browser page on `openseo.webbzi.com` posting to `/mcp` would now get a 403, and nothing in the app does that.
- **Access application (in-place update, side effect).** Alchemy's `Access.Application` diff replaces the app only when `type` changes. A `domain` change is an in-place PUT, so `aud` and the JWT checks survive. That PUT sends no `oauth_configuration`, and per the Cloudflare docs a PUT without it overwrites the existing config. Expect Managed OAuth (MCP login) to be switched off by the deploy.
- **Zone policies (new exposure).** On workers.dev no zone settings applied. Once the app is on the `webbzi.com` zone, its Bot Fight Mode, Browser Integrity Check, cache rules, Rocket Loader and email obfuscation all apply to the app and `/mcp`.

## Options

1. Hand-made Custom Domain or route in the dashboard, plus a hand-managed Access app (`TEAM_DOMAIN` + `POLICY_AUD`). This needs no code. However, Alchemy reconciles the worker on every deploy and would detach a dashboard domain. Setting both vars also stops the stack from declaring the provisioned Access app, which Alchemy likely deletes on deploy (not verified). Rejected.
2. Proxied CNAME from `openseo` to the workers.dev hostname. Rejected: workers.dev does not serve foreign Host headers.
3. Optional `CUSTOM_DOMAIN` (bare hostname) in `.env.selfhost`, read by the stack for non-prod stages. When it is set: the app worker gets `domain: [CUSTOM_DOMAIN]` and `url: false`; the Access gate's `domain` becomes `CUSTOM_DOMAIN`; `BETTER_AUTH_URL` becomes `https://${CUSTOM_DOMAIN}`; and the stack output prints that URL.

## Choice

Option 3. It is about 25 lines in `deploy/alchemy/alchemy.run.ts` and generic enough to upstream to every-app/open-seo, which shrinks fork drift (the fork is 112 commits behind upstream, and upstream reworked the same file).

workers.dev is disabled (`url: false`) when a custom domain is set. The alternative was to keep it gated by giving the Access app two `destinations`, but that means changing the shared `emailAccessGate` for no user benefit. With only one Access hostname, an ungated workers.dev would serve public static assets and `/api/health`, while every app request fails with "No Cloudflare Access token". One origin also makes stale clients fail loudly. Rollback is unsetting the var and redeploying.

## Implementation (one branch, `feat/selfhost-custom-domain`)

1. `deploy/alchemy/alchemy.run.ts`
   - Add `optionalVar("CUSTOM_DOMAIN")`. Die if it contains `://`, `/`, `*`, or is used with `hosted-prod`.
   - App worker: `domain: prod ? [...] : customDomain ? [customDomain] : undefined`, `url: !customDomain || prod` (prod unchanged).
   - Pass `customDomain` to `resolveSelfHostAccess`; the Access gate uses `domain: customDomain || \`${workerName(stage)}.${subdomain}\``.
   - Non-prod `authUrl`: `https://${customDomain}` takes precedence over the workers.dev derivation.
   - Return `{ url: customDomain ? \`https://${customDomain}\` : app.url }`.
2. `scripts/selfhost-deploy-preflight.mjs`: the same hostname check, so a wrong value fails in seconds rather than after the build.
3. `deploy/.env.selfhost.example`: a commented `# CUSTOM_DOMAIN=openseo.example.com` with one line on the zone requirement.
4. Docs:
   - `docs/SELF_HOSTING_CLOUDFLARE.md`: add a "Serve from your own domain" section covering the same-account zone, no existing DNS record on the hostname, workers.dev being switched off, re-enabling Managed OAuth, and repointing MCP clients.
   - `docs/SELF_HOSTING_CLOUDFLARE_OPERATIONS.md`: note that Managed OAuth must be re-checked after any deploy that changes the Access app.
5. Acceptance: `pnpm types:check && pnpm lint && pnpm knip && pnpm exec prettier --check deploy docs scripts`. No app code or tests change. No plugin version bump is needed (no tool or skill change).

## Rollout (owner, after the pending main deploy, in a separate deploy so failures are attributable)

1. **Preconditions** (dashboard, about 2 minutes):
   - `webbzi.com` is under the same Cloudflare account as the `open-seo-selfhost` worker (the account whose workers.dev subdomain is `webbzi`). Alchemy otherwise fails with "Ensure the parent zone exists in this account." The local wrangler login is a different account (BOLLODROMO), so it cannot check this.
   - No DNS record exists for `openseo` (still true on 2026-10-27).
2. **Zone hygiene for `openseo.webbzi.com`** (a configuration rule matching the hostname):
   - Browser Integrity Check off, Rocket Loader off, Email Obfuscation off. These challenge or rewrite non-browser MCP clients and the SPA's HTML.
   - Make sure no Cache Rule caches HTML or `/api/*` for the host.
   - If Bot Fight Mode is on (free plan), it cannot be skipped per hostname and may challenge MCP clients. Test MCP before relying on it.
3. **Snapshot the Access app** before deploying (Zero Trust → Access controls → Applications → `open-seo selfhost`): note the Managed OAuth toggle, the dynamic client registration settings and the allowed redirect URIs.
4. Set `CUSTOM_DOMAIN=openseo.webbzi.com` in `.env.selfhost`, then run `pnpm deploy:selfhost --yes`.
5. **Re-enable Managed OAuth** on the same app with the snapshot settings (localhost/loopback DCR on, HTTPS redirect URIs for any web connector).
6. **Verify:**
   - `dig +short openseo.webbzi.com` returns Cloudflare IPs.
   - `curl -sI https://openseo.webbzi.com/` returns a 302 to `<team>.cloudflareaccess.com`.
   - `curl -si -X POST https://openseo.webbzi.com/mcp` returns a 401 with `WWW-Authenticate` (a 302 means Managed OAuth is still off).
   - `curl -s https://openseo.webbzi.com/.well-known/oauth-authorization-server` returns JSON.
   - `curl -sI https://open-seo-selfhost.webbzi.workers.dev/` no longer reaches the app.
   - In a browser, sign in through Access, check that the dashboard loads, and open `/api/health`.
7. **Repoint clients:**
   - `~/.codex/config.toml` MCP url → `https://openseo.webbzi.com/mcp`, then re-run the Codex MCP login. Old tokens were issued for the old resource.
   - Update any Claude/claude.ai connector and any bookmark.
8. **Later, only when configured:**
   - For Google Search Console or GA4, add `https://openseo.webbzi.com/api/gsc/oauth/callback` and `/api/ga4/oauth/callback` to the Google OAuth client's redirect URIs.
   - Umami and DataForSEO are server-to-server and unaffected.

Unchanged by design: crons, Workflows, the audit worker (`url: false`), D1/KV/R2 resource names, DO state, `TEAM_DOMAIN`/`POLICY_AUD`. Existing SAM sessions pick up the new origin on their next connect.

Rollback: remove `CUSTOM_DOMAIN`, redeploy, and re-enable Managed OAuth again. The Advanced Certificate Cloudflare issued for the hostname is not deleted with the Custom Domain; remove it by hand if wanted.

## Out of scope, noted

Shared report links (`/s/*`, `/r/*`) sit behind Access for outside viewers on any hostname. Making them public needs an Access bypass policy on those paths, which is a separate decision.
