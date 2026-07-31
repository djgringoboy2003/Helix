# Current State

Where the project actually stands, for picking up work without re-deriving it.
Update this whenever a phase closes.

**Last updated:** 2026-07-31, after Phase 5.

## Orientation

This repository is a fork of `FatBoy721/Helix` (AGPL-3.0), working towards the
Snapmaker U1 MakerWorld workflow in `CLAUDE.md`. `origin` is the fork,
`upstream` is `FatBoy721`.

**Helix is not a blank base.** It ships a working on-device native slicer (JNI,
PrusaSlicer/Orca engine) and a working MakerWorld WebView login and download
flow, with real users via GitHub releases. Most remaining work is retrofitting
existing behaviour behind safety gates, not building new — see
`docs/BASELINE_AUDIT.md`.

## Done

| Stage | Commit | What |
|---|---|---|
| A — baseline audit | `403208a` | `docs/BASELINE_AUDIT.md`. No behaviour changes. |
| B — domain scaffolding | `add4de6` | `services/{security,jobs,makerworld,import}/`, feature flags, test harness. `docs/STAGE_B_SCAFFOLDING.md`. |
| C — MakerWorld WebView MVP | `75d5563` | Explore tab and its logic modules. `docs/STAGE_C_EXPLORE.md`. |
| CI fix | `850b733` | `android-baseline.yml` skips the APK build when `FIREBASE_CONFIG_B64` is absent. |
| C fix | `957843d` | `DownloadIo` returns HTTP status and content type, so a 403 or 418 page is no longer written to disk and hashed as a model. |
| 4 — unified imports | `683e32f` | `services/import/{ImportCoordinator,ImportTypes,ImportLibrary,ThreeMfInspector,ExpoImportIo}.ts`. `docs/PHASE_4_IMPORTS.md`. |
| 5 — U1 preparation | pending commit | `services/prepare/`, `U1ProjectRewriter.kt`, `PreparationReportCard.tsx`. `docs/PHASE_5_U1_PREPARATION.md`. |

Backlog phases 0–5 are complete except the two Phase 3 acceptance tests that
need a device and a real MakerWorld account (logged-in download, live navigation
history). Phase 1 (branding, icons, app identity) was **not** done — the app is
still `Helix` / `org.crabcore.u1control` / 1.2.8.

All four import doors — file picker, Android share, open-with, MakerWorld — now
run through `ImportCoordinator`, so `ThreeMfSecurityScanner` is finally called on
every archive. See `docs/PHASE_4_IMPORTS.md` for the list of inputs that are now
**refused** where they previously reached the slicer; that is the user-visible
change to review.

Downloaded projects are now retargeted for the U1 at import: the source
machine's bed, build height, motion limits and start/end/layer-change/
filament-change G-code are replaced from the bundled U1 profile before anything
can slice the file. See `docs/PHASE_5_U1_PREPARATION.md`, including what could
**not** be verified about the prebuilt engine's key precedence.

## Next

1. **Phase 6, filament mapping.** Read live `print_task_config`, show T0–T3,
   compare source material and colour against what is loaded, manual remap,
   mapping hash. The mapping hash is one of the values a start approval binds
   to, so this is a prerequisite for Phase 9.
2. **Phase 7** (slicing and review).
3. **Phases 8–9** are the high-risk pair; see below.

## The highest-risk item in the backlog

Three call sites run slice → upload → start as one continuous flow, triggered by
one confirmation tap:

- `app/(tabs)/slicer.tsx:892`
- `app/(tabs)/index.tsx:450`
- `app/(tabs)/files.tsx:278`

They have no camera-freshness check, no approval binding, and no hold-to-start —
none of the guarantees `CLAUDE.md` requires. This is **shipped,
user-relied-upon behaviour**, not a stub.

`PrintJobMachine` and `ApprovalService` already provide the gated path they must
route through, but re-routing them is its own reviewed change (Phases 8–9).
**Flag it explicitly before touching it; never refactor it in passing.**

## Known gaps and deferred work

- **Two duplicate MakerWorld download paths** still coexist: native OkHttp in
  `HelixSlicerModule.kt`, and the JS WebView hooks in
  `app/makerworld-download.tsx`. Explore did not add a third — it wraps the same
  technique behind `ModelSourceProvider` — but the Slice tab has not moved onto
  the provider yet. Doing that is what retires one path, and it means editing a
  shipped flow. Both now feed the same import, so neither is unscanned.
