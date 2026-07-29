// Why a model download failed.
//
// `ModelSourceProvider` defines a `DownloadFailureReason` set, but nothing
// populated it: a failed download surfaced as whatever text the transport
// happened to produce. The operator's next action differs completely between
// "sign in", "solve the CAPTCHA" and "try again later", so the reason has to be
// derived from the response rather than described in prose.
//
// This matters more than a normal error path. MakerWorld answers 403 to an
// unauthenticated download and 418 to a bot check, and in both cases it still
// sends a body. Writing that body to disk produces a file that is the wrong
// thing but is *authentically* that wrong thing — non-empty, hashable, and
// indistinguishable from a model until something tries to slice it.

import type { DownloadFailureReason } from './ModelSourceProvider';

/**
 * Content types that are never a model file.
 *
 * MakerWorld can answer `200` with an HTML sign-in page or a JSON error, so the
 * status alone is not enough. Only types that are definitely not a model are
 * listed: a real 3MF arrives as `application/octet-stream`, `application/zip`,
 * `model/3mf` or with no type at all, and rejecting an unfamiliar type would
 * break valid downloads.
 */
const NON_MODEL_MIME = /^(text\/html|text\/plain|application\/json|application\/xml|text\/xml)\b/i;

export interface DownloadResponse {
  status: number;
  mimeType?: string | null;
}

/**
 * Maps a completed HTTP response to a failure reason, or `null` when it is fine.
 *
 * A redirect status reaching this point means the transport stopped following
 * redirects rather than that a hop was refused — `checkRedirectChain` is what
 * enforces the allowlist across hops.
 */
export function reasonForResponse(response: DownloadResponse): DownloadFailureReason | null {
  const { status } = response;

  if (status === 401) return 'not-signed-in';
  if (status === 403) return 'forbidden';
  // MakerWorld's GeeTest bot check, and the conventional "I'm a teapot" refusal.
  if (status === 418) return 'captcha-required';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'network';
  if (status < 200 || status >= 300) return 'unknown';

  // A 2xx carrying an error page is the case that would otherwise be saved as a
  // model, so it is checked after the status, not instead of it.
  if (response.mimeType && NON_MODEL_MIME.test(response.mimeType.trim())) {
    return 'forbidden';
  }

  return null;
}

/** Maps a thrown transport error — no response at all — to a reason. */
export function reasonForTransportError(error: unknown): DownloadFailureReason {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/abort|cancel/i.test(message)) return 'cancelled';
  return 'network';
}

/**
 * Operator-facing text for a reason.
 *
 * Each one says what to do next. The status code is not shown: it explains
 * nothing to the person holding the phone, and the URL it came from may be
 * signed.
 */
export function describeReason(reason: DownloadFailureReason): string {
  switch (reason) {
    case 'not-signed-in':
      return 'MakerWorld needs you to sign in before downloading this model.';
    case 'captcha-required':
      return 'MakerWorld wants to check you are human. Tap its Download button on the page and solve the puzzle.';
    case 'forbidden':
      return 'MakerWorld refused the download. Signing in, or opening the model page first, usually clears it.';
    case 'rate-limited':
      return 'MakerWorld is rate limiting downloads. Wait a minute and try again.';
    case 'network':
      return 'The download could not be completed. Check the connection and try again.';
    case 'cancelled':
      return 'The download was cancelled.';
    case 'policy-rejected':
      return 'The download was refused because it did not meet the app’s safety rules.';
    case 'empty-file':
      return 'The downloaded file was empty.';
    default:
      return 'The download failed for an unknown reason.';
  }
}
