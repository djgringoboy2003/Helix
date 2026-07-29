# CLAUDE.md

## Project objective

Build an Android companion app for the Snapmaker U1.

The finished workflow is:

```text
Browse MakerWorld
→ choose a print profile
→ download editable 3MF
→ inspect and sanitise
→ retarget for Snapmaker U1
→ map filaments and toolheads
→ slice locally
→ preview actual G-code
→ upload without starting
→ show a fresh bed-camera image
→ receive explicit operator approval
→ start exact uploaded file
→ monitor print
```

Use the current repository as the source of truth. This project should begin as a fork of `FatBoy721/Helix`, not as a new app.

## Required reading

Before changing code, read:

- `README.md`
- `docs/PROJECT_MASTER_PLAN.md`
- `docs/TECHNICAL_ARCHITECTURE.md`
- `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/SAFETY_AND_TESTING.md`
- `docs/SOURCE_REPOSITORIES_AND_LICENCES.md`

Then inspect the existing repository structure and native Android integration.

## Core technical direction

Use:

- React Native.
- Expo development builds.
- TypeScript.
- existing Helix navigation and Moonraker services.
- existing native Android slicer integration.
- Android WebView for MakerWorld browsing in the first release.
- a provider interface around MakerWorld access.
- local Android storage.
- secure storage for session credentials.
- a strict print-job state machine.
- SHA-256 hashes for downloaded and sliced artifacts.
- Moonraker REST for files.
- Moonraker WebSocket JSON-RPC for live status.
- upload-only before final approval.

Do not begin with native MakerWorld API screens. Deliver the WebView path first.

## Non-negotiable safety rules

Never:

- start a print after download.
- start a print after slicing.
- auto-start a queued print.
- silently guess filament mappings.
- preserve downloaded machine start or end G-code.
- preserve foreign machine dimensions or motion limits.
- overwrite an existing printer file without approval.
- reuse approval after a setting, file, printer or filament change.
- start while the camera image is stale or unavailable.
- expose Moonraker to the public internet through router port forwarding.
- put passwords, cookies, access tokens or private IP details in logs.
- let AI logic directly issue physical printer commands.

Every start approval must bind to:

- printer identifier.
- uploaded filename.
- G-code SHA-256.
- job revision.
- filament and toolhead mapping.
- operator action.
- approval timestamp.

A changed value invalidates approval.

## Licence rules

Helix and the native U1 slicer use AGPL-3.0-or-later.

Keep:

- source availability.
- copyright notices.
- third-party notices.
- licence files.
- attribution.

Do not copy code from MkWorld2Snap into a commercial project. Its PolyForm Noncommercial licence restricts commercial use.

Use Crossprint and MkWorld2Snap as behavioural references unless licence compatibility has been checked for each copied section.

## Development rules

1. Inspect before editing.
2. Build the untouched base first.
3. Record baseline build results.
4. Work in small vertical slices.
5. Add tests with each behavioural change.
6. Keep printer-affecting code narrow and deterministic.
7. Keep MakerWorld behind a provider interface.
8. Avoid broad refactors during feature delivery.
9. Preserve existing native Android slicer files.
10. Do not run `expo prebuild --clean` without a reviewed recovery plan.
11. Keep `main` releasable.
12. Use descriptive commits.
13. Document assumptions.
14. Fail closed when printer state is unknown.
15. Prefer visible errors over silent fallback.

## Initial delivery target

Complete these items first:

### Stage A, repository baseline

- inspect repository.
- identify package manager and build commands.
- identify the native slicer module.
- identify Moonraker REST and WebSocket services.
- identify current MakerWorld share handling.
- run TypeScript checks.
- run existing tests.
- build a debug Android APK.
- install on a connected ARM64 Android device when available.
- produce `docs/BASELINE_AUDIT.md`.

Do not change product behaviour during Stage A.

### Stage B, architecture scaffolding

Add:

```text
services/makerworld/ModelSourceProvider.ts
services/makerworld/MakerWorldWebViewProvider.ts
services/makerworld/MakerWorldUrlParser.ts
services/import/ThreeMfSecurityScanner.ts
services/jobs/PrintJobMachine.ts
services/security/FileHash.ts
```

Add tests before wiring screens.

### Stage C, MakerWorld WebView MVP

Add an Explore tab with:

- MakerWorld WebView.
- persistent login session.
- back, forward, refresh and open-current-model controls.
- model and profile URL detection.
- Android download interception.
- progress and failure state.
- handoff into the current slicer import flow.

Do not rebuild MakerWorld search natively during this stage.

## First response expected from Claude Code

Before making edits, return:

1. repository summary.
2. current build system.
3. native module risks.
4. licence findings.
5. existing features worth retaining.
6. exact Stage A commands.
7. likely files touched during Stage B and Stage C.
8. a short implementation order.

Then perform Stage A.

Continue without asking broad preference questions. Stop only for a decision where proceeding risks data loss, licence breach or physical printer safety.
