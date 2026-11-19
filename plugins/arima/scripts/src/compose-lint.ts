import path from 'node:path';
import { parse } from 'yaml';

/**
 * Lint for the Compose files the devops role writes (devops card sections 6 and 7, D-47). Two jobs:
 * keep the design portable to K3s or K8s, and keep a staging or preview file from reaching the host
 * or the production project. `arima-env check` runs it; `arima-env up` refuses a file that fails.
 */

export interface Violation {
  rule: ComposeRule;
  where: string;
  detail: string;
}

export const COMPOSE_RULES = [
  'yaml-syntax',
  'privileged',
  'host-network',
  'host-namespace',
  'dangerous-capability',
  'device',
  'unconfined',
  'docker-socket',
  'host-path-mount',
  'external-resource',
  'unlinted-file',
  'build-outside-repo',
  'host-file-reference',
  'image-unpinned',
  'no-healthcheck',
  'no-resource-limits',
  'port-binding',
  'production-reference',
  'interpolation',
  'container-link',
  'unsafe-option',
] as const;
export type ComposeRule = (typeof COMPOSE_RULES)[number];

/** The only capabilities a service may add; anything else is refused. */
const SAFE_CAPS = new Set(['NET_BIND_SERVICE', 'CHOWN', 'SETUID', 'SETGID', 'KILL']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

/** A name or path that points at production: a token `production`, `prod` or `prd`. */
export function mentionsProduction(text: string): boolean {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((t) => t === 'production' || t === 'prod' || t === 'prd');
}

const HOST_PATH = /^(?:[/\\.~]|[A-Za-z]:[/\\]|\\\\)/;
const isHostPath = (s: string): boolean => HOST_PATH.test(s);
const SOCKET = /docker\.sock|docker_engine|[\\/]var[\\/]run[\\/]docker/i;
const ARIMA_HOME = /\.config[/\\]+arima/i;

/** Interpolations other than exactly ${ARIMA_*}: they read the host environment (HOME, USERPROFILE...). */
export function badInterpolations(text: string): string[] {
  const t = text.replace(/\$\$/g, '');
  return [...t.matchAll(/\$(\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)/g)]
    .map((m) => m[0])
    .filter((x) => !/^\$\{ARIMA_[A-Z_]+\}$/.test(x));
}

/** True when `p`, resolved against `baseDir`, stays inside `repoRoot`. Remote URLs never do. */
function insideRepo(p: string, baseDir: string, repoRoot: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) || /^git@/i.test(p) || p.startsWith('~')) return false;
  const abs = path.resolve(baseDir, p);
  const rel = path.relative(path.resolve(repoRoot), abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface LintOptions {
  /** The directory the Compose file lives in (relative paths in it resolve against this). */
  composeDir: string;
  /** The repository root: build contexts and env files must stay inside it. */
  repoRoot: string;
}

function lineOf(e: unknown): string {
  const l = (e as { linePos?: { line?: number }[] }).linePos?.[0]?.line;
  return typeof l === 'number' ? ` at line ${l}` : '';
}

export function lintCompose(text: string, o: LintOptions): Violation[] {
  const out: Violation[] = [];
  const add = (rule: ComposeRule, where: string, detail: string): void => {
    out.push({ rule, where, detail });
  };
  let doc: unknown;
  try {
    doc = parse(text, { merge: true });
  } catch (e) {
    return [
      {
        rule: 'yaml-syntax',
        where: 'file',
        detail: `not valid YAML${lineOf(e)} (the parser excerpt is withheld: it may quote file content)`,
      },
    ];
  }
  if (!isObj(doc)) return [{ rule: 'yaml-syntax', where: 'file', detail: 'not a mapping' }];

  const ident = (where: string, value: unknown): void => {
    if (typeof value !== 'string') return;
    const bad = badInterpolations(value);
    if (bad.length > 0)
      add(
        'interpolation',
        where,
        `reads the host environment: ${bad.join(' ')}; only \${ARIMA_*} is allowed`,
      );
    if (mentionsProduction(value)) add('production-reference', where, `names production: ${value}`);
    if (ARIMA_HOME.test(value))
      add('host-file-reference', where, `reaches ~/.config/arima: ${value}`);
  };
  const hostFile = (where: string, p: unknown): void => {
    if (typeof p !== 'string') return;
    ident(where, p);
    if (!insideRepo(p, o.composeDir, o.repoRoot))
      add('host-file-reference', where, `points outside the repository: ${p}`);
  };

  // Every string except where a value only reaches the container's own process: a host variable
  // read into a path, a type or a name is a way out of the project.
  const QUIET = new Set(['environment', 'command', 'entrypoint', 'labels', 'healthcheck', 'args']);
  const walk = (node: unknown, where: string): void => {
    if (typeof node === 'string') {
      const bad = badInterpolations(node);
      if (bad.length > 0)
        add('interpolation', where, `reads the host environment: ${bad.join(' ')}`);
    } else if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${where}[${i}]`));
    else if (isObj(node))
      for (const [k, v] of Object.entries(node)) if (!QUIET.has(k)) walk(v, `${where}.${k}`);
  };
  walk(doc, '');
  if ('include' in doc)
    add('unlinted-file', 'include', 'include pulls in files that are not linted');
  ident('name', doc['name']);

  for (const kind of ['volumes', 'networks', 'secrets', 'configs'] as const) {
    const top = doc[kind];
    if (!isObj(top)) continue;
    for (const [k, v] of Object.entries(top)) {
      const where = `${kind}.${k}`;
      ident(where, k);
      if (!isObj(v)) continue;
      ident(`${where}.name`, v['name']);
      if (typeof v['name'] === 'string' && !v['name'].startsWith('${ARIMA_PROJECT}'))
        add(
          'external-resource',
          `${where}.name`,
          'an explicit name must start with ${ARIMA_PROJECT}',
        );
      if (v['driver_opts'] !== undefined || v['driver'] !== undefined)
        add(
          'unsafe-option',
          `${where}.driver`,
          'volume drivers and driver_opts can bind host paths',
        );
      if (v['external'] !== undefined && v['external'] !== false)
        add('external-resource', where, 'external resources are not owned by this project');
      if (kind === 'secrets' || kind === 'configs') {
        hostFile(`${where}.file`, v['file']);
        if (v['environment'] !== undefined)
          add(
            'interpolation',
            `${where}.environment`,
            'reads a host environment variable into the container',
          );
      }
    }
  }

  const services = isObj(doc['services']) ? doc['services'] : {};
  for (const [name, raw] of Object.entries(services)) {
    if (!isObj(raw)) continue;
    const s = raw;
    const at = (f: string): string => `services.${name}.${f}`;
    ident(at('container_name'), s['container_name']);
    if (
      typeof s['container_name'] === 'string' &&
      !s['container_name'].startsWith('${ARIMA_PROJECT}')
    )
      add(
        'container-link',
        at('container_name'),
        'container_name must start with ${ARIMA_PROJECT}',
      );
    ident(at('image'), s['image']);

    // Anything but a literal false is refused: Compose reads yes, "TRUE" and ${VAR} as true.
    if (s['privileged'] !== undefined && s['privileged'] !== false)
      add('privileged', at('privileged'), 'privileged containers are not allowed');
    if (String(s['network_mode']).trim().toLowerCase() === 'host')
      add('host-network', at('network_mode'), 'host network');
    for (const k of ['network_mode', 'pid', 'ipc'])
      if (typeof s[k] === 'string' && /^container:/i.test(s[k].trim()))
        add('container-link', at(k), `${k} joins another container: ${s[k]}`);
    for (const k of ['pid', 'ipc', 'uts', 'userns_mode'])
      if (String(s[k]).trim().toLowerCase() === 'host') add('host-namespace', at(k), `${k}: host`);
    for (const k of ['volumes_from', 'external_links'])
      if (asList(s[k]).length > 0)
        add('container-link', at(k), `${k} reaches containers of other projects`);
    for (const k of [
      'cgroup',
      'cgroup_parent',
      'sysctls',
      'device_cgroup_rules',
      'provider',
      'runtime',
    ])
      if (s[k] !== undefined) add('unsafe-option', at(k), `${k} is not allowed`);
    for (const c of asList(s['cap_add']))
      if (!SAFE_CAPS.has(String(c).toUpperCase().replace(/^CAP_/, '')))
        add('dangerous-capability', at('cap_add'), String(c));
    if (asList(s['devices']).length > 0)
      add('device', at('devices'), 'host devices are not allowed');
    for (const o2 of asList(s['security_opt']))
      if (/unconfined|seccomp=|apparmor=|label[:=]disable/i.test(String(o2)))
        add('unconfined', at('security_opt'), String(o2));
    if ('extends' in s)
      add('unlinted-file', at('extends'), 'extends pulls in files that are not linted');

    // Volumes: named only, never the socket, never a host path.
    for (const v of asList(s['volumes'])) {
      let source: string | undefined;
      let bind = false;
      if (typeof v === 'string') {
        const first = v.split(':')[0] ?? '';
        source = /^[A-Za-z]$/.test(first) ? v.slice(0, 3) : first; // C:\path
        bind = isHostPath(source);
        if (SOCKET.test(v)) add('docker-socket', at('volumes'), v);
      } else if (isObj(v)) {
        source = typeof v['source'] === 'string' ? v['source'] : undefined;
        bind = v['type'] === 'bind' || (source !== undefined && isHostPath(source));
        if (source !== undefined && SOCKET.test(source))
          add('docker-socket', at('volumes'), source);
      }
      if (bind) add('host-path-mount', at('volumes'), `host path ${String(source)}`);
      else if (source !== undefined) ident(at('volumes'), source);
    }

    // Build: stays inside the repository; no host ssh agent or secrets pulled into the build.
    const b = s['build'];
    const ctx = typeof b === 'string' ? b : isObj(b) ? b['context'] : undefined;
    if (typeof ctx === 'string' && !insideRepo(ctx, o.composeDir, o.repoRoot))
      add('build-outside-repo', at('build.context'), `context ${ctx}`);
    if (typeof ctx === 'string') ident(at('build.context'), ctx);
    if (isObj(b) && typeof b['dockerfile'] === 'string') {
      ident(at('build.dockerfile'), b['dockerfile']);
      const base = typeof ctx === 'string' ? path.resolve(o.composeDir, ctx) : o.composeDir;
      if (path.isAbsolute(b['dockerfile']) || !insideRepo(b['dockerfile'], base, o.repoRoot))
        add('build-outside-repo', at('build.dockerfile'), `dockerfile ${b['dockerfile']}`);
    }
    if (isObj(b)) {
      if (b['ssh'] !== undefined)
        add('build-outside-repo', at('build.ssh'), 'ssh agent forwarding');
      if (isObj(b['additional_contexts']))
        for (const [k, v] of Object.entries(b['additional_contexts']))
          if (typeof v === 'string') {
            ident(at(`build.additional_contexts.${k}`), v);
            if (!insideRepo(v, o.composeDir, o.repoRoot))
              add('build-outside-repo', at(`build.additional_contexts.${k}`), v);
          }
    }

    for (const f of asList(s['env_file'])) hostFile(at('env_file'), isObj(f) ? f['path'] : f);

    // Image: pinned tag or digest, or a tag set by interpolation.
    if (typeof s['image'] === 'string') {
      const img = s['image'];
      const last = img.split('/').pop() ?? img;
      const tag = last.includes('@') ? 'digest' : last.includes(':') ? last.split(':').pop() : '';
      if (tag === '' || tag === 'latest')
        add('image-unpinned', at('image'), `${img} has no pinned tag`);
    }

    const hc = s['healthcheck'];
    if (!isObj(hc) || hc['disable'] === true)
      add('no-healthcheck', at('healthcheck'), 'every service needs a health check');

    const deploy = isObj(s['deploy']) ? s['deploy'] : {};
    const res = isObj(deploy['resources']) ? deploy['resources'] : {};
    const limits = isObj(res['limits']) ? res['limits'] : {};
    if (s['mem_limit'] === undefined && limits['memory'] === undefined)
      add('no-resource-limits', at('deploy.resources.limits'), 'set a memory limit');

    // Ports: host port by interpolation (free port per environment), bound to loopback.
    for (const p of asList(s['ports'])) {
      let host: string | undefined;
      let ip: string | undefined;
      if (typeof p === 'string') {
        const parts = p.split(':');
        if (parts.length === 2) host = parts[0];
        else if (parts.length >= 3) {
          ip = parts.slice(0, -2).join(':');
          host = parts[parts.length - 2];
        }
      } else if (isObj(p)) {
        host = p['published'] === undefined ? undefined : String(p['published']);
        ip = typeof p['host_ip'] === 'string' ? p['host_ip'] : undefined;
      } else if (typeof p === 'number') {
        continue; // container port only: Docker picks the host port
      }
      if (host !== undefined && host !== '' && !host.includes('${'))
        add('port-binding', at('ports'), `fixed host port ${host}; use \${ARIMA_PORT}`);
      const loop = ip !== undefined && /^(127\.0\.0\.1|\[?::1\]?|localhost)$/.test(ip);
      const publishes = (host !== undefined && host !== '') || ip !== undefined;
      if (publishes && !loop) add('port-binding', at('ports'), 'publish on 127.0.0.1 only');
    }
  }
  return out;
}
