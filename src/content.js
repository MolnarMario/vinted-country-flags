// Vinted Country Flags: works out where each seller is and draws their flag in
// the corner of the item image.
//
// Resolution ladder, cheapest first. Each card stops at the first step that answers:
//   1. the item is already in the shared cache
//   2. the seller is named for free: by the React payload the page was rendered
//      from, by the grid XHR the site made for itself (see feed-map.js), or by
//      the markup of a "more from this seller" row
//   3. that seller is already in the shared cache
//   4. the price printed on the card, which is the seller's own number run
//      through one exchange rate, so the rounding gives the currency away.
//      Only once some rates are known. They are fitted from the cards that
//      steps 1, 3 and 5 settle, see teachPrice and price-currency.js
//   5. one /api/v2/users lookup for the seller, paced by the shared bucket
//
// Steps 1 to 4 cost no request at all.
//
// Up to 2026-10-08 a /api/v2/catalog/items call answered most of a non-euro
// grid for free, because every converted item named its seller's currency.
// Vinted retired that endpoint (it answers 404) and the grid's new source
// carries no conversion object, so every seller nobody has cached costs a
// lookup until step 4 has learned its rates, and on a euro domain always.
// That is why the IntersectionObserver matters: the cards actually on screen
// are resolved first and scrolling pays for the rest. Past the bucket's burst
// of 20 that is one lookup per 1.25 s, which is why a page used to fill in
// fast at the top and crawl further down.
//
// What this file no longer does, on purpose: it does not fetch item pages. A
// two megabyte HTML document per card is the kind of traffic that earns the
// visitor Vinted's "Client Challenge" page. Worse, the regex that read the
// seller off it could match the visitor's own profile link, which the page
// also carries, and that put the visitor's flag on other people's items.

