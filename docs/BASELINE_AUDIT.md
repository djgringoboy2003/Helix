# Baseline Audit

> **Historical record of Stage A**, and the document that first flagged the
> three `startPrint` call sites as the highest-blast-radius change in the
> backlog. It was right, and it undercounted: a fourth start path existed in
> Kotlin. All four were closed at `3dd64c4` — see `docs/PHASE_9_SAFE_START.md`.

Stage A audit of the untouched `FatBoy721/Helix` fork, performed before any product behaviour changes, per `CLAUDE.md`.

- Fork: `https://github.com/djgringoboy2003/Helix` (cloned to a local working copy, `origin` remote)
- Upstream: `https://github.com/FatBoy721/Helix` (`upstream` remote)
- Baseline commit: `34f9a872315171797c54afcbc1d4097fa3da413c` — "Merge pull request #13 from FatBoy721/play-store-prep" (2026-07-25)
- App identity at baseline: name `Helix`, Android package `org.crabcore.u1control`, version `1.2.8` (versionCode 18)

## 1. Repository summary

Helix is a working, released React Native / Expo Android app for controlling a Snapmaker U1 (PAXX firmware) via Moonraker. It is **not a blank starting point** — it already ships:

- A Fluidd-style dashboard, multi-printer support, bed mesh, macros, console, file browser, history, timelapse, multiACE, remote screen, notifications (local + ntfy), LAN/Tailscale connectivity with failover.
- A full **on-device native slicer** (Snapmaker Orca / PrusaSlicer engine via JNI) with STL/3MF import, multi-plate handling, per-colour extruder remap, 3D model/G-code viewers, and Moonraker upload.
- **Working MakerWorld integration** that already covers most of what the project docs describe as future "Stage C" work: in-app WebView login with cookie capture, JWT capture, a WebView-based download flow with fetch/XHR hooking to grab the signed 3MF URL post-CAPTCHA, and a native (OkHttp) download path as an alternative. Share-to-app (`+native-intent.tsx`) is also wired.
- CI already in place (`.github/workflows/build-apk.yml`): PR validation (typecheck, lint, regression tests), and a release pipeline that builds a signed release APK and publishes a rolling GitHub release.
- Licence scaffolding already present and mostly accurate: `LICENSE` (AGPL-3.0), `ATTRIBUTION.md`, `THIRD_PARTY_NOTICES.md`.

This changes the shape of the project relative to `docs/PROJECT_MASTER_PLAN.md`'s assumption of building MakerWorld access "from scratch behind a provider interface" — a working (if ungated) implementation already exists and has real users via the GitHub releases page. The job is less "build the WebView MVP" and more "retrofit the existing MakerWorld/slice/print pipeline behind the safety gates and job state machine this project requires," being careful not to regress a shipped flow.

## 2. Build system and commands

Package manager: npm (`package-lock.json`, lockfileVersion 3). Node 22 LTS per project docs; CI uses Node 20/22 depending on workflow.

```bash
npm install                 # or npm ci
npm run typecheck           # tsc --noEmit
npm run test:regressions    # node scripts/check-regressions.js (custom TS-aware test runner, no Jest)
npx eslint . --quiet        # lint (not wired as an npm script; CI calls it directly)
cd android && ./gradlew assembleDebug --no-daemon   # debug APK
```

No Jest/Vitest — `scripts/check-regressions.js` is a hand-rolled runner that transpiles `.ts` on the fly with the TypeScript compiler API and calls `assert` directly. New unit tests for Stage B/C domain code should either extend this runner or introduce a real test framework; recommend deciding this explicitly before Stage B rather than assuming Jest.

Android native unit tests exist separately under `android/app/src/test/java/org/crabcore/u1control/slicing/` (JUnit/Kotlin: `GcodeFirstLayerGuardTest.kt`, `GcodeToolMapperTest.kt`), run via Gradle (`./gradlew testDebugUnitTest`), not via `npm run test:regressions`.

