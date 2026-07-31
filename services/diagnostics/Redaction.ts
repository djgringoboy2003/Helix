// Removing everything a diagnostic report must not carry.
//
// `CLAUDE.md` forbids passwords, cookies, access tokens and private IP details
// in logs. A diagnostic export is a log the operator is about to paste into a
// GitHub issue, so it is the single most likely way any of those escapes — and
// unlike a log line, it is composed of values the app already holds and could
// easily hand over wholesale.
//
// The approach is to redact by *pattern* over the finished text rather than to
// pick safe fields at the source. Both are done — the report builder only puts
// in what it means to — but a field-by-field allowlist fails silently the day
// somebody adds a field, whereas a pattern sweep over the output catches a
// printer URL that arrives inside an error message nobody thought about.
//
// Everything here is pure and exhaustively tested, because "it looked redacted"
// is not a property anyone can eyeball on a 200-line report.

/** What each pattern is replaced with, so a reader can see something was removed. */
export const REDACTED = '[redacted]';

/**
 * Private and link-local IPv4, including the CGNAT range Tailscale uses.
 *
 * Deliberately not "any IPv4": a public address in a diagnostic is usually a
 * MakerWorld CDN host and is worth keeping, while `192.168.x.x` says where
 * somebody lives on their own network.
 */
const PRIVATE_IPV4 =
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/g;

/** Tailscale machine names identify a person's tailnet. */
const TAILNET_HOST = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net\b/gi;

/** `user:password@host` in any URL. */
const URL_CREDENTIALS = /\/\/[^/\s:@]+:[^/\s@]+@/g;

/**
 * JWTs, including the bearer token MakerWorld issues.
 *
 * Matched structurally (three base64url segments) rather than by the header
 * that precedes them, because these turn up bare inside error strings.
 */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

/** `Authorization: Bearer …`, `token=…`, `password=…`, and friends. */
const LABELLED_SECRET =
  /\b(authorization|bearer|cookie|set-cookie|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|password|passwd|pwd|secret|session|sessionid|auth)\b(\s*[:=]\s*|\s+)("[^"]*"|'[^']*'|[^\s,;&"']+)/gi;

/** Android app-private storage, which embeds the user's profile and package. */
const ANDROID_PATH = /\/(?:data\/user\/\d+|data\/data|storage\/emulated\/\d+)\/[^\s"',)]*/g;

/** Windows user directories, for reports generated during development. */
const WINDOWS_USER_PATH = /[A-Za-z]:\\Users\\[^\\\s"',)]+/g;

/** POSIX home directories. */
const POSIX_HOME = /\/(?:home|Users)\/[^\s/"',)]+/g;

/**
 * Strips every secret and locator this app could plausibly emit.
 *
 * Order matters: labelled secrets run before the generic patterns so that
 * `password=192.168.0.5` is redacted as a password rather than half-redacted as
 * an address, and path redaction runs last so a path inside a labelled value is
 * already gone.
 */
export function redactSensitive(text: string): string {
  if (!text) return '';

  return text
    .replace(URL_CREDENTIALS, `//${REDACTED}@`)
    .replace(JWT, REDACTED)
    .replace(LABELLED_SECRET, (_match, label: string, separator: string) => {
      // Keep the label so the report still shows *that* a token was involved.
      const gap = separator.includes('=') ? '=' : ': ';
      return `${label}${gap}${REDACTED}`;
    })
    .replace(TAILNET_HOST, REDACTED)
    .replace(PRIVATE_IPV4, REDACTED)
    .replace(ANDROID_PATH, REDACTED)
    .replace(WINDOWS_USER_PATH, REDACTED)
    .replace(POSIX_HOME, REDACTED);
}

/**
 * A file path reduced to its name.
 *
 * Used where the report genuinely wants to say *which* file without saying
 * where it lives. `redactSensitive` would blank the whole path; this keeps the
 * part that helps diagnose and drops the part that identifies.
 */
export function fileNameOnly(pathOrUri: string): string {
  const withoutQuery = pathOrUri.split(/[?#]/)[0] ?? '';
  const name = withoutQuery.split(/[/\\]/).filter(Boolean).pop() ?? '';
  return name || REDACTED;
}

/**
 * A printer address reduced to what is useful without saying where it is.
 *
 * Scheme and port answer most connection questions — "is it http, is it on
 * 7125" — while the host is the part that locates somebody's machine.
 */
export function describeEndpoint(url: string): string {
  const trimmed = (url ?? '').trim();
  if (!trimmed) return 'not set';
  const match = /^(https?):\/\/([^/:]+)(?::(\d+))?/i.exec(trimmed);
  if (!match) return REDACTED;
  const [, scheme, host, port] = match;
  const kind = /^[\d.]+$/.test(host) ? 'ip' : host.endsWith('.ts.net') ? 'tailnet' : 'hostname';
  return `${scheme}://<${kind}>${port ? `:${port}` : ''}`;
}
