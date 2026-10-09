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
//   - only the same-origin JSON paths listed below are fetched
//   - a JSON response is handed back verbatim, never evaluated
//
// It also reads the responses the site asks for on its own account. See below.

(() => {
  const REQ = 'vcf-fetch-request';
  const RES = 'vcf-fetch-response';
  const FEED = 'vcf-feed-items';
  // Only two endpoints are left. /api/v2/catalog/items went away on 2026-10-08
  // and the item page fetch went with it: a two megabyte document that also
  // names the visitor's own profile, so it could hand back the wrong member.
  const ALLOWED_JSON = /^\/api\/v2\/(users\/\d+|countries)(\?|$)/;

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.type !== REQ || typeof msg.path !== 'string') return;

    const reply = (payload) =>
      window.postMessage({ type: RES, id: msg.id, ...payload }, location.origin);

    if (!ALLOWED_JSON.test(msg.path)) {
      reply({ ok: false, status: 0, error: 'path not allowed' });
      return;
    }

    try {
      const res = await fetch(msg.path, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
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
      // When Vinted decides the traffic looks automated it answers an API path
      // with an HTML "Client Challenge" page instead of JSON, sometimes with a
      // 200. That is the site pushing back, the same as a 429, and the worker
      // has to hear it that way or the queue keeps knocking.
      const type = res.headers.get('Content-Type') || '';
      if (!/json/i.test(type)) {
        reply({ ok: false, status: 429, retryAfter: null, error: 'challenge' });
        return;
      }
      const body = await res.json();
      reply({ ok: true, status: res.status, body });
    } catch (e) {
      reply({ ok: false, status: 0, error: String(e && e.message || e) });
    }
  });

  // ------------------------------------------------------------ grid feeds

  // Every grid past the first screenful arrives over an XHR the site makes for
  // itself, and each item in it carries the seller's id:
  //   api.vinted.<tld>/homepage/homepage     the homepage, as it scrolls
  //   api.vinted.<tld>/svc-catalogue/items   the catalog, on every page change,
  //                                          filter and sort
  // Reading the answer it already got costs nothing. Asking for it again would
  // cost a request and, on the catalog, return a different shuffle: a replay
  // of the exact same URL shared 50 of its 96 items with the grid on screen.
  //
  // Vinted sends both over XMLHttpRequest, not fetch, measured on vinted.ro.
  // If that ever changes the grids quietly fall back to their first screenful,
  // and the same few lines wrapped around window.fetch bring them back.
  const FEED_URL = /\/(homepage\/homepage|svc-catalogue\/items)(\?|$)/;
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
              const body =
                this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
              const pairs = FeedMap.fromApi(body);
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
