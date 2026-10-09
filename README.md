# Vinted Country Flags

Chrome extension that puts the seller's country flag in the corner of every item
on Vinted: the homepage, the search grid and the listing page. All 27 markets.

![the grid with flags](docs/screenshot.jpg)

Vinted shows you items from sellers all over Europe and never says where they
are. Not on the card, not on the listing page, not in the HTML behind either.
The only way to find out is opening the seller's profile, which kills browsing.
This puts the answer on the picture.

## How it knows

Two facts per card: who the seller is, and where that seller lives. The first is
free. The second costs one request per seller, once, and then sits in a cache
for 30 days.

### Who the seller is, for free

Every grid on Vinted already names its sellers. It just never shows you, and it
says it in two places:

- The first screenful is server rendered, and the React payload the page
  hydrates from is still sitting in the document. A catalog page wraps each
  item as `"productItem":{"id":...}`, the homepage as `"entity":{"id":...}`,
  and both carry `"user":{"id":...}` a few hundred characters later. Reading it
  is a string scan.
- Everything after that arrives over an XHR the site makes for itself:
  `api.vinted.<tld>/svc-catalogue/items` when a catalog page changes page,
  filter or sort, and `api.vinted.<tld>/homepage/homepage` as the homepage
  scrolls. `src/page-fetch.js` wraps `XMLHttpRequest.open` and reads those
  responses as they go past.

On a vinted.ro search on 2026-10-08 the document named the sellers of 96 of 96
cards in 8 ms, and the XHR for page 2 named 96 of 96 again. Neither cost a
request. Asking for the same data ourselves would cost one and come back
different: the relevance feed is a shuffled draw, and a replay of the exact URL
the page had just used shared 50 of its 96 items with the grid on screen.

Cards in a "more from this seller" row name their seller in the markup, because
the row header links to them. On a `/member/` page every card belongs to that
member.

### Where they live, for one request

`GET /api/v2/users/{id}` returns the seller's `country_id`. The extension joins
that against `GET /api/v2/countries`, which answers on every domain with the id,
ISO code, currency and localised name of all 27 markets, and is cached for a
week. Not `country_code`: Vinted spells Britain "UK", which is not an ISO code
and resolves to no flag.

The answer goes into a cache in the service worker, not the tab, so a seller
resolved on vinted.fr is already known on vinted.de. Seller ids and item ids
are global across markets. Browsing the same searches costs almost nothing after
the first visit.

A cold page, though, costs a lookup per seller nobody has cached, and those are
paced (see below). So the grid fills in rather than appearing. Cards in and
near the viewport go first, and scrolling pays for the rest. The popup says how
many are still coming, because a flag that is on its way otherwise looks the
same as a flag that is broken.

### It used to be mostly free, and stopped being on 2026-10-08

Up to version 2.1 the extension mirrored the page's query to
`/api/v2/catalog/items`, and every item there whose seller priced in another
currency carried a `conversion` object naming that currency. On a non-euro
domain that pinned almost every card for free: 93 of 94 on vinted.ro, 83 of 96
on vinted.pl. On a euro domain it pinned nothing, since everyone prices in euro.

On 2026-10-08 that endpoint started answering 404 with an HTML body, and the
grid's new source carries no `conversion` at all. Version 2.1 kept firing four
of those dead calls per page view and then fell back to fetching up to six full
item pages, 2 MB of HTML each. That fallback was also wrong: an item page
embeds the visitor's own profile link, and the regex sometimes took that for
the seller, which put the visitor's flag on other people's items. Version 2.2
drops both. Every domain now works the way euro domains always did.

`src/price-currency.js` reads the seller's currency off the rounding in a
converted price. It used to learn its exchange rates from `conversion` objects.
With none arriving, it now fits them from cards whose seller is already known:
a shown price in lei next to a Polish seller says the zloty rate is one where
some whole number of zloty rounds to that price, and a handful of such cards
agree on one rate. A rough rate table keeps the search near the right answer,
so 9/10 or 10/11 of the rate cannot win just because round prices fit it too.

So on a non-euro domain the first screenful still costs lookups, but each one
also teaches the fingerprint, and further down the page the price starts naming
sellers for free. Queued cards are rechecked when a rate settles, and the ones
the price can name give their place in the queue back. In simulation it settles
the zloty rate within about 15 known sellers and the answers it gives are right
99% of the time, the same as with exact rates. Forints are counted in tens and
the shown price is rounded to a hundredth of a leu, which is too coarse to pin
the forint rate from ordinary prices, so those mostly stay with lookups. On a
euro domain every seller prices in euro and the fingerprint has nothing to do.

## Being a good guest

The rate limit is measured, not guessed. From a cold bucket, exactly 30 requests
to `/api/v2/users` succeed and the 31st returns 429 with `Retry-After: 60`.
Paced at one per second, 45 in a row draw nothing. It is shared per IP: draining
it on vinted.fr leaves vinted.co.uk with 20 instead of 30. When a session looks
too busy Vinted can also answer with an HTML "Client Challenge" page instead of
JSON.

- The extension's bucket is set below that: 20 at once, then 0.8 per second.
  The site's front end calls `/api/v2/` on the same host for its own banners,
  and an extension running right at the measured edge leaves those nothing.
- That bucket lives in the service worker, so every tab and every Vinted domain
  spends one budget. Per-tab throttling would have spent it once per tab.
- A card scrolled out of the viewport hands its token back, and work queued for
  it is dropped before it costs anything. Scroll back and it is asked about
  again.
- 429, 403, 503, or an HTML page where JSON was expected, stops all lookups and
  honours the `Retry-After` the response carries. The cards that were waiting
  are retried once the circuit closes. Before 2.2 they stayed blank until a
  reload.
