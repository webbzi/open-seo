type UmamiErrorCode =
  // Upstream HTTP outcomes.
  | "umami_unauthorized"
  | "umami_website_not_found"
  | "umami_rate_limited"
  | "umami_upstream_unavailable"
  | "umami_bad_request"
  | "umami_malformed_response"
  // Adapter outcomes.
  | "umami_not_configured"
  | "umami_not_connected"
  | "validation_error";

const RETRYABLE_CODES: ReadonlySet<UmamiErrorCode> = new Set([
  "umami_rate_limited",
  "umami_upstream_unavailable",
]);

/** Messages are fixed copy: never the API key, the instance URL, or an
 *  upstream response body. */
export class UmamiError extends Error {
  readonly retryable: boolean;

  constructor(
    public readonly code: UmamiErrorCode,
    message: string,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "UmamiError";
    this.retryable = RETRYABLE_CODES.has(code);
  }
}
