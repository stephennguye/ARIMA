/**
 * Conversion between ARIMA's plain JSON values (what agents write in outbox entries and read from
 * the mirror) and Notion's property value objects.
 */

export type Plain =
  string | number | boolean | null | string[] | { start: string; end?: string | null };

/** Property types an agent may write. formula, rollup and files are read-only. */
export const WRITABLE_TYPES = new Set([
  'title',
  'rich_text',
  'number',
  'select',
  'multi_select',
  'date',
  'checkbox',
  'url',
  'people',
  'relation',
]);

const CHUNK = 2000; // Notion limit per rich-text element

const rich = (s: string): { type: 'text'; text: { content: string } }[] => {
  const out: { type: 'text'; text: { content: string } }[] = [];
  for (let i = 0; i < s.length; i += CHUNK)
    out.push({ type: 'text', text: { content: s.slice(i, i + CHUNK) } });
  return out;
};

export class ValueError extends Error {}

/**
 * Plain value -> Notion property value. `resolveRelation` turns an ARIMA ID (US-112) or a page id
 * into the page id Notion needs, and throws if it cannot.
 */
export function toNotionValue(
  type: string,
  name: string,
  value: unknown,
  resolveRelation: (id: string) => string,
): Record<string, unknown> {
  const bad = (expected: string): never => {
    throw new ValueError(`"${name}" (${type}) expects ${expected}`);
  };
  switch (type) {
    case 'title':
      return typeof value === 'string' ? { title: rich(value) } : bad('a string');
    case 'rich_text':
      return typeof value === 'string' ? { rich_text: rich(value) } : bad('a string');
    case 'number':
      return typeof value === 'number' || value === null
        ? { number: value }
        : bad('a number or null');
    case 'select':
      return value === null
        ? { select: null }
        : typeof value === 'string'
          ? { select: { name: value } }
          : bad('an option name or null');
    case 'multi_select':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? { multi_select: (value as string[]).map((n) => ({ name: n })) }
        : bad('an array of option names');
    case 'date':
      if (value === null) return { date: null };
      if (typeof value === 'string') return { date: { start: value } };
      if (
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof (value as { start?: unknown }).start === 'string'
      ) {
        const v = value as { start: string; end?: string | null };
        return { date: { start: v.start, ...(v.end ? { end: v.end } : {}) } };
      }
      return bad('an ISO date string, {start, end} or null');
    case 'checkbox':
      return typeof value === 'boolean' ? { checkbox: value } : bad('true or false');
    case 'url':
      return value === null || typeof value === 'string' ? { url: value } : bad('a string or null');
    case 'people':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? { people: (value as string[]).map((id) => ({ id })) }
        : bad('an array of Notion user ids');
    case 'relation':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? { relation: (value as string[]).map((id) => ({ id: resolveRelation(id) })) }
        : bad('an array of ARIMA IDs');
    default:
      throw new ValueError(`"${name}" is a ${type} property, which agents cannot write`);
  }
}

interface RawValue {
  type: string;
  [k: string]: unknown;
}

const plain = (rt: unknown): string =>
  Array.isArray(rt) ? rt.map((t) => (t as { plain_text?: string }).plain_text ?? '').join('') : '';

/** Notion property value -> plain JSON for the mirror. Unknown types become null. */
export function fromNotionValue(raw: RawValue): Plain | { id: string; name?: string }[] {
  switch (raw.type) {
    case 'title':
      return plain(raw['title']);
    case 'rich_text':
      return plain(raw['rich_text']);
    case 'number':
      return (raw['number'] as number | null) ?? null;
    case 'select':
      return (raw['select'] as { name?: string } | null)?.name ?? null;
    case 'multi_select':
      return ((raw['multi_select'] as { name: string }[] | undefined) ?? []).map((o) => o.name);
    case 'date': {
      const d = raw['date'] as { start: string; end?: string | null } | null;
      return d === null || d === undefined
        ? null
        : d.end
          ? { start: d.start, end: d.end }
          : d.start;
    }
    case 'checkbox':
      return raw['checkbox'] === true;
    case 'url':
      return (raw['url'] as string | null) ?? null;
    case 'people':
      return ((raw['people'] as { id: string; name?: string }[] | undefined) ?? []).map((p) => ({
        id: p.id,
        ...(p.name ? { name: p.name } : {}),
      }));
    case 'relation':
      return ((raw['relation'] as { id: string }[] | undefined) ?? []).map((r) => r.id);
    case 'files':
      return ((raw['files'] as { name?: string }[] | undefined) ?? []).map((f) => f.name ?? '');
    case 'formula': {
      const f = raw['formula'] as { type?: string; [k: string]: unknown } | undefined;
      const v = f && f.type ? f[f.type] : null;
      return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null;
    }
    case 'rollup': {
      const r = raw['rollup'] as
        { type?: string; array?: RawValue[]; number?: number | null } | undefined;
      if (r?.type === 'number') return r.number ?? null;
      if (r?.type === 'array') {
        return (r.array ?? []).map((x) => {
          const v = fromNotionValue(x);
          return typeof v === 'string' ? v : JSON.stringify(v);
        });
      }
      return null;
    }
    case 'created_time':
    case 'last_edited_time':
      return (raw[raw.type] as string | undefined) ?? null;
    default:
      return null;
  }
}

type Block = Record<string, unknown>;

/** Minimal Markdown -> Notion blocks: headings, bullets, numbers, to-dos, paragraphs. */
export function markdownToBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const para: string[] = [];
  const flush = (): void => {
    if (para.length > 0) {
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: rich(para.join(' ')) },
      });
      para.length = 0;
    }
  };
  const block = (type: string, body: Record<string, unknown>): void => {
    flush();
    blocks.push({ object: 'block', type, [type]: body });
  };
  for (const line of markdown.split(/\r?\n/)) {
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const todo = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const num = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (line.trim() === '') flush();
    else if (h) block(`heading_${(h[1] as string).length}`, { rich_text: rich(h[2] as string) });
    else if (todo) block('to_do', { rich_text: rich(todo[2] as string), checked: todo[1] !== ' ' });
    else if (bullet) block('bulleted_list_item', { rich_text: rich(bullet[1] as string) });
    else if (num) block('numbered_list_item', { rich_text: rich(num[1] as string) });
    else para.push(line.trim());
  }
  flush();
  return blocks;
}
