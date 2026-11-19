import type { NotionClientLike } from '../src/notion/port.js';

interface Prop {
  id: string;
  name: string;
  type: string;
  select?: { options: { name: string }[] };
  multi_select?: { options: { name: string }[] };
  relation?: { data_source_id: string };
}

interface DataSource {
  id: string;
  props: Map<string, Prop>;
}

interface Row {
  id: string;
  dsId: string;
  last_edited_time: string;
  properties: Record<string, { type: string; [k: string]: unknown }>;
}

/** Like the SDK's APIResponseError: carries an HTTP status. */
class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

interface Block {
  id: string;
  type: string;
  [k: string]: unknown;
}

/**
 * In-memory stand-in for the slice of the Notion API ARIMA uses: pages with child blocks,
 * databases with one data source, dual relations that create their reverse property, and
 * property updates. No network. Hooks let tests simulate API refusals.
 */
export class FakeNotion {
  private n = 0;
  readonly pages = new Map<string, Block[]>();
  readonly databases = new Map<string, { id: string; title: string; dataSourceId: string }>();
  readonly sources = new Map<string, DataSource>();
  readonly calls: string[] = [];
  /** Return a message to make the API reject adding this property name. */
  rejectProperty: (
    dsTitle: string,
    name: string,
    config: Record<string, unknown>,
  ) => string | undefined = () => undefined;

  constructor(readonly rootId = 'root-page') {
    this.pages.set(rootId, []);
  }

  readonly rows = new Map<string, Row>();
  private clock = 0;
  /** Make the next matching API call fail, e.g. { op: 'pages.update', status: 503 }. */
  failNext: { op: string; status?: number; message?: string } | undefined;

  /**
   * Notion rounds last_edited_time to the minute (checked against the real API). When set, every
   * write in the test falls in the same minute and gets the same timestamp.
   */
  sameMinute = false;

  /** Monotonic fake clock: every write gets a later last_edited_time. */
  tick(): string {
    if (this.sameMinute) return new Date(Date.UTC(2026, 10, 18, 0, 0, 0)).toISOString();
    this.clock += 1;
    return new Date(Date.UTC(2026, 10, 18, 0, 0, this.clock)).toISOString();
  }

  /** When true every API call fails as if Notion were unreachable. */
  down = false;

  private maybeFail(op: string): void {
    if (this.down) throw new ApiError('fetch failed: ENOTFOUND api.notion.com');
    if (this.failNext && this.failNext.op === op) {
      const f = this.failNext;
      this.failNext = undefined;
      throw new ApiError(f.message ?? 'simulated failure of ' + op, f.status);
    }
  }

  private fromRequest(type: string, value: unknown): { type: string; [k: string]: unknown } {
    if (type === 'title' || type === 'rich_text') {
      const items = (value as { text: { content: string } }[]).map((x) => ({
        plain_text: x.text.content,
      }));
      return { type, [type]: items };
    }
    return { type, [type]: value };
  }

  private writeProps(ds: DataSource, row: Row, props: Record<string, unknown>): void {
    for (const [name, value] of Object.entries(props)) {
      const def = ds.props.get(name);
      if (def === undefined) throw new ApiError(name + ' is not a property that exists.', 400);
      // Real Notion puts the property id on every value (found by comparing with recorded responses).
      row.properties[name] = {
        id: def.id,
        ...this.fromRequest(def.type, (value as Record<string, unknown>)[def.type]),
      };
    }
  }

  /** Simulates a human editing a row in the Notion UI (bumps last_edited_time). */
  humanEdit(pageId: string, props: Record<string, unknown>): void {
    const row = this.rows.get(pageId);
    if (!row) throw new Error('no row ' + pageId);
    this.writeProps(this.sources.get(row.dsId) as DataSource, row, props);
    row.last_edited_time = this.tick();
  }

  /** The row whose title text equals `id` in the database titled `dbTitle`. */
  rowByTitle(dbTitle: string, id: string): Row | undefined {
    const db = [...this.databases.values()].find((d) => d.title === dbTitle);
    return [...this.rows.values()].find(
      (r) =>
        r.dsId === db?.dataSourceId &&
        Object.values(r.properties).some(
          (p) =>
            p.type === 'title' &&
            (p['title'] as { plain_text: string }[]).map((x) => x.plain_text).join('') === id,
        ),
    );
  }

  /** Plain text of one property of a row. */
  text(row: Row, name: string): string {
    const p = row.properties[name];
    const items = (p?.['title'] ?? p?.['rich_text'] ?? []) as { plain_text: string }[];
    return items.map((x) => x.plain_text).join('');
  }

