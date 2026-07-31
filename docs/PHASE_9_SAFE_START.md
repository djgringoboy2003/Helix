# Phase 9 — Safe start, and the cutover

Implements Phase 9 of `docs/IMPLEMENTATION_BACKLOG.md` on top of Phase 8
(`00821a8`), **and performs the cutover** that Phases 7 and 8 deliberately left
undone.

This is the change the backlog has been building towards, and the one flagged
since Stage A as the highest-blast-radius edit in the project. Read
`docs/PHASE_8_UPLOAD_ONLY.md` first if you have not: it explains why the halves
could not ship apart.

## What was added

| File | Purpose |
|---|---|
| `services/start/StartService.ts` | The approved-start path. The only code in the app that starts a print |
| `services/start/StartJob.ts` | Builds the `PrintJob` an approval binds to |
| `services/start/RemoteGcode.ts` | Reads a printer-held file back and reviews it |
| `services/printer/MoonrakerPrinterIo.ts` | Moonraker behind the upload and start interfaces |
| `components/StartApprovalDialog.tsx` | Live bed image, mapping, bed-clear, hold-to-start |
| `hooks/useReprintApproval.ts` | The shared reprint flow for Home and Files |
| `tests/unit/startService.test.js` | 41 assertions |

Modified: `app/(tabs)/slicer.tsx`, `app/(tabs)/index.tsx`, `app/(tabs)/files.tsx`,
`HelixGcodePreviewActivity.kt`, `services/gcode/GcodeReview.ts`,
`services/jobs/JobErrors.ts`, `services/moonraker.ts`,
`tests/unit/sliceReview.test.js`.

## There were four start paths, not three

`docs/CURRENT_STATE.md` named three. A fourth exists in Kotlin:
`HelixGcodePreviewActivity.sendToPrinter(alsoPrint = true)` uploaded and started
over raw OkHttp, with its own copy of the preference logic and no connection to
any of this. It bypassed every gate by construction, being on the other side of
the bridge.

All four are closed:

| Was | Now |
|---|---|
| `slicer.tsx` — slice → upload → start, one tap | Uploads, then the approval gate |
| `index.tsx` — `startPrint(filename)` | Reads the file back, hashes it, approval gate |
| `files.tsx` — remap → upload → start | Remaps and uploads, then the approval gate |
| `HelixGcodePreviewActivity.kt` — OkHttp upload → start | **Upload only.** The start call is deleted, not disabled |

The Kotlin change is a deletion rather than a flag: `applyPrintPreferences`,
`physicalUsedExtruders`, `returnToHomeWithPrintSuccess` and `moonrakerJson` went
with it, because the only thing that used them was the start. The pill is now
"Upload & Approve" and the file waits in the app.

## The order of the start, and why it is that order

```text
approved? → printer reachable → firmware ready → not busy
          → exact file present, same size, same mtime
          → filament re-read and still matching
          → full gate (approval bindings, camera, bed-clear, warnings)
          → toolhead map                    ← job still start_approved
          → [job → starting]
          → start command
          → [job → printing]
```

Nothing is trusted from the approval screen. Printer state, the file listing and
the loaded filament are all re-read inside `startApprovedPrint`, immediately
before the command goes out, because an approval is a claim about a moment and
the moment may have passed.

### The job enters `starting` between the two commands, not before

`applyPrintSetup` sends `SET_MAIN_STATE`, `SET_PRINT_USED_EXTRUDERS` and
`SET_PRINT_PREFERENCES`. Those configure; they do not move anything. So a
printer that refuses them leaves the job in `start_approved` — retryable, with
its approval intact — rather than in a state that claims the machine might be
running.

The transition to `starting` happens after that and before the start command,
so an app that dies mid-request recovers to `failed` and never assumes nothing
happened.

This was originally written the other way round, with `starting` entered before
both commands. It was wrong twice over: it made a recoverable configuration
failure terminal, and it left the persisted job disagreeing with the in-memory
one the screen would have retried from.

### A failed start command is *uncertain*, not failed

The request may have been received and the response lost. `StartOutcome` carries
`uncertain: true` for exactly this case, the job goes to `failed`, and the
message tells the operator to look at the printer. Offering a retry would risk a
second start on a machine that already took the first.

## What an approval binds to, and what is re-derived

`CLAUDE.md` requires the binding to cover printer, filename, G-code SHA-256, job
revision, filament and toolhead mapping, operator action and timestamp. All
seven are in `StartApproval`, and `validateStartApproval` re-derives every one
from live job state at start time. That machinery is Stage B's; Phase 9 is the
first caller.

**The G-code hash is the one value that cannot be re-derived at start time.** It
describes bytes that now live on the printer, and re-hashing them means pulling
the whole file back — which would not be atomic anyway, since the file could
change between the re-hash and the start. So the check that is actually made is:
the printer still lists **that exact filename**, at **that size**, with **that
modification time**, all captured when the upload was verified. A different file
of identical name, size and mtime is not a realistic accident.