Local environment note: this machine's shell had no `JAVA_HOME`/`ANDROID_HOME` set and no `android/local.properties`. On this machine the values are `JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-17.0.17.10-hotspot` and `ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk`; Gradle needs the Windows form of these paths, so invoke `gradlew.bat` from PowerShell rather than exporting POSIX paths in Git Bash, which Gradle rejects as an invalid directory. Fixed for this session by adding `android/local.properties` (`sdk.dir=C:\Users\rober\AppData\Local\Android\Sdk`, gitignored) and exporting `JAVA_HOME`/`ANDROID_HOME` before invoking Gradle. A `google-services.json` (gitignored, see section 3) is also required at `android/app/` before any Gradle build — neither file is committed, so both are one-time local setup steps for anyone building this fork from scratch.

## 3. Baseline results

| Check | Result |
|---|---|
| `npm install` | Pass — 979 packages, 0 errors (38 known vulnerabilities reported by `npm audit`, pre-existing upstream, not addressed in Stage A) |
| `npm run typecheck` | **Pass**, no errors |
| `npm run test:regressions` | **Pass**, 71/71 assertions, exit 0 |
| `cd android && ./gradlew assembleDebug` | **Pass** (after resolving a Firebase config blocker — see below), `app-debug.apk` ~157 MB, `BUILD SUCCESSFUL in 4m 46s` |
| Install on connected ARM64 device | **Pass** — `adb -s 53b451df install -r app-debug.apk` → `Success`. Device: `53b451df`, model `A065`, `ro.product.cpu.abi=arm64-v8a` |

### Gradle build blocker (resolved)

First `assembleDebug` attempt failed:

```
Execution failed for task ':app:processDebugGoogleServices'.
> File google-services.json is missing.
```

`android/app/build.gradle` unconditionally applies the Google Services Gradle plugin and depends on `com.google.firebase:firebase-messaging` (`android/app/build.gradle:2,177-178`). `HelixSlicerModule.kt` uses it for real, in-use functionality — subscribing the device to an `"helix-announcements"` FCM topic and fetching an FCM token (`android/app/src/main/java/org/crabcore/u1control/slicing/HelixSlicerModule.kt:22,74-91`), which pairs with the `functions/` Cloud Functions backend (device-token registration + server-side print-event push, `functions/src/index.ts`) under Firebase project `helix-edba4` (`.firebaserc`) — owned by the upstream author, `FatBoy721`. This project's fork had no `google-services.json` for that or any Firebase project, and the upstream repo only supplies one via CI secrets (`FIREBASE_CONFIG_B64`) or a developer's own gitignored copy.

**Resolution**: the user registered a new Android app (`org.crabcore.u1control`) under their own existing Firebase project (`carvery-efficiency`, shared with an unrelated app, `com.carvery.efficiency`) via the Firebase Console, and placed the resulting `google-services.json` at `android/app/google-services.json` (confirmed gitignored via `.gitignore:18`, never committed). The rebuild then succeeded and installed cleanly. Worth knowing for later: FCM/`helix-announcements` on this build now lives inside the `carvery-efficiency` Firebase project/Firestore (`helixDevices` collection) alongside Carvery's own data — functionally fine (Firebase supports multiple apps per project), just worth remembering if project-level quotas, billing, or Firestore security rules ever need separating per-app.

`package-lock.json` picked up a trivial, harmless drift during `npm install` (lockfile's embedded `version` field was stale at `1.2.5` vs `package.json`'s `1.2.8`; npm corrected it to match). No dependency versions changed.

## 4. Native module risks

