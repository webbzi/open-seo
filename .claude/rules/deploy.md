---
paths:
  - "deploy/alchemy/**"
  - "scripts/selfhost-deploy-preflight.mjs"
  - "deploy/.env.selfhost.example"
---

- Alchemy's `Access.Application` updates in place (PUT, same `aud`) when `domain`, `name`, or policy refs change, and it sends no `oauth_configuration`. Per Cloudflare's docs, that PUT overwrites Managed OAuth, so MCP login through Access stops until it is re-enabled in Zero Trust. Only a `type` change replaces the app (new `aud`).
- Setting both `TEAM_DOMAIN` and `POLICY_AUD` skips Access provisioning, so the stack-managed Access application and policy are no longer declared. Alchemy normally deletes undeclared resources on deploy; check the plan before switching.
- A Worker `domain` needs its zone in the same account as the Worker. The agents SDK MCP handler accepts the request's own Host/Origin only for `*.workers.dev`; on a custom hostname Host validation is skipped and Origin defaults to localhost.
