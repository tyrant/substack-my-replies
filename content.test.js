'use strict';

// ---------------------------------------------------------------------------
// Global mocks — must be set up before requiring the module
// ---------------------------------------------------------------------------

const chromeMock = {
  storage: {
    local: {
      get: jest.fn((key, cb) => cb({})),
      set: jest.fn(),
    },
  },
};
global.chrome = chromeMock;

jest.spyOn(console, 'error').mockImplementation(() => {});

// ---------------------------------------------------------------------------
// Module loader
// ---------------------------------------------------------------------------

let mod;

function loadModule() {
  jest.resetModules();
  chromeMock.storage.local.get.mockImplementation((key, cb) => cb({}));
  chromeMock.storage.local.set.mockReset();
  mod = require('./content.js');
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function makeBadge() {
  const badge = document.createElement('span');
  badge.id = 'smr-badge';
  document.body.appendChild(badge);
  return badge;
}

/**
 * Adds a text node sibling first so document.body.textContent won't cleanly
 * match /^\d+ Repl(y|ies)$/ — otherwise body is returned before the span.
 */
function makeRepliesEl(text = '3 Replies') {
  document.body.appendChild(document.createTextNode('Page '));
  const el = document.createElement('span');
  el.textContent = text;
  document.body.appendChild(el);
  return el;
}

/**
 * Returns a promise that resolves after all pending micro-tasks have flushed,
 * plus one extra setTimeout(0) tick for timer-based side-effects.
 */
function flush() {
  return new Promise(r => setTimeout(r, 0));
}

function mockFetch(...pages) {
  let call = 0;
  global.fetch = jest.fn(() => {
    const page = pages[call++];
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(page),
    });
  });
}

// ---------------------------------------------------------------------------
// Per-test reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  loadModule();
  mod._state.memCache = {};
  mod._state.currentNoteId = null;
  mod._state.checkToken = 0;
});

afterEach(() => {
  jest.clearAllMocks();
  delete global.fetch;
});

// ---------------------------------------------------------------------------
// ensureStyle
// ---------------------------------------------------------------------------

