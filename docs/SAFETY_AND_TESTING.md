# Safety and Testing Plan

## Safety boundary

The application controls heaters, motors and a physical build surface.

Treat every printer command as a safety-sensitive action.

AI-generated recommendations must not directly issue printer commands.

Deterministic application code owns printer actions.

## Allowed without final start approval

- read printer state.
- read temperatures.
- read files.
- show camera.
- inspect models.
- prepare models.
- slice.
- upload with print disabled.
- generate reports.
- request operator approval.

## Require explicit confirmation

- start print.
- heat bed.
- heat nozzle.
- move axes.
- home.
- dock or undock toolhead.
- load or unload filament.
- resume.
- cancel.
- emergency or alarm reset.
- execute unknown macro.

Pause may use a direct visible control, but record the operator action.

## Print start gate

The start gate should fail when any required check is unknown.

Required checks:

```text
printer identity matches
printer connected
Klipper ready
printer idle
camera frame fresh
operator confirms bed clear
G-code record matches job
job revision unchanged
uploaded filename exists
filament mapping unchanged
toolheads available
no blocking preparation warnings
approval not expired
```

## Camera freshness

Record:

- capture timestamp.
- printer identity.
- camera endpoint.
- job revision.

Do not reuse old gallery images.

Display capture time near the approval control.

## File integrity

Generate SHA-256 for:

- downloaded source.
- prepared 3MF.
- sliced G-code.

Record hashes in the job.

A new slice creates a new revision and clears old approvals.

## 3MF archive safety

3MF is a ZIP-based format.

Test against:

- path traversal.
- ZIP bombs.
- duplicate paths.
- oversized XML.
- invalid UTF-8.
- malicious entity expansion.
- malformed relationship files.
- missing content type records.
- unsupported encryption.
- nested archive abuse.

Use secure XML parsers with external entities disabled.

## G-code safety checks

Before upload:

- check extrusion extents.
- check Z range.
- check expected tool numbers.
- check maximum temperatures.
- check machine-start script source.
- check output printer profile.
- check bed dimensions.
- check unsupported commands.
- check file completeness.
- check slicer metadata.

Foreign downloaded machine G-code should never pass through to the final output.

## Test layers

### Unit tests

Fast deterministic tests for:

- parsers.
- URL handling.
- job state machine.
- hash binding.
- approval expiry.
- path validation.
- profile rules.
- filament mapping.
- error classification.

### Integration tests

Tests across:

- download to import.
- import to preparation.
- preparation to slice.
- slice to review.
- upload-only.
- approval gate.
- Moonraker mock server.

### Instrumented Android tests

Run on ARM64 hardware for:

- JNI slicer.
- foreground service.
- process recovery.
- WebView download interception.
- secure storage.
- file provider and share intents.

### Real U1 tests

Use a dedicated test checklist.

Never use unattended automated print starts during CI.

## Real printer checklist

### Connection

- valid LAN URL.
- invalid URL.
- printer offline.
- Wi-Fi drop.
- Tailscale fallback.
- Moonraker restart.
- Klipper restart.

### Upload

- small G-code.
- large G-code.
- collision.
- low printer storage.
- interrupted upload.
- server rejection.
- file list refresh.
- incorrect size.

### Start gate

- clean bed.
- occupied bed.
- stale image.
- camera down.
- printer busy.
- wrong printer selected.
- changed filament.
- changed settings.
- changed file.
- expired approval.

### Active print

- pause.
- resume.
- cancel.
- filament runout.
- thermal error.
- object skip.
- app background.
- app force-close.
- WebSocket loss.
- print completion.

## Fixture library

Store legal test fixtures with source and licence records.

Minimum fixture categories:

```text
single-colour Bambu 3MF
four-colour painted 3MF
per-volume colour 3MF
multi-object plate
multi-plate project
HueForge project
tree-support project
wipe-tower project
geometry-only 3MF
PrusaSlicer 3MF
Cura 3MF
STL
pre-sliced-only package
corrupt archive
path-traversal archive
large model
oversized model
0.2 mm project
0.4 mm project
0.6 mm project
0.8 mm project
```

## Regression policy

Every confirmed bug needs:

1. fixture or mock reproduction.
2. failing test.
3. fix.
4. passing test.
5. brief entry in changelog or release notes.

## Continuous integration

Pull requests should run:

```text
npm clean install
TypeScript check
JavaScript and TypeScript tests
Android lint
Gradle JVM tests
debug APK build
dependency review
secret scan
licence notice check
```

Native slicer instrumented tests belong in a separate workflow that targets an ARM64 device environment.

## Release gate

Do not release when:

- baseline tests fail.
- native slicer smoke test fails.
- approval binding test fails.
- upload-only test fails.
- archive-security tests fail.
- required licence notices are missing.
- app logs secrets.
- printer commands bypass domain guards.
