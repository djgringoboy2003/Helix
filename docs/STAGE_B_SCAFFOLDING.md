# Stage B — Architecture Scaffolding

> **Historical record of Stage B.** Two forward-looking statements below are
> now resolved: `FileHash.setFileHasher()` gained its native caller at
> `40af7f4`, and the call sites this document says "will be re-routed" were
> re-routed at `3dd64c4`.

Domain layer for the Snapmaker U1 MakerWorld workflow, added per `CLAUDE.md`
Stage B and Phase 2 of `docs/IMPLEMENTATION_BACKLOG.md`.

Everything here is **new and additive**. No screen, native module or existing
service was modified, so app behaviour is unchanged from the Stage A baseline
(`403208a`). Wiring happens in Stage C and later phases.

## What was added

| File | Purpose |
|---|---|
| `services/security/Sha256.ts` | Streaming SHA-256; the identity every artifact and approval binds to |
| `services/security/Base64.ts` | Base64/UTF-8 byte conversion without `atob`/`Buffer` |
| `services/security/FileHash.ts` | File-level hashing over `expo-file-system`, with a replaceable backend |
| `services/jobs/JobErrors.ts` | Structured error codes and the `GateResult` type used by every gate |
| `services/jobs/PrintJobTypes.ts` | Job, artifact, filament-mapping and approval data model; `filamentMapHash` |
| `services/jobs/PrintJobMachine.ts` | Transitions, guards, revision rules, approval invalidation, start gate |
| `services/jobs/ApprovalService.ts` | Start-approval creation, binding validation, camera freshness |
| `services/jobs/PrintJobRepository.ts` | Persistence and restart recovery over a storage interface |
| `services/jobs/AsyncStorageJobStorage.ts` | AsyncStorage backend for the repository |
| `services/makerworld/ModelSourceProvider.ts` | Provider interface and registry |
| `services/makerworld/MakerWorldUrlParser.ts` | Host-anchored MakerWorld URL recognition |
| `services/makerworld/DownloadHostPolicy.ts` | HTTPS host allowlist, redirect/size limits, filename sanitising |
| `services/makerworld/MakerWorldWebViewProvider.ts` | WebView provider implementation over a bridge interface |
| `services/import/ZipDirectory.ts` | ZIP central-directory reader (metadata only, no inflation) |
| `services/import/ThreeMfSecurityScanner.ts` | 3MF archive safety scan against configurable limits |
| `services/featureFlags.ts` | Feature flag mechanism, with locked safety flags |

## Decisions worth knowing

### Test framework: extended the existing runner, did not adopt Jest

Section 2 of `docs/BASELINE_AUDIT.md` flagged this as a decision to make before
Stage B. Helix has no Jest/Vitest — `scripts/check-regressions.js` transpiles
`.ts` on the fly and asserts directly, and CI calls it as
`npm run test:regressions`.

Adopting Jest would have meant a new dependency, a Babel/Metro-aware config, and
a second CI command, for a repository whose existing 71 tests do not need it.
Instead the loader and `test()` helper moved to `scripts/test-harness.js`, which
now also discovers `tests/unit/*.test.js`. `check-regressions.js` keeps its 71
original tests inline and unchanged; CI is untouched.

`test()` now registers rather than runs, so suites can be async. First failure
still aborts the run with a non-zero exit code, as before.

Unit suites are `.js` requiring `.ts` sources directly. The sources are still
strictly typechecked by `tsc --noEmit`; the test files are not, which is the
same trade the existing runner already made.

### SHA-256 is implemented in this repository

React Native has no `crypto.subtle`, and a start approval binds to a G-code
hash. Putting that primitive behind a native dependency would place a
safety-critical value outside this repo's test suite, so it is implemented here
and verified against the NIST vectors and against Node's `crypto` across
padding boundaries and chunk sizes.

It is streaming, so a large G-code file never sits in memory at once. It is also
pure JavaScript and therefore not fast — roughly a second per 10 MB on a phone.
`FileHash.setFileHasher()` exists so `HelixSlicerModule` can supply a native
digest later without any caller changing; that is a performance change, not a
correctness one.

### The upload/start separation is structural, not a convention

There is no transition from `uploaded` to `starting` in the table. Reaching
motion requires `uploaded → awaiting_start_approval → start_approved →
starting`, and `start_approved` can only be entered through
`grantStartApproval`, which validates a full approval record first. A test
asserts the absence of the shortcut directly.

### Revision changes rewind, they do not just increment

