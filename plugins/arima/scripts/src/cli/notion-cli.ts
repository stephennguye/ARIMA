import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { writeFileAtomic } from '../lib/atomic-file.js';
import { describeError, getValidator } from '../lib/schema.js';
import { bootstrapTemplate } from '../notion/build.js';
import { mapWorkspace } from '../notion/mapper.js';
import { guardInteractive } from '../interactive.js';
import type { WaitOptions } from '../interactive.js';
import { ENGINE_STATUS_PREFIX } from '../item-status.js';
import { checkKillSwitch } from '../killswitch.js';
import type { PauseSwitchPort } from '../notion/port.js';
import { remotePauseFlag } from '../state.js';
import { notionMapFile, pullMirror, readNotionMap } from '../notion/mirror.js';
import { pushOutbox } from '../notion/outbox.js';
import { ensureViews } from '../notion/views.js';
import { buildDigest } from '../digest.js';
import { sendNotifications } from '../notify.js';
import { createNotionPortFromToken } from '../notion/port.js';
import type { NotionPort } from '../notion/port.js';
import type { Io } from './config-cli.js';

export const USAGE = `Usage: arima-notion bootstrap --parent <page-id> [--token-env NAME]
       arima-notion map [--root <page-id>] [--migrate] [--project <dir>] [--token-env NAME]
       arima-notion pull [--project <dir>]     mirror every mapped database to .arima/mirror/
       arima-notion push [--project <dir>] [--allow-status-writes] [--as-run <run-id>]
                                               apply .arima/outbox/ to Notion (orchestrator only)
       arima-notion views [--project <dir>]    create the Board, Approval inbox, RTM, Milestone burn and Open bugs views (idempotent)
       arima-notion notify [--dry-run] [--project <dir>]
                                               @mention the owner on each item awaiting them, and on the Urgent page when urgent
bootstrap builds the 19 ARIMA databases under a page (run once, to build the public template).
map finds them under a duplicated template, verifies every property, writes .arima/notion-map.json.
The Notion integration token is read from the environment (default ARIMA_NOTION_TOKEN); it is never printed.
Exit codes: 0 ok, 1 verification failed, Notion error, or outbox entries rejected/in conflict/deferred, 2 usage`;

export interface NotionCliDeps {
  portFactory?: (token: string) => NotionPort;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** Test seams for the run-lock wait (spec 12.4). */
  lock?: Pick<WaitOptions, 'maxWaitMs' | 'pollMs' | 'sleep' | 'clock'>;
  /** Overrides the kill-switch check of `push`. */
  isPaused?: () => Promise<boolean>;
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
  if (
    command !== 'bootstrap' &&
    command !== 'map' &&
    command !== 'pull' &&
    command !== 'push' &&
    command !== 'views' &&
    command !== 'notify'
  ) {
    io.err(`${USAGE}\n`);
    return 2;
  }
  let values: {
    parent?: string;
    root?: string;
    migrate?: boolean;
    project?: string;
    'token-env'?: string;
    'allow-status-writes'?: boolean;
    'as-run'?: string;
    'dry-run'?: boolean;
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
        'allow-status-writes': { type: 'boolean' },
        'as-run': { type: 'string' },
        'dry-run': { type: 'boolean' },
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

  if (command === 'pull' || command === 'push' || command === 'views' || command === 'notify') {
    // Spec 12.4: wait for a live run (exit 11); push also refuses while paused (exit 12), pull never does.
    const stop = await guardInteractive({
      projectDir,
      command: `arima-notion ${command}`,
      holderRunId: values['as-run'],
      ...(deps.lock ?? {}),
      err: io.err,
      note: io.err,
      ...(command === 'push'
        ? {
            isPaused:
              deps.isPaused ??
              (async () =>
                (
                  await checkKillSwitch(
                    projectDir,
                    cfg.root
                      ? { port: port as unknown as PauseSwitchPort, rootPageId: cfg.root }
                      : null,
                    () => Promise.resolve(remotePauseFlag({ projectDir })),
                  )
                ).on),
          }
        : {}),
    });
    if (stop !== undefined) return stop;
  }

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
        'run arima-notion views to create the human views (Board, Approval inbox, RTM, Milestone burn, Open bugs)\n',
      );
      return 0;
    }

    if (command === 'pull') {
      const mirrors = await pullMirror(projectDir, port, readNotionMap(projectDir), {
        ...(deps.now ? { now: deps.now } : {}),
      });
      let rows = 0;
      for (const m of mirrors.values()) rows += m.rows.length;
      io.out(`mirrored ${mirrors.size} databases, ${rows} rows, to .arima/mirror/\n`);
      return 0;
    }

    if (command === 'push') {
      const report = await pushOutbox(projectDir, port, readNotionMap(projectDir), {
        ...(deps.now ? { now: deps.now } : {}),
        // The engine's own Status writes (queued by the dispatcher and the interactive commands) carry the st- prefix AND are
        // registered in the protected engine-entry registry: both are required, so an agent cannot forge one. A human may force
        // anything with --allow-status-writes.
        allowStatusWrites:
          values['allow-status-writes'] === true ? true : { idPrefix: ENGINE_STATUS_PREFIX },
      });
      io.out(
        `outbox: ${report.applied.length} applied, ${report.rejected.length} rejected, ${report.conflicts.length} in conflict (human edit kept), ${report.deferred.length} deferred\n`,
      );
      for (const r of report.rejected) io.out(`rejected ${r.id}: ${r.reason}\n`);
      for (const c of report.conflicts)
        io.out(
          `conflict ${c}: a human edited the page after the agent read it; their edit was kept\n`,
        );
      for (const d of report.deferred) io.out(`deferred ${d}: will be retried next run\n`);
      return report.rejected.length + report.conflicts.length + report.deferred.length > 0 ? 1 : 0;
    }

    if (command === 'views') {
      const r = await ensureViews(port, readNotionMap(projectDir));
      for (const c of r.created) io.out(`created  ${c.db}: ${c.name}\n`);
      for (const e of r.existing) io.out(`exists   ${e.db}: ${e.name}\n`);
      for (const f of r.failed) io.out(`FAILED   ${f.db}: ${f.name}: ${f.reason}\n`);
      io.out(
        `views: ${r.created.length} created, ${r.existing.length} already there, ${r.failed.length} failed\n`,
      );
      return r.failed.length > 0 ? 1 : 0;
    }

    if (command === 'notify') {
      if (cfg.root === undefined) {
        io.err('notion.root_page_id is not set in arima.yaml\n');
        return 2;
      }
      const digest = buildDigest(projectDir, deps.now ?? new Date());
      const r = await sendNotifications({
        projectDir,
        port,
        rootPageId: cfg.root,
        ...(deps.now ? { now: deps.now } : {}),
        ...(digest.health === 'red'
          ? { redHealth: { date: digest.date, reasons: digest.healthReasons } }
          : {}),
        ...(values['dry-run'] === true ? { dryRun: true } : {}),
      });
      for (const x of r.sent)
        io.out(
          `${values['dry-run'] === true ? 'would send' : 'sent'} ${x.kind} ${x.key}${values['dry-run'] === true ? '' : ` (${x.via})`}\n`,
        );
      for (const x of r.skipped) io.out(`skipped ${x}\n`);
      for (const x of r.failed) io.err(`failed ${x.key}: ${x.reason}\n`);
      io.out(
        `notifications: ${r.sent.length} ${values['dry-run'] === true ? 'to send' : 'sent'}, ${r.skipped.length} skipped, ${r.failed.length} failed\n`,
      );
      return r.failed.length > 0 ? 1 : 0;
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
