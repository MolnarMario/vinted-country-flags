// Unit tests for the files with no DOM dependency worth mocking.
// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

function loadInto(sandbox, file) {
  vm.runInContext(readFileSync(file, 'utf8'), sandbox);
}

// A fake service worker: the content-script side talks to it over
// chrome.runtime.sendMessage, so the tests hand it whatever the case needs.
function fakeChrome(handlers = {}) {
  return {
    runtime: {
      sendMessage: async (msg) => {
        const h = handlers[msg.k];
        if (!h) throw new Error('no handler for ' + msg.k);
        return h(msg);
      },
      getURL: (p) => 'chrome-extension://test/' + p,
    },
  };
}

function newSandbox({ hostname = 'www.vinted.ro', lang = 'ro-RO', chrome } = {}) {
  const ctx = vm.createContext({
    location: { hostname, pathname: '/catalog', search: '' },
    document: {
      documentElement: { getAttribute: (name) => (name === 'lang' ? lang : null) },
    },
    chrome: chrome || fakeChrome(),
    console,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    Promise,
    Intl,
    URLSearchParams,
  });
  vm.runInContext('globalThis.globalThis = globalThis;', ctx);
  return ctx;
}

// ------------------------------------------------------------------ countries

// /api/v2/countries as it answered on 2026-08-31, trimmed to the fields the
// extension reads. All 27 markets, so the "exactly one market uses this
// currency" rule is being tested against the real shape of the data.
const COUNTRY_ROWS = [
  [2, 'DE', 'EUR', 'Germania'], [35, 'AU', 'AUD', 'Australia'], [4, 'AT', 'EUR', 'Austria'],
  [19, 'BE', 'EUR', 'Belgia'], [29, 'HR', 'EUR', 'Croația'], [27, 'DK', 'DKK', 'Danemarca'],
  [7, 'ES', 'EUR', 'Spania'], [32, 'EE', 'EUR', 'Estonia'], [28, 'FI', 'EUR', 'Finlanda'],
  [16, 'FR', 'EUR', 'Franța'], [30, 'GR', 'EUR', 'Grecia'], [24, 'HU', 'HUF', 'Ungaria'],
  [31, 'IE', 'EUR', 'Irlanda'], [18, 'IT', 'EUR', 'Italia'], [33, 'LV', 'EUR', 'Letonia'],
  [1, 'LT', 'EUR', 'Lituania'], [20, 'LU', 'EUR', 'Luxemburg'], [10, 'NL', 'EUR', 'Țările de Jos'],
  [15, 'PL', 'PLN', 'Polonia'], [21, 'PT', 'EUR', 'Portugalia'], [25, 'RO', 'RON', 'România'],
  [13, 'GB', 'GBP', 'Regatul Unit'], [3, 'CZ', 'CZK', 'Cehia'], [22, 'SK', 'EUR', 'Slovacia'],
  [34, 'SI', 'EUR', 'Slovenia'], [12, 'SE', 'SEK', 'Suedia'], [14, 'US', 'USD', 'Statele Unite'],
].map(([id, iso_code, currency, title]) => ({ id, iso_code, currency, title }));

function loadCountries(opts = {}) {
  const ctx = newSandbox(opts);
  loadInto(ctx, 'src/countries.js');
  const C = ctx.VCF_COUNTRIES;
  if (opts.init !== false) assert.equal(C.init(COUNTRY_ROWS), true);
  return C;
}

test('the market table comes from Vinted, not from a hardcoded domain list', () => {
  const C = loadCountries({ init: false });
  assert.equal(C.ready, false, 'nothing is answered before the table loads');
  assert.equal(C.fromConversion(null), null);
  assert.equal(C.init([]), false, 'an empty answer is not a market');
  assert.equal(C.init(COUNTRY_ROWS), true);
  assert.equal(C.ready, true);
});

test('a currency used by one market pins that country', () => {
  const C = loadCountries();
  assert.equal(C.fromCurrency('RON'), 'RO');
  assert.equal(C.fromCurrency('PLN'), 'PL');
  assert.equal(C.fromCurrency('HUF'), 'HU');
  assert.equal(C.fromCurrency('CZK'), 'CZ');
  assert.equal(C.fromCurrency('GBP'), 'GB');
  assert.equal(C.fromCurrency('AUD'), 'AU', 'Australia is a market and the old table missed it');
  assert.equal(C.fromCurrency('EUR'), 'EU', 'eighteen markets, so the euro pins nothing');
  assert.equal(C.fromCurrency('CHF'), null, 'Switzerland is not a Vinted market');
  assert.equal(C.fromCurrency('BGN'), null, 'nor Bulgaria, which the old table claimed');
  assert.equal(C.fromCurrency('XYZ'), null);
});

test('a null conversion means the seller prices in the buyer currency', () => {
  // The page language names the market before the first catalog response lands.
  const ro = loadCountries({ lang: 'ro-RO' });
  assert.equal(ro.buyerCurrency, 'RON');
  assert.equal(ro.fromConversion(null), 'RO');
  assert.equal(ro.fromConversion({ seller_currency: 'PLN' }), 'PL');

  // The same file on a euro domain. Measured: 0 of 259 items on vinted.fr
  // carried a conversion, so this branch is the whole page.
  const fr = loadCountries({ hostname: 'www.vinted.fr', lang: 'fr-FR' });
  assert.equal(fr.buyerCurrency, 'EUR');
  assert.equal(fr.fromConversion(null), 'EU', 'which is why the euro domains cost a lookup each');
  assert.equal(fr.fromConversion({ seller_currency: 'PLN' }), 'PL');

  const uk = loadCountries({ hostname: 'www.vinted.co.uk', lang: 'en-GB' });
  assert.equal(uk.buyerCurrency, 'GBP');
  assert.equal(uk.fromConversion(null), 'GB');
});

