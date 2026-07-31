# Phase 8 — Upload-only

> **The cutover described below as "NOT happened" has since happened**, at
> `3dd64c4`. All three call sites named here were re-routed, and a fourth that
> this document did not know about — native OkHttp in
> `HelixGcodePreviewActivity.kt` — had its start call deleted. Read
> `docs/PHASE_9_SAFE_START.md` for what actually shipped. The section below is
> kept as the record of why the two halves could not ship apart.

Implements Phase 8 of `docs/IMPLEMENTATION_BACKLOG.md` on top of Phase 7.

## What was added

| File | Purpose |
|---|---|
| `services/upload/UploadService.ts` | Upload with every check, and no way to start a print |
| `tests/unit/uploadService.test.js` | 25 assertions |

**No existing file was modified.** This phase is entirely additive — see the
cutover section below, which is the important part of this document.

## The guarantee, and how it is held

`uploadSlicedGcode` cannot start a print. That is not a convention, it is
checked three ways:

1. `PrintJobMachine` has no `uploaded → starting` transition (Stage B).
2. The function has no access to any start call.
3. **A test reads this module's own source** and asserts it contains no
   `printer/print/start`, no `startPrint`, and no `SET_MAIN_STATE`. So the
   guarantee survives a later edit by someone who has not read the comment at
   the top of the file.

## The order of checks

Everything that can refuse without touching the network runs first, then printer
state, then storage, then the collision question, and only then are bytes sent.
An upload that will be refused is worth discovering before spending a minute
pushing 40 MB over wifi.

```text
reviewed? → printer reachable → firmware ready → not busy
          → local file unchanged → storage → collision → send → verify bytes
```

### Decisions inside that

**An unreviewed slice never uploads.** Without a passing review there is no hash
to record, and Phase 9's approval binds to that hash.

**The local file must still match the review.** If its size changed since the
review, the bytes about to be sent are not the bytes the hash describes, so it
refuses and asks for a re-slice.

**Unknown printer state fails closed.** A printer that does not report
`print_stats.state` is refused, not assumed idle.

**An existing file is never overwritten without approval.** A collision returns
`needs-approval` with the existing file's details — it is a question, not a
failure. And if the file *list* cannot be read, the upload stops: a collision
that cannot be ruled out is not a collision that can be ignored.

**Byte count is verified after the upload.** A short write would otherwise be
approved and printed as though it were the reviewed file.

**Two checks deliberately do not fail closed**, because failing closed there
would make the app unusable rather than safe: a printer that does not report
free space, and a Moonraker build that returns no size for an upload. Both are
real, both are noted in tests, and in both cases a later check still catches the
dangerous outcome.

## The cutover has NOT happened — read this before Phase 9

`docs/CURRENT_STATE.md` names three call sites that run slice → upload → start
as one continuous flow from a single confirmation tap:

- `app/(tabs)/slicer.tsx`
- `app/(tabs)/index.tsx`
- `app/(tabs)/files.tsx`

**They are untouched.** This phase did not re-route them, and that is a
deliberate sequencing decision rather than work left undone:

> Removing `startPrint` from those call sites in Phase 8 alone would leave the
> app able to upload and unable to print. The approved-start path that replaces
> it does not exist until Phase 9.

So the cutover is a **Phase 9 change**, and it should be done in one move:
re-route all three call sites onto `PrintJobMachine` + `ApprovalService` +
`uploadSlicedGcode` + the new start path, together, with the camera-freshness
check and hold-to-start in place.

Until then the shipped flow still starts prints the way it always has, with no
approval binding, no camera check and no hold-to-start. Phase 8 has built the
upload half of its replacement and proved it in isolation; it has not changed
what the app does.

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` | **Pass**, no errors |
| `npm run test:regressions` | **Pass**, 434 assertions (409 after Phase 7 + 25 new), exit 0 |
| `npx eslint` on all changed paths | **Pass**, 0 errors |
| `npx expo export --platform android` | **Pass** |
| `cd android && ./gradlew assembleRelease` | **Pass** — `BUILD SUCCESSFUL in 1m 34s` |

### Phase 8 acceptance tests

All eight are covered.

| Test | Where |
|---|---|
| Printer offline | Not connected, and an unreachable printer that throws |
| Busy printer | `printing`, any casing |
| Paused printer | `paused`, any casing |
| Filename collision | `needs-approval`; case-insensitive; approved overwrite proceeds |
| Upload interruption | Throwing transfer → `upload/interrupted`, nothing started |
| Moonraker restart | File list unreadable → stops rather than risking an overwrite |
| Insufficient storage | Refused, including the margin boundary |
| Mismatched byte count | Refused, names both numbers, says it was not started |

## Deliberately not done

- **The cutover**, as above. Phase 9.
- **No `PrintJob` record.** `uploadSlicedGcode` returns an `UploadRecord`
  carrying the filename, size and hash a `StartApproval` needs, but writing it
  into a job belongs with the Phase 9 change that creates jobs at all.
- **No wiring into a screen.** The service has no caller yet, by design — its
  first caller should be the re-routed flow.
