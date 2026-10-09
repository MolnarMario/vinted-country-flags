// The one place that knows how many requests are left and who has already been
// looked up.
//
// Both used to live in the content script, and both were wrong there. Vinted's
// rate limit is per IP, so two Vinted tabs share one budget and two per-tab
// throttles will happily spend it twice. The cache was IndexedDB in the page's
// origin, so a seller resolved on vinted.fr was a stranger again on vinted.de,
// even though seller ids are global across markets.
//
// The worker does no fetching. A content script asks it for permission, waits
// the granted delay, fetches from the page's own context, then reports what
// came back.

// Measured on vinted.fr: from a cold bucket exactly 30 requests succeed, and
// paced at 1 per second 45 in a row drew no 429. The extension used to run
// right at that edge, which was fine while it sent a handful of lookups per
// page. Since 2026-10-08 every uncached seller costs one, the page's own
// /api/v2 calls (banners, info_banners) hit the same host, and Vinted now has
// a "Client Challenge" page it serves instead of JSON. So the bucket keeps
// a third of the burst and a fifth of the rate back for the site itself.
const CAPACITY = 20;
const REFILL = 0.8;    // per second
const FALLBACK_RETRY_MS = 60000; // what Vinted's Retry-After said, every time

const DB_NAME = 'vinted-country-flags';
// Version 2 throws away every cached item. Up to 2.1.0 a card nobody else
// could name had its seller read off the item page, and that page also carries
// the visitor's own profile link, so some items were cached for thirty days
// under the visitor's country. Sellers are kept: each of those came from the
// seller's own profile and is right.
const DB_VERSION = 2;
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // a seller's country basically never changes
const COUNTRIES_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ------------------------------------------------------------- token bucket

// The worker is torn down after about 30 seconds idle and the bucket goes with
// it. That happens to be right: 30 idle seconds refill 24 tokens, more than the
// whole capacity. The circuit is the part that has to survive, so it
// lives in session storage.
let bucket = null;

async function loadBucket() {
  if (bucket) return bucket;
  let saved = null;
  try {
    saved = (await chrome.storage.session.get('vcfBucket')).vcfBucket;
  } catch (e) {
    saved = null;
  }
  const now = Date.now();
  bucket = {
    tokens: CAPACITY,
    last: now,
    blockedUntil: 0,
    sent: 0,
    throttled: 0,
    failed: 0,
    ...(saved || {}),
  };
  return bucket;
}

function saveBucket() {
  try {
    chrome.storage.session.set({ vcfBucket: bucket });
  } catch (e) {
    /* session storage is unavailable in some enterprise profiles */
  }
}

function refill(now) {
  const gained = ((now - bucket.last) / 1000) * REFILL;
  bucket.tokens = Math.min(CAPACITY, bucket.tokens + gained);
  bucket.last = now;
}

// Hands out one token and says how long the caller must wait before spending
// it. Tokens are allowed to go negative: that is what queues the callers behind
// each other instead of letting them all fire at once.
async function reserve() {
  await loadBucket();
  const now = Date.now();

  if (now < bucket.blockedUntil) {
    return { ok: false, blockedMs: bucket.blockedUntil - now };
  }

  refill(now);
  const deficit = 1 - bucket.tokens;
  bucket.tokens -= 1;
  saveBucket();
  return { ok: true, waitMs: deficit > 0 ? Math.ceil((deficit / REFILL) * 1000) : 0 };
}

// A card that scrolled off screen before its turn came. Putting the token back
// keeps abandoned work from eating the budget.
async function release() {
  await loadBucket();
  refill(Date.now());
  bucket.tokens = Math.min(CAPACITY, bucket.tokens + 1);
  saveBucket();
  return { ok: true };
}

// 429 carries Retry-After, and every one I saw said 60. Honour it rather than
// picking a number: the old five minute lockout threw away four minutes of
// budget on every trip.
async function report({ ok, status, retryAfter }) {
  await loadBucket();
  if (ok) {
    bucket.sent++;
    saveBucket();
    return { ok: true };
  }

  const pushback = status === 429 || status === 403 || status === 503;
  if (pushback) {
    const secs = Number(retryAfter);
    const waitMs = secs > 0 ? Math.min(secs * 1000, 15 * 60 * 1000) : FALLBACK_RETRY_MS;
    bucket.throttled++;
    bucket.blockedUntil = Date.now() + waitMs;
    bucket.tokens = 0;
    bucket.last = Date.now();
  } else {
    bucket.failed++;
  }
  saveBucket();
  return { ok: true };
}

async function bucketState() {
  await loadBucket();
  refill(Date.now());
  const now = Date.now();
  return {
    tokens: Math.floor(Math.max(0, bucket.tokens)),
    blockedMs: Math.max(0, bucket.blockedUntil - now),
    sent: bucket.sent,
    throttled: bucket.throttled,
    failed: bucket.failed,
  };
}

