// Tiny handoff between the interactive MakerWorld download screen and the Slice
// tab. The download screen captures + saves the 3MF, drops the result here, and
// navigates back; the Slice tab picks it up on focus.

export type MwDownloadResult = {
  designId: string;
  instanceId: string;
  fileName: string;
  filePath: string;
  sizeBytes: number;
  /**
   * SHA-256 of the downloaded bytes, when the sender already took one.
   *
   * The Explore tab's provider hashes what it writes, so the import on the Slice
   * side can skip a second pass over the same file. The older download screen
   * does not hash, and omits this; the import hashes for itself in that case.
   */
  sha256?: string;
  /** Creator and licence as stated by the source page, for the import record. */
  attribution?: MwAttribution;
};

export type MwAttribution = {
  title: string | null;
  creator: string | null;
  licence: string | null;
  pageUrl: string | null;
};

let last: MwDownloadResult | null = null;

export function setMwDownload(result: MwDownloadResult): void {
  last = result;
}

export function takeMwDownload(): MwDownloadResult | null {
  const r = last;
  last = null;
  return r;
}
