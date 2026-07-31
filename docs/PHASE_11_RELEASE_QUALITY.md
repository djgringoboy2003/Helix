# Phase 11 — Release quality

Implements the parts of Phase 11 in `docs/IMPLEMENTATION_BACKLOG.md` that were
genuinely missing, on top of Phase 10 (`018cef6`).

## Audit first

| Backlog item | State |
|---|---|
| Accessibility labels | **Partial** — present on the safety-critical controls and the newer screens; not a complete sweep |
| Large text | **Ships.** Nothing sets `allowFontScaling={false}`, so system text scaling already applies |
| Dark and light appearance | **Dark only.** `constants/theme.ts` is a fixed dark palette and nothing reads `useColorScheme` |
| Tablet layout | **Partial** — `useWindowDimensions` drives the printer picker; no dedicated wide layout |
| Privacy screen | **Added here**, behind a setting |
| Licence screen | **Added here** |
| Diagnostic export | **Added here** |
| Crash-safe state | **Ships** — `PrintJobRepository` recovery, `LastSliceStore`, settings migration |
| Onboarding / first-run printer setup | **Ships** — `components/FirstRunSetup.tsx` |
| Release signing / GitHub Actions APK | **Ships** — `build-apk.yml`, repaired in `25edaf1` |
| Play Store policy review | Not a code task |

## The licence screen

The item tracked since Stage A, and the only one here with a legal edge. Helix
is AGPL-3.0-or-later, and `CLAUDE.md` requires the licence files, copyright
notices, third-party notices and attribution to be **kept**.

A link to GitHub is not keeping them. Somebody holding the APK offline, or
holding it after the repository moves, still has to be able to read what they
were given and find out where the source is. So the text is compiled in.

### The generator, and why the test matters more than it

`scripts/generate-licence-text.js` copies `LICENSE`, `ATTRIBUTION.md` and
`THIRD_PARTY_NOTICES.md` into `constants/licenceText.ts`. The repository files
stay the source of truth; the module is generated and committed.

Generated files rot silently, and a stale licence notice is not a cosmetic
problem — it is the text the app conveys to whoever holds the build. So
`tests/unit/licenceText.test.js` **regenerates the module in memory and fails if
it differs**. Editing `LICENSE` without re-running the generator is caught by
the suite rather than shipping.

The tests also assert the licence is the real AGPL rather than a summary:
the header, the version line, section 13 (*Remote Network Interaction* — the
clause that makes this the AGPL and not the GPL), and a length floor.

Newlines are normalised to `\n` in the generator, so a CRLF checkout produces
the same module as an LF one. Without that the drift test would fail for
everyone on Windows, which is how a correctness check turns into one people
learn to ignore.

### What the screen says

The source offer is at the top, stated plainly, because under the AGPL that is
the part that actually grants something. The three documents are tabs below it,
monospaced — a licence's own layout carries meaning and reflowing it is not
something to do casually — and selectable so the text can be copied.

## The diagnostic export

`CLAUDE.md` forbids passwords, cookies, access tokens and private IP details in
logs. A diagnostic export is a log the operator is about to paste into a public
issue tracker, so it is the single most likely way any of those escapes.

### Redaction is a sweep, not an allowlist

Both are done. `DiagnosticReport.ts` only puts in what it means to, describing
**shapes** rather than values — `endpoint: http://<ip>:7125` answers the
question that matters while the address never does. But composing carefully is
the defence that fails the day somebody adds a field, so the finished text is
passed through `redactSensitive` unconditionally.

A test pins exactly that: a private address planted in the *slicer's error
string* — a field nobody shaped — still comes out redacted.

### What is removed, and what deliberately is not

| Removed | Kept |
|---|---|
| Private IPv4: `10.*`, `192.168.*`, `172.16–31.*`, `169.254.*`, and the `100.64–127.*` CGNAT range Tailscale uses | Public addresses — usually a MakerWorld CDN, and useful |
| `*.ts.net` tailnet hostnames | Scheme and port |
| JWTs, matched structurally so a bare token in an error string is caught | The *label*: `token: [redacted]` still says a token was involved |
| `password=`, `Cookie:`, `api_key:` and friends, with the value | Job state, revision, short hashes, mapping, event log |
| Android app-private paths, Windows `\Users\`, POSIX homes | Filenames — which file, never where it lives |

Ordering matters and is tested: labelled secrets are swept before the generic
patterns, so `password=192.168.0.5` comes out as `password=[redacted]` rather
than half-redacted.

The start approval is *described*, never reproduced — its revision and remaining
lifetime, not the record, which carries a filename and a printer id.

## The privacy screen

Android offers only `FLAG_SECURE`, which hides the app from the recents
thumbnail **and** blocks all screen capture. There is no way to have one without
the other, and blocking screenshots would stop an operator photographing their
own print — which is the more common need than hiding a printer name from
somebody looking over a shoulder.

So it is a setting, defaulted **off**, rather than a decision imposed here.

The value is mirrored into SharedPreferences by the native module, because
`MainActivity.onCreate` has to apply the flag *before the first frame is drawn*.
Applying it only once JavaScript is running would leave one recents thumbnail
already captured from the cold start, which defeats the point of the setting for
exactly the person who turned it on.

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` | **Pass** |
| `npm run test:regressions` | **Pass**, 518 assertions (495 before, 23 new) |
| `npx eslint` on changed paths | **Pass**, 0 errors |
| `npx expo export --platform android` | **Pass** |
| `cd android && ./gradlew assembleRelease` | **Pass** |

## Deliberately not done

- **Light appearance.** `constants/theme.ts` is a fixed dark palette threaded
  through every screen and native activity. Adding a light theme is a design
  decision and a wide refactor, not a release-quality tidy-up, and doing it
  badly is worse than not doing it.
- **A tablet layout**, for the same reason: the screens reflow, but a real
  wide-screen design is its own piece of work.
- **A complete accessibility sweep.** The safety-critical path is labelled;
  auditing every remaining control is worth a pass of its own.
## Pushed, and CI is green

`main` was pushed to the fork at `66968a5`. Both workflows passed — the first
time `Build APK` has succeeded there, since it previously hard-failed on the
missing signing secrets:

```
✓ validate in 41s
✓ build     in 57s   (signing skipped, with a notice naming the missing secrets)
- release   in 0s    (skipped: gated on an APK having been produced)
```

`Android baseline` also passed, which is the clean-clone confirmation that the
`services/gcode` repair in `5bbb3d1` actually fixed the build rather than only
looking fixed on the development machine.

The fork still cannot publish: `release` is gated on `needs.build.outputs.built`,
so a skipped build can never be followed by a release.
