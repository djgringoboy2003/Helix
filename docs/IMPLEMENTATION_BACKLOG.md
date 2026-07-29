# Implementation Backlog

## Phase 0, repository and licence audit

### Deliverables

- `docs/BASELINE_AUDIT.md`
- successful TypeScript check.
- successful existing tests.
- successful debug APK build.
- list of native Android files.
- list of existing Moonraker services.
- list of MakerWorld-related code.
- licence inventory.
- known baseline failures.

### Acceptance checks

- no product behaviour changes.
- build commands documented.
- baseline commit tagged or recorded.

## Phase 1, stable branded fork

### Work

- choose working app name.
- update display name and package identifiers with care.
- replace icons and splash assets.
- keep licence and attribution screens.
- add app version and build information.
- confirm U1 connection.
- confirm native slicer.
- confirm camera.
- confirm file list.
- confirm existing print controls.

### Tests

- clean install.
- upgrade install.
- reconnect after app restart.
- rotate screen during slicing.
- background and foreground transitions.

## Phase 2, domain scaffolding

### Work

- add `PrintJobMachine`.
- add persistent job repository.
- add artifact model.
- add SHA-256 service.
- add job revision rules.
- add approval invalidation.
- add state recovery.
- add structured error types.

### Tests

- every valid transition.
- every invalid transition.
- revision increment.
- approval invalidation.
- app restart recovery.
- parallel action rejection.

## Phase 3, MakerWorld WebView

### Work

- add Explore tab.
- embed MakerWorld.
- add back, forward and refresh controls.
- add external-open control.
- detect model and profile URLs.
- persist WebView session.
- surface login state.
- handle captcha page.
- intercept downloads.
- show progress.
- create `DownloadedModel`.
- hand off to import service.

### Tests

- logged-out flow.
- logged-in flow.
- navigation history.
- profile download.
- cancelled download.
- network loss.
- 403 response.
- 418 or captcha flow.
- large file rejection.
- invalid redirect rejection.

## Phase 4, unified imports

### Inputs

- MakerWorld download.
- Android share.
- Bambu Handy share.
- system file picker.
- Downloads folder.
- existing library item.
- direct supported URL.

### Work

- central import coordinator.
- deduplicate by SHA-256.
- secure filename handling.
- archive preflight.
- source detection.
- thumbnail extraction.
- metadata storage.
- creator and licence record.

### Tests

- duplicate file.
- corrupt ZIP.
- traversal path.
- missing geometry.
- unsupported compression.
- geometry-only file.
- pre-sliced-only file.
- multi-plate file.

## Phase 5, U1 preparation

### Work

- route Bambu files through existing sanitiser.
- preserve compatible colour paint.
- map profile data.
- remove foreign machine scripts.
- clamp unsafe settings.
- rebuild U1 profile identity.
- remove stale sliced output.
- generate conversion report.
- support profile selection.
- add warnings screen.

### Tests

Fixture set:

- single colour.
- four colour.
- painted colour.
- per-volume colour.
- multi-object.
- multi-plate.
- tree supports.
- brim.
- wipe tower.
- HueForge.
- 0.2 mm.
- 0.4 mm.
- 0.6 mm.
- 0.8 mm.
- oversized part.
- invalid range.
- foreign start G-code.

## Phase 6, filament mapping

### Work

- inspect live U1 `print_task_config`.
- display T0 to T3.
- compare source material to loaded material.
- compare source colour to loaded colour.
- manual remap.
- locked official spool handling.
- warning levels.
- mapping hash.

### Tests

- exact match.
- material mismatch.
- colour mismatch.
- empty head.
- duplicate mappings.
- manual spool swap plan.
- more than four project colours.
- RFID-locked colour.

## Phase 7, slicing and review

### Work

- foreground slicing.
- progress.
- cancel.
- recovery.
- G-code extent validation.
- thumbnail.
- 3D preview.
- layer view.
- critical settings summary.
- actual G-code metadata report.
- output SHA-256.

### Tests

- app background.
- app process death.
- low storage.
- native slicer failure.
- out-of-bounds G-code.
- cancellation.
- multi-plate extraction.
- high-memory model.

## Phase 8, upload-only

### Work

- printer readiness checks.
- storage check.
- collision policy.
- upload progress.
- byte-count verification.
- list refresh.
- printer metadata read.
- never start from upload call.
- job state update.

### Tests

- printer offline.
- busy printer.
- paused printer.
- filename collision.
- upload interruption.
- Moonraker restart.
- insufficient storage.
- mismatched byte count.

## Phase 9, safe start

### Work

- fresh camera frame.
- bed-clear prompt.
- hold-to-start control.
- approval record.
- approval expiry.
- state recheck.
- filament recheck.
- extruder map command.
- exact filename start.
- audit event.
- immediate cancel route.

### Tests

- stale camera.
- changed settings after approval.
- changed printer after approval.
- changed filament after approval.
- replaced G-code file.
- expired approval.
- printer starts another job.
- mapping command failure.
- start command failure.

## Phase 10, monitoring

### Work

- live progress.
- ETA.
- layer count.
- temperature cards.
- active toolhead.
- firmware error.
- pause.
- resume.
- cancel.
- skip object.
- camera.
- notification events.
- print history.

### Tests

- WebSocket disconnect.
- polling fallback.
- pause and resume.
- cancel.
- print error.
- filament runout.
- completion.
- app background notification.

## Phase 11, release quality

### Work

- accessibility labels.
- large text.
- dark and light appearance.
- tablet layout.
- privacy screen.
- licence screen.
- diagnostic export.
- crash-safe state.
- onboarding.
- first-run printer setup.
- release signing.
- GitHub Actions APK.
- Play Store policy review.

## Phase 12, native MakerWorld experiment

Start only after the MVP works.

### Work

- native search.
- model cards.
- model detail.
- profile list.
- bearer expiry.
- host allowlist.
- rate limits.
- WebView captcha fallback.
- feature flag.

### Exit rule

Disable the native path when MakerWorld changes break compatibility. The WebView path stays available.
