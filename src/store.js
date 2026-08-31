// Client side of the cache. The records live in the service worker so every
// Vinted tab and every Vinted domain reads the same ones; this file is the
// message passing plus a per-page memory copy so a redrawn grid does not send
// a hundred messages to learn what it already knows.

(() => {
  const MEM = { users: new Map(), items: new Map() };

  // The worker goes away when the extension reloads, and every pending message
  // rejects with "Extension context invalidated". Nothing here is worth
  // breaking the page over, so a dead channel just means a cache miss.
  async function call(k, payload) {
    try {
      const out = await chrome.runtime.sendMessage({ k, ...payload });
      return out && out.error ? null : out;
    } catch (e) {
      return null;
    }
  }

  async function get(kind, id) {
    const key = String(id);
    const hot = MEM[kind].get(key);
    if (hot !== undefined) return hot;
    const rec = await call(kind === 'users' ? 'getUser' : 'getItem', { id: key });
    MEM[kind].set(key, rec || null);
    return rec || null;
  }

  globalThis.VCF_Store = {
    getUser: (id) => get('users', id),

    async putUser(id, cc, city) {
      const rec = { id: String(id), cc, city: city || null, ts: Date.now() };
      MEM.users.set(rec.id, rec);
      await call('putUser', { id: rec.id, cc, city: rec.city });
      return rec;
    },

    getItem: (id) => get('items', id),

    async putItem(id, cc) {
      const rec = { id: String(id), cc, ts: Date.now() };
      MEM.items.set(rec.id, rec);
      await call('putItem', { id: rec.id, cc });
      return rec;
    },

    // One catalog response names 96 sellers and currency pins most of them.
    // They go over in a single message; the worker drops any it already has
    // from a profile lookup, since those carry a city and these do not.
    async bankUsers(rows) {
      const fresh = rows.filter((r) => r && r.cc && !MEM.users.get(String(r.id)));
      if (fresh.length === 0) return;
      for (const r of fresh) {
        MEM.users.set(String(r.id), { id: String(r.id), cc: r.cc, city: null, ts: Date.now() });
      }
      await call('bankUsers', { rows: fresh });
    },

    counts: () => call('counts').then((c) => c || { users: 0, items: 0 }),

    async clear() {
      MEM.users.clear();
      MEM.items.clear();
      await call('clear');
    },

    // Vinted's market list, cached in the worker for a week and shared by every
    // domain. The fetch happens here because a request from the page's own
    // context is the one that looks like Vinted's front end.
    async countries(fetchRows) {
      const saved = await call('getCountries');
      if (saved && Array.isArray(saved.rows) && saved.rows.length) return saved.rows;
      const rows = await fetchRows();
      if (Array.isArray(rows) && rows.length) await call('putCountries', { rows });
      return rows;
    },
  };
})();
