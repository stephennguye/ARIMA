import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { validateProject } from '../config.js';
import { isRole } from '../roles.js';
import { PUBLISH_EXIT, PublishError, postReview, publishBranch } from '../publish.js';
import type { GhRunner, ReviewFinding } from '../publish.js';
import type { Io } from './config-cli.js';

export const PUBLISH_USAGE = `Usage: arima-publish push --branch <branch> --item <ID> --role <role> --title <text> --body-file <file> --run-id <id> [--type story|bug|hotfix|chore] [--report <developer report.json> [--ui]] [--project <dir>]
  (with --report the body must pass the DoD check: every criterion mapped with evidence; --ui also needs a screenshot)
       arima-publish comment --pr <number> --report <runs/<run>.report.json> [--project <dir>]
Exit codes: 0 ok, 2 usage, 12 kill switch is on, 14 GitHub token missing, 31 branch refused (protected path, secret, attribution, scope), 32 push or GitHub refused`;

export interface PublishCliDeps {
  env?: NodeJS.ProcessEnv;
  gh?: GhRunner;
  /** Overrides the push URL (tests). */
  remoteUrl?: string;
}

interface GithubCfg {
  repo: string;
  default_branch: string;
  state_branch: string;
  machine_token_env?: string;
  allow_unchecked_remote?: boolean;
}

/** `arima-publish`: host only. It holds the machine token; no role can run it. */
export async function runPublishCli(
  argv: string[],
  io: Io,
  deps: PublishCliDeps = {},
): Promise<number> {
  const [command, ...rest] = argv;
  let v: Record<string, string | undefined>;
  try {
    v = parseArgs({
      args: rest,
      allowPositionals: false,
      options: {
        branch: { type: 'string' },
        item: { type: 'string' },
        role: { type: 'string' },
        title: { type: 'string' },
        'body-file': { type: 'string' },
        'run-id': { type: 'string' },
        type: { type: 'string' },
        ui: { type: 'boolean' },
        pr: { type: 'string' },
        report: { type: 'string' },
        project: { type: 'string' },
      },
    }).values as Record<string, string | undefined>;
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n${PUBLISH_USAGE}\n`);
    return PUBLISH_EXIT.usage;
  }
  const usage = (m: string): number => {
    io.err(`${m}\n${PUBLISH_USAGE}\n`);
    return PUBLISH_EXIT.usage;
  };
  const projectDir = path.resolve(io.cwd, v['project'] ?? '.');
  const cfg = validateProject(projectDir);
  if (!cfg.ok || cfg.arima === undefined) {
    for (const e of cfg.errors) io.err(`${path.basename(e.file)}:${e.line}: ${e.message}\n`);
    return usage('refusing to run with an invalid config (run: arima-config validate)');
  }
  const github = (cfg.arima as unknown as { github: GithubCfg }).github;
  const env = deps.env ?? process.env;
  const token = github.machine_token_env ? env[github.machine_token_env] : undefined;

  try {
    if (command === 'push') {
      const need = ['branch', 'item', 'role', 'title', 'body-file', 'run-id'].filter(
        (k) => v[k] === undefined,
      );
      if (need.length > 0) return usage(`missing: ${need.map((k) => `--${k}`).join(', ')}`);
      const role = v['role'] as string;
      if (!isRole(role)) return usage(`--role "${role}" is not a role`);
      const type = v['type'];
      if (type !== undefined && !['story', 'bug', 'hotfix', 'chore'].includes(type))
        return usage('--type must be story, bug, hotfix or chore');
      const bodyFile = path.resolve(io.cwd, v['body-file'] as string);
      if (!existsSync(bodyFile)) return usage(`body file not found: ${bodyFile}`);
      let criteria: string[] | undefined;
      if (v['report'] !== undefined) {
        const rf = path.resolve(io.cwd, v['report']);
        if (!existsSync(rf)) return usage(`report not found: ${rf}`);
        const rep = JSON.parse(readFileSync(rf, 'utf8')) as {
          criteria_map?: { criterion: string }[];
        };
        criteria = (rep.criteria_map ?? []).map((c) => c.criterion);
      }
      const p = await publishBranch({
        projectDir,
        runId: v['run-id'] as string,
        branch: v['branch'] as string,
        item: v['item'] as string,
        role,
        title: v['title'] as string,
        body: readFileSync(bodyFile, 'utf8'),
        ...(criteria !== undefined ? { criteria } : {}),
        ...(v['ui'] !== undefined ? { ui: true } : {}),
        ...(type !== undefined ? { type: type as 'story' | 'bug' | 'hotfix' | 'chore' } : {}),
        repo: github.repo,
        defaultBranch: github.default_branch,
        stateBranch: github.state_branch,
        ...(github.allow_unchecked_remote === true ? { allowUncheckedRemote: true } : {}),
        ...(deps.remoteUrl !== undefined ? { remoteUrl: deps.remoteUrl } : {}),
        token,
        ...(deps.gh ? { gh: deps.gh } : {}),
      });
      io.out(`${JSON.stringify({ pr: p.pr, url: p.url, sha: p.sha, created: p.created })}\n`);
      return PUBLISH_EXIT.ok;
    }
    if (command === 'comment') {
      if (v['pr'] === undefined || v['report'] === undefined)
        return usage('missing: --pr and --report');
      const pr = Number(v['pr']);
      if (!Number.isInteger(pr) || pr < 1) return usage('--pr must be a pull request number');
      const file = path.resolve(io.cwd, v['report']);
      if (!existsSync(file)) return usage(`report not found: ${file}`);
      const report = JSON.parse(readFileSync(file, 'utf8')) as {
        role: string;
        item: string;
        findings?: ReviewFinding[];
        verdict?: { result: string; reasons: string[] };
      };
      if (!isRole(report.role)) return usage('the report has no valid role');
      const r = await postReview({
        projectDir,
        role: report.role,
        item: report.item,
        pr,
        repo: github.repo,
        findings: report.findings ?? [],
        verdict: report.verdict,
        token,
        ...(deps.gh ? { gh: deps.gh } : {}),
      });
      io.out(`${JSON.stringify(r)}\n`);
      return PUBLISH_EXIT.ok;
    }
    return usage('unknown command');
  } catch (e) {
    if (!(e instanceof PublishError)) throw e;
    io.err(`${e.message}\n`);
    return e.exitCode;
  }
}
