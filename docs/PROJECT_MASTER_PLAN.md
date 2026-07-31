# Project Master Plan

> **Specification, not status.** Written at Stage A and still accurate as a
> description of what the product is meant to be. The full user journey in
> section 94 onwards is now built end to end, and the job state machine in
> section 437 is implemented in `services/jobs/PrintJobMachine.ts` with the
> monitor in `JobMonitor.ts` closing it. For what exists today and what was
> deliberately left, read `docs/CURRENT_STATE.md`.

## Product goal

Create an Android application that gives Snapmaker U1 owners a phone-first workflow similar to Bambu Handy or the Snapmaker app, while keeping slicing and printer control local.

The user should browse MakerWorld, select a print profile, prepare the project for the U1, slice on the phone, inspect the output and send the job to the printer.

## Product principles

### Local first

Models, profiles, sliced output, history and printer traffic should stay local unless the user selects a remote connection method.

### Review before motion

Downloading, importing, preparing, slicing, uploading and printing are separate actions.

No physical action should happen before a final operator review.

### Preserve creator intent

Keep compatible geometry, object placement, colours, support intent and process choices.

Replace printer-specific or unsafe machine details.

### Fail visibly

Unknown profile values, unsupported colour counts, invalid archives and printer-state conflicts should produce clear errors.

Silent fallback risks a failed print or damaged machine.

### Replaceable MakerWorld access

MakerWorld does not expose a stable public app API for this use.

The first release should use a WebView and Android download interception.

A provider interface should isolate future native API work.

## Base project choice

Use `FatBoy721/Helix` as the base.

Helix already supplies:

- Expo and React Native application.
- U1 Moonraker client.
- real-time WebSocket state.
- file management.
- U1 controls.
- camera and remote screen.
- notifications.
- multi-printer switching.
- native Android slicing.
- Bambu 3MF support.
- MakerWorld share-to-slice.
- upload and print path.

Starting from Helix avoids rebuilding the hardest components.

## Supporting source roles

### `taylormadearmy/u1-slicer-for-android`

Primary source for native U1 slicing, Bambu 3MF preparation, profiles, viewers and JNI integration.

### `ELI7F/crossprint`

Accuracy reference for translating divergent Bambu Studio and Snapmaker Orca 3MF configuration dialects.

### `dlgambill/u1hub`

Reference for Moonraker file management, toolhead mapping, printer status, skip-object support, queue behaviour and remote-access safety.

### `bbolinger/snapmaker-u1-toolkit`

Reference for operator approval, upload-only workflow, camera review and hash-bound print starts.

### `Dakros66/MkWorld2Snap`

Workflow and interface reference for U1 retargeting, conversion reports and spool-specific tuning.

Do not copy restricted code without a licence review.

### `maziggy/bambuddy`

Reference for MakerWorld error handling, host validation, file-size limits, local library features and server-side slicing design.

### `licctvcctv/makerworld-3mf-downloader`

Reference for MakerWorld profile download flow, captcha response handling and session-based access.

## Full user journey

### 1. Printer setup

The user adds a U1 by:

- LAN discovery.
- manual Moonraker URL.
- optional Tailscale URL.
- connection test.
- camera test.
- printer identity check.

The app stores normal settings locally and stores credentials through Android secure storage.

### 2. MakerWorld browse

The Explore tab opens MakerWorld inside a controlled WebView.

Native controls surround the page:

- back.
- forward.
- reload.
- open model in app.
- download selected profile.
- share.
- open externally.

The app detects model IDs and profile IDs from navigation.

### 3. Download

The download service:

- checks HTTPS.
- checks final host.
- limits size.
- checks content type.
- records source URL.
- records creator and licence when available.
- generates SHA-256.
- avoids duplicates.
- stores the file in app storage.
- creates a print-job record.

### 4. 3MF preflight

The app treats 3MF as an untrusted ZIP archive.

Checks include:

- path traversal.
- absolute paths.
- excessive entry count.
- excessive expanded size.
- invalid XML.
- missing model geometry.
- unsupported encryption.
- unsupported compression.
- invalid dimensions.
- stale embedded G-code.
- foreign machine scripts.

### 5. Source detection

Classify the input as:

- Bambu Studio project.
- Snapmaker Orca project.
- PrusaSlicer project.
- Cura 3MF.
- geometry-only 3MF.
- STL.
- pre-sliced G-code package.

Editable geometry is the primary path.

### 6. U1 preparation

Keep:

