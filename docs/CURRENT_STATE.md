# Current State

Where the project actually stands, for picking up work without re-deriving it.
Update this whenever a phase closes.

**Last updated:** 2026-07-31, after Phase 11.

## Read this first if you are picking the project up

1. **The workflow in `CLAUDE.md` is built, end to end**, and verified on a real
   printer. There is no half-finished phase to resume.
2. Confirm the tree is green before touching anything: `npm run typecheck` and
   `npm run test:regressions` (**518 assertions**). `main` is pushed and CI is
   green.
3. The single most valuable outstanding work is **not** a backlog phase. It is
   exercising the start gate's refusal paths on hardware — see *What is actually
   left* below.
4. Before changing anything that touches a print, read *Design commitments worth
   not re-litigating* at the bottom. Several were arrived at the hard way.

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
| 5 — U1 preparation | `02e60a6` | `services/prepare/`, `U1ProjectRewriter.kt`, `PreparationReportCard.tsx`. `docs/PHASE_5_U1_PREPARATION.md`. |
| 6 — filament mapping | `7bce4f8` | `services/filament/`, `FilamentMappingCard.tsx`. `docs/PHASE_6_FILAMENT_MAPPING.md`. |
| 7 — slicing and review | `00821a8` | `services/gcode/`, `SliceReviewCard.tsx`. `docs/PHASE_7_SLICE_REVIEW.md`. |
| 8 — upload-only | `00821a8` | `services/upload/UploadService.ts`. `docs/PHASE_8_UPLOAD_ONLY.md`. Additive only. |
| 9 — safe start **and the cutover** | `3dd64c4` | `services/start/`, `services/printer/`, `StartApprovalDialog.tsx`, `useReprintApproval.ts`. `docs/PHASE_9_SAFE_START.md`. |
| gitignore repair | `5bbb3d1` | `services/gcode/` had never been committed; `main` could not build from a clean clone. |
| 10 — monitoring | `018cef6` | `services/jobs/JobMonitor.ts`, `hooks/useJobMonitor.ts`. `docs/PHASE_10_MONITORING.md`. |
| CI repair | `25edaf1` | `Build APK` skips instead of failing without signing secrets, so a red run means something. |
| 11 — licence + diagnostics | `66968a5` | In-app AGPL text with a drift test, redacted diagnostic export. `docs/PHASE_11_RELEASE_QUALITY.md`. |
| 11 — privacy screen | `fad986d` | Opt-in `FLAG_SECURE`, applied before the first frame. |

Backlog phases 0–10 are complete, and Phase 11 in part — see
`docs/PHASE_11_RELEASE_QUALITY.md` for the audit of what already shipped and
what was deliberately left. Phase 1 (branding, icons, app identity) was **not**
done — the app is still `Helix` / `org.crabcore.u1control` / 1.2.8.

## On-device verification, 2026-07-31

Phases 4–6 were exercised end to end on device `53b451df` (ARM64, `A065`) with
the release APK at `7bce4f8`, against a **real logged-in MakerWorld download**.
Confirmed by the operator:

1. The retarget ran and reported itself — `Retargeting … for the U1`, then the
   replaced / removed / brought-into-range summary.
2. The filament mapping card rendered, with a row per project colour and T0–T3
   chips.
3. The slice succeeded and the G-code preview was correct.

This also closes the Phase 3 acceptance test that needed a person, a phone and a
real account: **logged-in download**. Live back/forward navigation history is
still unexercised, and remains the one outstanding Phase 3 item.

Not covered by that run, and still unverified on device:

- The import **rejection** paths. No corrupt, traversal-carrying or
  geometry-free file was tried; those are covered by the suite only.
- Whether the mapping *affects* slicing — by design it still does not. Slicing
  uses the tab's existing `toolRemap` path. Phase 9 made the job's mapping
  describe that decision, bound the approval to it, and derived
  `SET_PRINT_USED_EXTRUDERS` from it, so the mapping now governs what the
  printer is told even though it does not govern the slice.

**Capturing a device run:** this phone's logcat ring buffer defaults to 256 KiB,
which holds roughly four minutes and had already rotated past the session. Run
`adb -s <id> logcat -G 16M` and `logcat -c` *before* the run; the setting resets
on reboot. `run-as` cannot read app storage — release builds are not
debuggable — so logs are the only route in.

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

The Slice tab now shows a filament mapping card: project colours against what is
physically on T0–T3, with warnings, a spool-swap plan, and a Confirm that binds
to the mapping hash a start approval will later check.