- The only endpoints the extension ever calls are `/api/v2/users/{id}` and
  `/api/v2/countries`. Everything else it knows, it read off a response the
  site had already received.
- Requests go out from the page's own JavaScript context, so they are ordinary
  same-origin calls carrying the session you already have. Nothing is proxied,
  nothing leaves your browser.

## What it will not do

Guess. A card whose seller nothing named gets no flag rather than a probable
one. In practice that is cards in grids the extension does not read, such as
the "similar items" strip on an item page when it arrives over a request other
than the two above.

Guessing the seller from the DOM is still not an option for a grid card. An
earlier version walked up from the card and took the first `/member/` link it
found, which on a catalog page meant grabbing whichever closet row happened to
come first in the document and labelling unrelated items with its country. A
wrong flag is worse than no flag, so grid cards do not climb at all.

## Install

It is not on the Chrome Web Store, so it installs as an unpacked extension.

1. Download the zip from the
   [latest release](https://github.com/MolnarMario/vinted-country-flags/releases/latest).
2. Unpack it somewhere you will keep it. Chrome reloads the extension from that
   folder on every start, so do not delete it afterwards.
3. Go to `chrome://extensions` and turn on Developer mode, top right.
4. Click "Load unpacked" and pick the unpacked folder, the one holding
   `manifest.json`.
5. Open any Vinted market, for example https://www.vinted.fr/catalog?search_text=nike

Chrome will keep showing a "Disable developer mode extensions" warning on
startup. That is Chrome's standard nag for anything not installed from the
Store, not a problem with the extension.

Chrome will list 28 sites in the permission prompt. Match patterns cannot
wildcard a TLD, so every market has to be named.

The toolbar popup has an on/off switch, the coverage on the current page, how
much request budget is left, the cache counts, and a "clear cache" button. While
lookups are queued it also shows how many cards are still filling in.

## Layout

```
manifest.json
src/worker.js       service worker: the shared token bucket and the cache
src/page-fetch.js   MAIN world: the two lookups, and reads the site's own grid XHRs
src/countries.js    the market table from /api/v2/countries, currency rule, names
src/price-currency.js  reads the currency off a converted price, fits the rates from known sellers
src/throttle.js     the tab's queue in front of the worker's bucket
src/store.js        cache client, one message per lookup
src/feed-map.js     item id to seller id, from the document and from grid XHRs
src/content.js      DOM scanning, the resolution ladder, badge injection
src/badge.css
flags/*.svg         252 files: every ISO country, 76 drawn, the rest letter tiles
popup/
tools/              flag, icon and manifest generators, zip packager, test harness
test/
```

A seller can live in a country Vinted does not operate in, so any ISO code can
come back from a profile. Every one has a file; the 76 with a real drawing cover
the markets and their neighbours, and the rest get a legible two-letter tile. A
missing file still degrades to the neutral marker rather than a broken image.

Flags are bundled SVGs rather than emoji because Windows has no colour flag
emoji: `🇷🇴` renders as the letters "RO" in Chrome on Windows.

Regenerate the flags with `node tools/make-flags.mjs`. Domains live in
`tools/domains.mjs`; `node tools/make-manifest.mjs` writes them into the three
places `manifest.json` needs them. The toolbar icons are cut from
`icons/icon-source.png` by `powershell -File tools/make-icons.ps1`.

Build the shareable zip with `powershell -File tools/make-zip.ps1`. It picks up
the version from the manifest and leaves out `tools/`, `test/` and the full size
source art.

## Tests

```
node --test test/logic.test.mjs
```

The suite covers the currency rule against the real 27-market table, the
country-id join, the flag files, price parsing in every market's number format,
the token bucket's arithmetic and its handling of `Retry-After`, the feed
parsers for both the homepage and the catalog, and the price fingerprint
including the cases that used to answer wrongly on a forint domain.

The DOM-dependent parts were verified against live pages. In 2.2, on a vinted.ro
search: the catalog parser named 96 of 96 sellers from the document and 96 of 96
from the page-2 XHR, against the cards actually on screen. Earlier: the card
selector, the `/items/` and `/member/` paths were confirmed unchanged on
vinted.fr, vinted.de, vinted.pl, vinted.co.uk and vinted.ro, and on the homepage
the selector found all 70 cards and both feed parsers named all 70 sellers.

## Dead ends, so nobody probes them again

- `/api/v2/catalog/items`. 404 with an HTML body since 2026-10-08.
- Replaying `svc-catalogue/items`. It answers, but the relevance feed is a fresh
  shuffle each time: 50 of 96 items in common with the grid it was copied from.
  Reading the response the page already got is both free and exact.
- `/api/v2/items/{id}` is 404. `/api/v2/items/{id}/details` answered a "Client
  Challenge" HTML page.
- The item page HTML. 1.9 MB with no `country_code`, no `country_id`, no city.
  It does name the seller, but it also embeds the visitor's own `profile_url`,
  so "the first `/member/` link" is not reliably the seller.
- `country_ids` on the old catalog endpoint. Silently ignored. Asking vinted.fr
  for Romanian sellers returned 95 items whose first five sellers were IT, FR,
  FR, FR, FR.
- `user.profile_url`. Rewritten to whichever domain you are browsing, so it says
  nothing about the seller. All 95 items on a French page carried `vinted.fr`,
  Italian and Dutch sellers included.
- `service_fee`. A pure function of price: `0.70 + 0.05 × price` held to the
  cent across 22 items for French, Dutch and Italian sellers alike.

## Licence

GPL-3.0. See [LICENSE](LICENSE).

Not affiliated with Vinted. It reads the same API the site's own front end
reads, from your browser, with your own session, and sends nothing anywhere.
