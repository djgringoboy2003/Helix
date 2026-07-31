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

- `docs/CURRENT_STATE.md` — read this first. Where the project actually stands,
  what is next, and which shipped behaviour must not be refactored in passing.
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

**The workflow at the top of this file is built, end to end.** Stages A–C and
backlog phases 0–10 are complete, and phase 11 substantially so. The stage
descriptions below are kept as the record of what was asked for and what the
acceptance criteria were. **Do not redo them.**

Current position, and everything you need to pick the project up: read
`docs/CURRENT_STATE.md` first. What is left is listed there — none of it is
blocking, and the most valuable next work is not a backlog phase but exercising
the start gate's *refusal* paths on real hardware, which the test suite covers
and a device never has.

### Stage A, repository baseline — done

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

### Stage B, architecture scaffolding — done

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

### Stage C, MakerWorld WebView MVP — done

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

The build is complete, so neither "audit the repository first" nor "start the
next phase" is automatically the right opening. Instead:

1. Read `docs/CURRENT_STATE.md`.
2. Confirm the tree is green before changing anything — `npm run typecheck` and
   `npm run test:regressions` (currently 518 assertions).
3. Say what you are doing and which files you expect to touch.
4. Then work.

Continue without asking broad preference questions. Stop only for a decision where proceeding risks data loss, licence breach or physical printer safety.

## Things that have already bitten, and will again

- **`git status` is not the same as "it builds".** `.gitignore`'s unanchored
  `gcode/` rule silently kept `services/gcode/` out of the repository for a
  whole commit; every local check passed because the files were on disk. CI
  caught it and the failure went unread. If you add a directory, confirm git
  actually tracks it.
- **A permanently-red CI job is worse than no CI.** `Build APK` failed on every
  push for want of signing secrets the fork does not have, and that noise buried
  the real failure above. It now skips instead. Keep it that way: red must mean
  something.
- **Verify from a clean checkout, not the working directory.** A temporary git
  worktree plus a `node_modules` junction is the cheap way. Remove the junction
  with `rmdir` **before** deleting the worktree — `Remove-Item -Recurse` follows
  it and will delete the real `node_modules`.
- **Nothing may start a print except `startApprovedPrint`.** There were four
  start paths, one of them in Kotlin on the far side of the bridge. If you add a
  fifth, the gate is gone. `printer/print/start` should appear exactly once in
  the JS bundle and zero times in the compiled dex.
