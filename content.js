/**
 * Substack My Replies — content script
 *
 * Badge lifecycle on a note page:
 *   1. Injected immediately → "Check replies" (clickable, auto-starts check)
 *   2. While fetching      → spinner + "Checking replies, page N…"
 *   3. Complete            → "Y replies from you · recheck" (recheck is clickable)
 *
 * @mikeyclarke's user_id (4619740) confirmed via:
 *   fetch('/api/v1/user/4619740-mikey-clarke/public_profile/self', {credentials:'include'})
 *     .then(r=>r.json()).then(d=>console.log(d.id, d.handle))  →  4619740  'mikeyclarke'
 */

const MY_USER_ID   = 4619740;
const MY_USER_SLUG = '4619740-mikey-clarke'; // used to build reply URLs
const NOTE_RE      = /substack\.com\/@[^/]+\/note\/c-(\d+)/;
const BADGE_ID     = 'smr-badge';
const STYLE_ID     = 'smr-style';

// ---------------------------------------------------------------------------
// Styles — injected once into <head>
// ---------------------------------------------------------------------------

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    @keyframes smr-spin { to { transform: rotate(360deg); } }
    #${BADGE_ID} {
      margin-left: 12px;
      font-size: inherit;
      font-weight: 500;
      white-space: nowrap;
      color: var(--color-fg-secondary-themed, #888);
    }
    #${BADGE_ID} a,
    [${MINE_ATTR}] a {
      color: inherit;
      text-decoration: underline;
      cursor: pointer;
    }
    [${MINE_ATTR}] {
      margin-top: auto;
      margin-bottom: auto;
      vertical-align: middle;
      border-radius: var(--border-radius-sm, 4px);
      white-space: nowrap;
    }
    .smr-spinner {
      display: inline-block;
      width: 10px;
      height: 10px;
      border: 1.5px solid currentColor;
      border-top-color: transparent;
      border-radius: 50%;
      animation: smr-spin 0.7s linear infinite;
      vertical-align: middle;
      margin-right: 5px;
    }
  `;
  document.head.appendChild(s);
}

// ---------------------------------------------------------------------------
// Badge state helpers
// ---------------------------------------------------------------------------

function getBadge() {
  return document.getElementById(BADGE_ID);
}

/** State 1: "Check replies" link — shown immediately on injection. */
function setBadgeInitial(noteId) {
  const badge = getBadge();
  if (!badge) return;
  badge.innerHTML = '';
  const a = document.createElement('a');
  a.textContent = 'Check replies';
  a.href = 'javascript:void(0)';
  a.addEventListener('click', () => runCheck(noteId));
  badge.appendChild(a);
}

/** State 2: spinner + "Checking replies, page N…"
 *  First call builds all elements; subsequent calls only update the page number,
 *  leaving the spinner element untouched so its CSS animation runs continuously.
 */
function setBadgeChecking(page) {
  const badge = getBadge();
  if (!badge) return;

  const existing = badge.querySelector('.smr-page-num');
  if (existing) {
    existing.textContent = page;
    return;
  }

  badge.innerHTML = '';
  const spinner = document.createElement('span');
  spinner.className = 'smr-spinner';
  badge.appendChild(spinner);
  badge.appendChild(document.createTextNode('Checking replies, page '));
  const pageNum = document.createElement('span');
  pageNum.className = 'smr-page-num';
  pageNum.textContent = page;
  badge.appendChild(pageNum);
  badge.appendChild(document.createTextNode('…'));
}

/** Builds the native tooltip text: title (if any), newline, formatted date (if any). */
function buildTooltip(title, date) {
  const dateStr = date ? new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  return [title, dateStr].filter(Boolean).join('\n\n');
}

/** State 3: "Replies from you: <a>1</a>, <a>2</a> … · recheck"
 *  replies — array of { id, title, date } objects authored by MY_USER_ID.
 */
function setBadgeComplete(replies, noteId) {
  const badge = getBadge();
  if (!badge) return;
  badge.innerHTML = '';

  if (replies.length === 0) {
    badge.appendChild(document.createTextNode('No replies from you · '));
  } else {
    badge.appendChild(document.createTextNode('Replies from you: '));
    replies.forEach((reply, i) => {
      if (i > 0) badge.appendChild(document.createTextNode(', '));
      const a = document.createElement('a');
      a.textContent = String(i + 1);
      a.href = `https://substack.com/profile/${MY_USER_SLUG}/note/c-${reply.id}`;
      a.target = '_blank';
      a.title = buildTooltip(reply.title, reply.date);
      badge.appendChild(a);
    });
    badge.appendChild(document.createTextNode(' · '));
  }

  const recheck = document.createElement('a');
  recheck.textContent = 'recheck';
  recheck.href = 'javascript:void(0)';
  recheck.addEventListener('click', () => runCheck(noteId));
  badge.appendChild(recheck);
}

