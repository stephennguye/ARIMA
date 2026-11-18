import { Client } from '@notionhq/client';
import { Throttle } from '../lib/throttle.js';
import type { ApiProperty } from './props.js';

/** Name of the kill-switch to-do on the project root page (spec §11.3 "Pause ARIMA"). */
export const PAUSE_TODO_TEXT = 'Pause ARIMA';

export interface TodoBlock {
  id: string;
  text: string;
  checked: boolean;
}

/** What the kill switch and preflight need. */
export interface PauseSwitchPort {
  /** To-do blocks directly under a page. */
  listTodoBlocks(pageId: string): Promise<TodoBlock[]>;
  setTodoChecked(blockId: string, checked: boolean): Promise<void>;
  /** Appends a to-do block to a page and returns its id. */
  appendTodo(pageId: string, text: string, checked: boolean): Promise<string>;
}

/** A block directly under a page. For `child_database`, `text` is the database title. */
export interface ChildBlock {
  id: string;
  type: string;
  text: string;
  checked?: boolean;
}

export interface DatabaseInfo {
  /** Database id (the child_database block id). */
  id: string;
  title: string;
  /** The data source that holds the schema and rows. */
  dataSourceId: string;
}

export interface PropertyInfo {
  id: string;
  name: string;
  type: string;
  /** select / multi_select option names. */
  options?: string[];
  /** relation: the data source this property points at. */
  relationTarget?: string;
}

/**
 * The only Notion operations ARIMA is allowed to perform. There is deliberately no delete, no
 * archive and no property removal (spec §9.3, §11.1; ADR-0003): items are retired by changing a
 * status, never removed. Later tasks extend this port without ever adding a delete.
 */
export interface NotionPort extends PauseSwitchPort {
  listChildren(pageId: string): Promise<ChildBlock[]>;
  appendParagraph(pageId: string, text: string): Promise<string>;
  /** Creates an inline database under a page with the given plain properties. */
  createDatabase(
    parentPageId: string,
    title: string,
    properties: Record<string, ApiProperty>,
  ): Promise<DatabaseInfo>;
  getDatabase(databaseId: string): Promise<DatabaseInfo>;
  getDataSourceProperties(dataSourceId: string): Promise<Record<string, PropertyInfo>>;
  /** Adds NEW properties; throws if any name already exists (never alters or removes existing ones). */
  addProperties(dataSourceId: string, properties: Record<string, ApiProperty>): Promise<void>;
}

/** The slice of the official SDK client the port uses, so tests can fake it. */
export interface NotionClientLike {
  blocks: {
    children: {
      list(args: { block_id: string; start_cursor?: string; page_size?: number }): Promise<{
        results: unknown[];
        has_more: boolean;
        next_cursor: string | null;
      }>;
      append(args: { block_id: string; children: unknown[] }): Promise<{ results: unknown[] }>;
    };
    update(args: { block_id: string; to_do: { checked: boolean } }): Promise<unknown>;
  };
  databases: {
    create(args: {
      parent: { type: 'page_id'; page_id: string };
      title: unknown[];
      is_inline: boolean;
      initial_data_source: { properties: Record<string, unknown> };
    }): Promise<unknown>;
    retrieve(args: { database_id: string }): Promise<unknown>;
  };
  dataSources: {
    retrieve(args: { data_source_id: string }): Promise<unknown>;
    update(args: { data_source_id: string; properties: Record<string, unknown> }): Promise<unknown>;
  };
}

interface RawBlock {
  id?: string;
  type?: string;
  to_do?: { rich_text?: { plain_text?: string }[]; checked?: boolean };
  paragraph?: { rich_text?: { plain_text?: string }[] };
  child_database?: { title?: string };
}

interface RawDatabase {
  id: string;
  title?: { plain_text?: string }[];
  data_sources?: { id: string }[];
}

interface RawProperty {
  id: string;
  name: string;
  type: string;
  select?: { options?: { name: string }[] };
  multi_select?: { options?: { name: string }[] };
  relation?: { data_source_id?: string };
}

const plain = (rt: { plain_text?: string }[] | undefined): string =>
  (rt ?? []).map((t) => t.plain_text ?? '').join('');

function toDatabaseInfo(raw: RawDatabase): DatabaseInfo {
  const dataSourceId = raw.data_sources?.[0]?.id;
  if (dataSourceId === undefined) throw new Error(`database ${raw.id} has no data source`);
  return { id: raw.id, title: plain(raw.title), dataSourceId };
}