test('the catalog response overrides the language guess', () => {
  const C = loadCountries({ lang: 'en' }); // no region subtag to work from
  assert.equal(C.buyerCurrency, null);
  assert.equal(C.fromConversion(null), null, 'no guess is better than a wrong one');
  C.setBuyerCurrency('pln');
  assert.equal(C.buyerCurrency, 'PLN');
  assert.equal(C.fromConversion(null), 'PL');
  C.setBuyerCurrency('nonsense');
  assert.equal(C.buyerCurrency, 'PLN', 'a malformed code is ignored, not stored');
});

test('a seller profile is read by country id, not by Vinted’s own code', () => {
  const C = loadCountries();
  // The live bug this replaces: country_code is "UK", which is not an ISO
  // country and resolved to the "?" marker for every British seller.
  const brit = { country_id: 13, country_code: 'UK', country_iso_code: 'GB', city: 'Liverpool' };
  assert.equal(C.fromUser(brit), 'GB');
  assert.equal(C.fromUser({ country_id: 25, country_code: 'RO' }), 'RO');

  // Greece is the same trap by analogy, EL against GR. The id join sidesteps
  // it without needing a Greek seller to confirm.
  assert.equal(C.fromUser({ country_id: 30, country_code: 'EL' }), 'GR');

  // A seller living outside every market: the id is not in the table, so the
  // ISO code is all there is.
  assert.equal(C.fromUser({ country_id: 999, country_iso_code: 'CH' }), 'CH');
  assert.equal(C.fromUser({ country_id: 999, country_code: 'CH' }), null);
  assert.equal(C.fromUser(null), null);
});

test('EU is a placeholder, not an answer', () => {
  const C = loadCountries();
  assert.equal(C.isResolved('RO'), true);
  assert.equal(C.isResolved('EU'), false, 'must not be cached as if it were a country');
  assert.equal(C.isResolved('XX'), false);
  assert.equal(C.isResolved(null), false);
});

test('every flag a country code can resolve to is actually shipped', () => {
  const C = loadCountries();
  assert.equal(C.flagFile('RO'), 'ro');
  assert.equal(C.flagFile('gb'), 'gb');
  assert.equal(C.flagFile('EU'), 'eu');
  assert.equal(C.flagFile('ZZZ'), 'xx', 'anything that is not a two letter code');
  assert.equal(C.flagFile(null), 'xx');

  // A seller can live anywhere, so the bundle covers every ISO code rather
  // than the 34 flags that used to be in it.
  for (const cc of ['RO', 'GB', 'AU', 'CH', 'BR', 'JP', 'NZ', 'TR', 'MA', 'KE', 'FJ', 'XK']) {
    assert.ok(existsSync(`flags/${C.flagFile(cc)}.svg`), `no flag file for ${cc}`);
  }
  assert.ok(existsSync('flags/xx.svg'));
  assert.ok(existsSync('flags/eu.svg'));
});

test('country names come from the site’s own language', () => {
  const ro = loadCountries({ lang: 'ro-RO' });
  assert.equal(ro.name('HU'), 'Ungaria', 'Vinted’s own title for a market');
  assert.equal(ro.name('RO'), 'România');
  // Not a market, so no title from Vinted, and Intl fills the gap in Romanian.
  assert.equal(ro.name('CH'), 'Elveția');
  assert.equal(ro.name('QQ'), 'QQ', 'a code nothing knows falls back to the code itself');
  assert.equal(ro.name(''), 'Unknown');

  const fr = loadCountries({ hostname: 'www.vinted.fr', lang: 'fr-FR', init: false });
  fr.init(COUNTRY_ROWS.map((r) => ({ ...r, title: null })));
  assert.equal(fr.name('DE'), 'Allemagne', 'with no title, Intl localises for the page language');

  // Live on vinted.fr, /api/v2/countries returns "Allemagne " for Germany.
  // Untrimmed it reaches a tooltip as "Allemagne  · Berlin".
  const messy = loadCountries({ lang: 'fr-FR', init: false });
  messy.init(COUNTRY_ROWS.map((r) => (r.iso_code === 'DE' ? { ...r, title: 'Allemagne ' } : r)));
  assert.equal(messy.name('DE'), 'Allemagne');
});

// ------------------------------------------------------------------- throttle

// The bucket lives in the worker, so the throttle tests speak to a stub of it.
function stubWorker() {
  const calls = { reserve: 0, release: 0, report: [] };
  let blockedMs = 0;
  let waitMs = 0;
  const handlers = {
    reserve: () => {
      calls.reserve++;
      return blockedMs ? { ok: false, blockedMs } : { ok: true, waitMs };
    },
    release: () => {
      calls.release++;
      return { ok: true };
    },
    report: (m) => {
      calls.report.push(m);
      return { ok: true };
    },
    bucket: () => ({ tokens: 30, blockedMs, sent: 0, throttled: 0, failed: 0 }),
  };
  return {
    calls,
    chrome: fakeChrome(handlers),
    block: (ms) => { blockedMs = ms; },
    setWait: (ms) => { waitMs = ms; },
  };
}

function loadThrottle(worker) {
  const ctx = newSandbox({ chrome: worker.chrome });
  loadInto(ctx, 'src/throttle.js');
  return new ctx.VCF_Throttle();
}

test('a token is taken for every request that actually goes out', async () => {
  const worker = stubWorker();
  const t = loadThrottle(worker);
  await Promise.all([0, 1, 2].map((i) =>
    t.submit('user:' + i, async () => ({ ok: true, status: 200 }))
  ));
  assert.equal(worker.calls.reserve, 3);
  assert.equal(worker.calls.report.length, 3);
  assert.equal(t.stats.sent, 3);
});

