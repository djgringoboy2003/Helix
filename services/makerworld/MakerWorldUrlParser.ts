// MakerWorld URL recognition.
//
// Parsed by hand rather than with `URL`: React Native's implementation is
// incomplete and differs from Node's, and this decides whether a link is
// trusted, so it must behave identically wherever it runs.
//
// The existing `extractMakerWorldDesignId` in `services/makerWorld.ts` matches
// anywhere in a string, so `https://evil.example/makerworld.com/models/1`
// satisfies it. This parser anchors on the host instead. It is additive for
// now; the older helper is replaced when its call sites move behind the
// provider interface.

export const MAKERWORLD_HOSTS: readonly string[] = ['makerworld.com', 'www.makerworld.com'];

export type MakerWorldUrlKind = 'model' | 'profile' | 'browse';

export interface ParsedModelUrl {
  provider: 'makerworld';
  kind: MakerWorldUrlKind;
  /** Numeric design id, empty for a plain browse URL. */
  modelId: string;
  /** Numeric instance/profile id when the link points at a specific profile. */
  profileId: string | null;
  /** Two-letter path locale when present, e.g. `en`. */
  locale: string | null;
  /** Rebuilt from the recognised parts — never the raw input. */
  canonicalUrl: string;
}

const SCHEME = /^(https?):\/\//i;
const LOCALE_SEGMENT = /^[a-z]{2}(?:-[a-z]{2})?$/i;
// MakerWorld appends a slug: /models/12345-some-model-name
const MODEL_SEGMENT = /^(\d+)(?:-[^/]*)?$/;
const PROFILE_FRAGMENT = /^profileId-(\d+)$/i;

interface SplitUrl {
  scheme: string;
  host: string;
  port: string;
  path: string;
  query: string;
  fragment: string;
  hasUserInfo: boolean;
}

function splitUrl(input: string): SplitUrl | null {
  let rest = input.trim();
  if (!rest) return null;

  const schemeMatch = SCHEME.exec(rest);
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : 'https';
  if (schemeMatch) rest = rest.slice(schemeMatch[0].length);
  // A bare `//host/path` is scheme-relative, not a path.
  else if (rest.startsWith('//')) rest = rest.slice(2);
  else if (rest.includes('://')) return null; // some other scheme entirely

  let fragment = '';
  const hashAt = rest.indexOf('#');
  if (hashAt >= 0) {
    fragment = rest.slice(hashAt + 1);
    rest = rest.slice(0, hashAt);
  }

  let query = '';
  const queryAt = rest.indexOf('?');
  if (queryAt >= 0) {
    query = rest.slice(queryAt + 1);
    rest = rest.slice(0, queryAt);
  }

  const slashAt = rest.indexOf('/');
  let authority = slashAt >= 0 ? rest.slice(0, slashAt) : rest;
  const path = slashAt >= 0 ? rest.slice(slashAt) : '/';

  // `https://makerworld.com@evil.example/` is a link to evil.example.
  const hasUserInfo = authority.includes('@');
  if (hasUserInfo) authority = authority.slice(authority.lastIndexOf('@') + 1);

  const colonAt = authority.lastIndexOf(':');
  const host = (colonAt > 0 ? authority.slice(0, colonAt) : authority).toLowerCase();
  const port = colonAt > 0 ? authority.slice(colonAt + 1) : '';

  if (!host) return null;
  return { scheme, host, port, path, query, fragment, hasUserInfo };
}

export function isMakerWorldHost(host: string): boolean {
  return MAKERWORLD_HOSTS.includes(host.trim().toLowerCase());
}

/**
 * Defined in terms of the parser so the two can never disagree: anything this
 * says is supported must also be something `parseMakerWorldUrl` will accept.
 */
export function supportsUrl(url: string): boolean {
  return parseMakerWorldUrl(url) !== null;
}

/**
 * Recognises MakerWorld model, profile and browse URLs.
 *
 * Returns `null` for anything not clearly on a MakerWorld host, including
 * look-alikes and links that merely mention the domain in a path.
 */
export function parseMakerWorldUrl(url: string): ParsedModelUrl | null {
  const split = splitUrl(url);
  if (!split) return null;
  if (split.hasUserInfo) return null;
  if (split.scheme !== 'https' && split.scheme !== 'http') return null;
  if (split.port && split.port !== '443') return null;
  if (!isMakerWorldHost(split.host)) return null;

  const segments = split.path.split('/').filter((segment) => segment.length > 0);

  let locale: string | null = null;
  if (segments.length > 0 && LOCALE_SEGMENT.test(segments[0]) && segments[0] !== 'models') {
    locale = segments[0].toLowerCase();
    segments.shift();
  }

  if (segments.length < 2 || segments[0] !== 'models') {
    return {
      provider: 'makerworld',
      kind: 'browse',
      modelId: '',
      profileId: null,
      locale,
      canonicalUrl: browseUrl(locale),
    };
  }

  const modelMatch = MODEL_SEGMENT.exec(segments[1]);
  if (!modelMatch) return null;
  const modelId = modelMatch[1];

  const profileId = extractProfileId(split.query, split.fragment);
  return {
    provider: 'makerworld',
    kind: profileId ? 'profile' : 'model',
    modelId,
    profileId,
    locale,
    canonicalUrl: modelUrl(modelId, profileId, locale ?? 'en'),
  };
}

function extractProfileId(query: string, fragment: string): string | null {
  const fromFragment = PROFILE_FRAGMENT.exec(fragment.trim());
  if (fromFragment) return fromFragment[1];

  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const key = pair.slice(0, eq).toLowerCase();
    const value = pair.slice(eq + 1);
    if ((key === 'profileid' || key === 'instanceid') && /^\d+$/.test(value)) return value;
  }
  return null;
}

export function modelUrl(modelId: string, profileId: string | null = null, locale = 'en'): string {
  const prefix = locale ? `/${locale}` : '';
  const fragment = profileId ? `#profileId-${profileId}` : '';
  return `https://makerworld.com${prefix}/models/${modelId}${fragment}`;
}

export function browseUrl(locale: string | null = 'en'): string {
  return locale ? `https://makerworld.com/${locale}` : 'https://makerworld.com';
}

/** Pulls the first MakerWorld link out of shared text (share sheets add prose). */
export function findMakerWorldUrl(text: string): ParsedModelUrl | null {
  const candidates = text.match(/(?:https?:\/\/)?[^\s<>"']+/g) ?? [];
  for (const candidate of candidates) {
    // Trailing punctuation is far more often sentence structure than URL.
    const trimmed = candidate.replace(/[.,;:!)\]}]+$/, '');
    const parsed = parseMakerWorldUrl(trimmed);
    if (parsed && parsed.kind !== 'browse') return parsed;
  }
  return null;
}
