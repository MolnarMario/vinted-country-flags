// Vinted Country Flags: works out where each seller is and draws their flag in
// the corner of the item image.
//
// Resolution ladder, cheapest first. Each card stops at the first step that answers:
//   1. the item is already in the shared cache
//   2. the catalog API response for this page pins the country by seller currency
//   3. the card sits in a "more from this seller" row, which names its seller,
//      so one lookup answers the whole row
//   4. the same catalog query, asked again: the feed is shuffled, so a card
//      missing from the first draw is usually in the second or third
//   5. the price printed on the card, which is the seller's own number run
//      through one exchange rate, so the rounding gives the currency away
//   6. the item page, which names the seller, followed by a seller lookup
//
// Steps 1, 2 and 5 cost no request at all. On a domain with its own currency
// they cover almost the whole page: 93 of 94 cards on vinted.ro, 83 of 96 on
// vinted.pl.
//
// The eighteen euro markets are the hard case and step 2 does nothing there.
// Every seller prices in euro, so `conversion` is null on every item (0 out of
// 259 on vinted.fr, 0 out of 271 on vinted.de) and the currency only ever says
// "somewhere in the eurozone". Those cards each cost a seller lookup, which is
// why the IntersectionObserver matters: the twenty cards actually on screen get
// resolved first and scrolling pays for the rest.