- **Custom native slicer is substantial and load-bearing**: `android/app/src/main/java/com/u1/slicer/` (JNI bridge, G-code parser/renderer, GL viewers, model/gcode packers) and `android/app/src/main/java/org/crabcore/u1control/slicing/` (Helix's integration layer: `HelixSlicerModule.kt`, `HelixSliceRunner.kt`, filament/tool mapping, G-code post-processors, MakerWorld downloader activity). Plus a prebuilt binary: `android/app/src/main/jniLibs/arm64-v8a/libprusaslicer-jni.so`.
- `android/` is **committed to git**, not generated by `expo prebuild`. CLAUDE.md's warning against `expo prebuild --clean` is correct and important here — a clean prebuild would very likely wipe or desync this custom native module, the JNI libs, and the Kotlin integration layer. **Do not run it.**
- `ios/` is prebuild-only and gitignored — no iOS native risk, but also no iOS parity; this project is Android-only per its own scope, consistent with that.
- The native module already owns MakerWorld cookie/JWT capture and a full native download path (`HelixSlicerModule.kt` lines ~880–1090), duplicating logic that also exists in JS (`services/makerWorld.ts`). Two independent MakerWorld download implementations (native OkHttp path and JS WebView-hook path) currently coexist — worth consolidating behind the `ModelSourceProvider` interface in Stage B rather than adding a third.

## 5. Unsafe / direct command paths (safety-critical finding)

This is the most important finding for `docs/SAFETY_AND_TESTING.md` compliance.

**The existing Slice tab (`app/(tabs)/slicer.tsx`, the `send`/preprocess handler around lines 780–908) already performs a single continuous flow: slice → upload → verify upload → apply print preferences → `api.startPrint()` — all inside one async function triggered by one user action (the print-preferences confirmation dialog).** Same pattern, simpler, in `app/(tabs)/index.tsx:450` (Home tab quick-print) and `app/(tabs)/files.tsx:278` (Files tab tap-to-print).

What it does have: an idle-state check before starting (`print_stats.state` must not be `printing`/`paused`), upload-then-verify before start, and a printer-preferences round-trip verification. What it does **not** have, relative to this project's non-negotiable rules:
- No separation between "upload" and "start" as distinct operator-gated steps — upload success flows straight into start.
- No fresh bed-camera check or operator bed-clear confirmation before start.
- No approval record bound to job revision / G-code hash / filament mapping / timestamp — nothing invalidates a "decision to print" if state changes between slicing and the (near-instant) start call.
- No hold-to-start gesture — the existing dialog is a normal tap-to-confirm.

This is a real, shipped, user-relied-upon flow (linked from GitHub releases), not a stub — it cannot simply be deleted. The recommended approach for later phases (Phase 8/9 in `docs/IMPLEMENTATION_BACKLOG.md`) is to introduce the new upload-only + approval-gated start path as the new default behind the job state machine, and treat the current one-shot `startPrint` calls as the exact three call sites (`slicer.tsx:892`, `index.tsx:450`, `files.tsx:278`) that need to be re-routed through `ApprovalService`/`U1PrintService` rather than calling `api.startPrint` directly. Flag this explicitly before touching it — it's the single highest-blast-radius change in the whole backlog.

No AI/LLM-driven code currently issues printer commands anywhere in the repo (confirmed by search) — that rule is not yet at risk, just worth keeping in mind as MakerWorld/slice automation grows.

## 6. Licence findings

- `LICENSE` = AGPL-3.0 (matches `docs/SOURCE_REPOSITORIES_AND_LICENCES.md` expectations). `package.json` also declares `"license": "AGPL-3.0-or-later"`.
- `ATTRIBUTION.md` and `THIRD_PARTY_NOTICES.md` already correctly credit `taylormadearmy/u1-slicer-for-android` and the underlying OrcaSlicer/PrusaSlicer engine (AGPL-3.0), including a documented Reddit permission thread for reuse. Good baseline to preserve verbatim.
- Gap: there is an in-app **About** card (`components/settings/AboutCard.tsx`) with links to GitHub/support/bug-report, but **no in-app licence/attribution screen** — `LICENSE`/`ATTRIBUTION.md`/`THIRD_PARTY_NOTICES.md` are only reachable by following the GitHub link out of the app. `docs/SOURCE_REPOSITORIES_AND_LICENCES.md` asks to keep "a visible licence screen"; this is pre-existing (not something Stage A broke) and is already tracked as a Phase 11 backlog item ("licence screen") — noting it here so it isn't lost.
- No code from `Dakros66/MkWorld2Snap` (PolyForm Noncommercial) or other restricted references found anywhere in the current tree.

## 7. Existing features worth retaining as-is

Everything in the feature list in section 1 — dashboard, multi-printer, bed mesh, macros, console, files, history, timelapse, multiACE, remote screen, notifications, theming/i18n, and the update-checker/APK-installer flow (`services/apkInstaller.ts`, `services/updateCheck.ts`) — is functioning, tested (in part, via the regression suite), and out of scope to change during Stage B/C except where a MakerWorld/slice/print-safety change specifically requires touching a shared file (e.g. the three `startPrint` call sites above).

## 8. Files likely touched in Stage B (architecture scaffolding)

New, additive, no existing-file edits expected other than wiring:

```text
services/makerworld/ModelSourceProvider.ts
services/makerworld/MakerWorldUrlParser.ts
services/makerworld/MakerWorldWebViewProvider.ts   (can likely wrap existing app/makerworld-download.tsx + app/makerworld-login.tsx logic rather than duplicate it)
services/import/ThreeMfSecurityScanner.ts
services/jobs/PrintJobMachine.ts
services/jobs/ApprovalService.ts
services/security/FileHash.ts
```

`services/security/FileHash.ts` should reuse `expo-file-system` (already a dependency) or an existing sha256 primitive rather than adding a new crypto dependency — none currently exists in JS; check for a `expo-crypto` addition vs. delegating to native (`HelixSlicerModule.kt` already does file I/O natively and could expose a hash method cheaply).

## 9. Files likely touched in Stage C (MakerWorld WebView MVP)

Given MakerWorld WebView + download already substantially exists, Stage C is more "wrap in the provider interface and job state machine" than "build new":

```text
app/makerworld-download.tsx      (existing — becomes the WebViewProvider's download implementation)
app/makerworld-login.tsx         (existing — session/login)
services/makerWorld.ts           (existing native-fetch path — reconcile with WebView path or keep as fallback behind the provider)
services/nativeSlicer.ts         (existing native bridge — MakerWorld cookie/JWT + download methods)
services/mwBus.ts, services/pendingModel.ts   (existing handoff plumbing into the Slice screen)
app/(tabs)/slicer.tsx            (handoff target; eventually the re-routed start-print call site)
```

An actual new "Explore tab" per the master plan doesn't exist yet — today MakerWorld access is reached via the Slice tab, not a dedicated tab. Decide explicitly whether Stage C adds a real Explore tab (per the plan) or keeps MakerWorld access inside Slice — this is a product decision, not purely technical.

## 10. Recommended small refactors (not yet done, flagging only)

- Consolidate the two MakerWorld download implementations (native OkHttp in `HelixSlicerModule.kt` vs. JS WebView-hook in `app/makerworld-download.tsx`/`services/makerWorld.ts`) behind the single `ModelSourceProvider` interface Stage B introduces, rather than leaving both as parallel undocumented paths.
- No SHA-256/hashing utility exists yet anywhere in the JS layer (`services/security/FileHash.ts` is genuinely new, not a rename).
- No feature-flag mechanism exists yet (`docs/TECHNICAL_ARCHITECTURE.md` suggests several, e.g. `makerworld_webview_enabled`). Needs to be introduced in Stage B before any gated behaviour ships.

## 11. Known blockers

None remaining. TypeScript, the regression suite, the debug APK build, and install onto a connected ARM64 device (`53b451df`, model `A065`) all pass as of this audit. Two one-time local setup steps are required on any machine building this fork from scratch (neither is committed, both are gitignored):

1. `android/local.properties` with `sdk.dir` pointing at the local Android SDK, plus `JAVA_HOME`/`ANDROID_HOME` exported before running Gradle.
2. `android/app/google-services.json` for a Firebase project with an Android app registered under `org.crabcore.u1control` (see section 3 for how this was obtained for this session).