Filename matching here is **case-sensitive**, unlike the upload collision check,
which folds case because the printer does. A start must name the file that was
approved character for character; a near-miss is a different file.

### The filament recheck is a real read, not a hash comparison

`recheckFilament` re-reads `print_task_config` and compares each mapped
toolhead's live material and colour against what the mapping recorded. A spool
swapped between approving and starting fails it. Comparison follows the rules the
mapping was built with — base material type, so `PLA Basic` still matches
`PLA Silk`, and colour normalised to `#RRGGBB`.

A head that stops reporting loaded filament fails too. `unknown` is not `loaded`.

## Reprints download the file. That is the check, not overhead.

Home's "print that again" and the Files tab both start files this app may never
have produced — from another slicer, another machine, or a version of Helix
older than the G-code review. There is no "we printed this before" exemption in
the safety rules, and only one honest way to get a SHA-256 for those bytes: read
them back and hash them.

The download also buys the extent scan, which is worth *more* here than on a
fresh slice. A file of unknown origin is precisely where a toolpath outside the
bed would come from.

The Files tab's remap path pays for this twice — download, remap, upload,
download again. That is a real cost on a 40 MB file and it is accepted
deliberately: reading back what actually landed verifies the upload end to end,
rather than assuming the bytes on the printer are the bytes that were written
locally.

## `SET_PRINT_USED_EXTRUDERS` now comes from the toolpaths

The scanner (`GcodeReview.ts`) gained `toolsUsed`: the toolheads that actually
*extrude*, tracked through bare `T<n>` commands.

This replaces reading the header's filament list, which lies in a way that
matters. A four-filament project sliced down to one colour still declares four
filaments; building the extruder map from that would demand four loaded heads
for a single-colour print and arm the wrong toolheads. A tool selected for a
temperature command and never extruded with is not a tool the print needs.

Matching is exact — `M104 T3 S200` and `TIMELAPSE_TAKE_FRAME` are not tool
changes.

## Phase 7's review is now enforced

It was displayed-only by design, because making it a gate meant editing the
shipped flow and Phases 8–9 were going to re-route that flow anyway.

Now:

- The Slice tab's button is **disabled** with "G-code did not pass review" when
  a blocking finding exists.
- `uploadSlicedGcode` refuses an unreviewed or failed slice, so the gate holds
  even if a screen forgets.
- The review is **re-run on the bytes about to be uploaded**, not reused from
  the card. This matters: `uploadForApproval` may re-slice for a tool remap and
  may inject timelapse macros, both of which produce a different file. Binding
  an approval to the card's earlier hash would bind it to bytes nobody is
  uploading.

## The approval screen

Built around the photograph, because that is what the safety rule is about. The
bed image is the largest element, re-fetched every 5 seconds, and its age is
shown as a number rather than implied. Past 60 seconds
(`DEFAULT_MAX_CAMERA_AGE_MS`) the start control disables rather than
disappearing, so the reason stays on screen.

`camera_approval_required` remains a **locked** feature flag — no stored value
can switch it off.

The confirmation is deliberately awkward. A tap is something a thumb does by
accident; a two-second hold is not. That is also why there is no separate "are
you sure": one considered action beats two reflexive ones. The bed-clear tick
covers the filament mapping too, which is displayed directly above it, so the
operator agrees to what will print rather than to an abstraction.

## Where jobs come from

`buildStartJob` creates the job at `review_required` and then **walks the real
transitions** to `awaiting_start_approval`. So a job reaching the approval screen
has satisfied every guard the machine enforces — valid hash, target printer,
recorded filename, complete confirmed mapping, no blocking warnings — rather than
having had its state assigned.

It starts at `review_required` rather than `created` because the reprint paths
genuinely have no source or prepared artifact: the file came off the printer, not
out of an import. Fabricating hashes for artifacts that do not exist, purely to
satisfy earlier guards, is the kind of confident wrong answer the safety rules
exist to prevent. `docs/CURRENT_STATE.md`'s "no job record at import" gap stays
open and honest.

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` | **Pass**, no errors |
| `npm run test:regressions` | **Pass**, 475 assertions (434 before, 41 new), exit 0 |
| `npx eslint` on all changed paths | **Pass**, 0 errors. `slicer.tsx`'s 5 warnings are pre-existing and unchanged |
| `npx expo export --platform android` | **Pass** |
| `cd android && ./gradlew assembleRelease` | **Pass** — `BUILD SUCCESSFUL` |

### On-device verification, 2026-07-31

Exercised on device `53b451df` (ARM64, `A065`) against a real U1 — Moonraker
1.4.0, `klippy_state: ready`, all four heads loaded. Confirmed by the operator
and corroborated by the printer's own logs.

The route taken was: slice in the app → native toolpath preview → **Upload &
Approve** → Files tab → approval sheet → hold-to-start → cancel.

```text
20:25:05  upload received from the phone      sv08-btt-eddy-mount…gcode (1.18 MB)
20:25:06  upload complete — nothing started
          ↓ 45 seconds, three file-list reads
