# Phase 10 — Monitoring

Implements Phase 10 of `docs/IMPLEMENTATION_BACKLOG.md` on top of Phase 9
(`3dd64c4`).

## Most of Phase 10 already shipped

The backlog lists live progress, ETA, layer count, temperature cards, pause,
resume, cancel, camera, notification events and print history. An audit against
the tree found all of them already present:

| Backlog item | Where it lives |
|---|---|
| Live progress | `display_status` in `app/(tabs)/index.tsx`, `components/PrinterStrip.tsx` |
| ETA | `services/printEta.ts`, `calculatePrintEtas` |
| Layer count | `print_stats.info.current_layer` / `total_layer` |
| Temperature cards | `components/TempGauge.tsx`, `MiniTemp` |
| Pause / resume / cancel | `printer.print.*` via `app/(tabs)/index.tsx` |
| Camera | `components/CameraFeed.tsx` |
| Notification events | `services/notifications.ts`, `services/notificationEvents.ts` |
| Print history | `components/HistoryView.tsx` |

Rebuilding any of it would have been a second implementation of shipped,
working behaviour, against development rules 8 and 9. So this phase adds the one
thing that was genuinely missing.

### Still not present

- **Active toolhead.** Nothing reads `active_extruder`. The Slice tab knows the
  tools a *file* uses; the dashboard does not show which one is running now.
- **Skip object.** No `EXCLUDE_OBJECT` support anywhere.
- **Filament runout** appears only as a settings string and a notification
  event; nothing watches for it during a print.

These are UI additions to an already-working monitoring surface, and none of
them affects the job record. Left for a follow-up rather than bundled here.

## What was missing: the job never ended

`startApprovedPrint` left a job at `printing` and nothing ever moved it again.
Every print this app started stayed `printing` in the record for ever —
including the ones that failed, and including the one cancelled during the
Phase 9 device run. That makes the audit trail a log of *intentions* rather than
outcomes, which is precisely the thing an audit trail is for.

`services/jobs/JobMonitor.ts` closes it. Pure, like the rest of the machine: it
takes a job and what the printer says, and returns the job. Persistence and
polling stay outside, which is what makes every rule directly testable.

## Decisions worth knowing

### `standby` is a failure, not a success

The single most important rule here. Moonraker reports `standby` after a
cancel, after an error recovery and after a firmware restart alike. Reading it
as "completed" would write a success into the record for a print that failed.

So `standby` on the job's own file records a failure that says the printer
returned to standby *without reporting completion*. A job is only ever
`completed` when the printer says `complete`.

### Unknown is not good news

A printer that is disconnected, whose Klipper is not ready, or that will not say
what it is doing leaves the job exactly where it is. The monitor never reads
silence as progress and never reads it as completion — the same rule the start
gate uses, applied to the other end of the print.

### A job the printer is not running is a job that failed

Matched on the filename the approval bound to, which is the same string the
start command named. If the printer is printing something else, this job's
outcome is no longer observable from here, so it fails with a note naming the
other file — basename only, since a full path is neither useful to an operator
nor something the event log should carry.

A printer reporting *no* filename cannot confirm it is running this job, so that
counts as "not this job" too.

### `starting` passes through `printing` on its way to `completed`

A job glimpsed only once, already finished, would otherwise need an edge from
`starting` to `completed` that the machine does not have — and adding one would
let a job claim to have completed without ever having been seen to print. The
monitor walks it through `printing` instead, so the event log records a step
that really did happen, in order.

### The machine still has the last word

Every move goes through `transition`, and a refused edge leaves the job alone
rather than forcing it. If the monitor and the state machine disagree, the state
machine is right.

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` | **Pass** |
| `npm run test:regressions` | **Pass**, 495 assertions (475 before, 20 new) |
| `npx eslint` on changed paths | **Pass**, 0 errors |
| `npx expo export --platform android` | **Pass** |
| `cd android && ./gradlew assembleRelease` | **Pass** |

### Phase 10 acceptance tests

| Test | Where |
|---|---|
| WebSocket disconnect | Disconnected, Klippy not ready, and null state all leave the job untouched |
| Polling fallback | Pre-existing: `useMoonraker` |
| Pause and resume | Both followed, in both directions |
| Cancel | Recorded as `cancelled`, distinct from a failure |
| Print error | `error` fails the job |
| Filament runout | **Not covered.** Nothing watches for it — see above |
| Completion | `complete` completes; `standby` deliberately does not |
| App background notification | Pre-existing: `services/notifications.ts` |

## Deliberately not done

- **No new dashboard UI.** The existing screens already read Moonraker directly
  and are unaffected by the job record. Surfacing job history is worth doing but
  belongs with the library screen that is still missing.
- **No polling of its own.** The monitor reacts to the status the app is already
  subscribed to, writes only when a job actually moves, and stops once there is
  nothing left to observe.
- **Runout, skip-object and active toolhead**, as above.
