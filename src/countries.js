// Currency to country resolution, with no per-domain knowledge in the file.
//
// Vinted publishes its own market list at /api/v2/countries. It works on every
// domain, needs no session, and returns id, iso_code, currency and a title in
// the site's language. Everything here is derived from that table, so a new
// market appears on its own and a currency that stops being unique stops
// pinning a country on its own too.
//
// The rule, for one item:
//   currency = conversion.seller_currency, or the buyer currency when the
//              conversion is null, which means the seller prices in ours
//   exactly one market uses that currency  -> that country
//   several do, which today only means EUR -> 'EU', a placeholder, not an answer
//   nobody does                            -> null
//
// Checked against live data: on vinted.ro a null conversion gives RON gives RO.
// On vinted.fr it gives EUR gives EU, which is why the euro domains cost a
// lookup per card. On vinted.pl, PLN gives PL, HUF gives HU, EUR gives EU.

(() => {
  const byCurrency = new Map(); // 'RON' -> ['RO']
  const byId = new Map();       // 25 -> { iso, currency, title }
  const byIso = new Map();      // 'RO' -> { id, currency, title }

  let buyerCurrency = null;
  let loaded = false;

  // The site's own language, which Vinted sets correctly on every domain
  // (ro-RO, fr-FR, en-GB). Used for country names and, before the first
  // catalog response lands, to guess which market we are on.
  const lang = (document.documentElement.getAttribute('lang') || '').trim() || 'en';
  const region = (lang.split('-')[1] || '').toUpperCase();

  let display = null;
  try {
    display = new Intl.DisplayNames([lang, 'en'], { type: 'region' });
  } catch (e) {
    display = null;
  }

  // Names the eurozone placeholder in the site's language when Intl knows the
  // word for the European Union, which it does for every locale Vinted ships.
  function euName() {
    const eu = display && safeDisplay('EU');
    return eu ? eu : 'Eurozone';
  }

  function safeDisplay(code) {
    try {
      const out = display.of(code);
      return out && out !== code ? out : null;
    } catch (e) {
      return null;
    }
  }

  // rows: the `countries` array from /api/v2/countries.
  function init(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return false;
    byCurrency.clear();
    byId.clear();
    byIso.clear();

    for (const row of rows) {
      const iso = String(row.iso_code || '').toUpperCase();
      const currency = String(row.currency || '').toUpperCase();
      if (!/^[A-Z]{2}$/.test(iso) || !currency) continue;
      // Vinted's own titles are not always clean: the French table returns
      // "Allemagne " with a trailing space, which would land in a tooltip as
      // "Allemagne  · Berlin".
      const title = String(row.title || '').trim();
      const rec = { id: row.id, iso, currency, title: title || null };
      byId.set(String(row.id), rec);
      byIso.set(iso, rec);
      if (!byCurrency.has(currency)) byCurrency.set(currency, []);
      byCurrency.get(currency).push(iso);
    }

    loaded = byIso.size > 0;
    // The market we are browsing, so a null conversion has something to mean
    // before the first catalog response names the buyer currency outright.
    if (loaded && !buyerCurrency && byIso.has(region)) {
      buyerCurrency = byIso.get(region).currency;
    }
    return loaded;
  }

  globalThis.VCF_COUNTRIES = {
    init,
    lang,

    get ready() {
      return loaded && !!buyerCurrency;
    },

    get buyerCurrency() {
      return buyerCurrency;
    },

    // Every catalog item carries price.currency_code, which is what the buyer
    // is being shown. That beats the guess from the page language.
    setBuyerCurrency(code) {
      const cur = String(code || '').toUpperCase();
      if (/^[A-Z]{3}$/.test(cur)) buyerCurrency = cur;
    },

    // The country a currency pins, 'EU' when it is the euro, null otherwise.
    fromCurrency(code) {
      const cur = String(code || '').toUpperCase();
      const markets = byCurrency.get(cur);
      if (!markets) return null;
      if (markets.length === 1) return markets[0];
      // Only EUR is shared today. Another shared currency would be a market
      // Vinted added, and guessing 'EU' for it would put a euro flag on a
      // country that never joined, so it answers nothing and pays for a lookup.
      return cur === 'EUR' ? 'EU' : null;
    },

    fromConversion(conversion) {
      const cur = (conversion && conversion.seller_currency) || buyerCurrency;
      return cur ? this.fromCurrency(cur) : null;
    },

    // /api/v2/users/{id} returns country_code as Vinted's own code, which is
    // "UK" for Britain and resolves to no flag. country_id joined against this
    // table is the code Vinted itself uses everywhere else, so prefer it and
    // keep country_iso_code for a seller living outside every market.
    fromUser(user) {
      if (!user) return null;
      const byIdHit = byId.get(String(user.country_id));
      if (byIdHit) return byIdHit.iso;
      const iso = String(user.country_iso_code || '').toUpperCase();
      return /^[A-Z]{2}$/.test(iso) ? iso : null;
    },

    isMarket(code) {
      return byIso.has(String(code || '').toUpperCase());
    },

    isResolved(code) {
      return !!code && code !== 'EU' && code !== 'XX';
    },

    // Every ISO alpha-2 code has a file (tools/make-flags.mjs), so this hands
    // back the code itself. Anything else, and anything that 404s anyway, gets
    // the neutral marker. content.js swaps a broken image for it.
    flagFile(code) {
      const cc = String(code || '').toUpperCase();
      if (cc === 'EU') return 'eu';
      return /^[A-Z]{2}$/.test(cc) ? cc.toLowerCase() : 'xx';
    },

    name(code) {
      const cc = String(code || '').toUpperCase();
      if (cc === 'EU') return euName();
      if (!/^[A-Z]{2}$/.test(cc)) return 'Unknown';
      // Vinted's own title is already in the site's language and matches the
      // wording the rest of the page uses, so it wins where it exists.
      const market = byIso.get(cc);
      if (market && market.title) return market.title;
      return (display && safeDisplay(cc)) || cc;
    },
  };
})();
