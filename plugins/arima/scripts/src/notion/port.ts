import { Client } from '@notionhq/client';
import { Throttle, withBackoff, withReadRetry } from '../lib/throttle.js';
import type { BackoffOptions } from '../lib/throttle.js';
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
  /** Every row of a data source (all pages of results). */
  queryRows(dataSourceId: string): Promise<RawRow[]>;
  getPageLastEdited(pageId: string): Promise<string>;
  /** One page with its raw property values (what a human sees now). */
  getPage(pageId: string): Promise<RawRow>;
  createPage(
    dataSourceId: string,
    properties: Record<string, unknown>,
    children?: unknown[],
  ): Promise<{ pageId: string; lastEdited: string; properties?: RawRow['properties'] }>;
  /** Updates property values. There is no way to trash or archive a page through this port. */
  updatePage(
    pageId: string,
    properties: Record<string, unknown>,
  ): Promise<{ lastEdited: string; properties?: RawRow['properties'] }>;
  appendChildren(pageId: string, blocks: unknown[]): Promise<void>;
  /** The views of a database (id and name). */
  listViews(databaseId: string): Promise<{ id: string; name: string }[]>;
  /** Creates a view of a data source (WP-142). Never alters or deletes an existing view. */
  createView(input: {
    databaseId: string;
    dataSourceId: string;
    name: string;
    type: 'table' | 'board';
    filter?: Record<string, unknown>;
    sorts?: Record<string, unknown>[];
    groupBy?: { propertyId: string; type: 'select' };
  }): Promise<string>;
  /** Adds a comment to a page (a mention in a comment notifies the person). */
  createComment(pageId: string, richText: unknown[]): Promise<void>;
  /** The id of the child page with this title under the page, created when there is none. */
  findOrCreateChildPage(parentPageId: string, title: string): Promise<string>;
}

/** A page of a data source with its raw Notion property values. */
export interface RawRow {
  pageId: string;
  lastEdited: string;
  properties: Record<string, { type: string; [k: string]: unknown }>;
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
    query(args: { data_source_id: string; start_cursor?: string; page_size?: number }): Promise<{
      results: unknown[];
      has_more: boolean;
      next_cursor: string | null;
    }>;
  };
  pages: {
    retrieve(args: { page_id: string }): Promise<unknown>;
    create(args: {
      parent:
        { type: 'data_source_id'; data_source_id: string } | { type: 'page_id'; page_id: string };
      properties: Record<string, unknown>;
      children?: unknown[];
    }): Promise<unknown>;
    update(args: { page_id: string; properties: Record<string, unknown> }): Promise<unknown>;
  };
  views?: {
    list(args: { database_id?: string; data_source_id?: string; start_cursor?: string }): Promise<{
      results: { id?: string }[];
      has_more: boolean;
      next_cursor: string | null;
    }>;
    retrieve(args: { view_id: string }): Promise<unknown>;
    create(args: Record<string, unknown>): Promise<unknown>;
  };
  comments?: {
    create(args: { parent: { page_id: string }; rich_text: unknown[] }): Promise<unknown>;
  };
}