  private id(prefix: string): string {
    this.n += 1;
    return `${prefix}-${String(this.n).padStart(4, '0')}`;
  }

  private typeOf(config: Record<string, unknown>): string {
    if (typeof config['type'] === 'string') return config['type'];
    const key = Object.keys(config).find((k) => k !== 'name' && k !== 'description');
    if (key === undefined) throw new Error('property config has no type');
    return key;
  }

  private addProp(ds: DataSource, name: string, config: Record<string, unknown>): void {
    const type = this.typeOf(config);
    const prop: Prop = { id: this.id('p'), name, type };
    const body = config[type] as Record<string, unknown> | undefined;
    if (type === 'select' || type === 'multi_select') {
      const options = ((body?.['options'] as { name: string }[] | undefined) ?? []).map((o) => ({
        name: o.name,
      }));
      prop[type] = { options };
    }
    if (type === 'relation') {
      const target = String(body?.['data_source_id']);
      if (!this.sources.has(target)) throw new Error(`relation target ${target} does not exist`);
      prop.relation = { data_source_id: target };
      const dual = body?.['dual_property'] as { synced_property_name?: string } | undefined;
      if (dual !== undefined) {
        const reverse = dual.synced_property_name ?? `Related to ${name}`;
        const targetDs = this.sources.get(target) as DataSource;
        if (targetDs.props.has(reverse))
          throw new Error(`reverse property ${reverse} already exists`);
        targetDs.props.set(reverse, {
          id: this.id('p'),
          name: reverse,
          type: 'relation',
          relation: { data_source_id: ds.id },
        });
      }
    }
    ds.props.set(name, prop);
  }

