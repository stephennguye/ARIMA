import type { PropSpec } from './schema.js';

/** A property configuration in the shape the Notion API expects (opaque to callers). */
export type ApiProperty = Record<string, unknown>;

const options = (names: readonly string[] | undefined): { name: string }[] =>
  (names ?? []).map((name) => ({ name }));

/**
 * Plain (non-relational) property -> API config. Formulas and rollups are included, but bootstrap
 * only sends them after the relations they depend on exist.
 */
export function toApiProperty(p: PropSpec): ApiProperty {
  switch (p.type) {
    case 'title':
      return { title: {} };
    case 'rich_text':
      return { rich_text: {} };
    case 'number':
      return { number: { format: 'number' } };
    case 'select':
      return { select: { options: options(p.options) } };
    case 'multi_select':
      return { multi_select: { options: options(p.options) } };
    case 'date':
      return { date: {} };
    case 'people':
      return { people: {} };
    case 'checkbox':
      return { checkbox: {} };
    case 'url':
      return { url: {} };
    case 'files':
      return { files: {} };
    case 'formula':
      return { formula: { expression: p.formula ?? '' } };
    case 'rollup':
      if (p.rollup === undefined) throw new Error(`rollup ${p.name} has no definition`);
      return {
        rollup: {
          relation_property_name: p.rollup.relation,
          rollup_property_name: p.rollup.property,
          function: p.rollup.fn,
        },
      };
    case 'relation':
      throw new Error(`relation ${p.name} needs a target data source id; use toApiRelation`);
  }
}

/** Two-way relation to `targetDataSourceId`; Notion creates the reverse property with this name. */
export function toApiRelation(targetDataSourceId: string, reverseName: string): ApiProperty {
  return {
    relation: {
      data_source_id: targetDataSourceId,
      dual_property: { synced_property_name: reverseName },
    },
  };
}

/** Properties sent when a database is first created: everything that has no dependencies. */
export function isPlain(p: PropSpec): boolean {
  return p.type !== 'relation' && p.type !== 'formula' && p.type !== 'rollup';
}
