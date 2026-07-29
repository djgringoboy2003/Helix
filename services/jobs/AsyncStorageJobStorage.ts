import AsyncStorage from '@react-native-async-storage/async-storage';

import { PrintJobRepository, type JobStorage } from './PrintJobRepository';

// AsyncStorage backend for `PrintJobRepository`.
//
// Kept apart from the repository so the recovery rules stay testable outside a
// React Native runtime. Job records hold no secrets — no cookies, tokens or
// signed URLs — so plain AsyncStorage is the right home for them; MakerWorld
// session data belongs in secure storage instead.

export const asyncStorageJobStorage: JobStorage = {
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: (key) => AsyncStorage.removeItem(key),
};

let shared: PrintJobRepository | null = null;

export function getPrintJobRepository(): PrintJobRepository {
  if (!shared) shared = new PrintJobRepository(asyncStorageJobStorage);
  return shared;
}