Both values a start approval binds to now exist: the **G-code SHA-256** from
Phase 7's review, and the **filament mapping hash** from Phase 6. The upload half
of the replacement flow exists and is tested. What does not exist is the
approved-start path.

## What is actually left

Nothing is blocking, and no phase is half-finished. In rough order of value:

**1. Exercise the refusal paths on hardware.** The pipeline is verified end to
end, but only the *happy* path. Every refusal — stale camera, swapped filament,
replaced file, expired approval, busy printer — exists only in the unit suite.
Those are the paths the whole design is for. Three are cheap to stage against a
real U1:

| To test | Do this | Expect |
|---|---|---|
| `start/printer-busy` | Start any print from Fluidd, then open the approval sheet | Refused before anything is touched |
| `start/filament-changed` | Pull a spool between ticking bed-clear and holding | Refused, naming the toolhead |
| `start/file-changed` | Delete or re-upload the file from Fluidd before holding | Refused, naming size or replacement |

**2. The Slice tab's own upload path, on a device.** The one device run went via
the native preview and the Files tab, so `uploadForApproval` — with its
collision prompt and byte-count verification — has not run against a real
printer.

**3. Time a large reprint.** The 28 MB case is unmeasured. The download alone is
~14 s on wifi, and the progress bar only tracks the download; the extent scan
and hash that follow are silent. If it feels broken, that is why.

**4. The remaining Phase 11 items**, each a piece of work in its own right
rather than a tidy-up: a light theme, a real tablet layout, a full accessibility
sweep.

**5. Phase 12**, native MakerWorld search. Explicitly gated on the MVP working
and optional by design — the WebView path stays regardless.

## The cutover is done

The three call sites that ran slice → upload → start from one tap are re-routed,
and a **fourth** start path that the previous notes did not know about — native
OkHttp in `HelixGcodePreviewActivity.kt` — has had its start call deleted, along
with the preference and extruder helpers that only it used.

Nothing in the app can now start a print except `startApprovedPrint`, and it
refuses without a validated `StartApproval`, a fresh bed image, a re-read of
printer state and filament, and a two-second operator hold. See
`docs/PHASE_9_SAFE_START.md` — particularly the section on why the G-code hash
is the one bound value that cannot be re-derived at start time, and what is
checked instead.

Phase 7's review is enforced from this change: a blocking finding disables the
upload button, `uploadSlicedGcode` refuses it independently, and the review is
re-run on the bytes actually being uploaded rather than reused from the card
(a re-slice or a timelapse injection produces a different file).

**Verified on device**, `53b451df` against a real U1 on 2026-07-31: the native
preview uploaded without starting, the file sat idle for 45 seconds, and the
print then started only after the operator saw a live bed image and held the
button. `applyPrintSetup` fired 0.4 s before the start with `EXTRUDERS=1`
derived from the toolpaths. The installed APK was taken apart to confirm the
trace could not have come from the old native code:
`printer/print/start` appears **zero** times across all four dex files and once
in the JS bundle. Full evidence in `docs/PHASE_9_SAFE_START.md`.

Still unexercised on device: the Slice tab's own `uploadForApproval` path,
Home's reprint of a large file, and every refusal path — nothing was
deliberately broken on the real printer.

## Known gaps and deferred work

- **Two duplicate MakerWorld download paths** still coexist: native OkHttp in
  `HelixSlicerModule.kt`, and the JS WebView hooks in
  `app/makerworld-download.tsx`. Explore did not add a third — it wraps the same
  technique behind `ModelSourceProvider` — but the Slice tab has not moved onto
  the provider yet. Doing that is what retires one path, and it means editing a
  shipped flow. Both now feed the same import, so neither is unscanned.
- **No job record at import — deliberately still open.** Phase 4 produces an
  `ImportRecord` carrying a SHA-256, but Phase 9 creates the `PrintJob` at
  `review_required`, not at import. The reprint paths genuinely have no source
  or prepared artifact, and fabricating hashes to satisfy the earlier guards
  would be the confident wrong answer the safety rules exist to prevent.
- **No active toolhead, skip-object or runout watching.** Nothing reads
  `active_extruder`, there is no `EXCLUDE_OBJECT` support, and filament runout
  exists only as a settings string and a notification event — nothing watches
  for it during a print. UI additions to a working surface; see
  `docs/PHASE_10_MONITORING.md`.
- **The filament mapping still does not drive slicing.** The Slice tab's
  `toolRemap` decides tools; the job's mapping *describes* that decision, binds
  the approval to it, and is what `SET_PRINT_USED_EXTRUDERS` is derived from.
  Replacing `toolRemap` outright is a refactor of shipped slicing behaviour.
