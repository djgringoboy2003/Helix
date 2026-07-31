# Phase 6 — Filament mapping

Implements Phase 6 of `docs/IMPLEMENTATION_BACKLOG.md` on top of Phase 5
(`02e60a6`).

Binding each project colour to a physical U1 toolhead, and producing the
**mapping hash** that a start approval will bind to in Phase 9.

## What was added

| File | Purpose |
|---|---|
| `services/filament/FilamentSlots.ts` | Reading both sides: what the printer has loaded, and what the project asks for |
| `services/filament/FilamentMappingPlanner.ts` | Suggesting, judging, warning, and the swap plan |
| `components/FilamentMappingCard.tsx` | The mapping UI |
| `tests/unit/filamentMapping.test.js` | 37 assertions |

Modified: `app/(tabs)/slicer.tsx` only — state, the derived plan, and the card.

## Built on Stage B, not beside it

`FilamentSlotMapping`, `FilamentMapping`, `filamentMapHash` and
`isFilamentMappingComplete` were written in Stage B and are used **as they
stand**. `MappingPlan.mapping` is a Stage B `FilamentMapping`, and
`MappingPlan.mapHash` is literally `filamentMapHash(mapping)` — asserted by a
test, so the two cannot drift.

That matters because `ApprovalService` already validates a `StartApproval`
against `filamentMapHash`. If this phase had produced its own shape, Phase 9
would have needed a conversion layer between "the mapping the operator
confirmed" and "the mapping the approval checked" — which is exactly where a
mismatch would hide.

## Where the data comes from

**Loaded filament** is read from `print_task_config` — `filament_exist`,
`filament_type`, `filament_sub_type`, `filament_color_rgba`, `filament_vendor` —
with the multiACE controller's `head_source` filling gaps. ACE is also the only
place an RFID SKU appears, which is what makes a slot locked.

**Project filament** is read from `filament_colour` / `filament_type` in the
prepared file's `project_settings.config`, using the `readProjectSettings`
bridge Phase 5 added. Reading it back from the *prepared* file rather than the
download means the mapping is judged against the same bytes that will be sliced.

## Decisions worth knowing

### It proposes; it never confirms

`CLAUDE.md`: **never silently guess filament mappings.** So a plan is always
built with `confirmedAt: null`, `isFilamentMappingComplete` stays false, and the
Confirm button is the only thing that sets it. A perfect match on every colour
still requires the operator to say yes.

### Confirmation is bound to the hash it was given for

The screen stores `{ at, hash }`, and honours the confirmation only while the
stored hash still equals the current plan's. Swapping a spool at the printer
changes the loaded colour, which changes the hash, which withdraws the
confirmation — without anyone having to remember to invalidate it.

This is the same binding rule `PrintJobMachine` applies to a start approval,
applied one step earlier so the two cannot disagree.

### `unknown` is not `empty`, and both block

A toolhead the printer has not described is `unknown`, and a mapping onto it
**blocks**. Treating silence as "probably fine" is what rule 14 means by failing
closed, and what is in a toolhead is printer state.

Nothing is ever *suggested* for an unknown head either — it is left unmapped for
the operator to decide, rather than filled in optimistically.

### Placeholder black is not a black spool

The U1 reports `#000000` with no material and no vendor when it has no data. A
test asserts this is read as "unknown", not as black: treating it as real black
is how a mapping silently matches every unknown slot against a black project
colour.

Fixing this exposed a real bug in the first draft — the slot still reported
`source: 'printer'` after the placeholder colour had been discarded. The
implementation was changed so `source` describes what actually survived, not
what was read.

### Material outranks colour

Suggestion scores a material mismatch far above any colour difference. Printing
PETG where PLA was designed changes temperatures and behaviour; printing red
where blue was designed changes only appearance. So a red PETG project colour
takes the PETG head over the closer-coloured PLA head, and a material mismatch
is a `warning` while a colour mismatch is `info`.

Materials match on their base type, so `PLA Matte` and `PLA` are both PLA.

### Warning levels

| Code | Level | Why |
|---|---|---|
| `filament/unmapped` | blocking | A colour with no toolhead must not default to T0 |
| `filament/empty-head` | blocking | Nothing is loaded there |
| `filament/unknown-head` | blocking | Unknown printer state fails closed |
| `filament/no-colours` | blocking | Nothing to map |
| `filament/material-mismatch` | warning | Printable, but temperatures differ |
| `filament/duplicate-mapping` | warning | Legal, but two colours will print identically |
| `filament/too-many-colours` | warning | More than four means heads must be shared |
| `filament/colour-mismatch` | info | Works, but will not look as designed |
| `filament/rfid-locked` | info | Cannot be relabelled; swap the spool instead |

### RFID-locked spools are reported only when they matter

A locked head that already matches the project exactly says nothing. A locked
head that does *not* match says so, and says the fix is physical — the spool's
identity came from RFID, so it is not the operator's to redeclare.

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` | **Pass**, no errors |
| `npm run test:regressions` | **Pass**, 370 assertions (333 pre-existing + 37 new), exit 0 |
| `npx eslint` on all changed paths | **Pass**, 0 errors |
| `npx expo export --platform android` | **Pass** — 4.29 MB Hermes bundle |
| `cd android && ./gradlew assembleRelease` | **Pass** — `BUILD SUCCESSFUL in 1m 53s` |
| On device, real MakerWorld project | **Pass** — 2026-07-31, device `53b451df`, release APK at `7bce4f8`. The card rendered with a row per project colour and T0–T3 chips. Note that confirming the mapping does **not** yet change what is sliced, so this run does not exercise the mapping's effect on output. |

The 5 `eslint` warnings in `app/(tabs)/slicer.tsx` are pre-existing, in regions
this phase did not touch.

### Phase 6 acceptance tests

All eight are covered.

| Test | Where |
|---|---|
| Exact match | Maps cleanly, no warnings, no swap plan |
| Material mismatch | `warning`, does not block |
| Colour mismatch | `info`; near-identical colours count as a match |
| Empty head | Blocks |
| Duplicate mappings | Allowed, reported, names the head and the count |
| Manual spool swap plan | `describeSwapPlan`, per head, want vs have |
| More than four project colours | Warns that heads must be shared |
| RFID-locked colour | Locked and mismatched warns; locked and matching is silent |

Plus the hash behaviour Phase 9 depends on: changing a toolhead changes the
hash, swapping a spool changes the hash, and re-confirming an unchanged mapping
does not.

## Deliberately not done

- **The mapping is not yet wired to slicing.** The Slice tab still uses its
  existing `toolRemap` path into `remapModelExtruders`. Routing slicing through
  the confirmed mapping means editing the shipped slice→upload→start flow, and
  belongs with Phases 8–9 where that flow is re-routed anyway.
- **No `PrintJob` record.** The plan produces the hash a `StartApproval` binds
  to, but creating the job is still Phases 8–9.
- **No spool-swap automation.** The swap plan tells the operator what to change;
  issuing ACE load/unload macros from it is not in this phase, and touching
  filament from an automated path deserves its own review.
- **No change to the three ungated `startPrint` call sites.**
