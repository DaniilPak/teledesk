// In-memory implementation of the store interface, used by the local dev server and tests.
export function createMemoryStore() {
  const items = new Map(); // `${pk}\u0000${sk}` -> item
  const k = (pk, sk) => `${pk}\u0000${sk}`;
  const clone = (x) => (x ? structuredClone(x) : null);

  return {
    _items: items,

    async get(pk, sk) {
      return clone(items.get(k(pk, sk)));
    },

    async put(item, { ifNotExists = false } = {}) {
      if (ifNotExists && items.has(k(item.pk, item.sk))) return false;
      items.set(k(item.pk, item.sk), clone(item));
      return true;
    },

    async update(pk, sk, { set = {}, remove = [], add = {} } = {}) {
      const cur = items.get(k(pk, sk)) ?? { pk, sk };
      for (const [key, v] of Object.entries(set)) if (v !== undefined) cur[key] = v;
      for (const [key, v] of Object.entries(add)) cur[key] = (cur[key] ?? 0) + v;
      for (const key of remove) delete cur[key];
      items.set(k(pk, sk), cur);
      return clone(cur);
    },

    async query(pk, { prefix, after, desc = false, limit = 50 } = {}) {
      let list = [...items.values()].filter((i) => i.pk === pk);
      if (after) list = list.filter((i) => i.sk > after);
      else if (prefix) list = list.filter((i) => i.sk.startsWith(prefix));
      list.sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0));
      if (desc) list.reverse();
      return list.slice(0, limit).map(clone);
    },

    async queryIndex(gsi1pk, { limit = 100 } = {}) {
      return [...items.values()]
        .filter((i) => i.gsi1pk === gsi1pk)
        .sort((a, b) => (a.gsi1sk < b.gsi1sk ? 1 : -1))
        .slice(0, limit)
        .map(clone);
    },

    async del(pk, sk) {
      items.delete(k(pk, sk));
    },
  };
}
