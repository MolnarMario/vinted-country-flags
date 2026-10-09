// Works out a seller's currency from the price printed on the card, with no
// request at all.
//
// Vinted shows every price in the buyer's currency, but a foreign seller's
// price is their own number run through one exchange rate and rounded to the
// cent. The rounding leaves a fingerprint. On vinted.ro, 100 PLN comes out as
// 122,42 RON, and no whole number of lei and no whole number of forints lands
// on 122,42.
//
// So for each currency we know a rate for, divide the shown price by it and ask
// how round the answer is:
//
//   122.42 / 1.2242    = 100         a grid one zloty wide, 1.22 RON per step
//   122.42 / 0.0145666 = 8404.24     only reproduces 122.42 at hundredths of a
//                                    forint, a grid 0.0001 RON wide
//   122.42 / 1         = 122.42      lei, but only to the cent
//
// The coarser the grid a currency explains the price on, the less likely the
// fit is a coincidence, because a coarse grid has fewer prices on it. So the
// coarsest wins, provided it wins by a clear factor. Otherwise the price is
// genuinely ambiguous and this answers null rather than guess.
//
// No rate is hardcoded. They are learned from the catalog responses the
// extension already fetches, where every converted item carries the seller's
// price next to ours. That follows the daily fix on its own and picks up a new
// currency the moment the site starts showing one.
//
// Measured against 936 items across five categories on vinted.ro, with rates
// learned from a different 878: it answers for 95% and gets 99.7% of those
// right. The three misses all named EUR, which resolves to no flag, so none of
// them put a wrong country on a card.
//
// On a euro domain the module correctly does nothing. Every seller prices in
// euro, so no conversion is ever shown, no second rate is ever learned, and
// ready() stays false.

