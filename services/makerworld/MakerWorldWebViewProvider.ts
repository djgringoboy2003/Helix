import {
  checkDownloadFilename,
  checkDownloadUrl,
  checkReceivedBytes,
  sanitizeDownloadFilename,
} from './DownloadHostPolicy';
import {
  browseUrl,
  modelUrl,
  parseMakerWorldUrl,
  supportsUrl,
  type ParsedModelUrl,
} from './MakerWorldUrlParser';
import {
  ModelSourceError,
  type DownloadProfileRequest,
  type DownloadedArtifact,
  type ModelReference,
  type ModelSourceProvider,
  type SessionStatus,
} from './ModelSourceProvider';

// The WebView implementation of `ModelSourceProvider`.
//
// This is the first-release path (`CLAUDE.md`: "Deliver the WebView path
// first"). Helix already has the moving parts — `app/makerworld-login.tsx`,
// `app/makerworld-download.tsx`, `services/mwBus.ts` and the native cookie
// store — and this wraps them rather than adding a third download path
// alongside the existing JS and native ones.
//
// Those screens are React and expo-router bound, so they are reached through
// {@link MakerWorldWebViewBridge}. That keeps every policy decision here — host
// allowlist, size cap, filename sanitising, hashing — testable without a React
// Native runtime, and leaves the bridge as a thin, boring adapter.

export const MAKERWORLD_PROVIDER_ID = 'makerworld-webview';

export interface BridgeDownloadResult {
  /** URL the page actually fetched the file from; policy-checked here. */
  sourceUrl: string;
  /** Server-supplied name; treated as hostile until sanitised. */
  suggestedName: string;
  filePath: string;
  sizeBytes: number;
}

/**
 * What the WebView screens provide.
 *
 * Everything here is a plain async operation so the provider stays free of
 * React, expo-router and native module imports.
 */
export interface MakerWorldWebViewBridge {
  /** True when a usable MakerWorld session cookie is held. */
  hasSession(): Promise<boolean>;
  /** Opens the browsing WebView at `url`. */
  openBrowser(url: string): Promise<void>;
  /** The model the browsing WebView is showing, if it is on a model page. */
  currentUrl(): Promise<string | null>;
  /**
   * Runs the interactive download screen and resolves once the page has handed
   * over a file. Resolves `null` if the operator backs out.
   */
  runDownload(
    model: ModelReference,
    onProgress?: (received: number, total: number | null) => void
  ): Promise<BridgeDownloadResult | null>;
  /** SHA-256 of a local file. */
  hashFile(filePath: string): Promise<string>;
  now(): number;
}

export class MakerWorldWebViewProvider implements ModelSourceProvider {
  readonly id = MAKERWORLD_PROVIDER_ID;
  readonly displayName = 'MakerWorld';

  private readonly bridge: MakerWorldWebViewBridge;

  constructor(bridge: MakerWorldWebViewBridge) {
    this.bridge = bridge;
  }

  supportsUrl(url: string): boolean {
    return supportsUrl(url);
  }

  parseUrl(url: string): ParsedModelUrl | null {
    return parseMakerWorldUrl(url);
  }

  async getSessionStatus(): Promise<SessionStatus> {
    const checkedAt = this.bridge.now();
    try {
      const signedIn = await this.bridge.hasSession();
      return { state: signedIn ? 'signed-in' : 'signed-out', accountLabel: null, checkedAt };
    } catch {
      // The rules say fail closed on unknown state, and for a read-only session
      // check that means reporting "unknown" rather than assuming signed out.
      return { state: 'unknown', accountLabel: null, checkedAt };
    }
  }

  async openBrowseUrl(url?: string): Promise<void> {
    const target = url && this.supportsUrl(url) ? url : browseUrl();
    await this.bridge.openBrowser(target);
  }

  async resolveCurrentModel(): Promise<ModelReference | null> {
    const current = await this.bridge.currentUrl();
    if (!current) return null;

    const parsed = this.parseUrl(current);
    if (!parsed || parsed.kind === 'browse' || !parsed.modelId) return null;
    return referenceFromParsedUrl(parsed);
  }

  /**
   * Runs the interactive download and turns the result into an artifact.
   *
   * The bytes are hashed here, from the file on disk, so the identity that
   * later gets bound into a start approval comes from what was actually
   * written — not from anything the page claimed.
   */
  async downloadProfile(request: DownloadProfileRequest): Promise<DownloadedArtifact> {
    const { model } = request;
    if (request.signal?.aborted) {
      throw new ModelSourceError(this.id, 'cancelled', 'Download cancelled.');
    }

    const result = await this.bridge.runDownload(model, request.onProgress);
    if (!result) {
      throw new ModelSourceError(this.id, 'cancelled', 'Download cancelled.');
    }

    const urlCheck = checkDownloadUrl(result.sourceUrl);
    if (!urlCheck.ok) {
      throw new ModelSourceError(this.id, 'policy-rejected', urlCheck.message);
    }

    const sizeCheck = checkReceivedBytes(result.sizeBytes);
    if (!sizeCheck.ok) {
      throw new ModelSourceError(this.id, 'policy-rejected', sizeCheck.message);
    }
    if (!Number.isFinite(result.sizeBytes) || result.sizeBytes <= 0) {
      throw new ModelSourceError(this.id, 'empty-file', 'The downloaded file is empty.');
    }

    const nameCheck = checkDownloadFilename(result.suggestedName);
    const fileName = nameCheck.ok
      ? sanitizeDownloadFilename(result.suggestedName)
      : sanitizeDownloadFilename(`makerworld_${model.modelId}.3mf`);

    const sha256 = await this.bridge.hashFile(result.filePath);

    return {
      provider: this.id,
      modelId: model.modelId,
      profileId: model.profileId,
      fileName,
      filePath: result.filePath,
      sizeBytes: result.sizeBytes,
      sha256,
      downloadedAt: this.bridge.now(),
      source: model,
    };
  }
}

/**
 * Builds a reference from a URL alone.
 *
 * Title, creator and licence are left empty rather than guessed; the import
 * step reads them from the 3MF metadata, which is the authoritative source for
 * the attribution record.
 */
export function referenceFromParsedUrl(parsed: ParsedModelUrl): ModelReference {
  return {
    provider: MAKERWORLD_PROVIDER_ID,
    modelId: parsed.modelId,
    profileId: parsed.profileId,
    title: '',
    creator: '',
    licence: null,
    pageUrl: modelUrl(parsed.modelId, parsed.profileId, parsed.locale ?? 'en'),
  };
}
