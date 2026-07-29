# Source Repositories and Licences

This file records the main source projects reviewed for the app plan.

## Main base

### FatBoy721/Helix

Repository:

`https://github.com/FatBoy721/Helix`

Role:

- Android U1 control app.
- React Native and Expo base.
- Moonraker client.
- live status.
- camera and remote screen.
- native slicing.
- MakerWorld share-to-slice.
- upload and print.
- notifications.
- multi-printer support.

Licence:

AGPL-3.0-or-later.

Action:

Fork this repository and retain its notices.

## Native slicer

### taylormadearmy/u1-slicer-for-android

Repository:

`https://github.com/taylormadearmy/u1-slicer-for-android`

Role:

- Kotlin and native C++ U1 slicer.
- Snapmaker Orca engine through JNI.
- Bambu 3MF sanitisation.
- multi-colour support.
- profile embedding.
- OpenGL model and G-code views.
- Moonraker upload.

Licence:

AGPL-3.0-or-later.

Action:

Retain licence, attribution and source access.

## 3MF translation accuracy

### ELI7F/crossprint

Repository:

`https://github.com/ELI7F/crossprint`

Role:

- translation between Bambu Studio and Snapmaker Orca 3MF dialects.
- field policy.
- vocabulary checks.
- type and range handling.
- colour mapping.
- filament preset mapping.
- project setting difference rebuilding.

Licence:

Review the current repository licence before copying code. Treat as a behavioural and testing reference until confirmed.

## U1 printer control

### dlgambill/u1hub

Repository:

`https://github.com/dlgambill/u1hub`

Role:

- Moonraker U1 file handling.
- upload progress.
- toolhead mapping.
- filament colour command.
- queue.
- printer-to-printer transfer.
- skip object.
- live status.
- safe remote access.

Licence:

MIT.

Action:

Reuse patterns with attribution where code is copied.

## Physical safety workflow

### bbolinger/snapmaker-u1-toolkit

Repository:

`https://github.com/bbolinger/snapmaker-u1-toolkit`

Role:

- upload-only workflow.
- G-code-derived review.
- fresh bed-camera approval.
- hash and revision binding.
- explicit print-start gate.
- monitoring.

Licence:

Review the repository licence before copying code. Treat the safety design as a reference.

## Desktop conversion workflow

### Dakros66/DOC-U1-Link

Repository:

`https://github.com/Dakros66/DOC-U1-Link`

Role:

- Bambu project conversion.
- U1 template injection.
- filament remapping.
- conversion inspector.
- whitelist model.

Licence:

GPLv3 according to its repository documentation.

## Newer desktop conversion application

### Dakros66/MkWorld2Snap

Repository:

`https://github.com/Dakros66/MkWorld2Snap`

Role:

- editable 3MF preparation.
- U1 profiles.
- conversion report.
- parameter review.
- spool tuning.
- folder automation.

Licence:

PolyForm Noncommercial 1.0.0.

Action:

Do not copy this code into a commercial product without separate permission. Study behaviour and interface ideas.

## MakerWorld download reference

### licctvcctv/makerworld-3mf-downloader

Repository:

`https://github.com/licctvcctv/makerworld-3mf-downloader`

Role:

- MakerWorld session-based download flow.
- profile instance download.
- captcha handling.
- rate-limit delay.
- browser integration.

Licence:

MIT according to repository documentation.

Action:

MakerWorld endpoints are undocumented. Keep access behind a replaceable provider and respect login, access restrictions and rate limits.

## MakerWorld service and library design

### maziggy/bambuddy

Repository:

`https://github.com/maziggy/bambuddy`

Role:

- MakerWorld URL handling.
- authenticated profile resolution.
- host allowlist.
- file limits.
- error separation.
- local print library.
- slicing workflow patterns.

Licence:

AGPL-3.0.

Action:

Retain AGPL obligations when copying covered code.

## Official U1 Moonraker fork

### Snapmaker/u1-moonraker

Repository:

`https://github.com/Snapmaker/u1-moonraker`

Role:

- official U1-specific Moonraker source.
- reference for available endpoints and U1 changes.

Licence:

Check the repository licence before copying implementation code.

## Licence policy for this project

The Helix-based application should stay open source under AGPL-3.0-or-later unless a qualified legal review finds a different compliant arrangement.

Keep:

- `LICENSE`.
- `THIRD_PARTY_NOTICES.md`.
- `ATTRIBUTION.md`.
- source links.
- copyright notices.
- visible licence screen.

For every imported section, record:

```text
source repository
source file
source commit
licence
changes made
date imported
```

Do not assume interface ideas create licence obligations, but do not copy source code without recording its licence.