(() => {
  // The shown price is rounded to the cent, so a candidate has to reproduce it
  // to within half a cent. Loosening this lifts coverage by about a point and
  // multiplies wrong answers by five, so it stays tight.
  //
  // Half a cent is an absolute figure and the error in a learned rate is not,
  // so an expensive item is held to a stricter standard than a cheap one: a
  // rate known to one part in a million still misplaces a 7000 unit price by a
  // hundredth. I tried widening the tolerance by an estimate of the rate error
  // to compensate. On simulated grids it changed nothing once a few hundred
  // rates had been learned, and with only a handful it took accuracy from 98%
  // to 91% by answering on rates that were not worth trusting. Refusing an
  // expensive item until the rate is solid is the better trade, so the
  // tolerance stays flat.
  const TOLERANCE = 0.005;

  // Grids the seller's own price might sit on, coarsest first. The top of the
  // ladder is there for the weak currencies: 100000 is 260 EUR of lei but only
  // 260 EUR of forints too, and a Hungarian seller asking 500000 HUF for a coat
  // is an ordinary listing, not an outlier.
  const GRID = [
    1000000, 500000, 200000, 100000, 50000, 10000, 5000, 1000, 500,
    100, 50, 20, 10, 5, 2, 1, 0.5, 0.1, 0.01,
  ];

  // How coarse a fit has to be before it means anything, in buyer currency.
  //
  // This used to be a flat 1, meaning one unit of whatever the buyer sees. One
  // leu is about 0.20 EUR, which is a real guard. One forint is 0.0025 EUR,
  // which is no guard at all: on vinted.hu every price on the page clears a
  // one-forint grid and the fingerprint starts inventing currencies. So anchor
  // it to a value instead, and refuse to answer until the euro rate that
  // converts it is known.
  const MIN_SPACING_EUR = 0.2;

  // How much coarser the winner has to be than the runner up.
  const MARGIN = 2;

  // Rates from too few items are dominated by the cent rounding in each sample.
  const MIN_SAMPLES = 3;

  // currency -> running totals, so the rate is one sum divided by another
  // rather than an average of ratios. Summing cancels the per-item rounding.
  const totals = new Map();

  const buyer = () => {
    const C = globalThis.VCF_COUNTRIES;
    return (C && C.buyerCurrency) || null;
  };

  function learn(items) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const conv = item && item.conversion;
      if (!conv || !conv.seller_currency) continue;
      const seller = Number(conv.seller_price);
      const price = Number(item.price && item.price.amount);
      if (!(seller > 0) || !(price > 0)) continue;
      const t = totals.get(conv.seller_currency) || { seller: 0, buyer: 0, n: 0 };
      t.seller += seller;
      t.buyer += price;
      t.n++;
      totals.set(conv.seller_currency, t);
    }
  }

  // ------------------------------------------------- rates without conversions

  // Since 2026-10-08 nothing on the grid carries a conversion, so learn() has
  // nothing to eat. What the page does have is sellers whose country is known
  // for certain (a lookup, or the cache), each next to a price in our currency.
  // That is the shown price and the seller's currency, without the seller's
  // own number. The number can still be recovered, because people price in
  // whole units: a rate r is right for an item if some whole seller price s
  // reproduces the shown price, |round(s * r, 2) - shown| <= 0.005. Each
  // whole s allows a sliver of rates, and the true rate is where the slivers
  // of most items line up.
  //
  // r / 2, r / 3 and so on line up just as well, since a whole price doubled
  // is still whole. So the search stays inside a band around a rough rate,
  // which is the one place a number is written down here. The exact rate
  // still comes from the page.
  //
  // Euro value of one unit. RON, PLN and HUF are the rates vinted.ro itself
  // applied on 2026-08-31, read off its conversion objects; those three are
  // nearly every seller on that domain (61 RON, 24 PLN, 8 HUF of 93 items).
  // The rest are market rates from autumn 2026.
  const ROUGH_EUR = {
    EUR: 1, RON: 0.1881, PLN: 0.2302, HUF: 0.002739, CZK: 0.0405, GBP: 1.16,
    DKK: 0.134, SEK: 0.091, USD: 0.87, AUD: 0.56,
  };
  // How far the real rate may sit from the rough one. 5/6 and 6/5 of the rate
  // fit every item priced in fives and sixes, and both are outside. A rough
  // rate that drifts past this stops solving rather than solving wrong, mostly,
  // and the cards go back to lookups.
  const BAND_LO = 0.87;
  const BAND_HI = 1.15;
  // Inside the band, r * 10/9 and r * 10/11 still fit every item priced in
  // tens. Those are told apart by how round the implied prices come out: 100
  // zloty against 90 or 110. That only works with a few items, so it waits
  // for them, and the winner has to beat the next cluster clearly.
  const MIN_OBSERVED = 4;
  const SOLVE_MARGIN = 1.5;
  // Keeps the newest items only. More would sharpen the rate a little and
  // slow the search a lot.
  const MAX_OBSERVED = 40;
  // How many seller units a single item may imply before it is skipped. A
  // 3000 lei coat in forints is tens of thousands of slivers and adds nothing
  // a cheap item does not.
  const MAX_UNITS = 3000;

  const observed = new Map(); // currency -> [buyer price, ...]
  const solved = new Map(); // currency -> rate, or null when it did not solve

  // The smallest step people price in. Forints come in tens, everything else
  // in whole units. One forint is 0.0026 EUR, so a grid of single forints
  // fits almost any price and proves nothing.
  const unitOf = (cur) => (ROUGH_EUR[cur] < 0.01 ? 10 : 1);

  // What one item adds to a spot on the rate axis. Agreeing at all is worth
  // most of it and roundness only splits ties. The other way round, 45, 90
  // and 180 zloty read as a rounder 50, 100 and 200 at 9/10 of the rate, and
  // won there in simulation even though every other item disagreed.
  function weight(s) {
    return 3 + (s % 5 === 0) + (s % 10 === 0) + (s % 50 === 0) + (s % 100 === 0);
  }

  function observe(price, currency) {
    const cur = String(currency || '').toUpperCase();
    const home = buyer();
    const p = Number(price);
    if (!home || cur === home || !ROUGH_EUR[cur] || !ROUGH_EUR[home] || !(p > 0)) return;
    const list = observed.get(cur) || [];
    list.push(p);
    if (list.length > MAX_OBSERVED) list.shift();
    observed.set(cur, list);
    solved.delete(cur);
  }

  // Sweeps the rate axis once. Each item lays down a sliver for every whole
  // price that lands in the band, worth more the rounder that price is, and
  // the best spot is the one whose live slivers add up highest.
  function solve(cur) {
    if (solved.has(cur)) return solved.get(cur);
    const list = observed.get(cur) || [];
    const home = buyer();
    let rate = null;
    if (list.length >= MIN_OBSERVED && home && ROUGH_EUR[home]) {
      rate = sweep(list, (ROUGH_EUR[cur] / ROUGH_EUR[home]) * unitOf(cur));
      if (rate != null) rate /= unitOf(cur);
    }
    solved.set(cur, rate);
    return rate;
  }

  function sweep(prices, rough) {
    const lo = rough * BAND_LO;
    const hi = rough * BAND_HI;
    const events = [];
    prices.forEach((p, i) => {
      const first = Math.ceil((p - TOLERANCE) / hi);
      const last = Math.floor((p + TOLERANCE) / lo);
      if (last - first > MAX_UNITS) return;
      for (let s = Math.max(1, first); s <= last; s++) {
        const w = weight(s);
        events.push({ at: (p - TOLERANCE) / s, i, w });
        events.push({ at: (p + TOLERANCE) / s, i, w: -w });
      }
    });
    // Openings before closings at the same spot, so touching slivers count as
    // overlapping, which is what the inclusive tolerance means.
    events.sort((a, b) => a.at - b.at || b.w - a.w);

    const live = new Map(); // item -> weight of its open sliver
    const spots = [];
    for (let k = 0; k < events.length; k++) {
      const e = events[k];
      if (e.w > 0) live.set(e.i, Math.max(live.get(e.i) || 0, e.w));
      else live.delete(e.i);
      const next = events[k + 1];
      if (!next || live.size < 2) continue;
      let score = 0;
      for (const w of live.values()) score += w;
      spots.push({ from: e.at, to: next.at, score, n: live.size });
    }
    if (!spots.length) return null;

    spots.sort((a, b) => b.score - a.score);
    const best = spots[0];
    const mid = (best.from + best.to) / 2;
    if (mid < lo || mid > hi) return null;
    // Half the items have to agree. A discounted 42.30 zloty fits no whole
    // price, so all of them never will.
    if (best.n < Math.max(3, Math.ceil(prices.length / 2))) return null;
    // The runner up is the best spot in some other cluster. Inside 0.2% it is
    // the same answer with an item fewer.
    const rival = spots.find((s) => Math.abs((s.from + s.to) / 2 - mid) > mid * 0.002);
    if (rival && best.score < SOLVE_MARGIN * rival.score) return null;
    return mid;
  }

  // The buyer's own currency is always a candidate at rate 1: a seller who
  // prices in it is shown verbatim, so that rate is exact and its error is 0.
  // A rate from conversions beats a solved one, since it was read, not fitted.
  function rates() {
    const out = new Map();
    const home = buyer();
    if (home) out.set(home, 1);
    for (const cur of observed.keys()) {
      const r = solve(cur);
      if (r != null) out.set(cur, r);
    }
    for (const [cur, t] of totals) {
      if (t.n >= MIN_SAMPLES) out.set(cur, t.buyer / t.seller);
    }
    return out;
  }

  // MIN_SPACING_EUR expressed in buyer currency. Null until the euro rate is
  // known, which on a non-euro domain means until a euro seller has been seen.
  // The guard is a floor, not a fit, so the rough rate is close enough to size
  // it before then.
  function minSpacing() {
    const home = buyer();
    if (!home) return null;
    if (home === 'EUR') return MIN_SPACING_EUR;
    const eur = rates().get('EUR') || (ROUGH_EUR[home] && 1 / ROUGH_EUR[home]);
    return eur ? MIN_SPACING_EUR * eur : null;
  }

  const cents = (x) => Math.round(x * 100) / 100;

  // The coarsest grid, in buyer currency, on which some seller price reproduces
  // the shown price. 0 means no grid in the list explains it at all.
  function spacing(price, rate) {
    for (const step of GRID) {
      const seller = Math.round(price / rate / step) * step;
      if (seller <= 0) continue;
      if (Math.abs(cents(seller * rate) - price) <= TOLERANCE) return step * rate;
    }
    return 0;
  }

  // Returns the currency code, or null when the price does not single one out.
  function currencyFor(price) {
    if (!(price > 0)) return null;
    const floor = minSpacing();
    if (floor == null) return null;

    const scored = [];
    for (const [cur, rate] of rates()) scored.push({ cur, sp: spacing(price, rate) });
    if (scored.length < 2) return null; // nothing to compare the home currency against
    scored.sort((a, b) => b.sp - a.sp);
    const [best, next] = scored;
    if (best.sp < floor) return null;
    if (best.sp < MARGIN * next.sp) return null;
    return best.cur;
  }

  globalThis.VCF_PriceCurrency = {
    learn,
    observe,
    currencyFor,
    rates,
    minSpacing,
    // True once a foreign rate has been learned and the euro rate that anchors
    // the guard is known. Before that every price looks like the home currency,
    // which would flag the whole grid domestic.
    ready: () => rates().size > 1 && minSpacing() != null,
  };
})();