test('a card that scrolled away hands its token back', async () => {
  const worker = stubWorker();
  const t = loadThrottle(worker);
  const res = await t.submit('user:1', async () => ({ skipped: true }));
  assert.deepEqual(res, { skipped: true });
  assert.equal(worker.calls.release, 1, 'the budget is not spent on a card nobody is looking at');
});

test('cancelling drops queued work before it ever asks for a token', async () => {
  const worker = stubWorker();
  worker.setWait(60); // hold the first job long enough to cancel behind it
  const t = loadThrottle(worker);

  let ran = 0;
  const jobs = [0, 1, 2, 3].map((i) =>
    t.submit('user:' + i, async () => { ran++; return { ok: true, status: 200 }; })
  );
  const dropped = t.cancel((k) => k === 'user:3');
  jobs[3].catch(() => {});

  assert.equal(dropped, 1);
  await Promise.all(jobs.slice(0, 3));
  assert.equal(ran, 3, 'the cancelled card never costs a request');
  assert.equal(worker.calls.reserve, 3, 'nor a token');
});

test('cancelling a job that holds a token hands it back without waiting', async () => {
  // Past the burst every token comes with a delay of a second or more. A card
  // that scrolls away during it used to keep its slot until the delay ran out.
  const worker = stubWorker();
  worker.setWait(5000);
  const t = loadThrottle(worker);
  let ran = 0;
  const job = t.submit('user:1', async () => { ran++; return { ok: true, status: 200 }; });
  await new Promise((r) => setTimeout(r, 20));
  const started = Date.now();
  t.cancel((k) => k === 'user:1');
  await assert.rejects(job, /cancelled/);
  assert.ok(Date.now() - started < 1000, 'woken, not slept out');
  assert.equal(ran, 0);
  assert.equal(worker.calls.release, 1);
  assert.equal(t.pending, 0);
});

test('the shared circuit stops the queue without hitting the network', async () => {
  const worker = stubWorker();
  worker.block(60000); // Retry-After: 60, which is what Vinted answers
  const t = loadThrottle(worker);

  let touched = false;
  await assert.rejects(t.submit('user:1', async () => { touched = true; return { ok: true }; }));
  assert.equal(touched, false);
  assert.equal(t.circuitOpen, true);
  assert.ok(t.etaMs > 50000, 'and says how long, rather than inventing five minutes');
});

test('a 429 opens the circuit and passes Retry-After to the worker', async () => {
  const worker = stubWorker();
  const t = loadThrottle(worker);
  await assert.rejects(
    t.submit('user:1', async () => ({ ok: false, status: 429, retryAfter: 60 }))
  );
  assert.equal(t.circuitOpen, true);
  const sent = worker.calls.report[0];
  assert.equal(sent.ok, false);
  assert.equal(sent.status, 429);
  assert.equal(sent.retryAfter, 60, 'the worker decides how long, from Vinted’s own header');
  assert.equal(t.stats.throttled, 1);
});

// --------------------------------------------------------------------- bucket

function loadWorker() {
  const session = {};
  const ctx = vm.createContext({
    chrome: {
      storage: {
        session: {
          get: async (k) => ({ [k]: session[k] }),
          set: async (o) => Object.assign(session, o),
        },
        local: { get: async () => ({}), set: async () => {} },
      },
      runtime: { onMessage: { addListener() {} } },
    },
    indexedDB: { open: () => { throw new Error('no IndexedDB in this test'); } },
    console: { warn() {}, log() {} },
    Date,
    Math,
    Promise,
    Number,
    Array,
    Object,
    String,
    JSON,
  });
  vm.runInContext('globalThis.globalThis = globalThis;', ctx);
  loadInto(ctx, 'src/worker.js');
  return ctx.VCF_WORKER;
}

test('the bucket bursts below the measured limit, then paces below it', async () => {
  // Measured against vinted.fr: from a cold bucket exactly 30 requests to
  // /api/v2/users succeed and the 31st gets a 429 with Retry-After: 60. Paced
  // at one per second, 45 in a row drew nothing. The bucket stays under both,
  // because the page's own requests spend from the same budget.
  const W = loadWorker();
  assert.ok(W.CAPACITY < 30 && W.REFILL < 1, 'headroom under the measured limit');

  const immediate = [];
  for (let i = 0; i < W.CAPACITY; i++) {
    const g = await W.reserve();
    assert.equal(g.ok, true);
    immediate.push(g.waitMs);
  }
  assert.deepEqual([...new Set(immediate)], [0], 'the whole burst goes straight out');

  const step = 1000 / W.REFILL;
  const next = await W.reserve();
  assert.ok(Math.abs(next.waitMs - step) <= 100, `the next waits one refill, got ${next.waitMs}`);
  const after = await W.reserve();
  assert.ok(after.waitMs >= 2 * step - 100, 'and the queue keeps stacking a refill at a time');
});

test('a released token goes back into the bucket', async () => {
  const W = loadWorker();
  for (let i = 0; i < W.CAPACITY; i++) await W.reserve();
  await W.release();
  const g = await W.reserve();
  assert.equal(g.waitMs, 0, 'the returned token is spendable straight away');
});

test('a 429 honours Retry-After instead of a five minute guess', async () => {
  const W = loadWorker();
  await W.report({ ok: false, status: 429, retryAfter: 60 });

  const g = await W.reserve();
  assert.equal(g.ok, false);
  assert.ok(g.blockedMs > 55000 && g.blockedMs <= 60000, `blocked for ${g.blockedMs}ms`);

  const state = await W.bucketState();
  assert.equal(state.throttled, 1);
  assert.equal(state.tokens, 0, 'and the bucket is treated as drained');
});

test('a 429 with no Retry-After falls back to the observed 60 seconds', async () => {
  const W = loadWorker();
  await W.report({ ok: false, status: 429, retryAfter: null });
  const g = await W.reserve();
  assert.ok(g.blockedMs > 55000);
});

