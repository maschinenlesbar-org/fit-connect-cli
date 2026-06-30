// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

/** Base class for every error originating from this client. */
export class FitConnectError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Strip userinfo (`user:password@`) from a URL before it is embedded in a
 * human-readable error message, so credentials supplied via `--base-url` are
 * never echoed in cleartext. Returns the input unchanged if it does not parse as
 * a URL or carries no userinfo.
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return url;
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * The API responded with a non-2xx status code. `detail` holds a human-readable
 * message extracted from the response body when one is present (the Routing API
 * returns RFC 7807 `application/problem+json` error bodies with a `detail` field).
 */
export class FitConnectApiError extends FitConnectError {
  readonly status: number;
  readonly detail: string | undefined;
  readonly url: string;
  readonly method: string;
  readonly body: string;

  constructor(args: {
    status: number;
    url: string;
    method: string;
    body: string;
    detail?: string;
  }) {
    const detailPart = args.detail ? `: ${args.detail}` : "";
    super(`HTTP ${args.status} for ${args.method} ${redactUrl(args.url)}${detailPart}`);
    this.status = args.status;
    this.url = args.url;
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
  }

  /** True for statuses the API documents as transient and retry-able. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }
}

/** A transport-level failure (DNS, connection reset, timeout, ...). */
export class FitConnectNetworkError extends FitConnectError {}

/** The response body could not be parsed as the expected JSON shape. */
export class FitConnectParseError extends FitConnectError {}
