// Scrubs a real Notion API response so it can be committed as a fixture: every ID becomes a stable
// placeholder, people lose their names, e-mail addresses and avatars, URLs are neutralised. Shapes,
// property types and value structure are kept, which is the whole point of a fixture.
const UUID = /\b[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\b/gi;

export function scrub<T>(value: T): T {
  const ids = new Map<string, string>();
  const placeholder = (raw: string): string => {
    const key = raw.replace(/-/g, '').toLowerCase();
    let p = ids.get(key);
    if (p === undefined) {
      p = `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, '0')}`;
      ids.set(key, p);
    }
    return p;
  };
  const walk = (v: unknown, k?: string): unknown => {
    if (typeof v === 'string') {
      if (k === 'name' && /@/.test(v)) return 'Test User';
      if (k === 'email' || k === 'avatar_url') return k === 'email' ? 'test@example.com' : null;
      if (k === 'url' || k === 'public_url')
        return v.replace(/^https?:\/\/[^\s]+$/i, 'https://notion.example/page');
      return v.replace(UUID, (m) => placeholder(m));
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, k));
    if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const isPerson = o['object'] === 'user' && o['type'] === 'person';
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(o)) {
        if (isPerson && key === 'name') out[key] = 'Test User';
        else if (isPerson && key === 'person') out[key] = { email: 'test@example.com' };
        else if (key === 'avatar_url') out[key] = null;
        else out[walk(key) as string] = walk(val, key);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