/** State 4: error fallback */
function setBadgeError(noteId) {
  const badge = getBadge();
  if (!badge) return;
  badge.innerHTML = '';
  badge.appendChild(document.createTextNode('Could not load replies · '));
  const retry = document.createElement('a');
  retry.textContent = 'retry';
  retry.href = 'javascript:void(0)';
  retry.addEventListener('click', () => runCheck(noteId));
  badge.appendChild(retry);
}

// ---------------------------------------------------------------------------
// Badge DOM injection
// ---------------------------------------------------------------------------

function findRepliesElement() {
  return Array.from(document.querySelectorAll('*'))
    .find(el => /^\d+ Repl(y|ies)$/.test(el.textContent.trim())) ?? null;
}

/**
 * Creates and inserts the badge element after the replies count.
 * Returns true on success, false if the target isn't in the DOM yet.
 */
function injectBadge(noteId) {
  document.getElementById(BADGE_ID)?.remove();
  const repliesEl = findRepliesElement();
  if (!repliesEl) return false;

  const badge = document.createElement('span');
  badge.id = BADGE_ID;
  repliesEl.insertAdjacentElement('afterend', badge);
  setBadgeInitial(noteId);
  return true;
}

// ---------------------------------------------------------------------------
// API — paginated reply fetch with live progress updates
// ---------------------------------------------------------------------------

// Incremented on each new check; stale async loops compare against it and
// bail out if a newer check has started (e.g. user clicked recheck mid-flight).
let checkToken = 0;

// Returns the first URL found in a note body string, stripping trailing punctuation.
function extractBodyUrl(body) {
  const m = (body ?? '').match(/https?:\/\/\S+/);
  return m ? m[0].replace(/[.,;!?)]+$/, '') : '';
}

// Extracts { id, title, date } from a raw comment object.
// Notes don't have a title field; use the first URL in the body as a stand-in.
function replyData(comment) {
  return {
    id:    comment.id,
    title: extractBodyUrl(comment.body),
    date:  comment.date ?? '',
  };
}

// Tracks related-note IDs whose background check has already been initiated
// this session, so we don't re-fetch on every augmentation call.
const relatedNoteChecked = new Set();

