// Runs in the page's own JavaScript context, not the extension's isolated one.
//
// An MV3 content script fetch is issued from the extension's origin, so CORS
// applies and SameSite rules can strip the session cookies. Fetching from here
// is genuinely same-origin: the request is indistinguishable from one Vinted's
// own front end makes. This script does nothing else, so the extra exposure is
// limited to what is spelled out below.
//
// Guard rails, because the page can see this listener too:
//   - only messages from this exact window are answered
//   - only the same-origin paths listed below are fetched
//   - a JSON response is handed back verbatim, never evaluated
//   - an item page is 2MB of HTML, so it is never handed back. One regex runs
//     here and only the seller's numeric id crosses back.
//
// It also reads one response the site asks for on its own account. See below.

(() => {
  const REQ = 'vcf-fetch-request';
  const RES = 'vcf-fetch-response';
  const FEED = 'vcf-feed-items';
  const ALLOWED_JSON = /^\/api\/v2\/(catalog\/items|users\/\d+|countries)(\?|$)/;
  const ALLOWED_ITEM = /^\/items\/\d+(\?|$)/;
  const MEMBER = /\/member\/(\d+)/;

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.type !== REQ || typeof msg.path !== 'string') return;

    const reply = (payload) =>
      window.postMessage({ type: RES, id: msg.id, ...payload }, location.origin);

    const wantsItem = ALLOWED_ITEM.test(msg.path);
    if (!wantsItem && !ALLOWED_JSON.test(msg.path)) {
      reply({ ok: false, status: 0, error: 'path not allowed' });
      return;
    }

    try {
      const res = await fetch(msg.path, {
        credentials: 'include',
        headers: { Accept: wantsItem ? 'text/html' : 'application/json' },
      });
      if (!res.ok) {
        // A 429 says how long to stay away. Vinted's answer was 60 every time,
        // but taking its word for it beats the five minute lockout we invented.
        reply({
          ok: false,
          status: res.status,
          retryAfter: Number(res.headers.get('Retry-After')) || null,
        });
        return;
      }
      if (wantsItem) {
        // An item page links to exactly one member, its seller. Everything else
        // in those two megabytes stays here.
        const html = await res.text();
        const m = html.match(MEMBER);
        reply({ ok: true, status: res.status, memberId: m ? m[1] : null });
        return;
      }
      const body = await res.json();
      reply({ ok: true, status: res.status, body });
    } catch (e) {
      reply({ ok: false, status: 0, error: String(e && e.message || e) });
    }
  });

  // ------------------------------------------------------- homepage feed

  // Scrolling the homepage pages the feed in from
  // api.vinted.<tld>/homepage/homepage, and each item there carries the
  // seller's id. That request is not one the extension can make: replayed with
  // the same query it answers 400, so whatever authorises it is a header only
  // Vinted's own front end sends. Reading the answer it already got costs
  // nothing and is the only thing that puts a flag on a homepage card past the
  // first screenful.
  //
  // Vinted sends it over XMLHttpRequest, not fetch, measured on vinted.ro. If
  // that ever changes the homepage quietly falls back to its first screenful,
  // and the same few lines wrapped around window.fetch bring it back.
  const FEED_URL = /\/homepage\/homepage(\?|$)/;
  const FeedMap = globalThis.VCF_FeedMap;

  if (FeedMap) {
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      // Nothing in here may throw or delay: this is Vinted's own request, and
      // the page breaks if the wrapper does.
      try {
        if (FEED_URL.test(String(url))) {
          this.addEventListener('load', () => {
            try {
              const pairs = FeedMap.fromApi(JSON.parse(this.responseText));
              if (pairs.length) window.postMessage({ type: FEED, pairs }, location.origin);
            } catch (e) {
              /* not the JSON we expected, or a responseType with no text */
            }
          });
        }
      } catch (e) {
        /* keep the request itself intact */
      }
      return open.call(this, method, url, ...rest);
    };
  }
})();