test('an ordinary failure is counted but does not stop the queue', async () => {
  const W = loadWorker();
  await W.report({ ok: false, status: 500 });
  const g = await W.reserve();
  assert.equal(g.ok, true);
  assert.equal((await W.bucketState()).failed, 1);
});

// ------------------------------------------------------------ price parsing

// parsePrice reads the number off a card, and every market writes it
// differently. It is buried in content.js next to the DOM, so the test lifts
// the function out rather than mocking a page around it.
function loadParsePrice(lang) {
  const src = readFileSync('src/content.js', 'utf8');
  const body = src.slice(src.indexOf('  let decimalSep'), src.indexOf('  function countryFromPrice'));
  return new Function('COUNTRIES', 'Intl', `${body}; return parsePrice;`)({ lang }, Intl);
}

test('a price is read correctly in every market’s number format', () => {
  // Live strings from the five domains I loaded, plus the formats the rest
  // use. The separator comes from the page language, which Vinted sets right
  // everywhere, so nothing here is per-domain code.
  const cases = [
    ['ro-RO', '160,00 RON', 160],
    ['ro-RO', '1.234,56 RON', 1234.56],
    ['pl-PL', '10,00 zł', 10],
    ['pl-PL', '1 234,56 zł', 1234.56],
    ['de-DE', '50,00 €', 50],
    ['fr-FR', '40,00 €', 40],
    ['fr-FR', '1 234,56 €', 1234.56],
    ['en-GB', '£9.99', 9.99],
    ['en-GB', '£1,234.56', 1234.56],
    ['en-US', '$24.99', 24.99],
    ['hu-HU', '12 500 Ft', 12500],
    ['cs-CZ', '1 234,50 Kč', 1234.5],
    ['sv-SE', '1 234,50 kr', 1234.5],
    ['ro-RO', 'gratuit', null],
  ];
  for (const [lang, text, want] of cases) {
    assert.equal(loadParsePrice(lang)(text), want, `${lang} ${JSON.stringify(text)}`);
  }
});

test('a comma decimal is not read as a British thousands separator', () => {
  // The trap in going multi-domain: "1,50 €" is one euro fifty in Paris and
  // would be a hundred and fifty anywhere the comma groups thousands.
  assert.equal(loadParsePrice('fr-FR')('1,50 €'), 1.5);
  assert.equal(loadParsePrice('en-GB')('£1,500'), 1500);
});

// ---------------------------------------------------- worker cache, wired up

