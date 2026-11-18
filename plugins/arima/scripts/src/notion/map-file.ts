import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../lib/atomic-file.js';
import { describeError, getValidator } from '../lib/schema.js';
import { mapWorkspace } from './mapper.js';
import type { MapResult } from './mapper.js';
import { notionMapFile } from './mirror.js';
import type { NotionPort } from './port.js';

export interface MapAndWrite {
  result: MapResult;
  /** Path of notion-map.json when it was written. */
  file?: string;
}

/** Verifies the workspace and, if it passes, writes .arima/notion-map.json (schema-checked). */
export async function mapAndWrite(
  projectDir: string,
  port: NotionPort,
  rootPageId: string,
  opts: { migrate?: boolean; now?: Date } = {},
): Promise<MapAndWrite> {
  const result = await mapWorkspace(port, rootPageId, opts);
  if (result.map === undefined) return { result };
  const validate = getValidator('notion-map');
  if (!validate(result.map)) {
    throw new Error(
      `internal error: generated map is invalid: ${(validate.errors ?? []).map(describeError).join('; ')}`,
    );
  }
  const file = notionMapFile(projectDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(result.map, null, 2)}\n`);
  return { result, file };
}
