# Technical Architecture

## High-level structure

```text
React Native UI
    |
Domain services and print-job state machine
    |
Data repositories and local persistence
    |
Native slicer, Android platform services and Moonraker
```

## Presentation layer

Keep UI components free from direct printer commands.

Screens dispatch domain actions such as:

```text
downloadProfile
inspectArtifact
prepareForU1
startSlice
approveUpload
uploadArtifact
requestStartApproval
approveStart
pausePrint
cancelPrint
```

The domain layer decides whether each action is valid.

## Domain layer

### PrintJobMachine

Own every state transition.

Required behaviour:

- reject invalid transition order.
- increment revision after model, settings or filament changes.
- invalidate upload and start approvals after revision changes.
- record transition events.
- persist state after each transition.
- recover after app restart.

### PrintPreflight

Combines:

- archive security scan.
- source slicer detection.
- model extents.
- profile compatibility.
- filament compatibility.
- printer capability checks.
- G-code bounds checks.

### ApprovalService

Creates short-lived approval records.

An approval record includes:

```typescript
export interface StartApproval {
  jobId: string;
  jobRevision: number;
  printerId: string;
  filename: string;
  gcodeSha256: string;
  filamentMapHash: string;
  approvedAt: number;
  expiresAt: number;
}
```

A changed field invalidates the record.

## MakerWorld provider layer

```typescript
export interface ModelSourceProvider {
  id: string;
  supportsUrl(url: string): boolean;
  parseUrl(url: string): ParsedModelUrl | null;
  getSessionStatus(): Promise<SessionStatus>;
  openBrowseUrl(url?: string): Promise<void>;
  resolveCurrentModel(): Promise<ModelReference | null>;
  downloadProfile(request: DownloadProfileRequest): Promise<DownloadedArtifact>;
}
```

### MakerWorldWebViewProvider

First implementation.

Responsibilities:

- own WebView navigation.
- use Android WebView cookie store.
- detect MakerWorld URLs.
- intercept profile downloads.
- expose login state.
- surface captcha pages.
- send downloaded files into the unified import pipeline.

### MakerWorldApiProvider

Later experimental implementation.

Responsibilities:

- search.
- model details.
- profile list.
- profile download.
- auth-expiry handling.
- host allowlist.
- rate-limit handling.

Keep it disabled behind a feature flag until stable.

## Import layer

### ThreeMfSecurityScanner

Stream archive entries where practical.

Limits should be configurable.

Suggested defaults:

```text
maximum compressed file: 250 MB
maximum expanded archive: 1 GB
maximum entries: 10,000
maximum single XML file: 128 MB
maximum path length: 512
```

Reject:

- `../`
- absolute paths
- drive-letter paths
- symlink-style entries
- encrypted entries
- duplicate critical paths
- malformed XML
- nested archives beyond policy

### ThreeMfInspector

Extract:

- application source.
- printer model.
- process profile.
- filament list.
- nozzle size.
- plate count.
- geometry presence.
- build items.
- colour assignments.
- paint metadata.
- embedded G-code.
- thumbnail.
- licence notes.

### U1ProjectPreparer

Use existing native slicer and sanitisation code first.

Add Crossprint-style translation only after fixture tests prove a missing behaviour.

The preparer returns:

```typescript
export interface PreparationResult {
  outputPath: string;
  outputSha256: string;
  detectedSource: SourceDialect;
  selectedU1Profile: string;
  changes: ConversionChange[];
  warnings: PreparationWarning[];
  unsupported: UnsupportedSetting[];
}
```

## Slicing layer

Wrap existing native slicing through one domain service.

```typescript
export interface SlicerService {
  inspect(path: string): Promise<ModelInspection>;
  prepare(request: PrepareRequest): Promise<PreparedProject>;
  slice(request: SliceRequest, onProgress: ProgressHandler): Promise<SliceResult>;
  cancel(jobId: string): Promise<void>;
}
```

Run long slices through an Android foreground service.

Persist enough state to show a recovery banner after process death.

## Printer layer

### U1MoonrakerClient

Split REST and WebSocket responsibilities.

REST:

- server info.
- file list.
- file metadata.
- upload.
- move.
- delete.
- camera snapshot endpoints where applicable.

WebSocket JSON-RPC:

- object subscription.
- live state updates.
- G-code commands.
- print start.
- pause.
- resume.
- cancel.
- skip object.
- macro execution.

### U1PrintService

The only service allowed to start physical print motion.

Required start sequence:

```text
validate approval
→ check active printer identity
→ check printer idle
→ check Klipper ready
→ check camera freshness
→ check uploaded filename
→ check job revision
→ check G-code hash record
→ check filament mapping
→ apply toolhead map
→ start exact filename
→ record response
```

### Printer discovery

Use LAN discovery where the existing Helix code supports it.

Always provide manual URL entry.

Support optional Tailscale URL failover.

## Persistence

Use existing repository choices where practical.

Recommended storage boundaries:

### Secure storage

- MakerWorld-sensitive session data.
- remote printer credentials.
- notification secrets.

### Database

- printers.
- models.
- print jobs.
- artifacts.
- history.
- filament profiles.
- conversion reports.

### File storage

- downloaded 3MF.
- prepared 3MF.
- sliced G-code.
- thumbnails.
- camera approvals.
- logs stripped of secrets.

## Suggested source tree

```text
app/
  (tabs)/
  model/
  print/

components/
  makerworld/
  model/
  filament/
  slicer/
  printer/
  common/

services/
  makerworld/
    ModelSourceProvider.ts
    MakerWorldWebViewProvider.ts
    MakerWorldApiProvider.ts
    MakerWorldUrlParser.ts
    DownloadHostPolicy.ts

  import/
    ThreeMfSecurityScanner.ts
    ThreeMfInspector.ts
    U1ProjectPreparer.ts

  jobs/
    PrintJobMachine.ts
    PrintJobRepository.ts
    PrintPreflight.ts
    ApprovalService.ts

  slicing/
    SlicerService.ts
    NativeU1SlicerService.ts
    GcodeInspector.ts

  printer/
    U1MoonrakerClient.ts
    U1PrintService.ts
    U1ToolheadMapper.ts
    U1PrinterDiscovery.ts

  security/
    FileHash.ts
    SecureLogger.ts
    DownloadPolicy.ts

database/
  models/
  repositories/
  migrations/

tests/
  fixtures/
  unit/
  integration/
  hardware/
```

Adapt paths to the current Helix repository instead of forcing a large move.

## Network policy

### Local network

HTTP Moonraker traffic is acceptable only on a trusted local network.

Do not send sensitive credentials over plain HTTP on an untrusted network.

### Remote access

Prefer Tailscale or another private VPN.

Do not instruct users to expose Moonraker with direct port forwarding.

### Download policy

Allow only expected HTTPS hosts.

Follow redirects manually or validate every redirect host.

Apply response-size limits while streaming.

Do not trust filename extensions.

## Logging policy

Never log:

- session cookies.
- bearer tokens.
- passwords.
- remote-access tokens.
- full signed download URLs.
- full local file paths containing personal names.
- camera images.
- private IP data in exported diagnostics unless the user selects it.

Use structured error codes.

## Feature flags

Suggested flags:

```text
makerworld_webview_enabled
makerworld_native_api_enabled
crossprint_translation_enabled
remote_printer_enabled
camera_approval_required
experimental_multi_plate_enabled
```

Default unsafe or experimental paths to off.