(() => {
  const COUNTRIES = globalThis.VCF_COUNTRIES;
  const FeedMap = globalThis.VCF_FeedMap;
  const PriceCurrency = globalThis.VCF_PriceCurrency;
  const Store = globalThis.VCF_Store;
  const Throttle = globalThis.VCF_Throttle;

  if (!COUNTRIES || !Store || !Throttle) return;

  const REQ = 'vcf-fetch-request';
  const RES = 'vcf-fetch-response';
  const FEED = 'vcf-feed-items';
  // Vinted renders item cards in four shapes, identically on every domain: the
  // selector below found 96 cards on vinted.pl, 93 on vinted.de, 94 on
  // vinted.co.uk and 94 on vinted.ro, plus 20 on the vinted.ro homepage and 12
  // on the vinted.fr one. Every anchor is already position:relative with
  // overflow:hidden, so the badge drops into the top right corner without
  // touching Vinted's own layout.
  //   product-item-id-<id>--image   the main catalog grid
  //   item-<id>--image              a "more from this seller" row, one photo
  //   item-<id>--image-2            the same row's collage cards, top right cell
  //   feed-item--image              the homepage, which numbers nothing
  const FEED_IMAGE = 'feed-item--image';
  const FEED_CARD_SEL = '[data-testid="feed-item"]';
  const CARD_SEL = [
    '[data-testid^="product-item-id-"][data-testid$="--image"]',
    '[data-testid^="item-"][data-testid$="--image"]',
    '[data-testid^="item-"][data-testid$="--image-2"]',
    '[data-testid="' + FEED_IMAGE + '"]',
  ].join(', ');
  const ITEM_ID_RE = /^(?:product-item-id-|item-)(\d+)--image(?:-2)?$/;
  const MEMBER_RE = /\/member\/(\d+)/;
  const ITEM_HREF_RE = /\/items\/(\d+)/;

  const throttle = new Throttle();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let enabled = true;
  let booted = false;
  // Which cards on this page view got a real flag, so the popup can say how
  // much of the grid the extension actually answered.
  const coverage = { seen: new Set(), flagged: new Set(), guessed: new Set() };
  let lastHref = location.href;

  const inFlightUsers = new Map(); // userId -> Promise
  // userId -> Set of the cards still waiting on that seller. Cards, not item
  // ids: the same item can sit in the grid and in a closet row at once, and one
  // of them scrolling away must not cancel the lookup the other still needs.
  const wantedUsers = new Map();
  // itemId -> userId, from the document and from the site's own grid XHRs.
  // An item never changes hands, so this survives client side navigation.
  const sellers = new Map();

  // ---------------------------------------------------------------- fetching

  let reqSeq = 0;
  const pendingReqs = new Map();

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg) return;
    if (msg.type === FEED) {
      absorbFeed(msg.pairs);
      return;
    }
    if (msg.type !== RES) return;
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

  // ------------------------------------------------------------- grid feeds

  // Pairs arrive twice: once at boot from the server rendered document, and
  // again from page-fetch.js every time the site loads a grid. See feed-map.js
  // for where each of those lives.
  function absorbFeed(pairs) {
    if (!Array.isArray(pairs)) return;
    const converted = [];
    const bank = [];
    for (const pair of pairs) {
      if (!pair || !pair.id || !pair.userId) continue;
      if (!sellers.has(pair.id)) {
        sellers.set(pair.id, pair.userId);
        sellerArrived(pair.id);
      }
      if (pair.currency) COUNTRIES.setBuyerCurrency(pair.currency);
      // Only an item that actually carries a conversion says anything about
      // its seller's currency. The new grid endpoint leaves the field out
      // altogether, and reading "absent" as "prices in the buyer's currency"
      // would flag every foreign seller as a local.
      if (pair.conversion) {
        converted.push(pair);
        const cc = COUNTRIES.fromConversion(pair.conversion);
        if (COUNTRIES.isResolved(cc)) bank.push({ id: pair.userId, cc });
      }
    }
    if (PriceCurrency && converted.length) PriceCurrency.learn(converted);
    if (bank.length) Store.bankUsers(bank);
  }

  // The payload React hydrates the first screenful from is still sitting in the
  // document, so this is a string scan and no request.
  function absorbFlight() {
    if (!FeedMap) return;
    let text = '';
    for (const el of document.querySelectorAll('script:not([src])')) text += el.textContent || '';
    absorbFeed(FeedMap.fromFlight(text));
  }

  // The grid response is read before the cards it describes are rendered, so
  // the map is normally already filled by the time a card asks. Polling covers
  // the case where it is not, rather than leaving that card blank for good.
  async function sellerFromFeed(itemId) {
    for (let i = 0; i < 20; i++) {
      const hit = sellers.get(itemId);
      if (hit) return hit;
      await sleep(50);
    }
    return null;
  }

  // -------------------------------------------------------------- user layer

  // What a lookup resolves to when nobody wanted it any more by its turn.
  const DROPPED = { dropped: true };

  // A lookup is shared by every card selling for that seller, and it is
  // dropped once none of the registered ones wants it. A card still on its way
  // here (awaiting the cache) can then join the dropped promise and get
  // nothing back, so a caller that is still registered asks again once.
  async function lookupUser(userId) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const cached = await Store.getUser(userId);
      if (cached) return cached;
      const p = inFlightUsers.get(userId) || startLookup(userId);
      const rec = await p;
      if (rec !== DROPPED) return rec;
      if (inFlightUsers.get(userId) === p) inFlightUsers.delete(userId);
      const want = wantedUsers.get(userId);
      if (!want || want.size === 0) return null;
    }
    return null;
  }

  function startLookup(userId) {
    const p = throttle
      .submit('user:' + userId, async () => {
        // Bail out without spending a token if every card that wanted this
        // seller has already scrolled away.
        const want = wantedUsers.get(userId);
        if (!want || want.size === 0) return { skipped: true };
        return pageFetch('/api/v2/users/' + userId);
      })
      .then((res) => {
        if (res && res.skipped) return DROPPED;
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
      .catch((e) => (e && e.message === 'cancelled' ? DROPPED : null));

    inFlightUsers.set(userId, p);
    // Only this lookup's own entry: a retry may already have replaced it.
    p.then(() => {
      if (inFlightUsers.get(userId) === p) inFlightUsers.delete(userId);
    });
    return p;
  }

  function wantUser(userId, card) {
    if (!wantedUsers.has(userId)) wantedUsers.set(userId, new Set());
    wantedUsers.get(userId).add(card);
  }

  function unwantUser(userId, card) {
    const set = wantedUsers.get(userId);
    if (!set) return;
    set.delete(card);
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

  // A catalog card numbers its price element the way it numbers its photo. A
  // homepage card numbers nothing, so its price is found by walking up to the
  // card and back down.
  function priceElement(itemId, container) {
    const home = container.closest(FEED_CARD_SEL);
    if (home) return home.querySelector('[data-testid="feed-item--price-text"]');
    return document.querySelector(
      '[data-testid="product-item-id-' + itemId + '--price-text"], ' +
        '[data-testid="item-' + itemId + '--price-text"]'
    );
  }

  function cardPrice(itemId, container) {
    const el = priceElement(itemId, container);
    return el ? parsePrice(el.textContent) : null;
  }

  function countryFromPrice(itemId, container) {
    if (!PriceCurrency || !PriceCurrency.ready()) return null;
    const price = cardPrice(itemId, container);
    if (price == null) return null;
    const currency = PriceCurrency.currencyFor(price);
    if (!currency) return null;
    return COUNTRIES.fromCurrency(currency);
  }

  // Every card whose seller is known for certain is a worked example for the
  // fingerprint: a price in our currency next to the currency it was set in.
  // That is how the rates get learned now that no conversion arrives (see
  // price-currency.js). A guess is never fed back, or one wrong rate would
  // keep confirming itself.
  const taught = new Set();

  function teachPrice(itemId, container, cc) {
    if (!PriceCurrency || !PriceCurrency.observe || taught.has(itemId)) return;
    const currency = COUNTRIES.currencyOf(cc);
    const price = currency && cardPrice(itemId, container);
    if (price == null) return;
    taught.add(itemId);
    PriceCurrency.observe(price, currency);
    scheduleRecheck();
  }

  // Cards queued for a lookup were queued while the fingerprint could not
  // answer them. A new rate may change that, and a card the price can name
  // gives its place in the queue back. Cheap: one division per rate per card.
  let recheckTimer = null;

  function scheduleRecheck() {
    if (recheckTimer) return;
    recheckTimer = setTimeout(recheckQueued, 300);
  }

  function recheckQueued() {
    recheckTimer = null;
    if (!PriceCurrency || !PriceCurrency.ready()) return;
    for (const [userId, cards] of [...wantedUsers]) {
      for (const card of [...cards]) {
        if (typeof card === 'string' || !card.isConnected || card.dataset.vcf) continue;
        const testid = card.getAttribute('data-testid') || '';
        const itemId = cardItemId(card, testid);
        const guess = itemId && countryFromPrice(itemId, card);
        if (!guess || !COUNTRIES.isResolved(guess)) continue;
        paint(card, guess);
        coverage.flagged.add(itemId);
        coverage.guessed.add(itemId);
        unwantUser(userId, card);
      }
    }
    for (const [itemId, cards] of [...awaitingSeller]) {
      for (const card of [...cards]) {
        if (!card.isConnected || card.dataset.vcf) continue;
        const guess = countryFromPrice(itemId, card);
        if (!guess || !COUNTRIES.isResolved(guess)) continue;
        paint(card, guess);
        coverage.flagged.add(itemId);
        coverage.guessed.add(itemId);
        cards.delete(card);
      }
      if (cards.size === 0) awaitingSeller.delete(itemId);
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

  // Only two kinds of card name their seller in the markup:
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
    // Grid and homepage cards link to nobody, and their sellers come from
    // feed-map.js instead.
    if (testid.startsWith('product-item-id-') || testid === FEED_IMAGE) return null;

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

  // Catalog and closet cards carry the item id in the anchor's own testid.
  // Homepage cards do not: every one of them uses the same three testids, so
  // the id comes off the link that covers the photo.
  function cardItemId(container, testid) {
    const numbered = testid.match(ITEM_ID_RE);
    if (numbered) return numbered[1];
    if (testid !== FEED_IMAGE) return null;
    const card = container.closest(FEED_CARD_SEL);
    const link = card && card.querySelector('a[href*="/items/"]');
    const href = (link && link.getAttribute('href')) || '';
    const hit = href.match(ITEM_HREF_RE);
    return hit ? hit[1] : null;
  }

  async function resolveCard(container) {
    const testid = container.getAttribute('data-testid') || '';
    const itemId = cardItemId(container, testid);
    if (!itemId) return;
    coverage.seen.add(itemId);

    // Only certain answers come through here, so each one also teaches the
    // fingerprint. The price guess below paints directly.
    const flag = (cc, city) => {
      paint(container, cc, city);
      if (COUNTRIES.isResolved(cc)) {
        coverage.flagged.add(itemId);
        coverage.guessed.delete(itemId);
        teachPrice(itemId, container, cc);
      }
    };

    // 1. already known, possibly from another Vinted domain entirely
    const cachedItem = await Store.getItem(itemId);
    if (cachedItem && COUNTRIES.isResolved(cachedItem.cc)) {
      flag(cachedItem.cc);
      return;
    }

    // 2. who is selling it, without asking anyone
    const userId = sellerIdFromDom(container, testid) || (await sellerFromFeed(itemId));

    // 3. a seller already known, from any tab and any domain
    if (userId) {
      const banked = await Store.getUser(userId);
      if (banked) {
        flag(banked.cc, banked.city);
        Store.putItem(itemId, banked.cc);
        return;
      }
    }

    // 4. the price on the card. It is never written to the item cache: a later
    //    visit may get the certain answer, and a stored guess would short
    //    circuit that for thirty days. A lookup would only confirm a guess
    //    that is right 997 times in 1000, so none is spent.
    const guess = countryFromPrice(itemId, container);
    if (guess && COUNTRIES.isResolved(guess)) {
      paint(container, guess);
      coverage.flagged.add(itemId);
      coverage.guessed.add(itemId);
      return;
    }

    if (!userId) {
      // Nobody has named this seller yet. A grid response that lands late
      // will, so the card waits for it rather than staying blank on screen.
      awaitSeller(itemId, container);
      return;
    }

    // 5. one lookup. While Vinted is pushing back nothing goes out, and the
    //    card is put aside to try again once the circuit closes.
    if (throttle.circuitOpen) {
      deferCard(container);
      return;
    }

    wantUser(userId, container);
    const rec = await lookupUser(userId);
    unwantUser(userId, container);

    if (rec && rec.cc) {
      if (!container.isConnected) return;
      flag(rec.cc, rec.city);
      Store.putItem(itemId, rec.cc);
      return;
    }

    // No answer. A 429 or a challenge opened the circuit while this card
    // waited, so it goes back in line. A card that scrolled away is picked up
    // by the observer when it comes back.
    if (throttle.circuitOpen) deferCard(container);
  }

  // --------------------------------------------------------------- retrying

  // Cards that met a closed door. Before this they were marked seen and never
  // looked at again, so one 429 left every card on screen blank for good, and
  // the only way to get flags back was a reload.
  const deferred = new Set();
  let retryTimer = null;

  function deferCard(container) {
    deferred.add(container);
    if (retryTimer) return;
    // Wait out the circuit plus a beat, so the first retry is not the request
    // that trips it again.
    const wait = Math.max(1000, throttle.blockedUntil - Date.now() + 1000);
    retryTimer = setTimeout(retryDeferred, wait);
  }

  // Cards that asked before anything named their seller, by item id.
  const awaitingSeller = new Map();

  function awaitSeller(itemId, container) {
    if (!awaitingSeller.has(itemId)) awaitingSeller.set(itemId, new Set());
    awaitingSeller.get(itemId).add(container);
  }

  function sellerArrived(itemId) {
    const cards = awaitingSeller.get(itemId);
    if (!cards) return;
    awaitingSeller.delete(itemId);
    for (const el of cards) requeue(el);
  }

  // Unobserving and observing again makes the observer report the card's
  // current visibility, so only the cards still on screen spend anything.
  function requeue(el) {
    if (!el.isConnected || el.dataset.vcf) return;
    delete el.dataset.vcfSeen;
    observer.unobserve(el);
    observer.observe(el);
  }

  function retryDeferred() {
    retryTimer = null;
    if (throttle.circuitOpen) {
      retryTimer = setTimeout(retryDeferred, throttle.blockedUntil - Date.now() + 1000);
      return;
    }
    const cards = [...deferred];
    deferred.clear();
    for (const el of cards) requeue(el);
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
          continue;
        }
        // Scrolled away before we got to it: stop wanting the lookup, and
        // forget the card was seen so it is asked about again if it comes
        // back. Without that, a card scrolled past quickly lost its lookup to
        // the cancel and then stayed blank for the rest of the page view.
        for (const [uid, set] of wantedUsers) {
          if (set.has(el)) unwantUser(uid, el);
        }
        if (!el.dataset.vcf) delete el.dataset.vcfSeen;
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
      lastHref = location.href;
      // The old grid's cards are gone, so nothing will ever re-ask for them.
      for (const [itemId, cards] of awaitingSeller) {
        for (const el of cards) if (!el.isConnected) cards.delete(el);
        if (cards.size === 0) awaitingSeller.delete(itemId);
      }
      coverage.seen.clear();
      coverage.flagged.clear();
      coverage.guessed.clear();
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
    // The first screenful's sellers, read out of the document.
    absorbFlight();
    mutations.observe(document.body, { childList: true, subtree: true });
    scan();
  }

  function stop() {
    mutations.disconnect();
    observer.disconnect();
    clearBadges();
    clearTimeout(retryTimer);
    retryTimer = null;
    deferred.clear();
    awaitingSeller.clear();
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