(() => {
  const COUNTRIES = globalThis.VCF_COUNTRIES;
  const CatalogQuery = globalThis.VCF_CatalogQuery;
  const PriceCurrency = globalThis.VCF_PriceCurrency;
  const Store = globalThis.VCF_Store;
  const Throttle = globalThis.VCF_Throttle;

  if (!COUNTRIES || !CatalogQuery || !Store || !Throttle) return;

  const REQ = 'vcf-fetch-request';
  const RES = 'vcf-fetch-response';
  // Vinted renders item cards in three shapes, identically on every domain:
  // the selector below found 96 cards on vinted.pl, 93 on vinted.de, 94 on
  // vinted.co.uk and 94 on vinted.ro. All three anchors are already
  // position:relative with overflow:hidden, so the badge drops into the top
  // right corner without touching Vinted's own layout.
  //   product-item-id-<id>--image   the main catalog grid
  //   item-<id>--image              a "more from this seller" row, one photo
  //   item-<id>--image-2            the same row's collage cards, top right cell
  const CARD_SEL = [
    '[data-testid^="product-item-id-"][data-testid$="--image"]',
    '[data-testid^="item-"][data-testid$="--image"]',
    '[data-testid^="item-"][data-testid$="--image-2"]',
  ].join(', ');
  const ITEM_ID_RE = /^(?:product-item-id-|item-)(\d+)--image(?:-2)?$/;
  const MEMBER_RE = /\/member\/(\d+)/;

  const throttle = new Throttle();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let enabled = true;
  let booted = false;
  let catalogMap = null;      // itemId -> { cc, userId }
  let catalogKey = null;      // the path+search the map was built for
  let catalogPromise = Promise.resolve(null);
  let catalogRounds = [];     // index n = the promise for round n landing
  let catalogFetches = 0;
  // Which cards on this page view got a real flag, so the popup can say how
  // much of the grid the extension actually answered.
  const coverage = { seen: new Set(), flagged: new Set(), guessed: new Set() };
  let lastHref = location.href;

  const inFlightUsers = new Map(); // userId -> Promise
  const wantedUsers = new Map();   // userId -> Set of item ids still on screen

  // ---------------------------------------------------------------- fetching

  let reqSeq = 0;
  const pendingReqs = new Map();

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.type !== RES) return;
    const resolve = pendingReqs.get(msg.id);
    if (!resolve) return;
    pendingReqs.delete(msg.id);
    resolve(msg);
  });

  // Hands the path to the MAIN-world script and waits for it to come back.
  function pageFetch(path, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const id = ++reqSeq;
      pendingReqs.set(id, resolve);
      window.postMessage({ type: REQ, id, path }, location.origin);
      setTimeout(() => {
        if (pendingReqs.delete(id)) resolve({ ok: false, status: 0, error: 'timeout' });
      }, timeoutMs);
    });
  }

  // ----------------------------------------------------------- catalog layer

  // Why the same query goes out more than once.
  //
  // /api/v2/catalog/items?order=relevance does not return a fixed page. It
  // draws 96 items out of a pool half again as large and shuffles them, so two
  // identical calls a second apart share only about three quarters of their
  // items. The grid the server rendered is one such draw, and a quarter of the
  // cards on screen are simply absent from ours.
  //
  // Repeating the identical query is what closes the gap, because each repeat
  // is a fresh draw from the same pool. Measured on
  // /catalog/3480-coffee-tea-and-espresso-making, cumulative grid coverage per
  // round ran 68, 74, 90, 93 out of 96 and then stopped improving. Paginating
  // does not help at all: page 2 is drawn from the same pool and added five
  // matches for a whole extra request.
  const CATALOG_ROUNDS = 4;

  // The catalog endpoint is not in the same bucket as /users, or is far more
  // generous: six rapid calls answered 200 while /users was still 429ing. So
  // rounds pace themselves locally instead of spending seller-lookup tokens,
  // which on a euro domain are the scarce thing.
  const CATALOG_GAP_MS = 1000;

  function absorbCatalog(body, map) {
    if (!body || !Array.isArray(body.items)) return;

    // What the buyer is being shown, straight from the response. This is what a
    // null conversion means, and it beats the guess taken from the page
    // language at boot.
    const first = body.items.find((it) => it && it.price && it.price.currency_code);
    if (first) COUNTRIES.setBuyerCurrency(first.price.currency_code);

    // Every converted item in here carries the seller's own price beside ours,
    // which is one exchange rate observed for free. See price-currency.js.
    if (PriceCurrency) PriceCurrency.learn(body.items);

    // Each response also names 96 sellers. Currency pins most of them on a
    // domain with its own currency, so bank those: a closet row by a seller who
    // also has a grid item then costs no request at all, here or on any later
    // page, on any Vinted domain, because the cache is shared and seller ids
    // are global.
    const bank = [];
    for (const item of body.items) {
      const cc = COUNTRIES.fromConversion(item.conversion);
      const userId = item.user && item.user.id ? String(item.user.id) : null;
      map.set(String(item.id), { cc, userId });
      if (userId && COUNTRIES.isResolved(cc)) bank.push({ id: userId, cc });
    }
    if (bank.length) Store.bankUsers(bank);
  }

  // Resolves once round n has landed. Rounds are shared by every card on the
  // page, so a hundred misses still cost one extra request each.
  function catalogRound(n) {
    if (n >= CATALOG_ROUNDS) return catalogPromise;
    if (catalogRounds[n]) return catalogRounds[n];

    const mine = catalogMap;
    const path = '/api/v2/catalog/items?' + CatalogQuery.build(location);
    const send = () => {
      catalogFetches++;
      return pageFetch(path);
    };

    const run =
      n === 0 ? send() : catalogRound(n - 1).then(() => sleep(CATALOG_GAP_MS)).then(send);

    catalogRounds[n] = run
      .then((res) => {
        if (res && res.ok) absorbCatalog(res.body, mine);
        return mine;
      })
      .catch(() => mine);

    return catalogRounds[n];
  }

  // The first round, mirroring the filters already in the URL.
  function loadCatalog() {
    const key = location.pathname + location.search;
    if (catalogKey !== key) {
      catalogKey = key;
      catalogMap = new Map();
      catalogRounds = [];
      catalogPromise = Promise.resolve(catalogMap);
    }
    if (!CatalogQuery.isCatalogPath(location.pathname)) return catalogPromise;
    return catalogRound(0);
  }

  // -------------------------------------------------------------- user layer

  async function lookupUser(userId) {
    const cached = await Store.getUser(userId);
    if (cached) return cached;

    if (inFlightUsers.has(userId)) return inFlightUsers.get(userId);

    const p = throttle
      .submit('user:' + userId, async () => {
        // Bail out without spending a token if every card that wanted this
        // seller has already scrolled away.
        const want = wantedUsers.get(userId);
        if (!want || want.size === 0) return { skipped: true };
        return pageFetch('/api/v2/users/' + userId);
      })
      .then((res) => {
        const user = res && res.body && res.body.user;
        // Not user.country_code. That is Vinted's own code, and Britain comes
        // back as "UK", which is not an ISO country and resolves to no flag.
        // fromUser joins country_id against /api/v2/countries and keeps
        // country_iso_code for a seller living outside every market.
        const cc = COUNTRIES.fromUser(user);
        if (!cc) return null;
        // expose_location: false nulls the city but never the country, so only
        // the city needs the guard.
        return Store.putUser(userId, cc, (user && user.city) || null);
      })
      .catch(() => null);

    inFlightUsers.set(userId, p);
    p.then(() => inFlightUsers.delete(userId), () => inFlightUsers.delete(userId));
    return p;
  }

  function wantUser(userId, itemId) {
    if (!wantedUsers.has(userId)) wantedUsers.set(userId, new Set());
    wantedUsers.get(userId).add(itemId);
  }

  function unwantUser(userId, itemId) {
    const set = wantedUsers.get(userId);
    if (!set) return;
    set.delete(itemId);
    if (set.size === 0) {
      wantedUsers.delete(userId);
      throttle.cancel((key) => key === 'user:' + userId);
    }
  }

  // ------------------------------------------------------- price fingerprint

  // Every market writes its prices differently: "160,00 RON", "10,00 zł",
  // "50,00 €", "£9.99". Which character is the decimal point comes from the
  // page's own language, which Vinted sets correctly on every domain.
  let decimalSep = ',';
  try {
    const part = new Intl.NumberFormat(COUNTRIES.lang)
      .formatToParts(1234.5)
      .find((p) => p.type === 'decimal');
    if (part) decimalSep = part.value;
  } catch (e) {
    /* keep the comma */
  }

  // The big number on the card is the seller's own price converted. The bold
  // line under it adds buyer protection, which is charged in the buyer's
  // currency and would wash the fingerprint out, so only the first is read.
  function parsePrice(text) {
    // \s already covers the non breaking and narrow non breaking spaces that
    // French and Polish group thousands with, so only the apostrophe forms,
    // which is how Swiss German writes them, have to be listed.
    const m = String(text || '').match(/\d[\d\s.,'’]*/);
    if (!m) return null;
    let digits = '';
    for (const ch of m[0]) {
      if (ch >= '0' && ch <= '9') digits += ch;
      else if (ch === decimalSep) digits += '.';
    }
    const value = Number(digits.replace(/\.$/, ''));
    return value > 0 ? value : null;
  }

  function countryFromPrice(itemId) {
    if (!PriceCurrency || !PriceCurrency.ready()) return null;
    const el = document.querySelector(
      '[data-testid="product-item-id-' + itemId + '--price-text"], ' +
        '[data-testid="item-' + itemId + '--price-text"]'
    );
    if (!el) return null;
    const price = parsePrice(el.textContent);
    if (price == null) return null;
    const currency = PriceCurrency.currencyFor(price);
    if (!currency) return null;
    return COUNTRIES.fromCurrency(currency);
  }

  // ---------------------------------------------------------- item page probe

  // Last resort for a grid card nothing else reached. The item page names its
  // seller and nobody else, so one fetch turns the card into a seller id, and
  // the seller is then cached for every other item of theirs.
  //
  // It is a two megabyte document for one number, so it is capped hard: a page
  // view gets ITEM_PROBE_BUDGET of them and no more. Nothing cheaper exists.
  // The item page HTML carries no country_code, no country_id, no city, and no
  // state blob; Vinted never tells a buyer where the seller is.
  const ITEM_PROBE_BUDGET = 6;
  let itemProbes = 0;

  async function sellerIdFromItemPage(itemId) {
    if (itemProbes >= ITEM_PROBE_BUDGET || throttle.circuitOpen) return null;
    itemProbes++;
    try {
      const res = await throttle.submit('item:' + itemId, () => pageFetch('/items/' + itemId));
      return (res && res.memberId) || null;
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------------ badges

  function flagUrl(cc) {
    return chrome.runtime.getURL('flags/' + COUNTRIES.flagFile(cc) + '.svg');
  }

  // A seller can live in a country Vinted does not operate in, so any ISO code
  // can turn up. tools/make-flags.mjs writes a file for every one of them, but
  // a code that slips through still has to degrade to the neutral marker rather
  // than a broken image.
  function fallbackOnError(img) {
    img.addEventListener('error', () => {
      if (img.dataset.vcfFallback === '1') return;
      img.dataset.vcfFallback = '1';
      img.src = chrome.runtime.getURL('flags/xx.svg');
    });
  }

  function paint(container, cc, city) {
    if (!enabled || !cc) return;
    const label = COUNTRIES.name(cc) + (city ? ' · ' + city : '');

    let img = container.querySelector(':scope > .vcf-badge');
    if (!img) {
      img = document.createElement('img');
      img.className = 'vcf-badge';
      img.decoding = 'async';
      fallbackOnError(img);
      container.appendChild(img);
    }
    const src = flagUrl(cc);
    if (img.getAttribute('src') !== src) {
      delete img.dataset.vcfFallback;
      img.setAttribute('src', src);
    }
    img.alt = cc;
    img.title = label;
    img.classList.toggle('vcf-badge--pending', !COUNTRIES.isResolved(cc));
    container.dataset.vcf = cc;

    if (getComputedStyle(container).position === 'static') {
      container.classList.add('vcf-anchor');
    }
  }

  function clearBadges() {
    for (const el of document.querySelectorAll('.vcf-badge, .vcf-location')) el.remove();
    for (const el of document.querySelectorAll('[data-vcf]')) delete el.dataset.vcf;
  }

  // --------------------------------------------------------- card resolution

  // Only two kinds of card name their seller without a request:
  //   * anything on a /member/ page, which belongs to that member
  //   * a closet row card, sitting in a block whose header links to the one
  //     seller the row is showing
  //
  // A plain grid card names nobody. Climbing out of one reaches a container
  // holding several closet rows and stops there, so it never answered anyway,
  // it just walked twelve levels of querySelectorAll first. Ninety-six grid
  // cards doing that on every catalog page is the whole cost for nothing.
  //
  // Grid cards are the only ones Vinted tags product-item-id-; closet and
  // carousel cards use the plain item- prefix. That is the test. The /member/
  // and /items/ paths are not localised, so this works unchanged everywhere.
  function sellerIdFromDom(node, testid) {
    const onMemberPage = location.pathname.match(MEMBER_RE);
    if (onMemberPage) return onMemberPage[1];
    if (testid.startsWith('product-item-id-')) return null;

    // A closet row links to its seller three times over: the avatar, the
    // username and the "see seller" button. So the test is not how many links
    // are in scope but how many distinct sellers. One seller means the row
    // belongs to them and the answer is theirs. Two means the climb has left
    // the row, and guessing from there labels items with an unrelated country,
    // which is worse than showing none.
    let n = node;
    for (let i = 0; i < 12 && n; i++) {
      const ids = new Set();
      if (n.querySelectorAll) {
        for (const a of n.querySelectorAll('a[href*="/member/"]')) {
          const m = (a.getAttribute('href') || '').match(MEMBER_RE);
          if (m) ids.add(m[1]);
        }
      }
      if (ids.size === 1) return [...ids][0];
      if (ids.size > 1) return null; // climbed past this card's own row
      n = n.parentElement;
    }
    return null;
  }

  async function resolveCard(container) {
    const testid = container.getAttribute('data-testid') || '';
    const m = testid.match(ITEM_ID_RE);
    if (!m) return;
    const itemId = m[1];
    coverage.seen.add(itemId);

    const flag = (cc, city) => {
      paint(container, cc, city);
      if (COUNTRIES.isResolved(cc)) coverage.flagged.add(itemId);
    };

    // 1. already known, possibly from another Vinted domain entirely
    const cachedItem = await Store.getItem(itemId);
    if (cachedItem && COUNTRIES.isResolved(cachedItem.cc)) {
      flag(cachedItem.cc);
      return;
    }

    // 2. and 3. what the catalog API says about this item
    let map = await loadCatalog();
    let entry = map && map.get(itemId);

    // 4. a closet row card is never in the catalog response, and it names its
    //    seller in the markup, so take that instead of asking again
    let userId = (entry && entry.userId) || sellerIdFromDom(container, testid);

    // 5. the price on the card. Free and instant, so it paints now and the
    //    slower steps below get a chance to overwrite it with a certain answer.
    let guess = null;
    if (!entry && !userId) {
      guess = countryFromPrice(itemId);
      if (guess && COUNTRIES.isResolved(guess)) {
        flag(guess);
        coverage.guessed.add(itemId);
      } else {
        guess = null;
      }
    }

    // 6. a card missing from the first draw. Ask for another round rather than
    //    give up: the card is in the pool, just not in the sample we got.
    const onCatalog = CatalogQuery.isCatalogPath(location.pathname);
    for (let n = 1; onCatalog && !entry && !userId && n < CATALOG_ROUNDS; n++) {
      if (!container.isConnected) return;
      map = await catalogRound(n);
      entry = map && map.get(itemId);
      userId = entry && entry.userId;
    }

    if (entry && COUNTRIES.isResolved(entry.cc)) {
      coverage.guessed.delete(itemId);
      flag(entry.cc);
      Store.putItem(itemId, entry.cc);
      return;
    }

    // 7. nothing named this seller, so pay for the item page to name them.
    //    Skipped when the price already answered: a two megabyte fetch is not
    //    worth spending to confirm a guess that is right 997 times in 1000.
    if (!userId && !entry && !guess && onCatalog && container.isConnected) {
      userId = await sellerIdFromItemPage(itemId);
    }

    // The price guess stands. It is never written to the item cache: a later
    // visit may draw the certain answer from the catalog, and a stored guess
    // would short circuit that for thirty days.
    if (!userId) return;

    // A seller read off the page may already be banked from a catalog response.
    const banked = await Store.getUser(userId);
    if (banked) {
      coverage.guessed.delete(itemId);
      flag(banked.cc, banked.city);
      Store.putItem(itemId, banked.cc);
      return;
    }

    if (throttle.circuitOpen) {
      // Cannot ask. Show what the currency told us rather than nothing.
      if (entry && entry.cc === 'EU') flag('EU');
      return;
    }

    // Show the neutral eurozone marker straight away rather than leaving a gap,
    // then swap in the real flag once the lookup lands. On a euro domain this
    // is what every card looks like for its first few seconds.
    if (entry && entry.cc === 'EU') flag('EU');

    wantUser(userId, itemId);
    const rec = await lookupUser(userId);
    unwantUser(userId, itemId);

    if (rec && rec.cc && container.isConnected) {
      coverage.guessed.delete(itemId);
      flag(rec.cc, rec.city);
      Store.putItem(itemId, rec.cc);
    }
  }

  // ---------------------------------------------------------------- item page

  // Signup prompts sit under /member/ too ("/member/signup/select_type", shown
  // to logged out visitors and appearing before the seller in the document), so
  // take the first link that actually carries a numeric member id.
  function firstMemberId(root) {
    for (const a of root.querySelectorAll('a[href*="/member/"]')) {
      const m = (a.getAttribute('href') || '').match(MEMBER_RE);
      if (m) return m[1];
    }
    return null;
  }

  async function resolveItemPage() {
    if (!/^\/items\/\d+/.test(location.pathname)) return;

    const userId = firstMemberId(document);
    if (!userId) return;

    const photo = document.querySelector('[data-testid="item-photo-1"]');
    if (photo && photo.dataset.vcf) return; // already done for this listing

    wantUser(userId, 'item-page');
    const rec = (await Store.getUser(userId)) || (await lookupUser(userId));
    unwantUser(userId, 'item-page');
    if (!rec || !rec.cc) return;

    if (photo) paint(photo, rec.cc, rec.city);

    // Vinted's own seller panel says when they were last seen and nothing else.
    // The country goes in beside it, which is the one place on the site that
    // ever names it.
    const details = document.querySelector('[data-testid="user-info-details"]');
    if (details && !details.querySelector('.vcf-location')) {
      const span = document.createElement('span');
      span.className = 'vcf-location';
      const img = document.createElement('img');
      fallbackOnError(img);
      img.src = flagUrl(rec.cc);
      img.alt = rec.cc;
      span.appendChild(img);
      span.appendChild(
        document.createTextNode(COUNTRIES.name(rec.cc) + (rec.city ? ' · ' + rec.city : ''))
      );
      details.appendChild(span);
    }
  }

  // ----------------------------------------------------------------- observers

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const el = entry.target;
        if (entry.isIntersecting) {
          if (el.dataset.vcfSeen === '1') continue;
          el.dataset.vcfSeen = '1';
          resolveCard(el).catch(() => {});
        } else {
          // Scrolled away before we got to it: stop wanting the lookup.
          const m = (el.getAttribute('data-testid') || '').match(ITEM_ID_RE);
          if (!m) continue;
          for (const [uid, set] of wantedUsers) {
            if (set.has(m[1])) unwantUser(uid, m[1]);
          }
        }
      }
    },
    { rootMargin: '200px 0px', threshold: 0.01 }
  );

  function scan() {
    if (!enabled || !booted) return;
    for (const el of document.querySelectorAll(CARD_SEL)) {
      if (el.dataset.vcfWatched === '1') continue;
      el.dataset.vcfWatched = '1';
      observer.observe(el);
    }
    resolveItemPage().catch(() => {});
  }

  let scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 150);
  }

  const mutations = new MutationObserver(() => {
    if (location.href !== lastHref) {
      // Client-side navigation: the old catalog response no longer applies.
      lastHref = location.href;
      catalogKey = null;
      catalogPromise = Promise.resolve(null);
      catalogRounds = [];
      catalogMap = null;
      coverage.seen.clear();
      coverage.flagged.clear();
      coverage.guessed.clear();
      itemProbes = 0;
    }
    scheduleScan();
  });

  // --------------------------------------------------------------------- boot

  // Vinted's market list, straight from the site. The worker caches it for a
  // week and hands the same copy to every domain, so this fetch happens about
  // once. If it does not answer, we are on a domain that looks like Vinted and
  // is not, and the extension does nothing at all.
  async function fetchCountries() {
    const res = await pageFetch('/api/v2/countries');
    const body = res && res.ok && res.body;
    if (!body) return null;
    return Array.isArray(body) ? body : body.countries || null;
  }

  let bootPromise = null;
  function boot() {
    if (!bootPromise) {
      bootPromise = Store.countries(fetchCountries)
        .then((rows) => COUNTRIES.init(rows || []))
        .catch(() => false);
    }
    return bootPromise;
  }

  async function start() {
    booted = await boot();
    if (!booted || !enabled) return;
    mutations.observe(document.body, { childList: true, subtree: true });
    scan();
  }

  function stop() {
    mutations.disconnect();
    observer.disconnect();
    clearBadges();
    for (const el of document.querySelectorAll('[data-vcf-watched]')) {
      delete el.dataset.vcfWatched;
      delete el.dataset.vcfSeen;
    }
  }

  chrome.storage.local.get({ enabled: true }, (cfg) => {
    enabled = cfg.enabled !== false;
    if (enabled) start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.enabled) return;
    enabled = changes.enabled.newValue !== false;
    if (enabled) start();
    else stop();
  });

  // Lets the popup show what the extension is doing, which on a euro domain is
  // the difference between "filling in" and "broken".
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'vcf-stats') {
      Promise.all([Store.counts(), throttle.refresh()]).then(([counts]) => {
        sendResponse({
          active: booted,
          buyerCurrency: COUNTRIES.buyerCurrency,
          euroDomain: COUNTRIES.buyerCurrency === 'EUR',
          users: counts.users,
          items: counts.items,
          tokens: throttle.tokens,
          pending: throttle.pending,
          etaMs: throttle.etaMs,
          circuitOpen: throttle.circuitOpen,
          sent: throttle.stats.sent,
          failed: throttle.stats.failed,
          throttled: throttle.stats.throttled,
          catalogFetches,
          flagged: coverage.flagged.size,
          guessed: coverage.guessed.size,
          seen: coverage.seen.size,
        });
      });
      return true;
    }
    if (msg && msg.type === 'vcf-clear') {
      Store.clear().then(() => {
        clearBadges();
        sendResponse({ ok: true });
      });
      return true;
    }
    return false;
  });
})();
