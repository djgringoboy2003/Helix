import type { ImportRecord } from './ImportTypes';

// Where imported models are remembered.
//
// Small on purpose: the coordinator needs to answer "have I seen these exact
// bytes before" and "keep this one". Everything else — browsing, deleting,
// re-opening — is UI that can be built on `list()`.
//
// Keyed by SHA-256 rather than by path or name, because the same model arrives
// under different names through different doors, and the hash is the identity a
// print job and its approval will later bind to.

export interface ImportLibrary {
  findBySha256(sha256: string): Promise<ImportRecord | null>;
  save(record: ImportRecord): Promise<void>;
  list(): Promise<ImportRecord[]>;
  remove(sha256: string): Promise<void>;
}

/** The three AsyncStorage calls the persistent library needs. */
export interface ImportStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const IMPORT_INDEX_KEY = 'helix.imports.v1.index';

/** Oldest entries are dropped past this. The files themselves are not deleted. */
export const MAX_STORED_IMPORTS = 200;

/** For tests, and for a session that should not persist anything. */
export class InMemoryImportLibrary implements ImportLibrary {
  private readonly records = new Map<string, ImportRecord>();

  async findBySha256(sha256: string): Promise<ImportRecord | null> {
    return this.records.get(sha256) ?? null;
  }

  async save(record: ImportRecord): Promise<void> {
    this.records.set(record.sha256, record);
  }

  async list(): Promise<ImportRecord[]> {
    return [...this.records.values()].sort((a, b) => b.importedAt - a.importedAt);
  }

  async remove(sha256: string): Promise<void> {
    this.records.delete(sha256);
  }
}

/**
 * Persistent library over a key-value store.
 *
 * The whole index is one value. Imports are counted in hundreds, not millions,
 * and a single read keeps dedupe cheap on the import path where it is checked
 * on every file.
 *
 * A corrupt or unreadable index reads as empty rather than throwing: losing the
 * import history costs a duplicate import, while failing the read would block
 * importing altogether.
 */
export class StoredImportLibrary implements ImportLibrary {
  constructor(private readonly storage: ImportStorage) {}

  async findBySha256(sha256: string): Promise<ImportRecord | null> {
    const records = await this.readIndex();
    return records.find((record) => record.sha256 === sha256) ?? null;
  }

  async save(record: ImportRecord): Promise<void> {
    const records = await this.readIndex();
    const without = records.filter((existing) => existing.sha256 !== record.sha256);
    const next = [record, ...without].slice(0, MAX_STORED_IMPORTS);
    await this.storage.setItem(IMPORT_INDEX_KEY, JSON.stringify(next));
  }

  async list(): Promise<ImportRecord[]> {
    return this.readIndex();
  }

  async remove(sha256: string): Promise<void> {
    const records = await this.readIndex();
    const next = records.filter((record) => record.sha256 !== sha256);
    if (next.length === records.length) return;
    await this.storage.setItem(IMPORT_INDEX_KEY, JSON.stringify(next));
  }

  private async readIndex(): Promise<ImportRecord[]> {
    let raw: string | null;
    try {
      raw = await this.storage.getItem(IMPORT_INDEX_KEY);
    } catch {
      return [];
    }
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isImportRecord);
    } catch {
      return [];
    }
  }
}

/**
 * Guards the boundary back from storage.
 *
 * Stored JSON is not trusted to still match the current shape — an older build,
 * a partial write or an edited value would otherwise flow straight into code
 * that assumes it is well-formed.
 */
function isImportRecord(value: unknown): value is ImportRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<ImportRecord>;
  return (
    typeof record.sha256 === 'string' &&
    record.sha256.length === 64 &&
    typeof record.fileName === 'string' &&
    typeof record.filePath === 'string' &&
    typeof record.sizeBytes === 'number' &&
    typeof record.importedAt === 'number' &&
    typeof record.sourceKind === 'string' &&
    typeof record.attribution === 'object' &&
    record.attribution !== null
  );
}