20:25:51.391  SET_PRINT_USED_EXTRUDERS EXTRUDERS=1
20:25:51.393  SET_PRINT_PREFERENCES BED_LEVEL=1 …
20:25:51.789  Requesting Job Start, filename = sv08-btt-eddy-mount…gcode
20:28:13      Requesting job cancel
```

What that establishes:

1. **The native preview uploaded and did not start.** The filename carries no
   `_<epoch>` suffix, which only `deriveUploadName` produces —
   `buildPrinterUploadFilename` would have added one. The file then sat idle for
   45 seconds. The fourth start path is closed.
2. **The start went through the gate.** `applyPrintSetup` fired 0.4 s before the
   start command, in that order. The 45-second gap with three file-list reads is
   the approval flow: `prepare` listing files, the download and hash, then
   `StartService`'s own listing recheck immediately before the command.
3. **`EXTRUDERS=1` came from the toolpaths.** A single head, not the header's
   four-filament list — the `toolsUsed` change working on a real file.
4. **The camera and the hold are real.** The operator confirmed seeing the live
   bed image and holding the button for two seconds.
5. **`BED_LEVEL=1`** corroborates the Files-tab route: those preferences default
   to false and come from that dialog.

Because that trace would also fit the *old* native code, the installed APK was
taken apart rather than trusted:

| String | native dex | JS bundle |
|---|---|---|
| `printer/print/start` | **0** | 1 |
| `SET_PRINT_USED_EXTRUDERS` | **0** | 1 |
| `Upload & Print` | **0** | — |
| `Upload & Approve` | 1 | — |
| `Hold to start` | — | 1 |

There is exactly **one** reference to the start endpoint in the whole
application, and it is in JavaScript behind `startApprovedPrint`.

#### Not covered by that run

- **The Slice tab's own upload path.** `uploadForApproval` — with its re-review
  of the post-timelapse bytes, and `uploadSlicedGcode`'s collision and
  byte-count checks — has not run on device.
- **Home's reprint of a large file.** The 28 MB case is unmeasured. The raw
  download alone takes ~14 s on this wifi, and the progress bar only tracks the
  download, so the dialog will sit at "Checking the file 100%" through the
  extent scan and the JS SHA-256. No native hasher is installed —
  `setFileHasher` still has no caller.
- **Every refusal path.** Stale camera, swapped filament, replaced file, expired
  approval and the rest are covered by the suite only. Nothing was deliberately
  broken on the real printer.

### Phase 9 acceptance tests

All nine are covered.

| Test | Where |
|---|---|
| Stale camera | Old frame, no frame at all, and a frame from a previous job revision |
| Changed settings after approval | A real `setProfileSelection` rewinds the job out of `start_approved`; and a revision that disagrees with its approval record |
| Changed printer after approval | `activePrinterId` differs → `approval/printer-mismatch` |
| Changed filament after approval | Colour swap, material swap, and a head that stopped reporting |
| Replaced G-code file | Size change, mtime change at equal size, missing file, unreadable listing, and case-folded near-miss |
| Expired approval | Past `expiresAt`, and a clock that moved backwards |
| Printer starts another job | `printing`, `paused` any casing, unknown state, unreachable |
| Mapping command failure | Job stays `start_approved` and retryable; `startPrint` never reached |
| Start command failure | Job `failed`, `uncertain: true`, message says to check the printer |

Plus a structural test asserting `evaluateStartGate` is evaluated before
`io.startPrint` in the source, and that the start names `approval.filename` and
nothing else — so a later edit cannot move the command above the checks.

## Deliberately not done

- **No `PrintJob` at import.** Still Phase 4's `ImportRecord` up to the point a
  hash exists. See above for why the job starts at `review_required`.
- **The filament mapping still does not drive slicing.** The Slice tab's
  existing `toolRemap` path decides tools; Phase 9 makes the job's mapping
  describe *that* decision and binds the approval to it, and derives
  `SET_PRINT_USED_EXTRUDERS` from it. Replacing `toolRemap` outright is a
  refactor of shipped slicing behaviour and does not belong in a change this
  size.
- **Phase 6's card confirmation is not a hard prerequisite for uploading.** The
  start gate already refuses an incomplete or unavailable mapping, and the
  approval screen requires explicit agreement to the effective mapping, so
  demanding the card tap as well would add friction without adding a guarantee.
- **Approval expiry is not exercised live.** The screen grants and starts in one
  action, so the TTL protects stored and restored approvals rather than a live
  window. It is still checked on every start.
