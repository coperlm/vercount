// Local smoke test for /api/domains/export CSV logic (uses in-memory mock kv)
const createMockKV = () => {
  const store = new Map();
  const kv = {
    store,
    async keys(pattern) {
      const prefix = pattern.replace(/\*$/, '');
      const matches = [];
      for (const k of store.keys()) if (k.startsWith(prefix)) matches.push(k);
      return matches;
    },
    async get(key) { return store.get(key) ?? null; },
    async scard(key) {
      const v = store.get(key);
      if (!v) return 0;
      if (Array.isArray(v)) return v.length;
      if (v instanceof Set) return v.size;
      return 0;
    },
    pipeline() {
      const ops = [];
      return {
        get(k) { ops.push({ t: 'get', k }); return this; },
        scard(k) { ops.push({ t: 'scard', k }); return this; },
        async exec() {
          const res = [];
          for (const op of ops) {
            if (op.t === 'get') res.push(store.get(op.k) ?? null);
            else if (op.t === 'scard') {
              const v = store.get(op.k);
              if (!v) res.push(0);
              else if (Array.isArray(v)) res.push(v.length);
              else if (v instanceof Set) res.push(v.size);
              else res.push(0);
            }
          }
          return res;
        }
      };
    }
  };
  return kv;
};

// Seed mock data for domain example.com
const domain = 'example.com';
const paths = ['/', '/post-1', '/category/tech'];
const dates = [
  '2026-05-17',
  '2026-05-18',
  '2026-05-19',
];

const kv = createMockKV();

// Seed keys
for (const p of paths) {
  const pageKey = `pv:page:${domain}:${p}`;
  kv.store.set(pageKey, 100); // total views
  for (const d of dates) {
    kv.store.set(`pv:page:${domain}:${p}:${d}`, Math.floor(Math.random()*100));
    // uv as Set
    const s = new Set();
    const uvCount = Math.floor(Math.random()*20);
    for (let i=0;i<uvCount;i++) s.add(`ip${i}`);
    kv.store.set(`uv:page:${domain}:${p}:${d}`, s);
  }
}

(async function(){
  const prefix = `pv:page:${domain}:`;
  const keys = await kv.keys(`${prefix}*`);
  const pageKeys = keys.filter(k=>!/:\d{4}-\d{2}-\d{2}$/.test(k));
  const pathsFound = pageKeys.map(k=>k.substring(prefix.length));
  console.log('Found paths:', pathsFound);

  // Build pipeline
  const pipeline = kv.pipeline();
  for (const d of dates) {
    for (const p of pathsFound) {
      pipeline.get(`pv:page:${domain}:${p}:${d}`);
      pipeline.scard(`uv:page:${domain}:${p}:${d}`);
    }
  }
  const raw = await pipeline.exec();
  // group
  const perPath = pathsFound.map(()=>({pv:[], uv:[]}));
  let idx = 0;
  for (let di=0; di<dates.length; di++){
    for (let pi=0; pi<pathsFound.length; pi++){
      perPath[pi].pv.push(Number(raw[idx++]||0));
      perPath[pi].uv.push(Number(raw[idx++]||0));
    }
  }
  // print CSV
  const header = ['path'];
  dates.forEach(d=>{ header.push(`${d} PV`); header.push(`${d} UV`); });
  console.log(header.join(','));
  for (let i=0;i<pathsFound.length;i++){
    const row = [pathsFound[i]];
    for (let j=0;j<dates.length;j++){ row.push(String(perPath[i].pv[j]||0)); row.push(String(perPath[i].uv[j]||0)); }
    console.log(row.join(','));
  }
})();