// -------------------------------------------------------------------- cache

const MEM = { users: new Map(), items: new Map() };
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (event.oldVersion >= 1 && event.oldVersion < 2 && db.objectStoreNames.contains('items')) {
        db.deleteObjectStore('items');
      }
      if (!db.objectStoreNames.contains('users')) db.createObjectStore('users', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((e) => {
    console.warn('[vcf] IndexedDB unavailable, memory cache only', e);
    return null;
  });
  return dbPromise;
}

function store(name, mode) {
  return openDb().then((db) => (db ? db.transaction(name, mode).objectStore(name) : null));
}

async function cacheGet(name, id) {
  const key = String(id);
  const hot = MEM[name].get(key);
  if (hot !== undefined) return hot;

  const os = await store(name, 'readonly');
  if (!os) return null;
  const rec = await new Promise((resolve) => {
    const r = os.get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => resolve(null);
  });
  if (!rec || Date.now() - rec.ts > TTL_MS) return null;
  MEM[name].set(key, rec);
  return rec;
}

async function cachePut(name, rec) {
  const row = { ...rec, id: String(rec.id), ts: Date.now() };
  MEM[name].set(row.id, row);
  const os = await store(name, 'readwrite');
  if (os) os.put(row);
  return row;
}

// A catalog response names 96 sellers at once and currency pins most of them.
// One message banks the lot, in one transaction, rather than a read and a write
// each. These records carry no city, so they must never overwrite one the
// profile endpoint paid for: add() refuses a key that already exists, which is
// that rule for free. Its ConstraintError has to be swallowed per request or it
// takes the whole transaction down with it.
async function bankUsers(rows) {
  const os = await store('users', 'readwrite');
  const now = Date.now();
  let queued = 0;

  for (const row of rows || []) {
    if (!row || !row.id || !row.cc) continue;
    const id = String(row.id);
    if (MEM.users.get(id)) continue;
    const rec = { id, cc: row.cc, city: null, ts: now };
    if (!os) {
      MEM.users.set(id, rec);
      queued++;
      continue;
    }
    const req = os.add(rec);
    req.onsuccess = () => MEM.users.set(id, rec);
    req.onerror = (e) => e.preventDefault();
    queued++;
  }
  return { queued };
}

async function cacheCount(name) {
  const os = await store(name, 'readonly');
  if (!os) return MEM[name].size;
  return new Promise((resolve) => {
    const r = os.count();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(0);
  });
}

async function cacheClear() {
  MEM.users.clear();
  MEM.items.clear();
  for (const name of ['users', 'items']) {
    const os = await store(name, 'readwrite');
    if (os) os.clear();
  }
  return { ok: true };
}

// ----------------------------------------------------------- country table

// /api/v2/countries answers the same on every domain, so one copy serves all of
// them. The content script fetches it, because a fetch from the page's own
// context is the one that behaves exactly like Vinted's front end.
async function getCountries() {
  try {
    const saved = (await chrome.storage.local.get('vcfCountries')).vcfCountries;
    if (saved && Date.now() - saved.ts < COUNTRIES_TTL_MS && Array.isArray(saved.rows)) {
      return { rows: saved.rows };
    }
  } catch (e) {
    /* fall through and let the caller fetch */
  }
  return { rows: null };
}

async function putCountries(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false };
  await chrome.storage.local.set({ vcfCountries: { ts: Date.now(), rows } });
  return { ok: true };
}

// ------------------------------------------------------------------ routing

const HANDLERS = {
  reserve,
  release,
  report: (m) => report(m),
  bucket: bucketState,
  getUser: (m) => cacheGet('users', m.id),
  putUser: (m) => cachePut('users', { id: m.id, cc: m.cc, city: m.city || null }),
  bankUsers: (m) => bankUsers(m.rows),
  getItem: (m) => cacheGet('items', m.id),
  putItem: (m) => cachePut('items', { id: m.id, cc: m.cc }),
  counts: async () => ({
    users: await cacheCount('users'),
    items: await cacheCount('items'),
  }),
  clear: cacheClear,
  getCountries,
  putCountries: (m) => putCountries(m.rows),
};

// The bucket is the one piece of arithmetic here that can be wrong in a way
// nobody notices until Vinted starts answering 429, so the tests reach it
// directly rather than through the message channel.
globalThis.VCF_WORKER = { reserve, release, report, bucketState, HANDLERS, CAPACITY, REFILL };

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = msg && HANDLERS[msg.k];
  if (!handler) return false;
  Promise.resolve(handler(msg))
    .then((out) => sendResponse(out === undefined ? null : out))
    .catch((e) => sendResponse({ error: String((e && e.message) || e) }));
  return true; // the response is async
});
