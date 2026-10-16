// Pure validators for self-host configuration values. Shared by the runtime
// (auth middleware, /api/health, telemetry) and the Docker preflight script,
// so every surface applies the exact same rules and wording.

export const MIN_BETTER_AUTH_SECRET_LENGTH = 32;

type TeamDomainResult =
  | { ok: true; origin: string }
  | { ok: false; message: string };

export function validateTeamDomain(value: string): TeamDomainResult {
  const normalized = value.trim().replace(/\/+$/, "");

  try {
    const parsed = new URL(normalized);

    if (parsed.protocol !== "https:") {
      throw new Error("TEAM_DOMAIN must use https");
    }

    return { ok: true, origin: parsed.origin };
  } catch {
    return {
      ok: false,
      message:
        "TEAM_DOMAIN must be a full https URL like https://your-team.cloudflareaccess.com" +
        (normalized && !normalized.includes("://")
          ? ` — add the https:// prefix to "${normalized}"`
          : ""),
    };
  }
}

// DATAFORSEO_API_KEY is NOT the key shown in the DataForSEO dashboard — it is
// base64("login:password"). Decoding it and finding a colon is a cheap sanity
// check that catches the most common paste mistake without a paid API call.
export function looksLikeDataForSeoKey(value: string): boolean {
  try {
    return atob(value.trim()).includes(":");
  } catch {
    return false;
  }
}

// UMAMI_API_URL is the Umami instance URL (an origin, or an origin plus the
// instance's base path). It must be https so the API key never crosses the
// network in the clear; plain http is accepted only for a Umami on the same
// machine. Returns the URL without a trailing slash, or null when invalid.
export function parseUmamiApiUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const allowedScheme =
    url.protocol === "https:" || (url.protocol === "http:" && isLocal);
  if (!allowedScheme || url.username || url.password || url.search || url.hash)
    return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

// Umami treats a bearer token as an account API key only when it carries this
// prefix; anything else is read as a short-lived login token, which OpenSEO
// does not support.
export function looksLikeUmamiApiKey(value: string): boolean {
  return value.trim().startsWith("umami_");
}

// OPENSEO_TELEMETRY_DISABLED / DO_NOT_TRACK semantics: any value except an
// explicit "off" string disables telemetry (fail toward privacy), but
// "0"/"false"/"no"/"off" mean what the operator wrote — telemetry stays on.
export function isTelemetryOptOutValue(
  value: string | undefined | null,
): boolean {
  if (!value) return false;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}
