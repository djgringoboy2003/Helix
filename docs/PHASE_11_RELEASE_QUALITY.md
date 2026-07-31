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
| Privacy screen | **Missing** |
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

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` | **Pass** |
| `npm run test:regressions` | **Pass**, 517 assertions (495 before, 22 new) |
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
- **A privacy screen.** Android has no way to blank only the recents thumbnail —
  it needs `FLAG_SECURE`, which also blocks all screenshots, including the ones
  an operator wants of their own print. That trade-off is the user's to make, so
  it belongs behind a setting rather than being imposed here.
- **A complete accessibility sweep.** The safety-critical path is labelled;
  auditing every remaining control is worth a pass of its own.
- **Nothing was pushed or published.** The `release` job stays gated on signing
  secrets the fork does not have.
