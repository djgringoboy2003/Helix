# Phase 7 — Slicing and review

> **Superseded in part by Phase 9.** This document says the review is
> "displayed, not yet enforced". That stopped being true at `3dd64c4`: a
> blocking finding now disables the upload, `uploadSlicedGcode` refuses an
> unreviewed slice independently, and the review is re-run on the bytes actually
> uploaded rather than reused from the card. See `docs/PHASE_9_SAFE_START.md`.

Implements Phase 7 of `docs/IMPLEMENTATION_BACKLOG.md` on top of Phase 6
(`7bce4f8`).

Produces the **output SHA-256** — the second of the two values a start approval
binds to. Phase 6 produced the first.

## What was added

| File | Purpose |
|---|---|
| `services/gcode/GcodeReview.ts` | Extent scanning and metadata parsing |
| `services/gcode/SliceReview.ts` | The review, its findings, and the critical settings summary |
| `services/gcode/ExpoGcodeIo.ts` | The real file system behind it |
| `components/SliceReviewCard.tsx` | The review UI |
| `tests/unit/sliceReview.test.js` | 39 assertions |

Modified: `services/security/Base64.ts` (added `bytesToUtf8`),
`app/(tabs)/slicer.tsx` (state, the review effect, the card).

## Most of Phase 7 already existed

The backlog lists foreground slicing, progress, cancel, recovery, thumbnails, a
3D preview and a layer view. **All of these already ship**, natively:
`sliceModelFile` with its progress events, `cancelSlice`, `LastSliceStore` for
recovery across process death, `getGcodeThumbnail`, `openNativeModelPreview` and
`openNativeGcodePreview`.

Rebuilding any of them would have meant a second implementation of shipped,
working behaviour against development rules 8 and 9. What did **not** exist is
the part the safety rules actually need: reading the finished G-code back and
judging it. That is what this phase adds.

## Decisions worth knowing

### Extents come from extruding moves only

`CLAUDE.md`'s workflow says "preview **actual** G-code", so the footprint is
computed from the file rather than read from its header. Travel moves are
excluded: a purge line, a wipe tower approach or a park position legitimately
runs outside the printed object, and judging by every move would reject files
that are perfectly safe.

The scanner tracks the state that changes what a coordinate *means* — `G90`/`G91`
for positioning, `M82`/`M83` for extrusion, and `G92` for redefining the origin
mid-file. `G92 E0` matters most: treating it as a move would make every following
extrusion look like a retraction and the extents would come out empty.

### Both ends of an extruding move count

Material spans the whole segment, so recording only the destination
under-reports the printed area. Two tests pin the consequences, and both came
from test failures where **the code was right and the test's premise was wrong**:

- A move that extrudes *while* travelling deposits from where the head already
  was, so that start point is printed area.
- A continuous Z rise during extrusion — spiral vase — really is printed height
  and must be inside the build volume. A Z-hop is a travel and is not.

### Metadata is read from both ends of the file, not streamed

Orca writes its header block at the start and its config block at the end, so
each end is read whole (256 KB). That keeps a multi-byte character split across
a chunk boundary from mattering anywhere it could affect a parsed value.

The extent scan *is* streamed, in 512 KB chunks, because a sliced plate is
routinely tens of megabytes. Splits are harmless there: G-code commands are
ASCII, so a replacement character can only ever land in a comment.

### The hash is taken last, over the finished file

After every native post-process has run — `GcodeToolMapper`,
`GcodeFirstLayerGuard`, `GcodeThumbnailInjector`, `GcodeFilamentColors`. Hashing
earlier would bind an approval to bytes that are not the bytes that get
uploaded.

The file is also scanned *before* it is hashed, so an obviously unusable file
costs no hashing time, and a hash once taken describes a file already judged.

### The review is displayed, not yet enforced

Blocking findings — out of bounds, below the bed, no extrusion, hash failure —
are shown prominently, with the card outlined in red. They do **not** yet stop
the shipped slice → upload → start flow.

That is deliberate. Making the review a hard gate means editing that flow, and
Phases 8–9 re-route it anyway; doing it twice would mean destabilising a shipped
path twice. The gate lands with the cutover.

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` | **Pass**, no errors |
| `npm run test:regressions` | **Pass**, 409 assertions after this phase |
| `npx eslint` on all changed paths | **Pass**, 0 errors |
| `npx expo export --platform android` | **Pass** |
| `cd android && ./gradlew assembleRelease` | **Pass** |

### Phase 7 acceptance tests

| Test | Where |
|---|---|
| Out-of-bounds G-code | Every axis, both directions, with an edge-tolerance test |
| Native slicer failure | Empty file, unreadable file, stat that throws |
| Low storage | Read failure part-way through blocks rather than reviewing a partial file |
| High-memory model | A large file is chunked through both the scan and the metadata windows |
| App background, process death | Pre-existing: `LastSliceStore` recovery, reviewed on restore because the effect keys on the output path |
| Cancellation | Pre-existing: `cancelSlice` |
| Multi-plate extraction | Pre-existing: `extractPlate`, and Phase 4's plate enumeration |