- geometry.
- build-item placement.
- compatible painted colour metadata.
- compatible object and volume assignments.
- process settings judged safe.
- creator notes.
- source and licence metadata.

Replace or remove:

- foreign printer identity.
- machine start and end G-code.
- bed geometry.
- nozzle metadata when incompatible.
- kinematic limits.
- unsupported settings.
- foreign cloud-host fields.
- stale sliced caches.
- invalid ranges.
- unsupported array shapes.

Generate a conversion report.

### 7. Filament mapping

Show each source filament with:

- source name.
- material.
- colour.
- expected nozzle and bed temperatures.
- source slot.
- assigned U1 toolhead.
- loaded U1 material and colour.
- compatibility result.

Require operator input when mappings do not match.

### 8. Prepare and slice

The Prepare screen offers:

- plate selection.
- object list.
- quantity.
- placement.
- scale.
- orientation.
- layer height.
- walls.
- infill.
- supports.
- brim.
- process profile.
- filament profile.
- toolhead mapping.
- wipe tower.

Run slicing in an Android foreground service.

### 9. G-code review

Build the review from actual sliced G-code.

Show:

- plate image.
- interactive G-code viewer.
- object count.
- extents.
- layer count.
- estimated time.
- total filament.
- filament by slot.
- nozzle diameter.
- nozzle and bed temperatures.
- maximum speeds.
- maximum accelerations.
- supports.
- brim.
- wipe tower.
- warnings.
- output file hash.

Reject extrusion outside the U1 build area.

### 10. Upload-only

Upload with printing disabled.

Verify:

- selected printer is online.
- Klipper is ready.
- printer is idle.
- storage is sufficient.
- filename collision policy.
- upload byte count.
- printer file listing.
- metadata readability.
- output hash where the printer interface permits verification.

### 11. Final print approval

Show:

- exact filename.
- exact printer.
- current printer state.
- current toolhead materials.
- fresh camera frame.
- sliced preview.
- critical settings.
- warnings.

The user presses and holds the start control.

Bind approval to:

- job revision.
- printer.
- filename.
- G-code hash.
- filament map.
- timestamp.

Recheck all state before issuing the start command.

### 12. Monitoring

Display:

- status.
- progress.
- active layer.
- total layers.
- ETA.
- temperatures.
- active toolhead.
- camera.
- pause.
- resume.
- cancel.
- skip object.
- firmware error text.

Send local or configured remote notifications for:

- started.
- paused.
- resumed.
- filament runout.
- temperature fault.
- printer error.
- completed.
- cancelled.

## Main application tabs

```text
Home
Explore
Library
Printer
History
Settings
```

## Main workflow screens

```text
ModelDetails
ProfileSelection
DownloadProgress
ImportReview
PrepareModel
FilamentMapping
SliceProgress
GcodePreview
PrintReview
UploadProgress
StartApproval
ActivePrint
PrintResult
```

## Data model

### Printer

```text
id
name
lanUrl
remoteUrl
cameraUrl
firmwareVersion
printerModel
lastConnectedAt
capabilities
```

### DownloadedModel

```text
id
sourceProvider
sourceModelId
sourceProfileId
sourceUrl
title
creator
licence
downloadedAt
filePath
sha256
sizeBytes
thumbnailPath
```

### PrintJob

```text
id
modelId
state
revision
printerId
sourceArtifactId
preparedArtifactId
gcodeArtifactId
profileSelection
filamentMapping
warnings
createdAt
updatedAt
```

### PrintArtifact

```text
id
jobId
type
path
sha256
sizeBytes
createdAt
metadata
```

### PrintEvent

```text
id
jobId
type
timestamp
details
```

## Job state machine

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

Screens must request transitions through the state machine.

Screens must not edit state directly.

## MVP completion definition

The first release is complete when one Android phone performs this flow:

1. connect to a U1.
2. browse MakerWorld.
3. sign in.
4. select a profile.
5. download 3MF.
6. import the project.
7. prepare it for U1.
8. map filaments.
9. slice locally.
10. review actual G-code.
11. upload without starting.
12. display a fresh bed image.
13. receive explicit approval.
14. start the exact file.
15. monitor progress.
16. pause, resume or cancel.
17. receive a completion or failure notification.

## Deferred features

Leave these outside the first release:

- full native MakerWorld clone.
- Bambu Cloud account management.
- unattended print queue starts.
- AI-selected print settings.
- public internet relay.
- iOS release.
- farm scheduling.
- social features.
- bulk MakerWorld downloads.
- closed-source commercial release.
