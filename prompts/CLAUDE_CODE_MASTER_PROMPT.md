# Claude Code Master Prompt

> **Historical.** This is the prompt the project was started from, kept for
> provenance. It describes work that is now done. `CLAUDE.md` is the live
> instruction file; `docs/CURRENT_STATE.md` is the live status.

You are working inside an Android project for a Snapmaker U1 companion app.

The repository should be a fork of:

`https://github.com/FatBoy721/Helix`

Your job is to turn the existing Helix app into a complete phone-first MakerWorld-to-Snapmaker-U1 workflow.

Read every instruction before editing.

## Product objective

Build this workflow:

```text
Browse MakerWorld
→ select a print profile
→ download editable 3MF
→ inspect the archive
→ prepare it for Snapmaker U1
→ preserve safe creator print intent
→ map filaments and U1 toolheads
→ slice locally on Android
→ review actual G-code
→ upload to Moonraker without starting
→ display a fresh bed-camera image
→ receive explicit operator approval
→ start the exact uploaded file
→ monitor, pause, resume, cancel and skip objects
```

The experience should feel like a native Snapmaker or Bambu phone app for the U1.

## Read first

Read these project files:

```text
README.md
CLAUDE.md
docs/PROJECT_MASTER_PLAN.md
docs/TECHNICAL_ARCHITECTURE.md
docs/IMPLEMENTATION_BACKLOG.md
docs/SAFETY_AND_TESTING.md
docs/SOURCE_REPOSITORIES_AND_LICENCES.md
```

Then inspect the whole repository.

Do not make edits before the audit.

## Main architectural decision

Use the existing Helix app as the base.

Retain and improve:

- React Native and Expo app structure.
- native Android slicer.
- Moonraker WebSocket client.
- Moonraker file services.
- camera.
- remote screen.
- file browser.
- printer controls.
- notifications.
- multi-printer support.
- existing MakerWorld share handling.

Do not create a replacement app from scratch.

## MakerWorld first-release decision

Use an Android WebView for MakerWorld browsing.

The first release should support:

- MakerWorld login in WebView.
- persistent WebView session.
- browsing.
- model and profile URL detection.
- download interception.
- profile download progress.
- captcha pages inside the WebView.
- Android share-to-app.
- handoff into the current import and slicing path.

Create a provider boundary so a native MakerWorld service may be added later.

Use an interface similar to:

```typescript
export interface ModelSourceProvider {
  id: string;
  supportsUrl(url: string): boolean;
  parseUrl(url: string): ParsedModelUrl | null;
  getSessionStatus(): Promise<SessionStatus>;
  resolveCurrentModel(): Promise<ModelReference | null>;
  downloadProfile(request: DownloadProfileRequest): Promise<DownloadedArtifact>;
}
```

Do not make undocumented MakerWorld endpoints a hard dependency of the MVP.

## 3MF handling

Treat every downloaded 3MF as untrusted input.

Add a preflight layer that checks:

- ZIP path traversal.
- absolute paths.
- excessive entries.
- excessive expanded size.
- malformed XML.
- missing geometry.
- embedded stale G-code.
- foreign machine scripts.
- unsupported encryption.
- invalid dimensions.
- unsupported source type.

Use the current native Bambu sanitisation pipeline first.

Study these projects for behaviour and tests:

```text
https://github.com/ELI7F/crossprint
https://github.com/Dakros66/DOC-U1-Link
https://github.com/Dakros66/MkWorld2Snap
https://github.com/taylormadearmy/u1-slicer-for-android
```

Do not copy code from a source until its licence is checked.

Preserve when safe:

- geometry.
- object positions.
- compatible colour painting.
- object and volume assignments.
- creator process choices.
- supports.
- layer height.
- wall and infill intent.
- source and licence metadata.

Remove or replace:

- foreign machine identity.
- foreign bed dimensions.
- foreign motion limits.
- downloaded machine start and end G-code.
- cloud host details.
- unsupported settings.
- invalid ranges.
- stale sliced caches.

Produce a human-readable conversion report.

## Printer control

Use Moonraker.

Study:

```text
https://github.com/dlgambill/u1hub
https://github.com/bbolinger/snapmaker-u1-toolkit
https://github.com/Snapmaker/u1-moonraker
```

Use REST for file operations and WebSocket JSON-RPC for live state and commands.

Keep printer actions inside a narrow deterministic service.

The UI must not directly issue start commands.

## Non-negotiable print safety

Never:

- start after download.
- start after slicing.
- auto-start a queued job.
- silently guess filament mappings.
- preserve downloaded machine G-code.
- overwrite printer files without approval.
- reuse approval after any job change.
- start using a stale camera frame.
- expose Moonraker through public router port forwarding.
- let an AI layer issue printer commands.

The print workflow must be:

```text
prepare
→ slice
→ review
→ upload with print disabled
→ verify upload
→ fetch fresh bed image
→ operator confirms bed clear
→ recheck printer and filament state
→ apply toolhead mapping
→ start exact filename
```

