# Substack My Replies

A Chrome extension (Manifest V3) that tells you at a glance whether you've already replied to a Substack note — and links you directly to each of your replies.

## Purpose

Substack note pages give no indication of whether you've already joined a conversation. Finding your own replies means scrolling through potentially hundreds of comments. This extension solves that by automatically scanning the replies API and surfacing the results directly in the page UI.

## Installation

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `substack-my-replies` folder.

The extension activates automatically on any `substack.com` page.

## Usage

Navigate to any Substack note, e.g. `substack.com/@username/note/c-12345`. The extension activates automatically — no interaction required.

## Behaviour

The extension adds a status badge immediately after the note's reply count. The badge progresses through these states:

| State | Display |
|---|---|
| Checking | `⟳ Checking replies, page N…` |
| Found replies | `Replies from you: 1, 2, 3 · recheck` |
| No replies | `No replies from you · recheck` |
| Error | `Could not load replies · retry` |

- Each numbered link in the "found replies" state opens that specific reply in a new tab.
- Results are **cached in `chrome.storage.local`** keyed by note ID. On subsequent visits the cached result is shown immediately without re-fetching. A **recheck** link is always available to re-run the scan.
- The extension also annotates the comment button on every reply-note card in the page with `(N yours)`, showing how many of your replies exist in that sub-thread. Cards not yet checked show `(? yours)`.
- Navigation between notes within the same tab is handled automatically via `history.pushState` patching and `popstate` listening.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest — targets `substack.com`, requests `storage` permission |
| `content.js` | Content script — all badge logic, API calls, caching, and DOM augmentation |
| `content.test.js` | Jest test suite |
| `package.json` | Dev dependencies and Jest configuration |
| `babel.config.json` | Babel preset for Jest transformation |

## Testing

```bash
npm install
npm test
```

The test suite uses **Jest 29** with **jsdom** and achieves **100% coverage** across statements, branches, functions, and lines. It covers:

- Badge state transitions (initial, checking, complete, error)
- Paginated API fetching, including cursor handling and stale-token cancellation
- Cache read/write, including rejection of legacy number-format entries and the storage-ready race condition
- DOM injection and MutationObserver retry when React hasn't rendered yet
- Reply-card augmentation edge cases
- SPA navigation detection via `pushState` and `popstate`
