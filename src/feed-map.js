// Turns the homepage feed into item id to seller id, without asking Vinted for
// anything.
//
// The homepage is not a catalog page. /api/v2/catalog/items does not return its
// items (0 of 20 matched on vinted.ro), and the endpoint that does,
// api.vinted.<tld>/homepage/homepage, answers 400 to a call the site did not
// make itself. So neither of the two routes the rest of the extension uses is
// available here, and a homepage card would otherwise name nobody at all.
//
// It does not have to. The answer is already in the tab, in two shapes:
//
//   the first screenful   server rendered into the document as the React
//                         payload the page hydrates from, where each item
//                         carries "user":{"id":...}
//   everything after it   the XHR the site fires when the feed paginates,
//                         where each item carries "user_id"
//
// Both are read, neither is requested. Measured 20 of 20 cards on vinted.ro and
// 12 of 12 on vinted.fr from the document, and 50 of 50 from the first
// pagination response.
//
// Split out from content.js because page-fetch.js needs the second half of it
// in the page's own world, and because a parser is worth testing without a DOM.

(() => {
  // What the flight payload looks like in the document. It is JSON inside a
  // JavaScript string literal, so every quote arrives backslash escaped, and a
  // regex over the raw text is cheaper than reassembling the payload.
  const ENTITY = '\\"entity\\":{\\"id\\":';

  // From the id to the seller, refusing to cross into the next entity. The
  // homepage mixes item blocks with category and brand blocks, and those have
  // an entity and no seller; without the guard one of them would borrow the
  // seller of the item that follows it. 900 characters is roughly three times
  // the longest gap seen, which is a title full of escaped quotes.
  const SELLER = /^(\d+),(?:(?!\\"entity\\")[\s\S])*?\\"user\\":\{\\"id\\":(\d+)/;
  const WINDOW = 900;

  const isId = (v) => /^\d+$/.test(String(v == null ? '' : v));

  // pairs from the server rendered document.
  function fromFlight(text) {
    const out = [];
    if (typeof text !== 'string') return out;
    let at = 0;
    for (;;) {
      const start = text.indexOf(ENTITY, at);
      if (start < 0) return out;
      at = start + ENTITY.length;
      const m = SELLER.exec(text.slice(at, at + WINDOW));
      if (m) out.push({ id: m[1], userId: m[2] });
    }
  }

  // pairs from the pagination response. The shape is blocks of blocks and it
  // has changed before, so this walks whatever it is given and takes every node
  // that carries both an item id and a seller id rather than following a path.
  function fromApi(node, out, depth) {
    const found = out || [];
    const level = depth || 0;
    if (!node || typeof node !== 'object' || level > 8) return found;

    if (Array.isArray(node)) {
      for (const child of node) fromApi(child, found, level + 1);
      return found;
    }

    const userId = node.user_id != null ? node.user_id : node.user && node.user.id;
    if (isId(node.id) && isId(userId)) found.push({ id: String(node.id), userId: String(userId) });

    for (const key of Object.keys(node)) fromApi(node[key], found, level + 1);
    return found;
  }

  globalThis.VCF_FeedMap = { fromFlight, fromApi };
})();
