# Phase 4 — Unified imports

Implements Phase 4 of `docs/IMPLEMENTATION_BACKLOG.md` on top of Stage C
(`957843d`).

Helix had four working doors into the Slice tab and no shared checkpoint between
them. `ThreeMfSecurityScanner` was written in Stage B, fully tested, and **called
by nothing** — every downloaded archive reached the native slicer with nothing
having looked inside it. This phase makes one funnel and puts the scanner in it.

## What was added

| File | Purpose |
|---|---|
| `services/import/ImportCoordinator.ts` | The single import path, and the order its gates run in |
| `services/import/ImportTypes.ts` | `ImportRecord`, attribution, source kinds, error codes |
| `services/import/ImportLibrary.ts` | SHA-256-keyed library, in-memory and persistent |
| `services/import/ThreeMfInspector.ts` | What is inside an archive, from its index alone |
| `services/import/ExpoImportIo.ts` | The real file system and AsyncStorage behind the above |
| `tests/unit/importCoordinator.test.js` | 31 assertions |
| `tests/unit/threeMfInspector.test.js` | 22 assertions |
| `tests/unit/helpers/zipBuilder.js` | Shared ZIP builder for archive-level tests |

Modified: `app/(tabs)/slicer.tsx` (import handoff only), `app/(tabs)/explore.tsx`
(one `setMwDownload` call), `services/mwBus.ts` (two optional fields).

## The funnel

```text
file picker  ─┐
Android share ─┤
open-with     ─┼─→ ImportCoordinator ─→ Slice tab
MakerWorld    ─┘
```

All four now call `getImportCoordinator().import(...)`. The gates run in this
order, and the order is the design:

```text
name → type → size → hash → dedupe → scan → inspect → record
```

- Cheap rejections come first. An unsupported type is refused before the file is
  even stat-ed.
- Nothing is opened as an archive before the index has been judged safe to read.
- **Dedupe sits before the scan**, because a hash already in the library was
  scanned when it was first admitted. Re-scanning identical bytes buys nothing.
- Failure is always a returned `rejected` outcome — never a thrown error, never a
  silent pass-through. `CLAUDE.md` rule 15.

## Decisions worth knowing

### The inspector never inflates anything

`ThreeMfSecurityScanner` judges the container; `ThreeMfInspector` judges the
payload. Both read **only the ZIP central directory**.

That is not a limitation dodged, it is the finding: every question Phase 4 asks
of an import — missing geometry, geometry-only, pre-sliced-only, multi-plate — is
decidable from entry *paths*. So the import path never has to decompress bytes
from an untrusted source in order to classify it.

Reading part *contents* needs a DEFLATE implementation and belongs to
`U1ProjectPreparer` in Phase 5, which is the component that actually parses
those parts.

### Thumbnails were not reimplemented

The backlog lists "thumbnail extraction". `HelixSlicerModule` already does it —
`getModelPlates` returns a `ModelPlate[]` carrying a rendered thumbnail per
plate, and `extractPlate` repacks one. Writing a JS thumbnail extractor would
have meant a JS inflate and a second implementation of shipped native
behaviour, against development rules 8 and 9.

The inspector instead records the plate *paths* it found, so the picker knows how
many plates exist and which have G-code before the native call is made.

### Attribution comes from the page, not from the archive

Creator and licence are recorded from the `ModelReference` the provider captured
at download time, and travel to the Slice tab on `mwBus`. They are deliberately
not read from metadata inside the 3MF: that metadata is self-declared by an
untrusted file, and would be attribution the operator has no reason to trust.

Every attribution field is nullable. A file from the Downloads folder genuinely
has no creator, and recording that it is unknown beats inventing one.

### `pre-sliced-only` is rejected, and is caught one layer earlier than expected

A 3MF holding only foreign G-code has nothing to retarget, and the safety rules
forbid preserving another machine's G-code, so there is nothing usable in it.

In practice the scanner catches it first: `3D/3dmodel.model` is a required OPC
part, so an archive without geometry fails `archive/missing-critical-path` before
the content inspection runs. The inspector's own rejection is defence in depth
and is tested directly. Both behaviours are asserted, and the coordinator test
says which gate fires.

