// Download policy for model files.
//
// `docs/TECHNICAL_ARCHITECTURE.md`: allow only expected HTTPS hosts, validate
// every redirect host, apply size limits while streaming, and do not trust
// filename extensions. A signed CDN URL must never be logged, so failures
// report the host and reason rather than the URL.

export type DownloadRejectionCode =
  | 'download/unparseable-url'
  | 'download/insecure-scheme'
  | 'download/host-not-allowed'
  | 'download/credentials-in-url'
  | 'download/port-not-allowed'
  | 'download/too-many-redirects'
  | 'download/too-large'
  | 'download/size-unknown'
  | 'download/bad-filename';

export type DownloadCheck =
  | { ok: true }
  | { ok: false; code: DownloadRejectionCode; message: string };

const allow = { ok: true } as const;
const reject = (code: DownloadRejectionCode, message: string): DownloadCheck => ({
  ok: false,
  code,
  message,
});

/**
 * Hosts that may serve a model file.
 *
 * `bblmw.com` is Bambu Lab's CDN, which is where MakerWorld's signed 3MF URLs
 * resolve to. Entries beginning with `.` match that domain and its subdomains;
 * anything else must match exactly.
 */
export const ALLOWED_DOWNLOAD_HOSTS: readonly string[] = [
  'makerworld.com',
  'www.makerworld.com',
  '.makerworld.com',
  '.bblmw.com',
  '.bambulab.com',
];

export const MAX_DOWNLOAD_BYTES = 250 * 1024 * 1024;
export const MAX_REDIRECTS = 5;

export function isAllowedDownloadHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, '');
  if (!normalized) return false;
  return ALLOWED_DOWNLOAD_HOSTS.some((entry) =>
    entry.startsWith('.')
      ? normalized === entry.slice(1) || normalized.endsWith(entry)
      : normalized === entry
  );
}

interface UrlParts {
  scheme: string;
  host: string;
  port: string;
  hasUserInfo: boolean;
}

function parts(url: string): UrlParts | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(url.trim());
  if (!match) return null;

  let authority = match[2];
  const hasUserInfo = authority.includes('@');
  if (hasUserInfo) authority = authority.slice(authority.lastIndexOf('@') + 1);

  const colonAt = authority.lastIndexOf(':');
  const bracketAt = authority.lastIndexOf(']');
  const hasPort = colonAt > bracketAt && colonAt > 0;
  return {
    scheme: match[1].toLowerCase(),
    host: (hasPort ? authority.slice(0, colonAt) : authority).toLowerCase(),
    port: hasPort ? authority.slice(colonAt + 1) : '',
    hasUserInfo,
  };
}

/** Applied to the initial URL and again to every redirect target. */
export function checkDownloadUrl(url: string): DownloadCheck {
  const parsed = parts(url);
  if (!parsed || !parsed.host) {
    return reject('download/unparseable-url', 'The download link could not be read.');
  }
  if (parsed.scheme !== 'https') {
    return reject('download/insecure-scheme', 'Model downloads must use HTTPS.');
  }
  if (parsed.hasUserInfo) {
    return reject('download/credentials-in-url', 'The download link embeds credentials.');
  }
  if (parsed.port && parsed.port !== '443') {
    return reject('download/port-not-allowed', `Downloads are not allowed on port ${parsed.port}.`);
  }
  if (!isAllowedDownloadHost(parsed.host)) {
    return reject('download/host-not-allowed', `${parsed.host} is not an approved download host.`);
  }
  return allow;
}

/**
 * Validates a redirect chain manually, as the architecture requires.
 *
 * Every hop is checked, not just the last: a chain that leaves the allowlist
 * and comes back has still handed the request to an unapproved host.
 */
export function checkRedirectChain(urls: readonly string[]): DownloadCheck {
  if (urls.length > MAX_REDIRECTS + 1) {
    return reject('download/too-many-redirects', 'The download redirected too many times.');
  }
  for (const url of urls) {
    const check = checkDownloadUrl(url);
    if (!check.ok) return check;
  }
  return allow;
}

/**
 * Enforces the size limit.
 *
 * An unknown length is only tolerated up front, where streaming still enforces
 * the cap; once bytes are arriving the running total must be checked with
 * {@link checkReceivedBytes}.
 */
export function checkDownloadSize(
  contentLength: number | null,
  maxBytes: number = MAX_DOWNLOAD_BYTES
): DownloadCheck {
  if (contentLength === null) return allow;
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    return reject('download/size-unknown', 'The download reported an unusable size.');
  }
  if (contentLength > maxBytes) {
    return reject('download/too-large', `The file is larger than the ${formatMb(maxBytes)} limit.`);
  }
  return allow;
}

export function checkReceivedBytes(
  receivedBytes: number,
  maxBytes: number = MAX_DOWNLOAD_BYTES
): DownloadCheck {
  return receivedBytes > maxBytes
    ? reject('download/too-large', `The download exceeded the ${formatMb(maxBytes)} limit.`)
    : allow;
}

const SAFE_EXTENSIONS: readonly string[] = ['.3mf', '.stl', '.obj', '.step', '.stp'];

const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * Produces a filename safe to write to local storage.
 *
 * The server-supplied name is treated as hostile: directory separators, parent
 * references, control characters and Windows device names are all removed
 * before use. Whether the name *describes* the content is a separate question —
 * see {@link hasSupportedModelExtension}, and note that the architecture says
 * not to trust the extension either way.
 */
export function sanitizeDownloadFilename(name: string, fallback = 'model.3mf'): string {
  const lastSeparator = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  let base = lastSeparator >= 0 ? name.slice(lastSeparator + 1) : name;

  // Control characters are filtered by code point so no raw control bytes have
  // to appear in this source file.
  base = Array.from(base)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join('')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim();

  if (WINDOWS_DEVICE_NAME.test(base)) base = `_${base}`;

  if (base.length > 120) {
    const dot = base.lastIndexOf('.');
    const extension = dot > 0 ? base.slice(dot, dot + 8) : '';
    base = base.slice(0, 120 - extension.length) + extension;
  }

  return base || fallback;
}

export function hasSupportedModelExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return SAFE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export function checkDownloadFilename(name: string): DownloadCheck {
  return sanitizeDownloadFilename(name, '')
    ? allow
    : reject('download/bad-filename', 'The download had no usable filename.');
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
