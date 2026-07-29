// What the Explore tab's toolbar knows about where the WebView is.
//
// `CLAUDE.md` Stage C asks for back, forward, refresh and "open current model"
// controls plus model and profile URL detection. Deciding when "open current
// model" is meaningful is URL reasoning, not view code, so it lives here where
// it can be tested without a WebView.

import {
  browseUrl,
  parseMakerWorldUrl,
  type ParsedModelUrl,
} from './MakerWorldUrlParser';
import { referenceFromParsedUrl } from './MakerWorldWebViewProvider';
import type { ModelReference } from './ModelSourceProvider';

export interface BrowseLocation {
  /** The raw current URL, as reported by the WebView. */
  url: string;
  /** True while the WebView is on a recognised MakerWorld page. */
  onMakerWorld: boolean;
  /** Parsed form when on MakerWorld, else `null`. */
  parsed: ParsedModelUrl | null;
  /**
   * The model the page is showing, when it is showing one.
   *
   * Non-null is exactly the condition for enabling "open current model": there
   * is no point offering to import a search page or a user profile.
   */
  model: ModelReference | null;
  /** Short human label for the toolbar, never the full URL. */
  label: string;
}

const EMPTY: BrowseLocation = {
  url: '',
  onMakerWorld: false,
  parsed: null,
  model: null,
  label: 'MakerWorld',
};

/**
 * Classifies the current WebView location.
 *
 * Off-site navigation is described rather than blocked. MakerWorld legitimately
 * sends the browser to identity and CDN hosts, and a browsing surface that
 * refused them would simply be broken; what matters is that importing is only
 * offered on a real MakerWorld model page.
 */
export function describeLocation(url: string | null | undefined): BrowseLocation {
  if (typeof url !== 'string' || !url.trim()) return EMPTY;

  const parsed = parseMakerWorldUrl(url);
  if (!parsed) {
    return { url, onMakerWorld: false, parsed: null, model: null, label: hostLabel(url) };
  }

  const isModelPage = parsed.kind !== 'browse' && Boolean(parsed.modelId);
  return {
    url,
    onMakerWorld: true,
    parsed,
    model: isModelPage ? referenceFromParsedUrl(parsed) : null,
    label: isModelPage ? modelLabel(parsed) : 'MakerWorld',
  };
}

/** Where the Explore tab starts, and where "home" returns to. */
export function exploreStartUrl(locale: string | null = 'en'): string {
  return browseUrl(locale);
}

/**
 * Whether importing should be offered for this location.
 *
 * Split out from {@link describeLocation} so the screen reads as a question
 * rather than a null check, and so the rule has a name in the tests.
 */
export function canImportFrom(location: BrowseLocation): boolean {
  return location.model !== null;
}

function modelLabel(parsed: ParsedModelUrl): string {
  return parsed.profileId
    ? `Model ${parsed.modelId} · profile ${parsed.profileId}`
    : `Model ${parsed.modelId}`;
}

/**
 * Host of an off-site URL, for showing where the browser wandered to.
 *
 * Only the host is ever surfaced: a full URL can carry a signed token or a
 * session identifier in its query, and the safety rules forbid putting those in
 * front of the operator or into a log.
 */
function hostLabel(url: string): string {
  const withoutScheme = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const authority = withoutScheme.split('/')[0] ?? '';
  const host = authority.slice(authority.lastIndexOf('@') + 1).split(':')[0];
  return host || 'Browsing';
}