A stub `3dmodel.model` with no real mesh cannot be detected without inflating it;
the native slicer reports that case.

### The hash is taken once, not twice

`MakerWorldWebViewProvider` already hashes what it writes, so the Slice-side
import would have hashed the same file a second time — about a second per 10 MB,
on a file that cannot have changed in between. `ImportRequest.knownSha256` lets a
caller that hashed these exact bytes supply the digest; anything that is not a
well-formed digest is ignored and the file is hashed.

This is an import-identity shortcut and nothing more. What a start approval binds
to is the hash of the **sliced G-code**, taken later, and never reused from here.

### Explore hands off; it does not import

The Explore tab downloads and passes the file to Slice, exactly as before. It
does not run the coordinator itself. Putting the funnel at the point where all
four doors converge is what makes it a funnel — and it means the *older*
`app/makerworld-download.tsx` flow, which is shipped and which nothing in Stages
B or C touched, is now scanned too, without editing it.

## Behaviour that changed for users

This is the part to review carefully. Files that previously reached the slicer
now get refused:

| Input | Before | Now |
|---|---|---|
| Corrupt or non-archive `.3mf` (e.g. a saved sign-in page) | Reached the slicer, failed there | `import/archive-rejected`, with the reason |
| Archive with traversal paths, symlinks, encryption, nested archives | Unscanned | Rejected |
| Compression bomb | Unscanned | Rejected from its declared ratio |
| 3MF with no geometry | Reached the slicer | `import/content-rejected` |
| File over 250 MB | Accepted | `import/too-large` |
| Non-model file type | Accepted by name | `import/unsupported-type` |
| Same bytes imported twice | Two independent loads | Second reports as a duplicate |

Every rejection is shown in the Slice tab's status line **and** as an alert, with
the specific reason — not a generic failure. Opening a file also now clears the
previously loaded model's plates, which the MakerWorld path previously left
behind.

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` | **Pass**, no errors |
| `npm run test:regressions` | **Pass**, 285 assertions (229 pre-existing + 56 new), exit 0 |
| `npx eslint` on all changed paths | **Pass**, 0 errors |
| `npx expo export --platform android` | **Pass** — 4.25 MB Hermes bundle |
| `cd android && ./gradlew assembleRelease` | **Pass** — `BUILD SUCCESSFUL in 1m 48s` |

`eslint` reports 5 pre-existing warnings in `app/(tabs)/slicer.tsx` (unused
variables and one `exhaustive-deps`), all in regions this phase did not touch.

### Phase 4 acceptance tests

`docs/IMPLEMENTATION_BACKLOG.md` names eight. All eight are covered.

| Test | Where |
|---|---|
| Duplicate file | Same bytes under a different name, and dedupe-before-scan |
| Corrupt ZIP | Corrupted central directory, and a non-archive body |
| Traversal path | `archive/path-traversal` through the coordinator |
| Missing geometry | `content/no-geometry`, and the scanner's required-part check |
| Unsupported compression | `archive/unsupported-compression` |
| Geometry-only file | Imports clean, no notices |
| Pre-sliced-only file | Rejected — inspector directly, scanner via the coordinator |
| Multi-plate file | Plates enumerated in order, `content/multi-plate` notice |

## Deliberately not done

- **No change to the three ungated `startPrint` call sites**
  (`app/(tabs)/slicer.tsx`, `app/(tabs)/index.tsx`, `app/(tabs)/files.tsx`).
  Still the highest-blast-radius item in the backlog, still Phases 8–9.
- **No `PrintJob` record at import.** The coordinator produces an `ImportRecord`
  with the SHA-256 a job will bind to, but creating the job belongs with the
  Phase 8–9 work that re-routes the start path.
- **No consolidation of the two MakerWorld download paths.** Both still exist;
  both now feed the same import. Retiring one still means editing a shipped flow.
- **No library UI.** `ImportLibrary.list()` is the basis for the "existing
  library item" entry point, which has no screen yet.
- **No XML parsing.** Entity expansion and well-formedness need inflation and
  belong to `U1ProjectPreparer` in Phase 5.
