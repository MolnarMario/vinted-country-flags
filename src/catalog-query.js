// Turns a Vinted address into the /api/v2/catalog/items query that returns the
// same items the page just rendered.
//
// Nothing here is per-domain. Vinted translates the catalog slug
// (/catalog/3480-cafea-ceai against /catalog/3480-kaffee-und-tee) and leaves
// the numeric prefix alone, which is the part the regex takes, and /brand/ and
// /catalog/ are not localised at all.
//
// Split out from content.js so the mapping can be tested without a DOM.

(() => {
  // Vinted's own URLs and its API disagree about parameter names, and about
  // where the category lives. /catalog/13-jumpers-and-sweaters puts it in the
  // path; the API only reads catalog_ids. Sending the URL through untranslated
  // asks for the generic front page feed, which shares about four items with
  // the ninety-six on screen, so almost nothing gets a flag.
  const PARAM_ALIAS = {
    'catalog[]': 'catalog_ids',
    'catalog_ids[]': 'catalog_ids',
    'brand_id[]': 'brand_ids',
    'brand_ids[]': 'brand_ids',
    'size_id[]': 'size_ids',
    'size_ids[]': 'size_ids',
    'status_id[]': 'status_ids',
    'status_ids[]': 'status_ids',
    'color_id[]': 'color_ids',
    'color_ids[]': 'color_ids',
    'material_id[]': 'material_ids',
    'material_ids[]': 'material_ids',
    'country_id[]': 'country_ids',
    'country_ids[]': 'country_ids',
    'video_game_rating_id[]': 'video_game_rating_ids',
    'video_game_rating_ids[]': 'video_game_rating_ids',
  };

  // Front end only params. Sending them changes nothing, or worse, pushes the
  // response away from what the page rendered.
  const PARAM_DROP = new Set(['disabled_personalization', 'time', 'search_id']);

  const CATALOG_PATH_RE = /^\/catalog\/(\d+)(?:-|$)/;
  const BRAND_PATH_RE = /^\/brand\/(\d+)(?:-|$)/;
  const PER_PAGE = 96; // the API caps here, and a catalog page renders 96 cards

  function isCatalogPath(pathname) {
    return CATALOG_PATH_RE.test(pathname)
      || BRAND_PATH_RE.test(pathname)
      || pathname === '/catalog'
      || pathname === '/catalog/';
  }

  // Repeated filters (two brands, three sizes) arrive as separate bracketed
  // params and go out as one comma separated list, which is what the API takes.
  function build(loc) {
    const out = new Map();
    const add = (key, value) => {
      if (value === '' || value == null) return;
      const prev = out.get(key);
      out.set(key, prev ? prev + ',' + value : value);
    };

    for (const [key, value] of new URLSearchParams(loc.search || '')) {
      const name = PARAM_ALIAS[key] || key;
      if (PARAM_DROP.has(name)) continue;
      add(name, value);
    }

    const cat = (loc.pathname || '').match(CATALOG_PATH_RE);
    if (cat && !out.has('catalog_ids')) out.set('catalog_ids', cat[1]);
    const brand = (loc.pathname || '').match(BRAND_PATH_RE);
    if (brand && !out.has('brand_ids')) out.set('brand_ids', brand[1]);

    // With no explicit sort the page renders the relevance feed. Leaving this
    // off costs a couple of matches per page. Getting it wrong costs all of
    // them, because a different sort is a different set of items.
    if (!out.has('order')) out.set('order', 'relevance');
    if (!out.has('page')) out.set('page', '1');
    out.set('per_page', String(PER_PAGE));

    const params = new URLSearchParams();
    for (const [key, value] of out) params.set(key, value);
    return params.toString();
  }

  globalThis.VCF_CatalogQuery = { build, isCatalogPath, PER_PAGE };
})();
