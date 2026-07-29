// Feature flags.
//
// `docs/TECHNICAL_ARCHITECTURE.md` names the flags and requires unsafe or
// experimental paths to default to off. Stage B introduces the mechanism before
// any gated behaviour ships, so nothing has to be retrofitted behind it later.
//
// Some flags are locked. A safety control is not an experiment: a stored value
// that tried to switch the camera check off would be an escalation path via
// whatever wrote it, so locked flags ignore overrides entirely and can only
// change by editing this file.

export type FeatureFlagName =
  | 'makerworld_webview_enabled'
  | 'makerworld_native_api_enabled'
  | 'crossprint_translation_enabled'
  | 'remote_printer_enabled'
  | 'camera_approval_required'
  | 'experimental_multi_plate_enabled';

export interface FeatureFlagDefinition {
  description: string;
  defaultValue: boolean;
  /**
   * Locked flags cannot be changed at runtime. Used for safety controls, where
   * "off" is never a valid stored state.
   */
  locked: boolean;
}

export const FEATURE_FLAGS: Record<FeatureFlagName, FeatureFlagDefinition> = {
  makerworld_webview_enabled: {
    description: 'Browse and download from MakerWorld in an in-app WebView.',
    defaultValue: true,
    locked: false,
  },
  makerworld_native_api_enabled: {
    description: 'Experimental native MakerWorld search and download path.',
    defaultValue: false,
    locked: false,
  },
  crossprint_translation_enabled: {
    description: 'Extra Bambu-to-U1 profile translation beyond the native sanitiser.',
    defaultValue: false,
    locked: false,
  },
  remote_printer_enabled: {
    description: 'Reach the printer over a private VPN such as Tailscale.',
    defaultValue: false,
    locked: false,
  },
  camera_approval_required: {
    description: 'Require a fresh bed camera frame before a print may start.',
    defaultValue: true,
    // Locked: `docs/SAFETY_AND_TESTING.md` forbids starting on a stale or
    // absent camera image, so this is not a toggle.
    locked: true,
  },
  experimental_multi_plate_enabled: {
    description: 'Handle multi-plate projects beyond the first plate.',
    defaultValue: false,
    locked: false,
  },
};

export type FeatureFlags = Record<FeatureFlagName, boolean>;

export const FEATURE_FLAG_NAMES = Object.keys(FEATURE_FLAGS) as FeatureFlagName[];

export function isFeatureFlagName(value: unknown): value is FeatureFlagName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(FEATURE_FLAGS, value);
}

export function defaultFeatureFlags(): FeatureFlags {
  const flags = {} as FeatureFlags;
  for (const name of FEATURE_FLAG_NAMES) flags[name] = FEATURE_FLAGS[name].defaultValue;
  return flags;
}

/**
 * Builds the effective flag set from stored or remote overrides.
 *
 * Unknown keys, non-boolean values and attempts to move a locked flag are all
 * discarded rather than rejected, so a corrupt or outdated stored value
 * degrades to the safe defaults instead of blocking startup.
 */
export function resolveFeatureFlags(overrides: unknown): FeatureFlags {
  const flags = defaultFeatureFlags();
  if (!overrides || typeof overrides !== 'object') return flags;

  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (!isFeatureFlagName(key)) continue;
    if (FEATURE_FLAGS[key].locked) continue;
    if (typeof value !== 'boolean') continue;
    flags[key] = value;
  }
  return flags;
}

let active: FeatureFlags = defaultFeatureFlags();

/** Applies overrides once at startup, after stored settings are read. */
export function setFeatureFlagOverrides(overrides: unknown): FeatureFlags {
  active = resolveFeatureFlags(overrides);
  return active;
}

export function getFeatureFlags(): FeatureFlags {
  return active;
}

export function isFeatureEnabled(name: FeatureFlagName): boolean {
  return active[name];
}

export function resetFeatureFlags(): void {
  active = defaultFeatureFlags();
}

/** Only unlocked flags may appear in a developer settings screen. */
export function togglableFeatureFlags(): FeatureFlagName[] {
  return FEATURE_FLAG_NAMES.filter((name) => !FEATURE_FLAGS[name].locked);
}