describe('ensureStyle', () => {
  test('injects a <style> tag with the correct id', () => {
    mod.ensureStyle();
    expect(document.getElementById('smr-style')).not.toBeNull();
  });

  test('is idempotent — only one <style> tag inserted', () => {
    mod.ensureStyle();
    mod.ensureStyle();
    expect(document.querySelectorAll('#smr-style').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getBadge
// ---------------------------------------------------------------------------

describe('getBadge', () => {
  test('returns null when badge is absent', () => {
    expect(mod.getBadge()).toBeNull();
  });

  test('returns the badge element when present', () => {
    const badge = makeBadge();
    expect(mod.getBadge()).toBe(badge);
  });
});

// ---------------------------------------------------------------------------
// setBadgeInitial
// ---------------------------------------------------------------------------

describe('setBadgeInitial', () => {
  test('does nothing when badge is absent', () => {
    expect(() => mod.setBadgeInitial('123')).not.toThrow();
  });

  test('renders "Check replies" link', () => {
    makeBadge();
    mod.setBadgeInitial('123');
    const a = document.querySelector('#smr-badge a');
    expect(a).not.toBeNull();
    expect(a.textContent).toBe('Check replies');
  });

  test('clicking the link starts a check (badge enters checking state)', async () => {
    makeBadge();
    // Mock fetch so runCheck doesn't throw; keep it pending
    let resolveFetch;
    global.fetch = jest.fn(
      () => new Promise(res => { resolveFetch = res; })
    );
    mod.setBadgeInitial('456');
    document.querySelector('#smr-badge a').click();
    await flush();
    expect(document.querySelector('.smr-spinner')).not.toBeNull();
    // Clean up: resolve the pending fetch
    resolveFetch({ ok: true, json: () => Promise.resolve({ commentBranches: [], nextCursor: null }) });
    await flush();
  });
});

// ---------------------------------------------------------------------------
// setBadgeChecking
// ---------------------------------------------------------------------------

describe('setBadgeChecking', () => {
  test('does nothing when badge is absent', () => {
    expect(() => mod.setBadgeChecking(1)).not.toThrow();
  });

  test('first call renders spinner and page number', () => {
    makeBadge();
    mod.setBadgeChecking(1);
    expect(document.querySelector('.smr-spinner')).not.toBeNull();
    expect(document.querySelector('.smr-page-num').textContent).toBe('1');
    expect(document.querySelector('#smr-badge').textContent).toContain('Checking replies');
  });

  test('subsequent calls update only the page number, leaving spinner intact', () => {
    makeBadge();
    mod.setBadgeChecking(1);
    const spinner = document.querySelector('.smr-spinner');
    mod.setBadgeChecking(2);
    expect(document.querySelector('.smr-spinner')).toBe(spinner);
    expect(document.querySelector('.smr-page-num').textContent).toBe('2');
  });
});

// ---------------------------------------------------------------------------
// setBadgeComplete
// ---------------------------------------------------------------------------

describe('setBadgeComplete', () => {
  test('does nothing when badge is absent', () => {
    expect(() => mod.setBadgeComplete([], '1')).not.toThrow();
  });

  test('shows "No replies from you" when ids is empty', () => {
    makeBadge();
    mod.setBadgeComplete([], '1');
    expect(document.querySelector('#smr-badge').textContent).toContain('No replies from you');
  });

  test('shows numbered links for each reply id', () => {
    makeBadge();
    mod.setBadgeComplete(['111', '222', '333'], '1');
    const links = document.querySelectorAll('#smr-badge a[href*="c-"]');
    expect(links).toHaveLength(3);
    expect(links[0].textContent).toBe('1');
    expect(links[0].href).toContain('c-111');
    expect(links[1].href).toContain('c-222');
    expect(links[2].href).toContain('c-333');
  });

  test('all reply links open in a new tab', () => {
    makeBadge();
    mod.setBadgeComplete(['111'], '1');
    expect(document.querySelector('#smr-badge a[href*="c-"]').target).toBe('_blank');
  });

  test('renders a recheck link that starts a new check', async () => {
    makeBadge();
    let resolveFetch;
    global.fetch = jest.fn(
      () => new Promise(res => { resolveFetch = res; })
    );
    mod.setBadgeComplete([], '99');
    const recheck = Array.from(document.querySelectorAll('#smr-badge a'))
      .find(a => a.textContent === 'recheck');
    expect(recheck).not.toBeNull();
    recheck.click();
    await flush();
    expect(document.querySelector('.smr-spinner')).not.toBeNull();
    resolveFetch({ ok: true, json: () => Promise.resolve({ commentBranches: [], nextCursor: null }) });
    await flush();
  });
});

// ---------------------------------------------------------------------------
// setBadgeError
// ---------------------------------------------------------------------------

describe('setBadgeError', () => {
  test('does nothing when badge is absent', () => {
    expect(() => mod.setBadgeError('1')).not.toThrow();
  });

  test('shows error text and retry link', () => {
    makeBadge();
    mod.setBadgeError('1');
    expect(document.querySelector('#smr-badge').textContent).toContain('Could not load replies');
    const retry = Array.from(document.querySelectorAll('#smr-badge a'))
      .find(a => a.textContent === 'retry');
    expect(retry).not.toBeNull();
  });

  test('retry link starts a new check', async () => {
    makeBadge();
    let resolveFetch;
    global.fetch = jest.fn(
      () => new Promise(res => { resolveFetch = res; })
    );
    mod.setBadgeError('77');
    document.querySelector('#smr-badge a').click();
    await flush();
    expect(document.querySelector('.smr-spinner')).not.toBeNull();
    resolveFetch({ ok: true, json: () => Promise.resolve({ commentBranches: [], nextCursor: null }) });
    await flush();
  });
});

// ---------------------------------------------------------------------------
// findRepliesElement
// ---------------------------------------------------------------------------

describe('findRepliesElement', () => {
  test('returns null when no matching element exists', () => {
    expect(mod.findRepliesElement()).toBeNull();
  });

  test('matches "1 Reply"', () => {
    const el = makeRepliesEl('1 Reply');
    expect(mod.findRepliesElement()).toBe(el);
  });

  test('matches "5 Replies"', () => {
    const el = makeRepliesEl('5 Replies');
    expect(mod.findRepliesElement()).toBe(el);
  });

  test('matches "0 Replies"', () => {
    const el = makeRepliesEl('0 Replies');
    expect(mod.findRepliesElement()).toBe(el);
  });

  test('does not match non-reply text', () => {
    makeRepliesEl('5 Comments');
    expect(mod.findRepliesElement()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// injectBadge
// ---------------------------------------------------------------------------

describe('injectBadge', () => {
  test('returns false when replies element is absent', () => {
    expect(mod.injectBadge('123')).toBe(false);
  });

  test('returns true and inserts badge after replies element', () => {
    makeRepliesEl('2 Replies');
    expect(mod.injectBadge('123')).toBe(true);
    expect(document.getElementById('smr-badge')).not.toBeNull();
  });

  test('badge is placed immediately after the replies element', () => {
    const repliesEl = makeRepliesEl('2 Replies');
    mod.injectBadge('123');
    expect(repliesEl.nextElementSibling.id).toBe('smr-badge');
  });

  test('removes existing badge before re-injecting', () => {
    makeBadge();
    makeRepliesEl('2 Replies');
    mod.injectBadge('123');
    expect(document.querySelectorAll('#smr-badge').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runCheck
// ---------------------------------------------------------------------------

describe('runCheck', () => {
  test('single-page: collects top-level and descendant comments authored by me', async () => {
    makeBadge();
    mockFetch({
      commentBranches: [
        {
          comment: { id: 'c1', user_id: 4619740 },
          descendantComments: [{ id: 'dc1', user_id: 4619740 }],
        },
        {
          comment: { id: 'c2', user_id: 9999 },
          descendantComments: [],
        },
      ],
      nextCursor: null,
    });
    await mod.runCheck('100');
    const badge = document.getElementById('smr-badge');
    expect(badge.textContent).toContain('Replies from you');
    expect(badge.querySelector('a[href*="c-c1"]')).not.toBeNull();
    expect(badge.querySelector('a[href*="c-dc1"]')).not.toBeNull();
    expect(badge.querySelector('a[href*="c-c2"]')).toBeNull();
  });

  test('multi-page: follows nextCursor and updates page counter', async () => {
    makeBadge();
    mockFetch(
      {
        commentBranches: [{ comment: { id: 'c1', user_id: 4619740 }, descendantComments: [] }],
        nextCursor: 'cur1',
      },
      {
        commentBranches: [{ comment: { id: 'c2', user_id: 4619740 }, descendantComments: [] }],
        nextCursor: null,
      }
    );
    await mod.runCheck('200');
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenNthCalledWith(
      2, expect.stringContaining('cursor=cur1'), expect.anything()
    );
    const badge = document.getElementById('smr-badge');
    expect(badge.querySelector('a[href*="c-c1"]')).not.toBeNull();
    expect(badge.querySelector('a[href*="c-c2"]')).not.toBeNull();
  });

  test('empty commentBranches stops pagination regardless of nextCursor', async () => {
    makeBadge();
    mockFetch({ commentBranches: [], nextCursor: 'ignored' });
    await mod.runCheck('300');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(document.getElementById('smr-badge').textContent).toContain('No replies from you');
  });

  test('HTTP error shows error badge', async () => {
    makeBadge();
    global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 500 }));
    await mod.runCheck('400');
    expect(document.getElementById('smr-badge').textContent).toContain('Could not load replies');
  });

  test('network error shows error badge', async () => {
    makeBadge();
    global.fetch = jest.fn(() => Promise.reject(new Error('net fail')));
    await mod.runCheck('401');
    expect(document.getElementById('smr-badge').textContent).toContain('Could not load replies');
  });

  test('stale token — superseded check does not update the badge', async () => {
    makeBadge();
    let resolveFirst;
    global.fetch = jest.fn(
      () => new Promise(res => { resolveFirst = () => res({ ok: true, json: () => Promise.resolve({ commentBranches: [], nextCursor: null }) }); })
    );
    const first = mod.runCheck('500');
    mod._state.checkToken += 1; // simulate recheck
    resolveFirst();
    await first;
    // Badge should NOT have been set to complete (token was stale)
    expect(document.getElementById('smr-badge').textContent).not.toContain('No replies from you');
  });

  test('stale token on error path — badge not updated', async () => {
    makeBadge();
    let rejectFirst;
    global.fetch = jest.fn(
      () => new Promise((_, rej) => { rejectFirst = () => rej(new Error('fail')); })
    );
    const first = mod.runCheck('600');
    mod._state.checkToken += 1;
    rejectFirst();
    await first;
    expect(document.getElementById('smr-badge').textContent).not.toContain('Could not load replies');
  });

  test('saves result to memCache on success', async () => {
    makeBadge();
    mockFetch({
      commentBranches: [{ comment: { id: 'cX', user_id: 4619740 }, descendantComments: [] }],
      nextCursor: null,
    });
    await mod.runCheck('700');
    expect(mod._state.memCache['700']).toEqual(['cX']);
  });

  test('fetch URL includes comment_id param', async () => {
    makeBadge();
    mockFetch({ commentBranches: [], nextCursor: null });
    await mod.runCheck('800');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('comment_id=800'),
      expect.anything()
    );
  });

  test('null descendantComment entries are skipped without crashing', async () => {
    makeBadge();
    mockFetch({
      commentBranches: [
        { comment: { id: 'c1', user_id: 9 }, descendantComments: [null] },
      ],
      nextCursor: null,
    });
    await mod.runCheck('950');
    expect(document.getElementById('smr-badge').textContent).toContain('No replies from you');
  });

  test('missing commentBranches key defaults to empty array', async () => {
    makeBadge();
    mockFetch({ nextCursor: null }); // no commentBranches key
    await mod.runCheck('960');
    expect(document.getElementById('smr-badge').textContent).toContain('No replies from you');
  });

  test('missing descendantComments key defaults to empty array (nullish branch)', async () => {
    makeBadge();
    // branch.descendantComments is absent → ?? [] fallback fires
    mockFetch({
      commentBranches: [
        { comment: { id: 'c1', user_id: 4619740 } }, // no descendantComments key
      ],
      nextCursor: null,
    });
    await mod.runCheck('970');
    const badge = document.getElementById('smr-badge');
    expect(badge.querySelector('a[href*="c-c1"]')).not.toBeNull();
  });

  test('mid-pagination stale token: exits loop on second iteration token check', async () => {
    makeBadge();
    let page1Resolve;
    global.fetch = jest.fn().mockImplementationOnce(
      () => new Promise(res => {
        page1Resolve = () => res({
          ok: true,
          json: () => Promise.resolve({
            commentBranches: [{ comment: { id: 'c1', user_id: 9 }, descendantComments: [] }],
            nextCursor: 'p2',
          }),
        });
      })
    );
    const run = mod.runCheck('501');
    // Let runCheck reach the first `await fetch()` and suspend there
    await Promise.resolve();
    // Bump token (simulates user clicking recheck mid-flight)
    mod._state.checkToken += 1;
    // Resolve page 1 — loop will process it, then check token at top of iteration 2 → stale → return
    page1Resolve();
    await run;
    // Only one page fetched; second page was never requested
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// getCache
// ---------------------------------------------------------------------------

describe('getCache', () => {
  test('returns null when entry is absent', async () => {
    expect(await mod.getCache('1')).toBeNull();
  });

  test('returns the array when entry is an array', async () => {
    mod._state.memCache = { '1': ['a', 'b'] };
    expect(await mod.getCache('1')).toEqual(['a', 'b']);
  });

  test('returns null for old number-format entries', async () => {
    mod._state.memCache = { '1': 3 };
    expect(await mod.getCache('1')).toBeNull();
  });

  test('coerces numeric argument to string key', async () => {
    mod._state.memCache = { '42': ['x'] };
    expect(await mod.getCache(42)).toEqual(['x']);
  });
});

// ---------------------------------------------------------------------------
// setCache
// ---------------------------------------------------------------------------

describe('setCache', () => {
  test('updates memCache immediately (synchronously)', () => {
    chromeMock.storage.local.get.mockImplementation((key, cb) => cb({ smr_cache: {} }));
    mod.setCache('5', ['id1']);
    expect(mod._state.memCache['5']).toEqual(['id1']);
  });

  test('merges with existing cache entries in storage', () => {
    chromeMock.storage.local.get.mockImplementation((key, cb) =>
      cb({ smr_cache: { '3': ['old'] } })
    );
    mod.setCache('5', ['id1']);
    expect(chromeMock.storage.local.set).toHaveBeenCalledWith({
      smr_cache: { '3': ['old'], '5': ['id1'] },
    });
  });

  test('initialises cache object when storage is empty', () => {
    chromeMock.storage.local.get.mockImplementation((key, cb) => cb({}));
    mod.setCache('5', ['id1']);
    expect(chromeMock.storage.local.set).toHaveBeenCalledWith({
      smr_cache: { '5': ['id1'] },
    });
  });
});

// ---------------------------------------------------------------------------
// findNoteIdNear
// ---------------------------------------------------------------------------

describe('findNoteIdNear', () => {
  test('returns null when no ancestor has a note link', () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    expect(mod.findNoteIdNear(btn)).toBeNull();
  });

  test('returns the note id from an ancestor link', () => {
    mod._state.currentNoteId = '999';
    const container = document.createElement('div');
    const a = document.createElement('a');
    a.href = 'https://substack.com/@user/note/c-111';
    container.appendChild(a);
    const btn = document.createElement('button');
    container.appendChild(btn);
    document.body.appendChild(container);
    expect(mod.findNoteIdNear(btn)).toBe('111');
  });

  test('returns null when first note link matches currentNoteId (main note card)', () => {
    mod._state.currentNoteId = '111';
    const container = document.createElement('div');
    const a = document.createElement('a');
    a.href = 'https://substack.com/@user/note/c-111';
    container.appendChild(a);
    const btn = document.createElement('button');
    container.appendChild(btn);
    document.body.appendChild(container);
    expect(mod.findNoteIdNear(btn)).toBeNull();
  });

  test('skips ancestor links whose href does not match the numeric id pattern', () => {
    mod._state.currentNoteId = null;
    const container = document.createElement('div');
    // href matches the querySelector selector but not /\/note\/c-(\d+)/ (no digits after c-)
    const badLink = document.createElement('a');
    badLink.href = 'https://substack.com/note/c-notanumber';
    container.appendChild(badLink);
    const goodLink = document.createElement('a');
    goodLink.href = 'https://substack.com/note/c-42';
    container.appendChild(goodLink);
    const btn = document.createElement('button');
    container.appendChild(btn);
    document.body.appendChild(container);
    // Should skip the bad link, find the good one
    expect(mod.findNoteIdNear(btn)).toBe('42');
  });

  test('does not traverse more than 10 parent levels to find a link', () => {
    mod._state.currentNoteId = null;
    // Build: btn → 11 wrapping divs → outer div (which holds the link)
    let inner = document.createElement('button');
    let node = inner;
    for (let i = 0; i < 11; i++) {
      const d = document.createElement('div');
      d.appendChild(node);
      node = d;
    }
    // note link is 11 levels above btn
    const a = document.createElement('a');
    a.href = 'https://substack.com/@user/note/c-555';
    node.appendChild(a);
    document.body.appendChild(node);
    expect(mod.findNoteIdNear(inner)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// augmentAllReplyCards
// ---------------------------------------------------------------------------

describe('augmentAllReplyCards', () => {
  function makeReplyCard(noteId, currentNoteId) {
    mod._state.currentNoteId = currentNoteId ?? null;
    const card = document.createElement('div');
    const link = document.createElement('a');
    link.href = `https://substack.com/@user/note/c-${noteId}`;
    card.appendChild(link);
    const btn = document.createElement('button');
    btn.setAttribute('aria-label', 'Comment');
    const countDiv = document.createElement('div');
    countDiv.textContent = '3';
    btn.appendChild(countDiv);
    card.appendChild(btn);
    document.body.appendChild(card);
    return btn;
  }

  test('inserts "(? yours)" when no cache entry exists', () => {
    makeReplyCard('111', '999');
    mod.augmentAllReplyCards();
    const annot = document.querySelector('[data-smr-mine]');
    expect(annot.textContent).toBe('(? yours)');
    expect(annot.getAttribute('data-smr-mine')).toBe('111');
  });

  test('inserts "(N yours)" when cache entry is present', () => {
    mod._state.memCache = { '111': ['a', 'b'] };
    makeReplyCard('111', '999');
    mod.augmentAllReplyCards();
    expect(document.querySelector('[data-smr-mine]').textContent).toBe('(2 yours)');
  });

  test('skips Comment button belonging to the main note', () => {
    makeReplyCard('111', '111');
    mod.augmentAllReplyCards();
    expect(document.querySelector('[data-smr-mine]')).toBeNull();
  });

  test('skips buttons without a count div child (even when note link present)', () => {
    mod._state.currentNoteId = '999';
    const card = document.createElement('div');
    // Provide a note link so findNoteIdNear returns non-null
    const link = document.createElement('a');
    link.href = 'https://substack.com/@user/note/c-111';
    card.appendChild(link);
    const btn = document.createElement('button');
    btn.setAttribute('aria-label', 'Comment');
    // No <div> child — should hit the `if (!countDiv) continue` branch
    card.appendChild(btn);
    document.body.appendChild(card);
    expect(() => mod.augmentAllReplyCards()).not.toThrow();
    expect(document.querySelector('[data-smr-mine]')).toBeNull();
  });

  test('is idempotent — calling twice does not duplicate annotation', () => {
    makeReplyCard('111', '999');
    mod.augmentAllReplyCards();
    mod.augmentAllReplyCards();
    expect(document.querySelectorAll('[data-smr-mine]').length).toBe(1);
  });

  test('updates label text when cache entry changes', () => {
    mod._state.memCache = {};
    makeReplyCard('111', '999');
    mod.augmentAllReplyCards();
    expect(document.querySelector('[data-smr-mine]').textContent).toBe('(? yours)');
    mod._state.memCache = { '111': ['x'] };
    mod.augmentAllReplyCards();
    expect(document.querySelector('[data-smr-mine]').textContent).toBe('(1 yours)');
  });

  test('replaces a stale annotation element (wrong noteId)', () => {
    mod._state.currentNoteId = '999';
    const card = document.createElement('div');
    const link = document.createElement('a');
    link.href = 'https://substack.com/@user/note/c-111';
    card.appendChild(link);
    const btn = document.createElement('button');
    btn.setAttribute('aria-label', 'Comment');
    const countDiv = document.createElement('div');
    btn.appendChild(countDiv);
    const stale = document.createElement('span');
    stale.setAttribute('data-smr-mine', '000');
    countDiv.insertAdjacentElement('afterend', stale);
    card.appendChild(btn);
    document.body.appendChild(card);

    mod.augmentAllReplyCards();
    expect(document.querySelector('[data-smr-mine="000"]')).toBeNull();
    expect(document.querySelector('[data-smr-mine="111"]')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// startAugObserver
// ---------------------------------------------------------------------------

describe('startAugObserver', () => {
  test('does not throw when called', () => {
    expect(() => mod.startAugObserver()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// handleNote
// ---------------------------------------------------------------------------

describe('handleNote', () => {
  test('no-ops when called with the same noteId twice', async () => {
    mod._state.currentNoteId = '123';
    mod.ensureStyle(); // would be called by handleNote; call it now to detect doubles
    const styleCount = document.querySelectorAll('#smr-style').length;
    await mod.handleNote('123');
    expect(document.querySelectorAll('#smr-style').length).toBe(styleCount);
  });

  test('cache hit: badge shows complete state immediately without fetching', async () => {
    mod._state.memCache = { '42': ['c1', 'c2'] };
    makeRepliesEl('2 Replies');
    await mod.handleNote('42');
    const badge = document.getElementById('smr-badge');
    expect(badge.textContent).toContain('Replies from you');
    expect(badge.querySelector('a[href*="c-c1"]')).not.toBeNull();
    expect(global.fetch).toBeUndefined(); // no fetch call made
  });

  test('cache miss: auto-starts a check (fetch is called)', async () => {
    makeRepliesEl('2 Replies');
    mockFetch({ commentBranches: [], nextCursor: null });
    await mod.handleNote('43');
    expect(global.fetch).toHaveBeenCalled();
  });

  test('removes old badge when switching notes', async () => {
    const oldBadge = document.createElement('span');
    oldBadge.id = 'smr-badge';
    document.body.appendChild(oldBadge);

    makeRepliesEl('1 Reply');
    mockFetch({ commentBranches: [], nextCursor: null });
    await mod.handleNote('44');
    expect(document.querySelectorAll('#smr-badge').length).toBe(1);
  });

  test('removes reply-card annotations from previous note', async () => {
    const oldAnnot = document.createElement('span');
    oldAnnot.setAttribute('data-smr-mine', '000');
    document.body.appendChild(oldAnnot);

    makeRepliesEl('1 Reply');
    mockFetch({ commentBranches: [], nextCursor: null });
    await mod.handleNote('45');
    expect(document.querySelector('[data-smr-mine="000"]')).toBeNull();
  });

  test('waits for DOM via MutationObserver when replies element is absent', async () => {
    mockFetch({ commentBranches: [], nextCursor: null });
    const promise = mod.handleNote('55');
    // Let handleNote proceed past `await getCache(noteId)` and set up the observer
    await Promise.resolve();
    await Promise.resolve();
    // Add the replies element — triggers the domObserver (jsdom fires MutationObserver as microtask)
    makeRepliesEl('1 Reply');
    // Drain microtasks so the observer callback runs, then the timer queue
    await flush();
    await flush();
    await promise;
    expect(document.getElementById('smr-badge')).not.toBeNull();
  });

  test('MutationObserver keeps watching when an unrelated mutation fires first', async () => {
    mockFetch({ commentBranches: [], nextCursor: null });
    const promise = mod.handleNote('56');
    // Let handleNote set up the domObserver
    await Promise.resolve();
    await Promise.resolve();
    // Unrelated DOM mutation: observer fires, injectBadge returns false (element absent)
    document.body.appendChild(document.createElement('div'));
    await flush();
    expect(document.getElementById('smr-badge')).toBeNull();
    // Now add the replies element: observer fires again, injectBadge returns true
    makeRepliesEl('1 Reply');
    await flush();
    await flush();
    await promise;
    expect(document.getElementById('smr-badge')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkUrl
// ---------------------------------------------------------------------------

describe('checkUrl', () => {
  test('calls handleNote when URL matches note pattern', async () => {
    Object.defineProperty(window, 'location', {
      value: { href: 'https://substack.com/@alice/note/c-12345' },
      writable: true,
      configurable: true,
    });
    mockFetch({ commentBranches: [], nextCursor: null });
    mod.checkUrl();
    await flush();
    expect(mod._state.currentNoteId).toBe('12345');
  });

  test('does not set currentNoteId for non-note URLs', async () => {
    Object.defineProperty(window, 'location', {
      value: { href: 'https://substack.com/@alice' },
      writable: true,
      configurable: true,
    });
    mod.checkUrl();
    await flush();
    expect(mod._state.currentNoteId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// init (SPA navigation wiring)
// ---------------------------------------------------------------------------

describe('init', () => {
  beforeEach(() => {
    // Use a non-note URL so init()'s own checkUrl() call doesn't trigger handleNote
    Object.defineProperty(window, 'location', {
      value: { href: 'https://substack.com/' },
      writable: true,
      configurable: true,
    });
  });

  test('patches history.pushState to emit smr:urlchange', () => {
    mod.init();
    const listener = jest.fn();
    window.addEventListener('smr:urlchange', listener);
    history.pushState({}, '', '/test');
    expect(listener).toHaveBeenCalled();
    window.removeEventListener('smr:urlchange', listener);
  });

  test('popstate event triggers a URL check', async () => {
    mod.init();
    Object.defineProperty(window, 'location', {
      value: { href: 'https://substack.com/@bob/note/c-99999' },
      writable: true,
      configurable: true,
    });
    mockFetch({ commentBranches: [], nextCursor: null });
    window.dispatchEvent(new Event('popstate'));
    await flush();
    expect(mod._state.currentNoteId).toBe('99999');
  });

  test('smr:urlchange event triggers a URL check', async () => {
    mod.init();
    Object.defineProperty(window, 'location', {
      value: { href: 'https://substack.com/@bob/note/c-88888' },
      writable: true,
      configurable: true,
    });
    mockFetch({ commentBranches: [], nextCursor: null });
    window.dispatchEvent(new Event('smr:urlchange'));
    await flush();
    expect(mod._state.currentNoteId).toBe('88888');
  });
});
