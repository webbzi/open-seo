# Self-hosted Umami

Connecting [Umami](https://umami.is) lets OpenSEO map each project to one
website on your self-hosted Umami instance. The connection is optional and
read-only. One OpenSEO deployment connects to one Umami instance.

## What you'll need

- A self-hosted Umami instance running **v3.4.0 or later**. Earlier versions
  have no account API keys, and Umami Cloud does not offer them.
- An Umami admin login, to create the user that owns the API key.
- Access to the OpenSEO deployment's environment variables.

## 1) Create a dedicated Umami user

In Umami, open **Admin → Users** and create a new user with the **User**
role. Do not use an admin account.

The API key acts as this user, and OpenSEO can read every website the user can
see. Every owner or admin of any organization on this OpenSEO deployment can
connect any of those websites to their projects. A dedicated user lets you
decide exactly which websites OpenSEO exposes, and lets you revoke OpenSEO's
access without touching anyone's own login.

An admin key is also unsafe for a second reason: it reports all-zero
statistics for a deleted website instead of an error, so a removed website
would look like a website with no traffic.

## 2) Give the user its websites

Umami lists a website for the user only when the user:

- owns the website, or
- is an **Owner** or **Manager** of the team that holds the website.

Team **Member** and **View only** roles can read a website's statistics, but
Umami does not list those websites for the user, so OpenSEO can't offer them.

The simplest setup is a team that holds the websites you want to expose, with
the dedicated user added as a **Manager**. OpenSEO never changes anything in
Umami, but a Manager role can edit the team's websites, so keep the key
secret.

## 3) Create the API key

Sign in to Umami as the dedicated user, open **Settings → API keys**, and
create a key. Copy it when Umami shows it; it starts with `umami_`.

## 4) Set environment variables

| Variable        | Value                                                    |
| --------------- | -------------------------------------------------------- |
| `UMAMI_API_URL` | Your Umami URL, for example `https://umami.example.com`. |
| `UMAMI_API_KEY` | The API key from step 3. Store it as a secret.           |

- `UMAMI_API_URL` must use `https`. Plain `http` is accepted only for
  `localhost` or `127.0.0.1`. If Umami is served under a path, include it
  (`https://example.com/umami`).
- Set both values. With either missing or invalid, OpenSEO turns the Umami
  integration off.

Where to set them:

- **Cloudflare (Alchemy):** add both to the env file you deploy with (see
  `deploy/.env.selfhost.example`). The key is uploaded as a Worker secret.
- **Docker:** add both to `.env`. Inside the container, `localhost` is the
  container itself, so point `UMAMI_API_URL` at Umami's public `https` URL.
- **Local development:** add both to `.env.local`.

## 5) Redeploy

Redeploy or restart OpenSEO. The Docker preflight and `/api/health` report an
`umami` check that warns when only one value is set or a value is invalid.

## 6) Connect a project

Open **Project settings → Integrations**. On the **Umami** card, choose a
website and click **Connect**. Only organization owners and admins can
connect, change, or disconnect a website; other members see the connection
read-only.

OpenSEO saves your browser's time zone with the connection, because Umami
websites have no time zone of their own. Reports use it to decide where each
day starts. To update it, click **Change website** and save the same website
from a browser in the right time zone.

Disconnecting removes only the project's mapping. Nothing changes in Umami.

## Troubleshooting

**The card says Umami isn't set up** — check that both variables are set, the
URL passes the rules in step 4, and the key starts with `umami_`. Then
redeploy.

**"Umami rejected the API key"** — the key was revoked or mistyped, or the
instance is older than v3.4.0.

**No websites appear** — the dedicated user owns no websites and is not an
Owner or Manager of a team that holds any. See step 2.
