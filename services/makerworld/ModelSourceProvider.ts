import type { ParsedModelUrl } from './MakerWorldUrlParser';

// The seam between the app and wherever models come from.
//
// `docs/PROJECT_MASTER_PLAN.md` requires MakerWorld access to sit behind an
// interface so the WebView path can ship first and a native API path can be
// tried later without the import pipeline noticing. Everything downstream of a
// download — inspection, preparation, slicing, upload, approval — deals in
// `DownloadedArtifact` and never in provider specifics.
//
// A provider's job ends at "bytes are on disk and here is what they are". It
// does not import, prepare, slice or touch the printer.

export type SessionState = 'signed-out' | 'signed-in' | 'unknown';

export interface SessionStatus {
  state: SessionState;
  /** Display name where the provider can cheaply tell; never an email or id. */
  accountLabel: string | null;
  /** When the session was last confirmed, for showing staleness in settings. */
  checkedAt: number;
}

export interface ModelReference {
  provider: string;
  modelId: string;
  profileId: string | null;
  title: string;
  creator: string;
  /** Licence as stated by the source, kept for attribution on import. */
  licence: string | null;
  pageUrl: string;
}

export interface DownloadProfileRequest {
  model: ModelReference;
  /** Where to write the file; the provider owns the final filename. */
  targetDirectory: string;
  onProgress?: (received: number, total: number | null) => void;
  signal?: { aborted: boolean };
}

export interface DownloadedArtifact {
  provider: string;
  modelId: string;
  profileId: string | null;
  fileName: string;
  /** Local path, no scheme. Never logged in full. */
  filePath: string;
  sizeBytes: number;
  sha256: string;
  downloadedAt: number;
  source: ModelReference;
}

export type DownloadFailureReason =
  | 'cancelled'
  | 'not-signed-in'
  | 'captcha-required'
  | 'forbidden'
  | 'rate-limited'
  | 'network'
  | 'policy-rejected'
  | 'empty-file'
  | 'unknown';

export class ModelSourceError extends Error {
  readonly reason: DownloadFailureReason;
  readonly providerId: string;

  constructor(providerId: string, reason: DownloadFailureReason, message: string) {
    super(message);
    this.name = 'ModelSourceError';
    this.providerId = providerId;
    this.reason = reason;
  }
}

export interface ModelSourceProvider {
  readonly id: string;
  readonly displayName: string;

  supportsUrl(url: string): boolean;
  parseUrl(url: string): ParsedModelUrl | null;

  getSessionStatus(): Promise<SessionStatus>;
  /** Opens the provider's browsing surface; resolves once it is showing. */
  openBrowseUrl(url?: string): Promise<void>;
  /** What the provider's browser is currently looking at, if anything. */
  resolveCurrentModel(): Promise<ModelReference | null>;
  downloadProfile(request: DownloadProfileRequest): Promise<DownloadedArtifact>;
}

const providers = new Map<string, ModelSourceProvider>();

export function registerModelSourceProvider(provider: ModelSourceProvider): void {
  providers.set(provider.id, provider);
}

export function getModelSourceProvider(id: string): ModelSourceProvider | null {
  return providers.get(id) ?? null;
}

export function listModelSourceProviders(): ModelSourceProvider[] {
  return [...providers.values()];
}

/** First registered provider that recognises the URL, in registration order. */
export function findProviderForUrl(url: string): ModelSourceProvider | null {
  for (const provider of providers.values()) {
    if (provider.supportsUrl(url)) return provider;
  }
  return null;
}

/** Test seam; the app registers providers once at startup. */
export function clearModelSourceProviders(): void {
  providers.clear();
}