Anything that could change the bytes reaching the printer — new source,
prepared file or G-code, changed profile, filament mapping or printer — bumps
the revision, discards any approval, invalidates downstream identities, and
rewinds the job to the earliest step that must be redone. Recording an upload
and attaching a thumbnail do not, because neither changes what gets printed.

Once a job is `starting`, `printing`, `paused` or terminal, every edit is
refused outright (`job/revision-locked`) rather than rewound: rewinding a job
the printer is acting on would leave the record describing something other than
what is running.

### Recovery never restores an operator

An approval means "the bed is clear and I am watching now". After process death
that claim is false, so `start_approved` recovers to `awaiting_start_approval`
with the approval dropped, and any expired approval is dropped from any state.

A job interrupted at `starting` recovers to `failed`. Whether the printer began
moving is unknowable from the app side, and `docs/SAFETY_AND_TESTING.md`
requires unknown state to fail closed. Live printer status is still readable
through the existing Printer tab; it is the *job record* that refuses to guess.

### Camera failures have their own error codes

`camera/unavailable`, `camera/stale`, `camera/printer-mismatch` and
`camera/revision-mismatch` are separate from the `approval/*` codes because the
operator's fix differs: refresh the view rather than re-approve the job.

### `camera_approval_required` is a locked flag

Feature flags default unsafe and experimental paths to off, as the architecture
requires. `camera_approval_required` additionally cannot be changed at runtime:
a stored value able to switch the camera check off would be an escalation path
via whatever wrote it. `resolveFeatureFlags` discards any override targeting it.

### The URL parser is stricter than the existing helper

`extractMakerWorldDesignId` in `services/makerWorld.ts` matches anywhere in a
string, so `https://evil.example/makerworld.com/models/1` satisfies it.
`MakerWorldUrlParser` anchors on the host and rejects look-alike domains,
userinfo tricks (`https://makerworld.com@evil.example/`), non-HTTPS schemes and
non-443 ports. Both exist for now; the old helper goes when its call sites move
behind the provider interface in Stage C.

### The 3MF scanner never inflates anything

It reads only the ZIP central directory, so a decompression bomb is caught from
its declared expansion ratio rather than by running out of memory. XML
well-formedness and entity expansion are explicitly *not* checked here — they
belong to `ThreeMfInspector`, the component that actually parses the model.
This scanner decides whether the archive is safe to open at all.

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` | **Pass**, no errors |
| `npm run test:regressions` | **Pass**, 192 assertions (71 pre-existing + 121 new), exit 0 |
| `npx eslint . --quiet` | **Pass** for all Stage B files |
| `cd android && ./gradlew assembleDebug` | **Pass** — see below |

`eslint` still reports 5 `import/no-unresolved` errors in `functions/src/index.ts`.
These are pre-existing and environmental — `functions/node_modules` is not
installed locally, and CI installs it separately. Confirmed by re-running the
lint with all Stage B changes stashed: the same 5 errors appear.

`eslint.config.js` gained one block declaring Node globals for `scripts/**/*.js`
and `tests/**/*.js`, which run under Node rather than Metro. No rule changed.

## Deliberately not done in Stage B

- **No screen wiring.** `CLAUDE.md` says to add tests before wiring screens.
  Nothing in `app/` imports any of this yet.
- **No change to the three ungated `startPrint` call sites**
  (`app/(tabs)/slicer.tsx:892`, `app/(tabs)/index.tsx:450`,
  `app/(tabs)/files.tsx:278`). Section 5 of `docs/BASELINE_AUDIT.md` identifies
  this as the highest-blast-radius change in the backlog. `PrintJobMachine` and
  `ApprovalService` now provide the path those call sites will be re-routed
  through in Phases 8–9, but re-routing a shipped, user-relied-upon flow is its
  own reviewed change and is flagged before it is attempted.
- **`ThreeMfInspector`, `U1ProjectPreparer`, `SlicerService`, `U1MoonrakerClient`
  and `U1PrintService`** — Phases 4–9. `StartGateContext` in `PrintJobMachine`
  defines the interface `U1PrintService` will have to satisfy.
- **The two duplicate MakerWorld download paths** (native OkHttp in
  `HelixSlicerModule.kt`, JS WebView hooks in `app/makerworld-download.tsx`)
  are still both present. `MakerWorldWebViewBridge` is the seam they consolidate
  behind in Stage C; Stage B did not add a third.
- **The `Explore` tab question** from section 9 of `docs/BASELINE_AUDIT.md` is
  still open. It is a product decision, not a technical one, and the provider
  interface does not depend on the answer.
