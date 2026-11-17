import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { writeFileAtomic } from '../lib/atomic-file.js';
import { describeError, getValidator } from '../lib/schema.js';
import { bootstrapTemplate } from '../notion/build.js';
import { mapWorkspace } from '../notion/mapper.js';
import { createNotionPortFromToken } from '../notion/port.js';
import type { NotionPort } from '../notion/port.js';
import type { Io } from './config-cli.js';

export const USAGE = `Usage: arima-notion bootstrap --parent <page-id> [--token-env NAME]
       arima-notion map [--root <page-id>] [--migrate] [--project <dir>] [--token-env NAME]
bootstrap builds the 19 ARIMA databases under a page (run once, to build the public template).
map finds them under a duplicated template, verifies every property, writes .arima/notion-map.json.
The Notion integration token is read from the environment (default ARIMA_NOTION_TOKEN); it is never printed.
Exit codes: 0 ok, 1 verification failed or Notion error, 2 usage`;

export interface NotionCliDeps {
  portFactory?: (token: string) => NotionPort;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export function notionMapFile(projectDir: string): string {
  return path.join(projectDir, '.arima', 'notion-map.json');
}

function rootFromConfig(projectDir: string): { root?: string; tokenEnv?: string } {
  const file = path.join(projectDir, 'arima.yaml');
  if (!existsSync(file)) return {};
  try {
    const doc = parse(readFileSync(file, 'utf8')) as {
      notion?: { root_page_id?: string; token_env?: string };
    };
    return {
      ...(doc.notion?.root_page_id && !doc.notion.root_page_id.startsWith('<')
        ? { root: doc.notion.root_page_id }
        : {}),
      ...(doc.notion?.token_env ? { tokenEnv: doc.notion.token_env } : {}),
    };
  } catch {
    return {};
  }
}

export async function runNotionCli(
  argv: string[],
  io: Io,
  deps: NotionCliDeps = {},
): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'bootstrap' && command !== 'map') {
    io.err(`${USAGE}\n`);
    return 2;
  }
  let values: {
    parent?: string;
    root?: string;
    migrate?: boolean;
    project?: string;
    'token-env'?: string;
  };
  try {
    values = parseArgs({
      args: rest,
      allowPositionals: false,
      options: {
        parent: { type: 'string' },
        root: { type: 'string' },
        migrate: { type: 'boolean' },
        project: { type: 'string' },
        'token-env': { type: 'string' },
      },
    }).values;
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n${USAGE}\n`);
    return 2;
  }

  const projectDir = path.resolve(io.cwd, values.project ?? '.');
  const cfg = rootFromConfig(projectDir);
  const tokenEnv = values['token-env'] ?? cfg.tokenEnv ?? 'ARIMA_NOTION_TOKEN';
  const token = (deps.env ?? process.env)[tokenEnv];
  if (!token) {
    io.err(`environment variable ${tokenEnv} is not set (the Notion integration token)\n`);
    return 2;
  }
  const port = (deps.portFactory ?? createNotionPortFromToken)(token);

  try {
    if (command === 'bootstrap') {
      if (values.parent === undefined) {
        io.err(`--parent is required\n${USAGE}\n`);
        return 2;
      }
      const report = await bootstrapTemplate(port, values.parent, (l) => io.out(`${l}\n`));
      io.out(
        `done: ${report.created.length} created, ${report.skipped.length} already existed, ${report.added.length} properties added\n`,
      );
      if (report.manual.length > 0) {
        io.out(
          `${report.manual.length} step(s) need doing by hand in Notion (see docs/NOTION-TEMPLATE.md):\n`,
        );
        for (const m of report.manual)
          io.out(
            `  - ${m.database}.${m.property}: ${m.reason}${m.hint ? `\n      ${m.hint}` : ''}\n`,
          );
      }
      io.out(
        'views are not created by the API; set them up as described in docs/NOTION-TEMPLATE.md\n',
      );
      return 0;
    }

    const root = values.root ?? cfg.root;
    if (root === undefined) {
      io.err(`--root is required (or set notion.root_page_id in arima.yaml)\n${USAGE}\n`);
      return 2;
    }
    const result = await mapWorkspace(port, root, {
      ...(values.migrate === true ? { migrate: true } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    for (const a of result.migrated) io.out(`added    ${a}\n`);
    for (const m of result.manual) io.out(`manual   ${m.database}.${m.property}: ${m.reason}\n`);
    for (const i of result.issues)
      io.out(
        `${i.severity === 'error' ? 'ERROR  ' : 'warning'} ${i.database}${i.property ? `.${i.property}` : ''}: ${i.detail}\n`,
      );
    if (result.map === undefined) {
      io.err('verification failed; notion-map.json was not written\n');
      return 1;
    }
    const validate = getValidator('notion-map');
    if (!validate(result.map)) {
      io.err(
        `internal error: generated map is invalid: ${(validate.errors ?? []).map(describeError).join('; ')}\n`,
      );
      return 1;
    }
    const file = notionMapFile(projectDir);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, `${JSON.stringify(result.map, null, 2)}\n`);
    io.out(
      `wrote ${path.relative(io.cwd, file) || file} (${Object.keys(result.map.databases).length} databases)\n`,
    );
    return 0;
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
