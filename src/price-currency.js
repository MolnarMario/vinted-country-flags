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

  // The buyer's own currency is always a candidate at rate 1: a seller who
  // prices in it is shown verbatim, so that rate is exact and its error is 0.
  function rates() {
    const out = new Map();
    const home = buyer();
    if (home) out.set(home, 1);
    for (const [cur, t] of totals) {
      if (t.n >= MIN_SAMPLES) out.set(cur, t.buyer / t.seller);
    }
    return out;
  }

  // MIN_SPACING_EUR expressed in buyer currency. Null until the euro rate is
  // known, which on a non-euro domain means until a euro seller has been seen.
  function minSpacing() {
    const home = buyer();
    if (!home) return null;
    if (home === 'EUR') return MIN_SPACING_EUR;
    const eur = rates().get('EUR');
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
    currencyFor,
    rates,
    minSpacing,
    // True once a foreign rate has been learned and the euro rate that anchors
    // the guard is known. Before that every price looks like the home currency,
    // which would flag the whole grid domestic.
    ready: () => rates().size > 1 && minSpacing() != null,
  };
})();