export function createNotionPort(
  client: NotionClientLike,
  throttle: Throttle = new Throttle(),
): NotionPort {
  const listChildren = async (pageId: string): Promise<ChildBlock[]> => {
    const out: ChildBlock[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await throttle.run(() =>
        client.blocks.children.list({
          block_id: pageId,
          page_size: 100,
          ...(cursor !== undefined ? { start_cursor: cursor } : {}),
        }),
      );
      for (const raw of page.results as RawBlock[]) {
        if (raw.id === undefined || raw.type === undefined) continue;
        if (raw.type === 'to_do' && raw.to_do) {
          out.push({
            id: raw.id,
            type: 'to_do',
            text: plain(raw.to_do.rich_text),
            checked: raw.to_do.checked === true,
          });
        } else if (raw.type === 'paragraph') {
          out.push({ id: raw.id, type: 'paragraph', text: plain(raw.paragraph?.rich_text) });
        } else if (raw.type === 'child_database') {
          out.push({ id: raw.id, type: 'child_database', text: raw.child_database?.title ?? '' });
        } else {
          out.push({ id: raw.id, type: raw.type, text: '' });
        }
      }
      if (!page.has_more || page.next_cursor === null) return out;
      cursor = page.next_cursor;
    }
  };

  const getDataSourceProperties = async (
    dataSourceId: string,
  ): Promise<Record<string, PropertyInfo>> => {
    const raw = (await throttle.run(() =>
      client.dataSources.retrieve({ data_source_id: dataSourceId }),
    )) as {
      properties?: Record<string, RawProperty>;
    };
    const out: Record<string, PropertyInfo> = {};
    for (const [name, p] of Object.entries(raw.properties ?? {})) {
      const info: PropertyInfo = { id: p.id, name: p.name ?? name, type: p.type };
      const opts = p.select?.options ?? p.multi_select?.options;
      if (opts) info.options = opts.map((o) => o.name);
      if (p.relation?.data_source_id) info.relationTarget = p.relation.data_source_id;
      out[name] = info;
    }
    return out;
  };

  return {
    listChildren,

    async listTodoBlocks(pageId) {
      return (await listChildren(pageId))
        .filter((b) => b.type === 'to_do')
        .map((b) => ({ id: b.id, text: b.text, checked: b.checked === true }));
    },

    async setTodoChecked(blockId, checked) {
      await throttle.run(() => client.blocks.update({ block_id: blockId, to_do: { checked } }));
    },

    async appendTodo(pageId, text, checked) {
      const res = await throttle.run(() =>
        client.blocks.children.append({
          block_id: pageId,
          children: [
            {
              object: 'block',
              type: 'to_do',
              to_do: { rich_text: [{ type: 'text', text: { content: text } }], checked },
            },
          ],
        }),
      );
      const id = (res.results[0] as RawBlock | undefined)?.id;
      if (id === undefined) throw new Error('Notion did not return the created block');
      return id;
    },

    async appendParagraph(pageId, text) {
      const res = await throttle.run(() =>
        client.blocks.children.append({
          block_id: pageId,
          children: [
            {
              object: 'block',
              type: 'paragraph',
              paragraph: { rich_text: [{ type: 'text', text: { content: text } }] },
            },
          ],
        }),
      );
      const id = (res.results[0] as RawBlock | undefined)?.id;
      if (id === undefined) throw new Error('Notion did not return the created block');
      return id;
    },

    async createDatabase(parentPageId, title, properties) {
      const raw = (await throttle.run(() =>
        client.databases.create({
          parent: { type: 'page_id', page_id: parentPageId },
          title: [{ type: 'text', text: { content: title } }],
          is_inline: true,
          initial_data_source: { properties },
        }),
      )) as RawDatabase;
      return toDatabaseInfo({ ...raw, title: raw.title ?? [{ plain_text: title }] });
    },

    async getDatabase(databaseId) {
      const raw = (await throttle.run(() =>
        client.databases.retrieve({ database_id: databaseId }),
      )) as RawDatabase;
      return toDatabaseInfo(raw);
    },

    getDataSourceProperties,

    async addProperties(dataSourceId, properties) {
      const existing = await getDataSourceProperties(dataSourceId);
      const clash = Object.keys(properties).filter((n) => n in existing);
      if (clash.length > 0) {
        throw new Error(`refusing to alter existing Notion properties: ${clash.join(', ')}`);
      }
      await throttle.run(() =>
        client.dataSources.update({ data_source_id: dataSourceId, properties }),
      );
    },
  };
}

/** Real port from an integration token. Retries on 429 are handled by the SDK. */
export function createNotionPortFromToken(token: string): NotionPort {
  const client = new Client({ auth: token, retry: { maxRetries: 5 } });
  return createNotionPort(client as unknown as NotionClientLike);
}