- **A remapped reprint transfers the file three times** — download, remap,
  upload, download again to hash what landed. Accepted: reading back what
  actually landed is what verifies the upload end to end.
- **The reprint progress bar only tracks the download.** After it reaches 100%
  the extent scan and the JS SHA-256 still have to run, with no indication. On a
  28 MB file the download alone is ~14 s on wifi, so the silent stretch after it
  is likely to be the part that feels broken. Measure before redesigning.
- **The extent scan is still JavaScript**, and it reads the whole file through
  the same base64 chunk reader the hash used to. Phase 10 gave hashing a native
  digest, which removes about half the wait on a reprint; the scan stays in
  TypeScript because the G-code rules belong where the tests are.
- **No library screen.** `ImportLibrary.list()` exists and is persisted, but the
  "existing library item" entry point has no UI.
- **No thumbnail extraction in JS, deliberately.** The native module already
  does it (`getModelPlates`); the inspector records plate paths instead.
- **Dark theme only.** `constants/theme.ts` is a fixed dark palette threaded
  through every screen and the native activities; nothing reads
  `useColorScheme`. A light theme is a design decision and a wide refactor.
- **A complete accessibility sweep.** The safety-critical path is labelled;
  auditing every remaining control is worth a pass of its own.
- `extractMakerWorldDesignId` in `services/makerWorld.ts` matches anywhere in a
  string, so `https://evil.example/makerworld.com/models/1` satisfies it.
  `MakerWorldUrlParser` is the host-anchored replacement; the old helper goes
  when its call sites move behind the provider.
- **`Build APK` no longer fails on the fork.** It used to hard-fail on the
  missing release keystore, so *every* push was red — and that noise buried a
  real `Android baseline` failure (the missing `services/gcode`) for hours. It
  now reports and skips, as `android-baseline.yml` already did, and the
  `release` job is explicitly gated on an APK having been produced so the fork
  still cannot publish. This revises the earlier "upstream's pipeline,
  deliberately left alone" decision: the cost turned out not to be cosmetic.

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
- **Filament mapping proposes but never confirms**, and its confirmation is
  stored against the mapping hash, so a spool swapped at the printer withdraws
  it automatically — the same binding rule a start approval uses.
- **`unknown` is not `empty`.** A toolhead the printer has not described blocks
  the mapping rather than being assumed fine, and is never auto-suggested.
- **Preparation happens at import, not at slice time**, because
  `HelixSliceRunner` is shared by the RN bridge and the prepare screen's own
  Slice button — sanitising at slice time from JS would leave that button
  bypassing it.
- **The test framework stays the hand-rolled runner.** Adopting Jest was
  considered and rejected in Stage B: new dependency, new config, second CI
  command, for tests that do not need it.
- **Nothing is trusted from the approval screen.** Printer state, the file
  listing and the loaded filament are all re-read inside `startApprovedPrint`,
  immediately before the command. An approval is a claim about a moment.
- **The job enters `starting` between the two printer commands.** The toolhead
  map configures rather than moves, so a printer that refuses it leaves the job
  `start_approved` and retryable; only the start command justifies `starting`.
- **A failed start command is uncertain, not failed.** The request may have
  landed with the response lost, so `StartOutcome.uncertain` is true, the job is
  terminal, and no retry is offered.
- **`toolsUsed` comes from the toolpaths, never the header.** A four-filament
  project sliced to one colour still declares four filaments; building the
  extruder map from that would arm the wrong heads.
- **A reprint is a start.** There is no "we printed this before" exemption: the
  file is read back and hashed, because that is the only honest way to have a
  SHA-256 for bytes this app did not produce.
- **The bundled licence text is generated and drift-tested.** `LICENSE` and the
  notice files stay the source of truth; a test regenerates the module in memory
  and fails if it differs, because a stale licence is the text the app conveys.
- **The diagnostic report redacts by sweep, not by allowlist.** It also composes
  carefully — shapes rather than values — but the unconditional sweep over the
  finished text is the half that still works when someone adds a field.
- **The hold is two seconds on purpose.** A tap is something a thumb does by
  accident; that is also why there is no second "are you sure".
- **`standby` is a failure, not a completion.** Moonraker reports it after a
  cancel, an error recovery and a firmware restart alike, so reading it as
  success would write a success into the record for a print that failed. A job
  completes only when the printer says `complete`.
- **A faster digest has to earn it.** The native SHA-256 is installed only after
  reproducing the in-repo implementation's output on a deliberately awkward
  fixture, compared against that implementation *directly* rather than through
  `hashFile` — which dispatches to whatever is installed and would otherwise
  compare the native digest with itself.
