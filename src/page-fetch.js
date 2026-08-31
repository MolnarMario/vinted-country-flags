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

(() => {
  const REQ = 'vcf-fetch-request';
  const RES = 'vcf-fetch-response';
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
})();