- **No job record at import.** Phase 4 produces an `ImportRecord` carrying the
  SHA-256 a job will bind to, but creating the `PrintJob` so that identity
  survives into the approval belongs with Phases 8–9.
- **No library screen.** `ImportLibrary.list()` exists and is persisted, but the
  "existing library item" entry point has no UI.
- **No thumbnail extraction in JS, deliberately.** The native module already
  does it (`getModelPlates`); the inspector records plate paths instead.
- **No in-app licence screen.** `LICENSE`, `ATTRIBUTION.md` and
  `THIRD_PARTY_NOTICES.md` are only reachable via the GitHub link. Pre-existing;
  tracked as Phase 11.
- `extractMakerWorldDesignId` in `services/makerWorld.ts` matches anywhere in a
  string, so `https://evil.example/makerworld.com/models/1` satisfies it.
  `MakerWorldUrlParser` is the host-anchored replacement; the old helper goes
  when its call sites move behind the provider.
- **`Build APK` CI is red on the fork** — it needs a release *keystore*, which
  the fork has no secrets for. Upstream's pipeline, deliberately left alone. The
  `release` job stays skipped, so nothing can publish from the fork.

## Working rules that are easy to get wrong

- **Never run `expo prebuild --clean`.** `android/` is committed and holds the
  custom slicer JNI code and a prebuilt `.so`. It is not generated.
- **Gradle needs PowerShell and Windows-form paths.** Git Bash POSIX paths are
  rejected. The pipeline can report exit 0 while Gradle exits 1 — check for
  `BUILD SUCCESSFUL` in the output, not the exit code.
- **Tests are a hand-rolled runner, not Jest:** `npm run test:regressions`
  (currently 229 assertions). Suites live in `tests/unit/*.test.js` and require
  `.ts` sources directly.
- **`npx expo export --platform android`** catches Metro resolution errors that
  `tsc` cannot, in about a minute — far faster than a Gradle build.
- **To see JS changes on the device, build `assembleRelease`.** The debug APK
  does not bundle JS and expects a Metro dev server, so it will show stale UI.
  Release falls back to the debug keystore when no release keystore exists.
- `android/local.properties` and `android/app/google-services.json` are
  gitignored, required to build, and already in place on the current machine.
  Do not recreate them.

## Design commitments worth not re-litigating

- **Upload and start are structurally separate.** `PrintJobMachine` has no
  `uploaded → starting` transition; reaching motion requires a validated
  approval record. A test asserts the shortcut's absence.
- **Revision changes rewind rather than increment**, discarding any approval.
- **Recovery never restores an operator.** `start_approved` recovers to
  `awaiting_start_approval`; a job interrupted at `starting` recovers to
  `failed`, because whether the printer moved is unknowable from the app.
- **`camera_approval_required` is a locked feature flag** — it ignores overrides
  entirely, so no stored value can switch the camera check off.
- **SHA-256 is implemented in this repository**, not delegated, so the primitive
  a start approval binds to stays inside this test suite.
- **The import funnel is at the Slice tab**, where all four doors converge — not
  at each door. That is what makes a check added once apply everywhere, and it
  is why the older `app/makerworld-download.tsx` flow is scanned without having
  been edited.
- **Import classification reads the ZIP index only**, never inflating an
  untrusted archive. Everything Phase 4 needed to know was decidable from entry
  paths.
- **No JavaScript inflate/deflate was ever written.** Phase 5 needed to rewrite
  a 3MF, and `java.util.zip` already does that correctly in Kotlin — so the
  *mechanism* is native and the *policy* is TypeScript, where the tests are.
- **Machine identity is defined by the bundled U1 profile**, not by a denylist:
  any key `snapmaker_u1.json` defines is taken from there, and unrecognised
  `machine_*`/`printer_*` keys are dropped. A denylist would rot; this does not.
- **Preparation happens at import, not at slice time**, because
  `HelixSliceRunner` is shared by the RN bridge and the prepare screen's own
  Slice button — sanitising at slice time from JS would leave that button
  bypassing it.
- **The test framework stays the hand-rolled runner.** Adopting Jest was
  considered and rejected in Stage B: new dependency, new config, second CI
  command, for tests that do not need it.
