# Phase 5 — U1 preparation

Implements Phase 5 of `docs/IMPLEMENTATION_BACKLOG.md` on top of Phase 4
(`683e32f`).

A MakerWorld 3MF is a **Bambu Studio project**. Its
`Metadata/project_settings.config` describes another machine completely: its bed
polygon, its build height, its motion limits, and its start, end, layer-change
and filament-change G-code. `CLAUDE.md` is explicit that none of it may survive:

> never preserve downloaded machine start or end G-code
> never preserve foreign machine dimensions or motion limits

This phase makes that true by construction.

## What was added

| File | Purpose |
|---|---|
| `services/prepare/U1ProjectPreparer.ts` | The policy: what is stripped, replaced, clamped, kept; the conversion report; the build-volume check |
| `services/prepare/U1Preparation.ts` | Sequencing and the fail-closed rules |
| `services/prepare/NativePrepareIo.ts` | The real native side behind it |
| `components/PreparationReportCard.tsx` | The warnings screen |
| `android/.../U1ProjectRewriter.kt` | The ZIP rewrite — mechanism only, no policy |
| `tests/unit/u1ProjectPreparer.test.js` | 33 assertions |
| `tests/unit/u1Preparation.test.js` | 15 assertions |

Modified: `HelixSlicerModule.kt` (three new bridge methods, all additive),
`services/nativeSlicer.ts` (their wrappers), `app/(tabs)/slicer.tsx`
(preparation after import, and the report card).

## The rule

The central rule is deliberately **not** a hand-maintained list of dangerous
keys:

> Any key the bundled U1 printer profile defines is a machine key, and its value
> comes from the U1 profile — never from the download.

`android/app/src/main/assets/orca_profiles/printer/snapmaker_u1.json` defines
127 keys. That set *is* the machine identity, so it can be the rule. A denylist
would rot the moment Bambu adds a setting; sourcing the answer from the U1's own
profile means a key this machine cares about is always taken from this machine's
profile.

Keys the U1 profile does **not** define are handled by prefix — `machine_`,
`printer_`, `printhost_`, `bbl_`, `bambu_`, `bed_custom_` — and dropped rather
than guessed at, because an unrecognised machine key from another vendor is
exactly the unknown state `CLAUDE.md` rule 14 says to fail closed on.

Everything else — infill, walls, supports, brim, prime tower, filament colours —
is the designer's intent and is kept.

## What this changes, and the honest limit on what was verified

Before this phase, a downloaded project's `project_settings.config` reached the
engine **with its foreign machine keys intact**. `HelixSliceRunner` builds a
`SliceConfig` carrying the U1's start and end G-code from the bundled asset, and
`SliceSettings3mfPatcher` merges the user's prepare-screen overrides into the
embedded config — but neither removes the source machine's own keys.

Whether the engine preferred the embedded values could not be determined from
this repository: `libprusaslicer-jni.so` is a prebuilt binary and its source is
not here. The in-tree comments point both ways, and are worth quoting because
they are the whole reason this was treated as unsafe:

- `SliceConfig.kt`: machine G-code is "populated from assets **for STL files (no
  embedded Snapmaker profile)**" — which says nothing about the 3MF case.
- `SliceConfig.kt`: some fields are applied "**after** `profile_keys[]`",
  implying embedded profile keys are applied and must be explicitly overridden.
- `SliceSettings3mfPatcher.kt`: "the native engine reads embedded profile keys
  instead of `SliceConfig` support fields when a Snapmaker profile is present."

So: embedded keys demonstrably win for at least some settings, and the machine
G-code case was unverifiable. Phase 5 makes the question moot — the foreign keys
are gone before the engine opens the file, so there is nothing left to prefer.

**This is not a claim that a foreign start G-code was previously being sent to
the printer.** It is a claim that nothing in this repository ruled it out, and
that the safety rules require ruling it out.

## Decisions worth knowing

### Policy in TypeScript, rewrite in Kotlin

Rewriting a 3MF means inflating and deflating ZIP entries. `java.util.zip`
already does that correctly and is already used for exactly this file by
`SliceSettings3mfPatcher`. Writing a JavaScript inflate would have meant
several hundred lines of security-critical code parsing untrusted input, to
duplicate a correct implementation that is already present.

So the split follows the one the codebase already uses for downloads and
imports: **the mechanism is native, the policy is TypeScript**, and the policy is
covered by `npm run test:regressions` rather than only by slicing something and
inspecting the result. `U1ProjectRewriter.kt` sets, deletes and drops exactly
what it is told to.

### Preparation happens at import, not at slice time

`HelixSliceRunner` is shared by the RN bridge **and** the prepare screen's own
Slice button. Sanitising at slice time from JavaScript would leave the prepare
screen's button bypassing it entirely.

