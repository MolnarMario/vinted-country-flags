// Turns the item grid into item id to seller id, without asking Vinted for
// anything.
//
// This used to be the homepage's special case. On 2026-10-08 Vinted retired
// /api/v2/catalog/items (it answers 404 with an HTML body now), and the catalog
// grid moved to api.vinted.<tld>/svc-catalogue/items, which the site calls on
// its own every time the grid changes. So the catalog is in the homepage's
// position: the answer is already in the tab and only has to be read.
//
//   the first screenful   server rendered into the document as the React
//                         payload the page hydrates from. The homepage wraps
//                         each item as "entity":{"id":...}, the catalog as
//                         "productItem":{"id":...}, and both carry
//                         "user":{"id":...} a few hundred characters later.
//   everything after it   the XHR the site fires when the grid pages, filters
//                         or sorts. The homepage feed says "user_id", the
//                         catalog says "user":{"id":...}.
//
// Both are read, neither is requested. Measured on vinted.ro: 20 of 20
// homepage cards and 96 of 96 catalog cards from the document, and 96 of 96
// from a catalog page change.
//
// Split out from content.js because page-fetch.js needs the second half of it
// in the page's own world, and because a parser is worth testing without a DOM.

(() => {
  // What the flight payload looks like in the document. It is JSON inside a
  // JavaScript string literal, so every quote arrives backslash escaped, and a
  // regex over the raw text is cheaper than reassembling the payload.
  //
  // The window is how far past the anchor the seller may sit. A homepage
  // entity reaches its seller within about 300 characters. A catalog item puts
  // two thumbnail URLs and its prices first, about 1000 characters, so its
  // window is wider.
  const ANCHORS = [
    { text: '\\"entity\\":{\\"id\\":', window: 900 },
    { text: '\\"productItem\\":{\\"id\\":', window: 3000 },
  ];

  // From the id to the seller, refusing to cross into the next item. The
  // homepage mixes item blocks with category and brand blocks, and those have
  // an entity and no seller; without the guard one of them would borrow the
  // seller of the item that follows it.
  const SELLER =
    /^(\d+),(?:(?!\\"(?:entity|productItem)\\")[\s\S])*?\\"user\\":\{\\"id\\":(\d+)/;

  const isId = (v) => /^\d+$/.test(String(v == null ? '' : v));

  // pairs from the server rendered document.
  function fromFlight(text) {
    const out = [];
    if (typeof text !== 'string') return out;
    for (const anchor of ANCHORS) {
      let at = 0;
      for (;;) {
        const start = text.indexOf(anchor.text, at);
        if (start < 0) break;
        at = start + anchor.text.length;
        const m = SELLER.exec(text.slice(at, at + anchor.window));
        if (m) out.push({ id: m[1], userId: m[2] });
      }
    }
    return out;
  }

  // pairs from a grid response. The shape is blocks of blocks and it has
  // changed before, so this walks whatever it is given and takes every node
  // that carries both an item id and a seller id rather than following a path.
  //
  // An item that still carries the old conversion object brings it along, with
  // its price, so the currency layer can use it. None of 96 did on vinted.ro on
  // 2026-10-08, but that is the field the free answers used to come from.
  function fromApi(node, out, depth) {
    const found = out || [];
    const level = depth || 0;
    if (!node || typeof node !== 'object' || level > 8) return found;

    if (Array.isArray(node)) {
      for (const child of node) fromApi(child, found, level + 1);
      return found;
    }

    const userId = node.user_id != null ? node.user_id : node.user && node.user.id;
    if (isId(node.id) && isId(userId)) {
      const pair = { id: String(node.id), userId: String(userId) };
      // What the buyer is shown, which is what an item without a conversion
      // object is priced in.
      if (node.price && node.price.currency_code) pair.currency = node.price.currency_code;
      if (node.conversion && node.price) {
        pair.conversion = node.conversion;
        pair.price = node.price;
      }
      found.push(pair);
    }

    for (const key of Object.keys(node)) fromApi(node[key], found, level + 1);
    return found;
  }

  globalThis.VCF_FeedMap = { fromFlight, fromApi };
})();
