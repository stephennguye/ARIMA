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
          const blocks = this.pages.get(block_id);
          if (!blocks) return Promise.reject(new Error(`no page ${block_id}`));
          return Promise.resolve({ results: blocks, has_more: false, next_cursor: null });
        },
        append: ({ block_id, children }) => {
          this.calls.push('blocks.children.append');
          const blocks = this.pages.get(block_id);
          if (!blocks) return Promise.reject(new Error(`no page ${block_id}`));
          const created = (children as Record<string, unknown>[]).map((c) => {
            const type = String(c['type']);
            const body = c[type] as { rich_text?: { text: { content: string } }[] };
            const rich = (body.rich_text ?? []).map((t) => ({ plain_text: t.text.content }));
            return { id: this.id('b'), type, [type]: { ...body, rich_text: rich } } as Block;
          });
          blocks.push(...created);
          return Promise.resolve({ results: created });
        },
      },
      update: () => Promise.resolve({}),
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
