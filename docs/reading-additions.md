# Reading additions: implementation and verification

- Headings and selected sections are page-local, inside the existing themed
  Library pane. The player shortcut opens that pane without adding a permanent
  header row. Refresh rebuilds the list from the whole readable page.
- Resume records the target and surrounding text. Resolution tolerates moved
  paragraphs, inserted prefixes, whitespace and new chunk boundaries. Equal
  matches and missing text require a user choice; no positional guess is made.
- Listening totals measure elapsed wall time only while audio is actually
  playing, excluding pauses, synthesis and seeks. They are approximate and local.
  Completion identifiers are SHA-256 digests, bounded to 300 per day, with 365
  days retained. Weekly goals are also local.
- Account sync is opt-in. The service worker merges newer portable positions and
  bookmarks, tracks deletions and applies newer global preference groups.
  Explicit file restore is a fresh local edit. Journal timestamps are monotonic
  after edits, including after a remote clock ahead of this device.
- Sync uses canonical JSON, gzip, base64, at most 14 7000-character parts and a
  SHA-256 header. Partial snapshots fail verification before local application.
  Unchanged content is not republished. A local change is batched for one minute;
  errors retry after five minutes and remain visible in the panel. The browser
  account controls actual device-to-device transport and extension identity.
- PDF OCR runs only for textless pages when enabled, with an explicit page range
  and a 20-page job limit. Images use OCR directly. All engine code and Turkish/
  English integer LSTM models are bundled. Cancellation preserves the old book.
  Canvas work is bounded by both pixel count and maximum dimension.

The integration suite checks real bundled image and scanned-PDF OCR with network
emulation offline; media API registration and callbacks operating the real player;
selective section playback; ambiguous/shifted/split anchors; listening pause and
play timing; sync quota sizes, stable snapshots, remote merges, deletions,
re-reading deleted pages, corrupt transfers and remote-copy removal. Account
transport is simulated by replacing a compressed snapshot with another device's
records. No signed-in account or physical media keyboard is used by CI.

Manual checks requiring real devices:

1. Install with the same extension identity on two devices, sign into the same
   browser account and enable extension synchronization in the browser.
2. Enable this extension's sync on both. Read/bookmark/edit a note on A, then open
   the same page on B and use Resume after sync. Delete and restore bookmarks,
   including an offline device returning later. Check that site settings and
   local documents do not travel.
3. Use physical media keys and the operating system panel while playing, paused,
   seeking and stopped. Which controls appear depends on the platform.

Primary API references:

- [Chrome storage.sync quotas and behavior](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [Media Session specification](https://www.w3.org/TR/mediasession/)
- [Tesseract.js API](https://github.com/naptha/tesseract.js/blob/master/docs/api.md)
- [Tesseract local assets](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md)

Tesseract 7's packaged worker is inspected when vendoring: unlike older examples,
it also selects a relaxed-SIMD LSTM core where available. All three LSTM cores
selected by that worker are bundled, with the SIMD choice left to the engine.