interface RawBlock {
  id?: string;
  type?: string;
  to_do?: { rich_text?: { plain_text?: string }[]; checked?: boolean };
  paragraph?: { rich_text?: { plain_text?: string }[] };
  child_database?: { title?: string };
  child_page?: { title?: string };
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
  backoff: BackoffOptions = {},
): NotionPort {
  /** Every API call: spaced to ~3 requests/second, and retried with backoff on HTTP 429. */
  const call = <T>(fn: () => Promise<T>): Promise<T> =>
    throttle.run(() => withBackoff(fn, backoff));
  /** Reads also survive a dropped connection or a 5xx (writes never do: a retry could duplicate). */
  const callRead = <T>(fn: () => Promise<T>): Promise<T> =>
    throttle.run(() =>
      withReadRetry(
        () => withBackoff(fn, backoff),
        backoff.sleep ? { sleep: async (ms) => void (await backoff.sleep?.(ms)) } : {},
      ),
    );

  const listChildren = async (pageId: string): Promise<ChildBlock[]> => {
    const out: ChildBlock[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await callRead(() =>
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
        } else if (raw.type === 'child_page') {
          out.push({ id: raw.id, type: 'child_page', text: raw.child_page?.title ?? '' });
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
    const raw = (await callRead(() =>
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
      await call(() => client.blocks.update({ block_id: blockId, to_do: { checked } }));
    },

    async appendTodo(pageId, text, checked) {
      const res = await call(() =>
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
      const res = await call(() =>
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
      const raw = (await call(() =>
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
      const raw = (await callRead(() =>
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
      await call(() => client.dataSources.update({ data_source_id: dataSourceId, properties }));
    },

    async queryRows(dataSourceId) {
      const rows: RawRow[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await callRead(() =>
          client.dataSources.query({
            data_source_id: dataSourceId,
            page_size: 100,
            ...(cursor !== undefined ? { start_cursor: cursor } : {}),
          }),
        );
        for (const raw of page.results as {
          object?: string;
          id: string;
          last_edited_time: string;
          properties?: RawRow['properties'];
        }[]) {
          if (raw.object !== undefined && raw.object !== 'page') continue;
          rows.push({
            pageId: raw.id,
            lastEdited: raw.last_edited_time,
            properties: raw.properties ?? {},
          });
        }
        if (!page.has_more || page.next_cursor === null) return rows;
        cursor = page.next_cursor;
      }
    },

    async getPageLastEdited(pageId) {
      const raw = (await callRead(() => client.pages.retrieve({ page_id: pageId }))) as {
        last_edited_time: string;
      };
      return raw.last_edited_time;
    },

    async getPage(pageId) {
      const raw = (await callRead(() => client.pages.retrieve({ page_id: pageId }))) as {
        id: string;
        last_edited_time: string;
        properties?: RawRow['properties'];
      };
      return { pageId: raw.id, lastEdited: raw.last_edited_time, properties: raw.properties ?? {} };
    },

    async createPage(dataSourceId, properties, children) {
      const first = children?.slice(0, 100);
      const raw = (await call(() =>
        client.pages.create({
          parent: { type: 'data_source_id', data_source_id: dataSourceId },
          properties,
          ...(first && first.length > 0 ? { children: first } : {}),
        }),
      )) as { id: string; last_edited_time: string; properties?: RawRow['properties'] };
      let lastEdited = raw.last_edited_time;
      for (let i = 100; children && i < children.length; i += 100) {
        const rest = children.slice(i, i + 100);
        await call(() => client.blocks.children.append({ block_id: raw.id, children: rest }));
      }
      if (children && children.length > 100) lastEdited = await this.getPageLastEdited(raw.id);
      return {
        pageId: raw.id,
        lastEdited,
        ...(raw.properties ? { properties: raw.properties } : {}),
      };
    },

    async updatePage(pageId, properties) {
      const raw = (await call(() => client.pages.update({ page_id: pageId, properties }))) as {
        last_edited_time: string;
        properties?: RawRow['properties'];
      };
      return {
        lastEdited: raw.last_edited_time,
        ...(raw.properties ? { properties: raw.properties } : {}),
      };
    },

    async listViews(databaseId) {
      if (client.views === undefined) throw new Error('this Notion client has no views API');
      const v = client.views;
      const out: { id: string; name: string }[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await callRead(() =>
          v.list({
            database_id: databaseId,
            ...(cursor !== undefined ? { start_cursor: cursor } : {}),
          }),
        );
        for (const r of page.results) {
          if (r.id === undefined) continue;
          const full = (await callRead(() => v.retrieve({ view_id: r.id as string }))) as {
            name?: string;
          };
          out.push({ id: r.id, name: full.name ?? '' });
        }
        if (!page.has_more || page.next_cursor === null) return out;
        cursor = page.next_cursor;
      }
    },

    async createView(i) {
      if (client.views === undefined) throw new Error('this Notion client has no views API');
      const v = client.views;
      const raw = (await call(() =>
        v.create({
          database_id: i.databaseId,
          data_source_id: i.dataSourceId,
          name: i.name,
          type: i.type,
          ...(i.filter ? { filter: i.filter } : {}),
          ...(i.sorts ? { sorts: i.sorts } : {}),
          ...(i.groupBy
            ? {
                configuration: {
                  type: i.type,
                  group_by: {
                    type: i.groupBy.type,
                    property_id: i.groupBy.propertyId,
                    sort: { type: 'manual' },
                  },
                },
              }
            : {}),
        }),
      )) as { id: string };
      return raw.id;
    },

    async createComment(pageId, richText) {
      if (client.comments === undefined) throw new Error('this Notion client has no comments API');
      const c = client.comments;
      await call(() => c.create({ parent: { page_id: pageId }, rich_text: richText }));
    },

    async findOrCreateChildPage(parentPageId, title) {
      const have = (await listChildren(parentPageId)).find(
        (b) => b.type === 'child_page' && b.text === title,
      );
      if (have !== undefined) return have.id;
      const raw = (await call(() =>
        client.pages.create({
          parent: { type: 'page_id', page_id: parentPageId },
          properties: { title: { title: [{ type: 'text', text: { content: title } }] } },
        }),
      )) as { id: string };
      return raw.id;
    },

    async appendChildren(pageId, blocks) {
      for (let i = 0; i < blocks.length; i += 100) {
        const chunk = blocks.slice(i, i + 100);
        await call(() => client.blocks.children.append({ block_id: pageId, children: chunk }));
      }
    },
  };
}

/** Real port from an integration token. Retries on 429 are handled by the SDK. */
export function createNotionPortFromToken(token: string): NotionPort {
  // The SDK's own retry is off: createNotionPort retries 429s itself (withBackoff), once.
  const client = new Client({ auth: token, retry: false });
  return createNotionPort(client as unknown as NotionClientLike);
}