async function runCheck(noteId) {
  const token = ++checkToken;
  setBadgeChecking(1);

  const myReplies = [];
  let cursor     = null;
  let page       = 1;

  try {
    do {
      if (token !== checkToken) return; // superseded by a newer check

      const url = new URL(
        `https://substack.com/api/v1/reader/comment/${noteId}/replies`
      );
      url.searchParams.set('comment_id', noteId);
      if (cursor) url.searchParams.set('cursor', cursor);

      const resp = await fetch(url.toString(), { credentials: 'include' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data     = await resp.json();
      const branches = data.commentBranches ?? [];

      for (const branch of branches) {
        if (branch.comment?.user_id === MY_USER_ID) myReplies.push(replyData(branch.comment));
        for (const dc of branch.descendantComments ?? []) {
          if (dc?.user_id === MY_USER_ID) myReplies.push(replyData(dc));
        }
      }

      cursor = branches.length === 0 ? null : (data.nextCursor ?? null);
      if (cursor) setBadgeChecking(++page);

    } while (cursor);

  } catch (err) {
    console.error('[Substack My Replies] fetch error:', err);
    if (token === checkToken) setBadgeError(noteId);
    return;
  }

  if (token === checkToken) {
    setBadgeComplete(myReplies, noteId);
    setCache(noteId, myReplies);
  }
}

// ---------------------------------------------------------------------------
// Cache — chrome.storage.local, keyed by note ID
// ---------------------------------------------------------------------------

const CACHE_KEY = 'smr_cache';

// In-memory copy of storage, kept in sync. Used by augmentAllReplyCards so
// annotation is synchronous (no per-card async lookup).
let memCache = {};

// Resolved once the initial chrome.storage.local.get has completed, so that
// getCache() never returns a stale "cache miss" before storage has loaded.
let _memCacheReady;
const memCacheReady = new Promise(resolve => { _memCacheReady = resolve; });

async function getCache(noteId) {
  await memCacheReady;
  const entry = memCache[String(noteId)];
  if (!Array.isArray(entry)) return null;
  if (entry.length > 0 && typeof entry[0] !== 'object') return null; // legacy ID-only format
  return entry;
}

function setCache(noteId, ids) {
  memCache[String(noteId)] = ids;
  // chrome APIs throw synchronously when the extension is reloaded mid-session.
  // The in-memory update above always succeeds; the storage write is best-effort.
  try {
    chrome.storage.local.get(CACHE_KEY, result => {
      const cache = result[CACHE_KEY] ?? {};
      cache[String(noteId)] = ids;
      try { chrome.storage.local.set({ [CACHE_KEY]: cache }); } catch {}
    });
  } catch {}
}

// ---------------------------------------------------------------------------
// Reply-card augmentation — annotate each reply's reply-count with mine info
// ---------------------------------------------------------------------------

const MINE_ATTR = 'data-smr-mine'; // set on annotation spans to track state

/**
 * Walks up from el looking for an <a href="...note/c-{id}..."> link that
 * belongs to the reply card (i.e. not the current page's own note ID).
 */
function findNoteIdNear(el) {
  let node = el;
  for (let i = 0; i < 10; i++) {
    node = node.parentElement;
    if (!node) break;
    for (const a of node.querySelectorAll('a[href*="/note/c-"]')) {
      // Ignore links we injected ourselves (annotation spans and the main badge)
      // — they contain reply-level note URLs that would corrupt card identification.
      if (a.closest(`[${MINE_ATTR}], #${BADGE_ID}`)) continue;
      const m = a.href.match(/\/note\/c-(\d+)/);
      if (!m) continue;
      // The first note link found in document order determines which card this
      // button belongs to. If it's the current page's note, this is the main
      // note's own interaction bar — skip it. Otherwise it's a reply card.
      return m[1] === currentNoteId ? null : m[1];
    }
  }
  return null;
}

/**
 * Scans all Comment buttons on reply cards and inserts/updates a "(yours: …)"
 * annotation span immediately after each button (as a sibling, not inside it,
 * so clicks on reply links don't trigger the button's own click handler).
 *
 * Reply card interaction bar structure (confirmed via DOM inspection):
 *   <button aria-label="Comment">
 *     <svg>...</svg>
 *     <div>1</div>   ← bare count, no label text
 *   </button>
 *   <span data-smr-mine="…">…</span>  ← annotation injected here
 *
 * We skip any Comment button whose nearest note link matches currentNoteId
 * (i.e. the main note's own comment button, if present).
 *
 * Safe to call repeatedly — idempotent via the MINE_ATTR marker.
 */
function augmentAllReplyCards() {
  for (const btn of document.querySelectorAll('button[aria-label="Comment"]')) {
    const noteId = findNoteIdNear(btn);
    if (!noteId) continue; // belongs to the main note — skip

    const countDiv = btn.querySelector('div');
    if (!countDiv) continue;

    // Reuse existing annotation for this noteId; create one otherwise.
    // The annotation lives as a sibling immediately after the button.
    let annot = btn.nextElementSibling;
    if (!annot || annot.getAttribute(MINE_ATTR) !== noteId) {
      if (annot?.hasAttribute(MINE_ATTR)) annot.remove();
      annot = document.createElement('span');
      annot.setAttribute(MINE_ATTR, noteId);
      annot.style.cssText = 'color: var(--color-fg-secondary-themed, #888); font-size: inherit;';
      btn.insertAdjacentElement('afterend', annot);
    }

    const entry = memCache[String(noteId)];
    const isNewFormat = Array.isArray(entry) && (entry.length === 0 || typeof entry[0] === 'object');
    const stateKey = isNewFormat ? entry.map(r => r.id).join(',') : '?';
    if (annot.dataset.smrState === stateKey) continue;
    annot.dataset.smrState = stateKey;

    annot.innerHTML = '';
    if (!isNewFormat) {
      annot.textContent = '(? yours)';
      checkRelatedNote(noteId);
    } else if (entry.length === 0) {
      annot.textContent = '(yours: 0)';
    } else {
      annot.appendChild(document.createTextNode('(yours: '));
      entry.forEach((reply, i) => {
        if (i > 0) annot.appendChild(document.createTextNode(', '));
        const a = document.createElement('a');
        a.textContent = String(i + 1);
        a.href = `https://substack.com/profile/${MY_USER_SLUG}/note/c-${reply.id}`;
        a.target = '_blank';
        a.title = buildTooltip(reply.title, reply.date);
        annot.appendChild(a);
      });
      annot.appendChild(document.createTextNode(')'));
    }
  }
}

// ---------------------------------------------------------------------------
// Related-note background check
// ---------------------------------------------------------------------------

// Fetches reply data for a note that appears in the Related Notes section
// but hasn't been visited (and thus cached) yet. Fires once per note per
// session. On success, updates the cache and re-renders annotations.
async function checkRelatedNote(noteId) {
  if (relatedNoteChecked.has(noteId)) return;
  relatedNoteChecked.add(noteId);

  const myReplies = [];
  let cursor = null;

  try {
    do {
      const url = new URL(`https://substack.com/api/v1/reader/comment/${noteId}/replies`);
      url.searchParams.set('comment_id', noteId);
      if (cursor) url.searchParams.set('cursor', cursor);

      const resp = await fetch(url.toString(), { credentials: 'include' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data     = await resp.json();
      const branches = data.commentBranches ?? [];

      for (const branch of branches) {
        if (branch.comment?.user_id === MY_USER_ID) myReplies.push(replyData(branch.comment));
        for (const dc of branch.descendantComments ?? []) {
          if (dc?.user_id === MY_USER_ID) myReplies.push(replyData(dc));
        }
      }

      cursor = branches.length === 0 ? null : (data.nextCursor ?? null);
    } while (cursor);

  } catch (err) {
    console.error('[Substack My Replies] related note check error:', err);
    relatedNoteChecked.delete(noteId); // allow retry on next augmentation pass
    return;
  }
  
  setCache(noteId, myReplies);
  augmentAllReplyCards();
}

let augObserver = null;

function startAugObserver() {
  augObserver?.disconnect();
  let debounceTimer = null;
  augObserver = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(augmentAllReplyCards, 250);
  });
  augObserver.observe(document.body, { childList: true, subtree: true });
}

// ---------------------------------------------------------------------------
// Per-note orchestration
// ---------------------------------------------------------------------------

let currentNoteId = null;
let domObserver   = null;

async function handleNote(noteId) {
  if (noteId === currentNoteId) return;
  currentNoteId = noteId;

  domObserver?.disconnect();
  augObserver?.disconnect();
  document.getElementById(BADGE_ID)?.remove();
  // Remove any reply-card annotations left over from the previous page.
  document.querySelectorAll(`[${MINE_ATTR}]`).forEach(el => el.remove());
  ensureStyle();

  const cached = await getCache(noteId);

  // Cache hit: show stored result immediately, skip API call.
  // Cache miss: auto-run the full check.
  const afterInject = cached !== null
    ? () => setBadgeComplete(cached, noteId)
    : () => runCheck(noteId);

  if (injectBadge(noteId)) {
    afterInject();
  } else {
    // React hasn't rendered the replies element yet — wait for it.
    domObserver = new MutationObserver(() => {
      if (injectBadge(noteId)) {
        domObserver.disconnect();
        afterInject();
      }
    });
    domObserver.observe(document.body, { childList: true, subtree: true });
  }

  // Annotate reply cards with cached mine-counts, and watch for new ones.
  augmentAllReplyCards();
  startAugObserver();
}

// ---------------------------------------------------------------------------
// SPA navigation detection
// ---------------------------------------------------------------------------

function checkUrl() {
  const m = location.href.match(NOTE_RE);
  if (m) handleNote(m[1]);
}

function init() {
  const _pushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    _pushState(...args);
    window.dispatchEvent(new Event('smr:urlchange'));
  };

  window.addEventListener('popstate', checkUrl);
  window.addEventListener('smr:urlchange', checkUrl);

  checkUrl();
}

/* istanbul ignore if */
if (typeof module === 'undefined') {
  // Browser-only bootstrap (unreachable in Node.js test environment).
  chrome.storage.local.get(CACHE_KEY, result => {
    memCache = result[CACHE_KEY] ?? {};
    _memCacheReady(); // unblock getCache() now that storage has loaded
    augmentAllReplyCards(); // re-annotate once cache has loaded
  });
  init();
} else {
  _memCacheReady(); // test env: storage is pre-seeded via _state.memCache; unblock immediately
  module.exports = {
    ensureStyle, getBadge,
    setBadgeInitial, setBadgeChecking, setBadgeComplete, setBadgeError,
    findRepliesElement, injectBadge,
    runCheck,
    getCache, setCache,
    findNoteIdNear, augmentAllReplyCards, startAugObserver,
    checkRelatedNote,
    handleNote, checkUrl, init,
    // expose mutable state for tests
    _state: {
      get checkToken() { return checkToken; },
      set checkToken(v) { checkToken = v; },
      get memCache() { return memCache; },
      set memCache(v) { memCache = v; },
      get currentNoteId() { return currentNoteId; },
      set currentNoteId(v) { currentNoteId = v; },
      get relatedNoteChecked() { return relatedNoteChecked; },
    },
  };
}
