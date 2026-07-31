import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import { createFileChunkReader, hashFile, normalizeFileUri } from '../security/FileHash';
import { ImportCoordinator, type ImportIo } from './ImportCoordinator';
import { StoredImportLibrary, type ImportStorage } from './ImportLibrary';

// The real file system and storage behind `ImportCoordinator`.
//
// Kept apart from the coordinator for the same reason `ExpoDownloadIo` is kept
// apart from `DownloadWriter`: the rules stay testable outside a React Native
// runtime. Nothing here decides anything.

export const expoImportIo: ImportIo = {
  async statFile(filePath) {
    const info = await FileSystem.getInfoAsync(normalizeFileUri(filePath));
    if (!info.exists || info.isDirectory) return null;
    return typeof info.size === 'number' ? info.size : 0;
  },

  createReader(filePath) {
    return createFileChunkReader(filePath);
  },

  async hashFile(filePath) {
    // Deliberately goes through `FileHash.hashFile` rather than hashing here, so
    // installing a native digest with `setFileHasher` speeds up imports too. It
    // re-stats the file, which is one cheap call against a hash that costs about
    // a second per 10 MB.
    const hashed = await hashFile(filePath);
    return hashed.sha256;
  },
};

export const asyncStorageImportStorage: ImportStorage = {
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: (key) => AsyncStorage.removeItem(key),
};

let shared: ImportCoordinator | null = null;

/** The app's single import path. Every entry point goes through this. */
export function getImportCoordinator(): ImportCoordinator {
  if (!shared) {
    shared = new ImportCoordinator({
      library: new StoredImportLibrary(asyncStorageImportStorage),
      io: expoImportIo,
    });
  }
  return shared;
}
