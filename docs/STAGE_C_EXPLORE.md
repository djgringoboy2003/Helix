# Stage C — MakerWorld WebView MVP (Explore tab)

Adds the Explore tab required by `CLAUDE.md` Stage C and Phase 3 of
`docs/IMPLEMENTATION_BACKLOG.md`, on top of the Stage B domain layer
(`add4de6`).

The shipped MakerWorld flow in the Slice tab is **unchanged**. Stage C adds a
second, parallel entry point that goes through the provider interface, and hands
off into the same slicer import flow. Nothing was removed.

## What was added

| File | Purpose |
|---|---|
| `app/(tabs)/explore.tsx` | The Explore tab: WebView, operator controls, import status |
| `services/makerworld/WebViewDownloadCapture.ts` | Injected hooks, and parsing of what the page posts back |
| `services/makerworld/BrowseNavigation.ts` | Location classification behind the toolbar |
| `services/makerworld/DownloadWriter.ts` | Intercepted download → bytes on disk, with policy enforced |
| `services/makerworld/ExpoDownloadIo.ts` | The real file system behind `DownloadWriter` |
| `tests/unit/makerworldBrowse.test.js` | 30 assertions across the three logic modules |

`app/(tabs)/_layout.tsx` gained one `Tabs.Screen` entry. That is the only
existing file Stage C modifies.

## Stage C checklist

| Requirement | Where |
|---|---|
| MakerWorld WebView | `explore.tsx` |
| Persistent login session | `sharedCookiesEnabled` + the existing native cookie capture; session state shown in the toolbar, with a link to `app/makerworld-login.tsx` |
| Back, forward, refresh, open-current-model | Toolbar buttons; `describeLocation` decides when import is offered |
| Model and profile URL detection | `BrowseNavigation.describeLocation` over `MakerWorldUrlParser` |
| Android download interception | `MAKERWORLD_DOWNLOAD_HOOK` plus `onShouldStartLoadWithRequest` |
| Progress and failure state | `ImportStatus` — downloading / verifying / done / error |
| Handoff into the slicer import flow | `setMwDownload` then `router.navigate('/slicer')` |

## Decisions worth knowing

### The screen owns no policy

Every decision that could matter for safety — allowed download host, HTTPS only,
size cap, filename sanitising, SHA-256 of what actually landed — happens in
`MakerWorldWebViewProvider` and the modules under `services/makerworld/`. The
screen supplies a bridge and renders state.

That split is the reason the 30 new assertions can exist at all: a policy that
can only be exercised by driving a real WebView is a policy that does not get
tested.

### The download URL is checked twice, deliberately

`DownloadWriter` checks the URL before requesting any bytes; the provider checks
it again afterwards. The second check is not redundant — it is the provider's own
contract with any future bridge — but it happens after the request has already
gone out, so it cannot be the only one. The decision whether to contact a host at
all has to be made before contacting it.

### Everything the page sends is treated as hostile

`parseHookMessage` takes a string produced by a remote page. Malformed JSON,
non-objects, wrong types, missing fields, blob payloads that are not base64 data
URLs, and messages over 64 MB all return `null` rather than throwing, so a
hostile or simply broken page cannot break the browsing screen. Most of the new
test suite is about what gets rejected.

### Off-site navigation is described, not blocked

MakerWorld legitimately sends the browser to identity and CDN hosts, and a
browsing surface that refused them would be broken. What is gated is *importing*:
that is offered only on a recognised MakerWorld model or profile page, decided by
the host-anchored parser rather than by substring matching.

Only the **host** of an off-site URL is ever shown. A full URL can carry a signed
token or session id in its query, and the safety rules forbid putting those in
front of the operator or into a log.

### Arming records attribution, and is dropped when it goes stale

Tapping Import arms the current model, so an intercepted file is attributed to
the page the operator chose. Browsing on to a different model or profile clears
it — otherwise the next download would be recorded against the wrong model, and
that record is what the import is built from. A download intercepted with nothing
armed and no model page in view still gets hashed and policy-checked; only its
model identity is recorded as unknown rather than guessed.

### Hashing is visible because it is slow

The SHA-256 is pure JavaScript (Stage B's reasoning: a safety-critical primitive
should not sit outside this repo's test suite), at roughly a second per 10 MB.
A large 3MF therefore spends real time in the `verifying` phase, which is shown
rather than hidden. `FileHash.setFileHasher()` remains the seam for a native
digest later; that would be a performance change, not a correctness one.

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` | **Pass**, no errors |
| `npm run test:regressions` | **Pass**, 222 assertions (192 pre-existing + 30 new) |
| `npx eslint` on all Stage C paths | **Pass**, no errors or warnings |
| `npx expo export --platform android` | **Pass** — 4.21 MB Hermes bundle, whole JS graph resolves |
| `cd android && ./gradlew assembleDebug` | **Pass** |

The 5 pre-existing `import/no-unresolved` errors in `functions/src/index.ts`
remain; they are environmental (`functions/node_modules` is not installed
locally) and resolve in CI, which installs it.

## Deliberately not done in Stage C

- **No change to the three ungated `startPrint` call sites**
  (`app/(tabs)/slicer.tsx:892`, `app/(tabs)/index.tsx:450`,
  `app/(tabs)/files.tsx:278`). Still the highest-blast-radius item in the
  backlog, still its own reviewed change.
- **No consolidation of the duplicate MakerWorld download paths.** The native
  OkHttp path in `HelixSlicerModule.kt` and the JS hooks in
  `app/makerworld-download.tsx` are both still in place and still reachable from
  the Slice tab. Explore does not add a third — it wraps the same interception
  technique behind the provider — but the Slice tab has not been moved onto the
  provider yet. Doing that is what retires one of the two paths, and it means
  editing a shipped flow.
- **No job record.** Explore produces a `DownloadedArtifact` and hands the file
  to the Slice tab exactly as the existing flow does. Creating a `PrintJob` at
  import time, so the artifact identity survives into the approval, belongs with
  the Phase 8–9 work that re-routes the start path.
- **No 3MF scan on import.** `ThreeMfSecurityScanner` exists and is tested, but
  nothing calls it yet; wiring it belongs with `ThreeMfInspector` in Phase 4.