Retargeting the file at import means both callers slice a file that was already
prepared, and there is no path around it — the same reasoning that put the Phase
4 import funnel where all four doors converge.

### Failure never falls back to the original file

A preparation that fails does not return a path. The unprepared file still
carries the source machine's G-code, so using it is precisely what the safety
rules forbid; the operator sees the refusal instead.

### A file with no foreign profile is left completely alone

A mesh, or a 3MF with no `project_settings.config`, is reported `not-needed` and
used unchanged. Writing a profile into a plain 3MF would switch it onto the
engine's embedded-profile path, which those files do not currently take — a
behaviour change for files that were never at risk. STL and plain-3MF slicing is
byte-for-byte unaffected by this phase.

### Clamps come from the U1 profile too

Layer-height limits are read from the profile's own `min_layer_height` /
`max_layer_height` (0.08–0.32 mm), not hardcoded. A project sliced for a 0.6 or
0.8 mm nozzle at 0.4–0.5 mm layers is brought to 0.32 mm and its nozzle becomes
the U1's 0.4 mm, so the two agree afterwards.

Temperature bounds (160–300 °C nozzle, 0–110 °C bed) are constants, because
temperature is a filament property and is not in the printer profile. They
mirror the range `HelixSliceRunner.parseMaterialProfiles` already clamps to.

A value that cannot be parsed as a number is **preserved, not clamped** —
guessing what `"nozzle_temperature": "default"` meant would be inventing a
temperature.

### Painted colour is untouched because it is not in this file

Per-triangle and per-volume paint lives on the mesh in `3D/*.model`. The plan
only ever names `project_settings.config` keys and sliced-output entries, so
there is no path by which paint could be rewritten. A test asserts that no
model part appears anywhere in a plan.

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` | **Pass**, no errors |
| `npm run test:regressions` | **Pass**, 333 assertions (285 pre-existing + 48 new), exit 0 |
| `npx eslint` on all changed paths | **Pass**, 0 errors |
| `npx expo export --platform android` | **Pass** — 4.27 MB Hermes bundle |
| `cd android && ./gradlew assembleRelease` | **Pass** — `BUILD SUCCESSFUL in 2m 33s` |
| On device, real Bambu project | **Pass** — 2026-07-31, device `53b451df`, release APK at `7bce4f8`. The retarget ran on a logged-in MakerWorld download and reported its replaced / removed / brought-into-range summary; the file then sliced correctly. |

The 5 `eslint` warnings in `app/(tabs)/slicer.tsx` are pre-existing, in regions
this phase did not touch.

The preparer tests run against the **real bundled U1 profile**, read from
`android/app/src/main/assets/`. The whole policy rests on "the U1 profile owns
these keys", so testing it against a stand-in profile would prove nothing about
the app. One fixture bug was caught this way: an early test asserted that a
foreign `machine_max_acceleration_x` of `20000` was replaced — but the U1's own
value is also `20000`, so the assertion passed while proving nothing.

### Phase 5 fixture coverage

`docs/IMPLEMENTATION_BACKLOG.md` names seventeen. All are covered as policy
cases; none required a binary 3MF fixture, because every one of them is a
question about `project_settings.config` content or object extents.

| Fixture | Covered by |
|---|---|
| Single colour, four colour | Filament lists preserved at both sizes |
| Painted colour, per-volume colour | Plans never name a model part |
| Multi-object, multi-plate | Layout keys preserved; plates handled at import |
| Tree supports, brim, wipe tower | Process settings preserved |
| HueForge | Four-colour list plus 0.08 mm layers, preserved |
| 0.2 / 0.4 mm | Layer heights in range are left alone |
| 0.6 / 0.8 mm | Layer height clamped to 0.32 mm, nozzle becomes the U1's |
| Oversized part | `checkFitsBuildVolume`, per axis, against the profile polygon |
| Invalid range | Negative layer height and temperature brought into range |
| Foreign start G-code | Replaced with the U1's; asserted not to contain the source's |

## Deliberately not done

- **The build-volume check is not yet wired to a screen.**
  `checkFitsBuildVolume` is complete and tested, but it needs per-object extents
  from `getObjectBoundingBoxes()`, which the prepare screen owns. Connecting it
  belongs with the prepare-screen work rather than the import path.
- **No profile *selection*.** The backlog lists "support profile selection" —
  choosing between U1 process profiles (0.08/0.16/0.20 mm etc.). Only one
  printer profile is bundled, so there is nothing to choose between yet.
- **No change to the three ungated `startPrint` call sites.** Still Phases 8–9.
- **`SliceSettings3mfPatcher` was left in place.** It now runs on an
  already-prepared file, which is harmless — it merges the user's own overrides.
  Folding it into the preparer would mean editing the shipped slice path.