Bind final approval to:

```text
job ID
job revision
printer ID
filename
G-code SHA-256
filament mapping hash
approval timestamp
expiry timestamp
```

Any mismatch must reject the start.

## Job state machine

Create a persistent state machine with these states:

```text
created
downloading
downloaded
inspecting
rejected
conversion_required
preparing
prepared
slicing
slice_failed
review_required
approved_for_upload
uploading
uploaded
awaiting_start_approval
start_approved
starting
printing
paused
completed
cancelled
failed
```

Screens request transitions through the state machine.

Screens must not set state directly.

Increase the job revision when any of these changes:

- model content.
- plate.
- orientation.
- scale.
- quantity.
- process profile.
- filament profile.
- toolhead mapping.
- slicer override.
- target printer.
- output G-code.

Revision changes invalidate previous approvals.

## First work package

Complete Stage A before implementing features.

### Stage A, baseline audit

1. Inspect repository structure.
2. identify package manager.
3. identify Expo and React Native versions.
4. identify Android package names.
5. identify native slicer bridge and prebuilt libraries.
6. identify existing Bambu 3MF pipeline.
7. identify existing MakerWorld share handling.
8. identify Moonraker REST services.
9. identify WebSocket client and subscriptions.
10. identify printer-start paths.
11. identify current tests.
12. identify licences and notices.
13. run TypeScript checks.
14. run unit tests.
15. run Android lint where configured.
16. build a debug APK.
17. install on a connected ARM64 Android device when available.
18. write `docs/BASELINE_AUDIT.md`.

Do not change product behaviour during Stage A.

The audit document should include:

- repository summary.
- build commands.
- baseline pass and fail results.
- native-module risks.
- unsafe direct command paths.
- licence findings.
- files likely affected by the next stage.
- recommended small refactors.
- known blockers.

Commit Stage A separately.

### Stage B, architecture scaffolding

Add or adapt these components without breaking existing features:

```text
services/makerworld/ModelSourceProvider.ts
services/makerworld/MakerWorldUrlParser.ts
services/makerworld/MakerWorldWebViewProvider.ts
services/import/ThreeMfSecurityScanner.ts
services/jobs/PrintJobMachine.ts
services/jobs/ApprovalService.ts
services/security/FileHash.ts
```

Match the repository’s existing directory conventions instead of forcing these exact paths.

Add unit tests for:

- MakerWorld URL parsing.
- job transitions.
- job revision.
- approval invalidation.
- SHA-256 output.
- safe archive paths.
- size-limit enforcement.

Commit Stage B separately.

### Stage C, MakerWorld WebView MVP

Add an Explore tab.

Features:

- MakerWorld WebView.
- login persistence.
- navigation controls.
- current model detection.
- profile detection.
- download interception.
- progress UI.
- clear error states.
- captcha stays inside WebView.
- Android share support.
- download record.
- SHA-256.
- handoff to the existing Prepare or Slice screen.

Do not rebuild MakerWorld’s search interface natively.

Do not add bulk download.

Commit Stage C separately.

## Existing native Android warning

Do not run:

```text
expo prebuild --clean
```

unless you first prove all custom native slicer code, JNI bindings, Android manifests and prebuilt libraries will be restored.

Protect the existing `android` folder.

Use Expo development builds, not Expo Go.

## Licence rules

Helix and U1 Slicer for Android use AGPL-3.0-or-later.

Retain:

- AGPL licence.
- source availability.
- attribution.
- third-party notices.
- copyright notices.

MkWorld2Snap uses PolyForm Noncommercial.

Do not copy its code into a commercial project without separate permission.

When copying source from any repository, record:

```text
repository
file
commit
licence
changes
date
```

## Testing rules

Every new behaviour requires tests.

Use:

- unit tests for state, parsing, policy and mapping.
- integration tests for download, import, slice and upload.
- Android instrumented tests for WebView, JNI and foreground slicing.
- real U1 manual tests for physical actions.

Do not automate real print starts in CI.

Every fixed defect needs a regression test.

## Git rules

Work in small branches or commits.

Suggested order:

```text
audit: record untouched Helix baseline
architecture: add job and provider boundaries
feature: add MakerWorld Explore WebView
feature: add secure profile downloads
feature: add unified import pipeline
feature: add conversion report
feature: add safe upload-only flow
feature: add hash-bound print start gate
```

Do not mix broad formatting changes with functional work.

Keep current working behaviour.

## Expected first response

Before editing, report:

1. repository structure.
2. existing build and test commands.
3. current native slicer path.
4. current Moonraker path.
5. current MakerWorld-related features.
6. licence status.
7. safety risks.
8. exact commands for Stage A.
9. planned Stage B file changes.
10. planned Stage C file changes.

Then begin Stage A and continue through its audit and baseline build.

Do not ask broad preference questions.

Use sensible working names and visible placeholders where branding is not yet chosen.

Stop only when proceeding risks:

- deleting user work.
- breaking licence obligations.
- exposing secrets.
- starting or moving physical hardware without operator approval.