  readonly client: NotionClientLike = {
    blocks: {
      children: {
        list: ({ block_id }) => {
          this.calls.push('blocks.children.list');
          this.maybeFail('blocks.children.list');
          const blocks = this.pages.get(block_id);
          if (!blocks) return Promise.reject(new Error(`no page ${block_id}`));
          return Promise.resolve({ results: blocks, has_more: false, next_cursor: null });
        },
        append: ({ block_id, children }) => {
          this.calls.push('blocks.children.append');
          this.maybeFail('blocks.children.append');
          const blocks = this.pages.get(block_id);
          if (!blocks) return Promise.reject(new Error(`no page ${block_id}`));
          const created = (children as Record<string, unknown>[]).map((c) => {
            const type = String(c['type']);
            const body = c[type] as { rich_text?: { text: { content: string } }[] };
            const rich = (body.rich_text ?? []).map((t) => ({ plain_text: t.text.content }));
            return { id: this.id('b'), type, [type]: { ...body, rich_text: rich } } as Block;
          });
          blocks.push(...created);
          const row = this.rows.get(block_id);
          if (row) row.last_edited_time = this.tick();
          return Promise.resolve({ results: created });
        },
      },
      update: ({ block_id, to_do }) => {
        this.calls.push('blocks.update');
        try {
          this.maybeFail('blocks.update');
        } catch (e) {
          return Promise.reject(e as Error);
        }
        for (const blocks of this.pages.values()) {
          const b = blocks.find((x) => x.id === block_id);
          if (b) {
            (b['to_do'] as { checked: boolean }).checked = to_do.checked;
            return Promise.resolve({});
          }
        }
        return Promise.reject(new ApiError('no block ' + block_id, 404));
      },
    },
    databases: {
      create: ({ parent, title, initial_data_source }) => {
        this.calls.push('databases.create');
        const blocks = this.pages.get(parent.page_id);
        if (!blocks) return Promise.reject(new Error(`no page ${parent.page_id}`));
        const dbId = this.id('db');
        const dsId = this.id('ds');
        const text = (title as { text: { content: string } }[]).map((t) => t.text.content).join('');
        const ds: DataSource = { id: dsId, props: new Map() };
        this.sources.set(dsId, ds);
        for (const [name, config] of Object.entries(initial_data_source.properties)) {
          this.addProp(ds, name, config as Record<string, unknown>);
        }
        const titles = [...ds.props.values()].filter((p) => p.type === 'title');
        if (titles.length !== 1)
          return Promise.reject(
            new Error(`database needs exactly one title property, got ${titles.length}`),
          );
        this.databases.set(dbId, { id: dbId, title: text, dataSourceId: dsId });
        blocks.push({ id: dbId, type: 'child_database', child_database: { title: text } });
        return Promise.resolve({
          id: dbId,
          title: [{ plain_text: text }],
          data_sources: [{ id: dsId }],
        });
      },
      retrieve: ({ database_id }) => {
        const db = this.databases.get(database_id);
        if (!db) return Promise.reject(new Error(`no database ${database_id}`));
        return Promise.resolve({
          id: db.id,
          title: [{ plain_text: db.title }],
          data_sources: [{ id: db.dataSourceId }],
        });
      },
    },
    dataSources: {
      retrieve: ({ data_source_id }) => {
        const ds = this.sources.get(data_source_id);
        if (!ds) return Promise.reject(new Error(`no data source ${data_source_id}`));
        return Promise.resolve({ id: ds.id, properties: Object.fromEntries(ds.props) });
      },
      update: ({ data_source_id, properties }) => {
        this.calls.push('dataSources.update');
        const ds = this.sources.get(data_source_id);
        if (!ds) return Promise.reject(new Error(`no data source ${data_source_id}`));
        const title =
          [...this.databases.values()].find((d) => d.dataSourceId === data_source_id)?.title ?? '?';
        try {
          for (const [name, config] of Object.entries(properties)) {
            const reject = this.rejectProperty(title, name, config as Record<string, unknown>);
            if (reject !== undefined) throw new Error(reject);
            if (config === null)
              throw new Error('deleting a property is not allowed in this test double');
            this.addProp(ds, name, config as Record<string, unknown>);
          }
        } catch (e) {
          return Promise.reject(e instanceof Error ? e : new Error(String(e)));
        }
        return Promise.resolve({});
      },
      query: ({ data_source_id }) => {
        this.calls.push('dataSources.query');
        try {
          this.maybeFail('dataSources.query');
        } catch (e) {
          return Promise.reject(e as Error);
        }
        const results = [...this.rows.values()]
          .filter((r) => r.dsId === data_source_id)
          .map((r) => ({
            object: 'page',
            id: r.id,
            last_edited_time: r.last_edited_time,
            properties: r.properties,
          }));
        return Promise.resolve({ results, has_more: false, next_cursor: null });
      },
    },
    pages: {
      retrieve: ({ page_id }) => {
        this.calls.push('pages.retrieve');
        const row = this.rows.get(page_id);
        if (!row) return Promise.reject(new ApiError('no page ' + page_id, 404));
        return Promise.resolve({
          id: row.id,
          last_edited_time: row.last_edited_time,
          properties: row.properties,
        });
      },
      create: ({ parent, properties, children }) => {
        this.calls.push('pages.create');
        try {
          this.maybeFail('pages.create');
          const ds = this.sources.get(parent.data_source_id);
          if (!ds) throw new ApiError('no data source ' + parent.data_source_id, 404);
          const row: Row = {
            id: this.id('pg'),
            dsId: ds.id,
            last_edited_time: this.tick(),
            properties: {},
          };
          this.writeProps(ds, row, properties);
          this.rows.set(row.id, row);
          this.pages.set(row.id, []);
          if (children && children.length > 0) {
            void this.client.blocks.children.append({ block_id: row.id, children });
            row.last_edited_time = this.tick();
          }
          return Promise.resolve({
            id: row.id,
            last_edited_time: row.last_edited_time,
            properties: row.properties,
          });
        } catch (e) {
          return Promise.reject(e as Error);
        }
      },
      update: ({ page_id, properties }) => {
        this.calls.push('pages.update');
        try {
          this.maybeFail('pages.update');
          const row = this.rows.get(page_id);
          if (!row) throw new ApiError('no page ' + page_id, 404);
          this.writeProps(this.sources.get(row.dsId) as DataSource, row, properties);
          row.last_edited_time = this.tick();
          return Promise.resolve({
            id: row.id,
            last_edited_time: row.last_edited_time,
            properties: row.properties,
          });
        } catch (e) {
          return Promise.reject(e as Error);
        }
      },
    },
  };

  // ---- helpers for assertions / simulating humans ----
  dbIdByTitle(title: string): string {
    const db = [...this.databases.values()].find((d) => d.title === title);
    if (!db) throw new Error(`no database ${title}`);
    return db.id;
  }

  props(title: string): Map<string, Prop> {
    const db = [...this.databases.values()].find((d) => d.title === title);
    if (!db) throw new Error(`no database ${title}`);
    return (this.sources.get(db.dataSourceId) as DataSource).props;
  }

  /** Simulates a human deleting a property in the Notion UI. */
  humanDeleteProperty(title: string, name: string): void {
    this.props(title).delete(name);
  }

  /** Simulates a human changing a property's type. */
  humanRetypeProperty(title: string, name: string, type: string): void {
    const p = this.props(title).get(name);
    if (p) p.type = type;
  }
}