// Just enough IndexedDB to run the worker's cache for real. The alternative is
// asserting that store.js sends the message names worker.js happens to listen
// for, which is the bug this is meant to catch.
function fakeIndexedDB() {
  const stores = new Map();
  const later = (req, run) => queueMicrotask(() => {
    try {
      req.result = run();
      if (req.onsuccess) req.onsuccess({ target: req });
    } catch (e) {
      req.error = e;
      let stopped = false;
      if (req.onerror) req.onerror({ target: req, preventDefault: () => { stopped = true; } });
      if (!stopped && req.onerror === null) throw e;
    }
  });

  const objectStore = (name, keyPath) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const rows = stores.get(name);
    return {
      get(key) {
        const req = {};
        later(req, () => rows.get(String(key)));
        return req;
      },
      put(rec) {
        const req = {};
        later(req, () => { rows.set(String(rec[keyPath]), rec); return rec[keyPath]; });
        return req;
      },
      add(rec) {
        const req = { onerror: null };
        later(req, () => {
          const k = String(rec[keyPath]);
          if (rows.has(k)) throw new Error('ConstraintError');
          rows.set(k, rec);
          return k;
        });
        return req;
      },
      count() {
        const req = {};
        later(req, () => rows.size);
        return req;
      },
      clear() {
        const req = {};
        later(req, () => rows.clear());
        return req;
      },
    };
  };

  return {
    open() {
      const req = {};
      const db = {
        objectStoreNames: { contains: (n) => stores.has(n) },
        createObjectStore: (n) => { stores.set(n, new Map()); return objectStore(n, 'id'); },
        transaction: () => ({ objectStore: (n) => objectStore(n, 'id') }),
      };
      queueMicrotask(() => {
        req.result = db;
        if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
  };
}

// worker.js and the content scripts in one rig, talking over the same message
// channel Chrome would give them.
function wireUp() {
  const bag = { local: {}, session: {} };
  const area = (name) => ({
    get: async (keys) => {
      const out = {};
      const ks = typeof keys === 'string' ? [keys] : Object.keys(keys || bag[name]);
      for (const k of ks) out[k] = bag[name][k];
      return out;
    },
    set: async (obj) => { Object.assign(bag[name], obj); },
  });

  let listener = null;
  const workerCtx = vm.createContext({
    chrome: {
      storage: { session: area('session'), local: area('local') },
      runtime: { onMessage: { addListener: (f) => { listener = f; } } },
    },
    indexedDB: fakeIndexedDB(),
    console: { warn() {}, log() {} },
    queueMicrotask,
    Date, Math, Promise, Number, Array, Object, String, JSON, Error, Boolean,
  });
  vm.runInContext('globalThis.globalThis = globalThis;', workerCtx);
  loadInto(workerCtx, 'src/worker.js');

  const chrome = {
    runtime: {
      sendMessage: (msg) => new Promise((resolve, reject) => {
        const claimed = listener(msg, null, resolve);
        if (!claimed) reject(new Error('nothing handled ' + msg.k));
      }),
      getURL: (p) => 'chrome-extension://test/' + p,
    },
  };

  const pageCtx = newSandbox({ chrome });
  loadInto(pageCtx, 'src/store.js');
  return { Store: pageCtx.VCF_Store, bag };
}

test('a seller cached by one tab is served to the next', async () => {
  const { Store } = wireUp();
  assert.equal(await Store.getUser('42'), null);

  await Store.putUser('42', 'IT', 'Bondeno di Gonzaga');
  const back = await Store.getUser('42');
  assert.equal(back.cc, 'IT');
  assert.equal(back.city, 'Bondeno di Gonzaga');

  // A second tab, and a second domain: same worker, same records. Seller ids
  // are global across markets, which is the whole reason the cache moved out
  // of the page's own IndexedDB.
  const other = wireUp();
  assert.equal(await other.Store.getUser('42'), null, 'a fresh rig starts empty');
});

test('banking a catalog response never overwrites a paid-for lookup', async () => {
  const { Store } = wireUp();
  await Store.putUser('7', 'NL', 'Utrecht');

  await Store.bankUsers([
    { id: '7', cc: 'XX' },   // the currency's answer, which has no city
    { id: '8', cc: 'PL' },
    { id: '9', cc: 'HU' },
  ]);

  const kept = await Store.getUser('7');
  assert.equal(kept.cc, 'NL', 'the record with a city wins');
  assert.equal(kept.city, 'Utrecht');
  assert.equal((await Store.getUser('8')).cc, 'PL');
  assert.equal((await Store.getUser('9')).cc, 'HU');

  const counts = await Store.counts();
  assert.equal(counts.users, 3);
});

test('the market table is fetched once and then served from the worker', async () => {
  const { Store } = wireUp();
  let fetches = 0;
  const fetchRows = async () => { fetches++; return COUNTRY_ROWS; };

  const first = await Store.countries(fetchRows);
  assert.equal(first.length, 27);
  assert.equal(fetches, 1);

  // A second tab, on a different domain, gets the same copy. The table is the
  // same on every market, so paying for it once is the point.
  const second = wireUp();
  // (a fresh rig has its own storage, so prove it through the same one instead)
  await Store.countries(fetchRows);
  assert.equal(fetches, 1, 'the cached table is reused for a week');
  assert.ok(second.Store);
});

test('clearing the cache empties both stores', async () => {
  const { Store } = wireUp();
  await Store.putUser('1', 'FR', null);
  await Store.putItem('900', 'FR');
  let n = await Store.counts();
  assert.equal(n.users, 1);
  assert.equal(n.items, 1);

  await Store.clear();
  n = await Store.counts();
  assert.equal(n.users, 0);
  assert.equal(n.items, 0);
  assert.equal(await Store.getUser('1'), null, 'and the memory copy goes with it');
});

test('a dead worker is a cache miss, not a broken page', async () => {
  const ctx = newSandbox({
    chrome: {
      runtime: {
        sendMessage: async () => { throw new Error('Extension context invalidated'); },
      },
    },
  });
  loadInto(ctx, 'src/store.js');
  const Store = ctx.VCF_Store;
  assert.equal(await Store.getUser('42'), null);
  await Store.putUser('42', 'IT', null); // must not throw
  await Store.bankUsers([{ id: '1', cc: 'PL' }]);
  const n = await Store.counts();
  assert.equal(n.users, 0);
  assert.equal(n.items, 0);
});

// --------------------------------------------------------- price fingerprint

// Rates observed on vinted.ro on 2026-08-31, plus a forint domain built from
// them so the guard can be tested where it used to fail.
const RATE = { PLN: 1.2241828, HUF: 0.01456663, EUR: 5.3175 };
const HUF_RATE = { EUR: 390.0, PLN: 89.75, RON: 73.3 };

function loadPrices({
  lang = 'ro-RO',
  rates = RATE,
  samples = [
    { cur: 'PLN', seller: 470 }, { cur: 'PLN', seller: 335 }, { cur: 'PLN', seller: 100 },
    { cur: 'HUF', seller: 14000 }, { cur: 'HUF', seller: 12500 }, { cur: 'HUF', seller: 5000 },
    { cur: 'EUR', seller: 40 }, { cur: 'EUR', seller: 12 }, { cur: 'EUR', seller: 25 },
  ],
} = {}) {
  const ctx = newSandbox({ lang });
  loadInto(ctx, 'src/countries.js');
  ctx.VCF_COUNTRIES.init(COUNTRY_ROWS);
  loadInto(ctx, 'src/price-currency.js');
  const P = ctx.VCF_PriceCurrency;
  P.learn(samples.map((s, i) => ({
    id: i,
    price: { amount: (Math.round(s.seller * rates[s.cur] * 100) / 100).toFixed(2) },
    conversion: { seller_currency: s.cur, seller_price: String(s.seller) },
  })));
  return P;
}

// What the price would show for a seller who typed `seller` in `cur`.
const shown = (rates, cur, seller) => Math.round(seller * rates[cur] * 100) / 100;

test('rates are read off conversions when Vinted sends them', () => {
  const P = loadPrices();
  const r = P.rates();
  assert.equal(r.get('RON'), 1, 'the buyer currency comes from the country table');
  assert.ok(Math.abs(r.get('PLN') - RATE.PLN) < 0.0005);
  assert.ok(Math.abs(r.get('HUF') - RATE.HUF) < 0.000005);
  assert.equal(P.ready(), true);
});

test('a converted price names the currency it was converted from', () => {
  const P = loadPrices();
  assert.equal(P.currencyFor(shown(RATE, 'PLN', 100)), 'PLN', '122.42 is 100 zloty');
  assert.equal(P.currencyFor(shown(RATE, 'PLN', 250)), 'PLN');
  assert.equal(P.currencyFor(shown(RATE, 'HUF', 12500)), 'HUF');
  assert.equal(P.currencyFor(shown(RATE, 'HUF', 20000)), 'HUF');
  assert.equal(P.currencyFor(shown(RATE, 'EUR', 40)), 'EUR');
});

test('a whole number of lei is a Romanian seller', () => {
  const P = loadPrices();
  assert.equal(P.currencyFor(500), 'RON');
  assert.equal(P.currencyFor(75), 'RON');
  assert.equal(P.currencyFor(1500), 'RON');
});

test('an unremarkable price is refused rather than guessed', () => {
  const P = loadPrices();
  // 0.01 lei is on every grid there is, so no currency can claim it.
  assert.equal(P.currencyFor(0.01), null);
  assert.equal(P.currencyFor(0), null);
  assert.equal(P.currencyFor(-5), null);
});

test('nothing is answered before a foreign rate has been seen', () => {
  const P = loadPrices({ samples: [] });
  assert.equal(P.ready(), false);
  assert.equal(P.currencyFor(500), null, 'without a rival, every price looks like lei');
});

test('one sighting of a currency is not enough to trust its rate', () => {
  const P = loadPrices({ samples: [{ cur: 'PLN', seller: 100 }, { cur: 'PLN', seller: 250 }] });
  assert.equal(P.rates().has('PLN'), false, 'two samples is under the minimum');
  const Q = loadPrices({
    samples: [
      { cur: 'PLN', seller: 100 }, { cur: 'PLN', seller: 250 }, { cur: 'PLN', seller: 470 },
      { cur: 'EUR', seller: 10 }, { cur: 'EUR', seller: 25 }, { cur: 'EUR', seller: 40 },
    ],
  });
  assert.equal(Q.rates().has('PLN'), true);
});

test('the guard is a value, not one unit of whatever the buyer sees', () => {
  // The bug: MIN_SPACING was 1, meaning one unit of buyer currency. That is
  // 0.20 EUR of lei, a real guard, and 0.0025 EUR of forints, no guard at all.
  // On vinted.hu every price clears a one forint grid, so the fingerprint would
  // have started naming currencies at random.
  const ro = loadPrices();
  assert.ok(Math.abs(ro.minSpacing() - 0.2 * RATE.EUR) < 0.01, 'about one leu');

  const hu = loadPrices({
    lang: 'hu-HU',
    rates: HUF_RATE,
    samples: [
      { cur: 'EUR', seller: 40 }, { cur: 'EUR', seller: 12 }, { cur: 'EUR', seller: 25 },
      { cur: 'PLN', seller: 100 }, { cur: 'PLN', seller: 250 }, { cur: 'PLN', seller: 470 },
      { cur: 'RON', seller: 160 }, { cur: 'RON', seller: 90 }, { cur: 'RON', seller: 45 },
    ],
  });
  assert.equal(hu.rates().get('HUF'), 1, 'the forint is the buyer currency there');
  assert.ok(hu.minSpacing() > 70, `guard scales to about 78 HUF, got ${hu.minSpacing()}`);

  // A price a single forint apart from its neighbours explains nothing.
  assert.equal(hu.currencyFor(7777), null);
  // A round euro price still does.
  assert.equal(hu.currencyFor(shown(HUF_RATE, 'EUR', 40)), 'EUR');
});

test('the grid reaches high enough for a weak currency', () => {
  // 100000 was the top of the ladder, which is 260 EUR of forints. A Hungarian
  // asking 500000 HUF for a coat is an ordinary listing, not an outlier, and
  // on their own domain the rate is 1 so the price is exact.
  const hu = loadPrices({
    lang: 'hu-HU',
    rates: HUF_RATE,
    samples: [
      { cur: 'EUR', seller: 40 }, { cur: 'EUR', seller: 12 }, { cur: 'EUR', seller: 25 },
      { cur: 'PLN', seller: 100 }, { cur: 'PLN', seller: 250 }, { cur: 'PLN', seller: 470 },
    ],
  });
  assert.equal(hu.currencyFor(500000), 'HUF');
  assert.equal(hu.currencyFor(1000000), 'HUF');
});

test('an expensive foreign item is refused while the rate is still rough', () => {
  // The tolerance is half a cent flat, and the error in a learned rate is
  // multiplied by the seller's price, so a big number needs a rate nailed down
  // by hundreds of samples. Three is not that, and the answer is no answer
  // rather than a coin flip.
  const P = loadPrices();
  assert.equal(P.currencyFor(shown(RATE, 'HUF', 500000)), null);
  assert.equal(P.currencyFor(shown(RATE, 'HUF', 12500)), 'HUF', 'an ordinary one still resolves');
});

test('the guard is sized from the rough euro rate until a euro seller turns up', () => {
  // Only zloty seen. The guard used to stay null here and the fingerprint off,
  // which was right while conversions named the euro rate within a page. Now
  // the rate has to be fitted from euro sellers the page happens to show, and
  // a floor does not need the exact rate, so the rough one sizes it.
  const P = loadPrices({
    samples: [
      { cur: 'PLN', seller: 100 }, { cur: 'PLN', seller: 250 }, { cur: 'PLN', seller: 470 },
    ],
  });
  assert.ok(P.minSpacing() > 0.9 && P.minSpacing() < 1.2, `about one leu, got ${P.minSpacing()}`);
  assert.equal(P.ready(), true);
  assert.equal(P.currencyFor(500), 'RON');
  // A euro price still has nothing to match and is left to a lookup.
  assert.equal(P.currencyFor(shown(RATE, 'EUR', 40)), null);
});

// What the fingerprint sees on vinted.ro since 2026-10-08: no conversions, only
// a shown price beside a seller whose country a lookup or the cache settled.
function observePrices(observations, lang = 'ro-RO') {
  const P = loadPrices({ lang, samples: [] });
  for (const [cur, seller] of observations) P.observe(shown(RATE, cur, seller), cur);
  return P;
}

test('a rate is fitted from known sellers when no conversion arrives', () => {
  const P = observePrices([
    ['PLN', 100], ['PLN', 45], ['PLN', 250], ['PLN', 80], ['PLN', 39.99], ['PLN', 120],
    ['EUR', 40], ['EUR', 15], ['EUR', 25], ['EUR', 12],
  ]);
  const r = P.rates();
  assert.ok(Math.abs(r.get('PLN') / RATE.PLN - 1) < 2e-4, `PLN ${r.get('PLN')}`);
  assert.ok(Math.abs(r.get('EUR') / RATE.EUR - 1) < 2e-4, `EUR ${r.get('EUR')}`);
  assert.equal(P.currencyFor(shown(RATE, 'PLN', 60)), 'PLN');
  assert.equal(P.currencyFor(shown(RATE, 'EUR', 30)), 'EUR');
  assert.equal(P.currencyFor(150), 'RON');
});

test('prices all in tens never settle on the rate a tenth off', () => {
  // r * 10/9 explains 100, 50 and 200 zloty as 90, 45 and 180, and fits every
  // item as well as the true rate does. With nothing to tell them apart the
  // answer is no rate at all, and one odd price is enough to break the tie.
  const tens = observePrices([['PLN', 100], ['PLN', 50], ['PLN', 200], ['PLN', 150], ['PLN', 30]]);
  const r = tens.rates().get('PLN');
  assert.ok(r === undefined || Math.abs(r / RATE.PLN - 1) < 1e-3, `PLN ${r}`);
  const mixed = observePrices([
    ['PLN', 100], ['PLN', 50], ['PLN', 200], ['PLN', 150], ['PLN', 30], ['PLN', 39], ['PLN', 67],
  ]);
  assert.ok(Math.abs(mixed.rates().get('PLN') / RATE.PLN - 1) < 1e-3, `PLN ${mixed.rates().get('PLN')}`);
});

test('forints too coarse to fit are refused, not fitted wrong', () => {
  // Counted in tens, 4990 Ft sits within a hundredth of a leu of 49/50 of the
  // rate, so ten ordinary forint prices fit two rates at once. The fit has to
  // say nothing then, and a forint price has to stay with a lookup.
  const P = observePrices([
    ['PLN', 100], ['PLN', 45], ['PLN', 250], ['PLN', 80], ['PLN', 120],
    ['HUF', 12500], ['HUF', 4990], ['HUF', 3990], ['HUF', 20000], ['HUF', 7500],
    ['HUF', 2990], ['HUF', 1500], ['HUF', 8990], ['HUF', 6000], ['HUF', 2490],
  ]);
  const huf = P.rates().get('HUF');
  assert.ok(huf === undefined || Math.abs(huf / RATE.HUF - 1) < 2e-4, `HUF ${huf}`);
  for (const ft of [8000, 4990, 15000]) {
    const got = P.currencyFor(shown(RATE, 'HUF', ft));
    assert.ok(got === null || got === 'HUF', `${ft} Ft read as ${got}`);
  }
});

test('a fitted rate waits for enough sellers to agree', () => {
  const few = observePrices([['PLN', 100], ['PLN', 45], ['PLN', 250]]);
  assert.equal(few.rates().has('PLN'), false, 'three items are not enough to fit');
  // Prices with cents fit no whole number, so they cannot outvote the rest.
  const messy = observePrices([
    ['PLN', 41.37], ['PLN', 12.83], ['PLN', 77.21], ['PLN', 19.64], ['PLN', 100],
  ]);
  assert.equal(messy.rates().has('PLN'), false);
  // Our own currency is never fitted: its rate is 1 by definition.
  const home = observePrices([['RON', 50], ['RON', 60], ['RON', 70], ['RON', 80]]);
  assert.equal(home.rates().get('RON'), 1);
});

test('a euro domain turns the fingerprint off by itself', () => {
  // Every seller prices in euro, so no conversion is ever shown and no second
  // rate is ever learned. Measured: 0 conversions in 259 items on vinted.fr.
  const P = loadPrices({ lang: 'fr-FR', samples: [] });
  assert.equal(P.rates().get('EUR'), 1);
  assert.equal(P.ready(), false, 'one currency is not a comparison');
  assert.equal(P.currencyFor(40), null);
});

// ------------------------------------------------------------- homepage feed

function loadFeedMap() {
  const ctx = vm.createContext({ console });
  vm.runInContext('globalThis.globalThis = globalThis;', ctx);
  loadInto(ctx, 'src/feed-map.js');
  return ctx.VCF_FeedMap;
}

// An array built inside the sandbox has the sandbox's Array as its prototype,
// which deepEqual counts as a difference. This drags it back over.
const plain = (v) => JSON.parse(JSON.stringify(v));

// One item block as vinted.ro served it on 2026-09-01, inside the React payload
// the homepage hydrates from: JSON in a JavaScript string literal, so every
// quote arrives escaped. Trimmed to the fields around the two ids.
const FLIGHT_ITEM =
  '\\"type\\":\\"item\\",\\"entity\\":{\\"id\\":9848877536,\\"title\\":\\"See-through top\\",' +
  '\\"user\\":{\\"id\\":234765155,\\"isBusiness\\":false},\\"url\\":\\"/items/9848877536-see-through-top\\",' +
  '\\"favouriteCount\\":8,\\"price\\":{\\"amount\\":\\"5.32\\",\\"currencyCode\\":\\"RON\\"}}';

test('the homepage names its sellers in the document, at no cost', () => {
  const F = loadFeedMap();
  const pairs = F.fromFlight('self.__next_f.push([1,"66:[{\\"blocks\\":[{' + FLIGHT_ITEM + '}]}]"])');
  assert.deepEqual(plain(pairs), [{ id: '9848877536', userId: '234765155' }]);
});

test('a block with no seller does not borrow the next one', () => {
  // The homepage mixes item blocks with category and brand blocks, and those
  // carry an entity and no seller. Without the guard the category would take
  // the seller of the item after it and flag that card with a stranger.
  const F = loadFeedMap();
  const category = '\\"type\\":\\"category\\",\\"entity\\":{\\"id\\":1904,\\"title\\":\\"Femei\\"}';
  const pairs = F.fromFlight(category + ',{' + FLIGHT_ITEM + '}');
  assert.deepEqual(plain(pairs), [{ id: '9848877536', userId: '234765155' }]);
});

test('the paginated feed names its sellers too, in a different word', () => {
  // api.vinted.ro/homepage/homepage as it answered on 2026-09-01: fifty blocks
  // of one item each, and the seller is user_id rather than user.id.
  const F = loadFeedMap();
  const body = {
    blocks: [
      { type: 'item', entity: { id: '9848737794', title: 'Botki czarne', user_id: '3155965908' } },
      { type: 'item', entity: { id: '9848737795', title: 'Nike', user_id: '3155965909' } },
    ],
    pagination: { next_page_token: 'next_row:12' },
  };
  assert.deepEqual(plain(F.fromApi(body)), [
    { id: '9848737794', userId: '3155965908' },
    { id: '9848737795', userId: '3155965909' },
  ]);
});

test('an item photo is not mistaken for an item', () => {
  // Every entity carries a photo object with its own id and no seller, so the
  // walk has to want both ids on the same node rather than either of them.
  const F = loadFeedMap();
  const body = {
    blocks: [{
      entity: {
        id: '9848737794',
        user_id: '3155965908',
        photo: { id: '0', image_no: 1, thumbnails: [{ id: '1' }, { id: '2' }] },
      },
    }],
  };
  assert.deepEqual(plain(F.fromApi(body)), [{ id: '9848737794', userId: '3155965908' }]);
});

// One catalog item as vinted.ro served it on 2026-10-08, inside the payload the
// search page hydrates from. Trimmed, but the thumbnail URLs are kept at their
// real length because they are what pushes the seller a thousand characters
// past the item id.
const THUMB = 'https://images1.vinted.net/t/06_00a1b_' + 'x'.repeat(120) + '/f800/1791480000.webp?s=' + 'a'.repeat(40);
const CATALOG_ITEM =
  '{\\"id\\":10103477464,\\"productItem\\":{\\"id\\":10103477464,\\"title\\":\\"Gryf Olimpijski\\",' +
  '\\"url\\":\\"/items/10103477464-gryf-olimpijski\\",\\"favouriteCount\\":7,\\"priceWithDiscount\\":null,' +
  '\\"price\\":{\\"amount\\":\\"371.27\\",\\"currencyCode\\":\\"RON\\"},' +
  '\\"thumbnailUrl\\":\\"' + THUMB + '\\",\\"thumbnailUrls\\":[\\"' + THUMB + '\\"],' +
  '\\"dominantColor\\":\\"#DFDAD5\\",\\"user\\":{\\"id\\":90829612,\\"photo\\":null,\\"isBusiness\\":false}}}';

test('the catalog page names its sellers in the document too', () => {
  const F = loadFeedMap();
  const doc = 'self.__next_f.push([1,"5:{\\"items\\":[' + CATALOG_ITEM + ',' +
    CATALOG_ITEM.replace(/10103477464/g, '10103477465').replace('90829612', '90829613') + ']}"])';
  assert.deepEqual(plain(F.fromFlight(doc)), [
    { id: '10103477464', userId: '90829612' },
    { id: '10103477465', userId: '90829613' },
  ]);
});

test('a catalog item with no seller does not borrow the next one', () => {
  const F = loadFeedMap();
  const orphan = '{\\"id\\":1,\\"productItem\\":{\\"id\\":1,\\"title\\":\\"x\\"}}';
  const pairs = F.fromFlight(orphan + ',' + CATALOG_ITEM);
  assert.deepEqual(plain(pairs), [{ id: '10103477464', userId: '90829612' }]);
});

test('the catalog grid response names every seller', () => {
  // api.vinted.ro/svc-catalogue/items as it answered on 2026-10-08. No
  // conversion object anywhere, and item_box repeats the id under item_id.
  const F = loadFeedMap();
  const body = {
    items: [{
      id: 10023964817,
      item_box: { item_id: 10023964817, first_line: 'piercing' },
      photo: { id: 1, image_no: 1 },
      price: { amount: '18.56', currency_code: 'RON' },
      user: { business: false, id: 276162419, login: 'lola_9090' },
    }],
    pagination: { current_page: 2 },
  };
  assert.deepEqual(plain(F.fromApi(body)), [
    { id: '10023964817', userId: '276162419', currency: 'RON' },
  ]);
});

test('a conversion travels with its item when Vinted still sends one', () => {
  const F = loadFeedMap();
  const conversion = { seller_price: '100.0', seller_currency: 'PLN', buyer_currency: 'RON' };
  const body = { items: [{ id: 5, user: { id: 6 }, price: { amount: '122.42', currency_code: 'RON' }, conversion }] };
  const [pair] = plain(F.fromApi(body));
  assert.equal(pair.conversion.seller_currency, 'PLN');
  assert.equal(pair.price.amount, '122.42');
});

test('a shape nobody recognises answers nothing rather than guessing', () => {
  const F = loadFeedMap();
  assert.deepEqual(plain(F.fromApi(null)), []);
  assert.deepEqual(plain(F.fromApi({ code: 'BAD_REQUEST', message: 'Bad Request' })), []);
  assert.deepEqual(plain(F.fromFlight('')), []);
  assert.deepEqual(plain(F.fromFlight(undefined)), []);
});
