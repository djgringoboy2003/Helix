import {
  getU1PrinterProfile,
  prepareForU1,
  readProjectSettings,
} from '../nativeSlicer';
import type { PrepareIo } from './U1Preparation';

// The real native side behind `runU1Preparation`.
//
// Kept apart from the sequencing for the same reason `ExpoImportIo` is kept
// apart from `ImportCoordinator`: the rules stay testable off-device. Nothing
// here decides anything — the ZIP rewrite is `java.util.zip` in
// `U1ProjectRewriter.kt`, and the policy is `U1ProjectPreparer.ts`.

export const nativePrepareIo: PrepareIo = {
  readProjectSettings,
  getU1PrinterProfile,
  prepareForU1,
};
