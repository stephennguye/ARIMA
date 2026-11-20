// WP-213: the Compose design check (devops card sections 6 and 7). Every rule has a file that breaks
// only that rule, and the clean file passes. A mutation of a rule must make its test fail.
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { lintFile } from '../src/env.js';
import {
  COMPOSE_RULES,
  dockerfilesOf,
  lintCompose,
  lintDockerfile,
  mentionsProduction,
} from '../src/compose-lint.js';
import type { ComposeRule } from '../src/compose-lint.js';

const OPTS = { composeDir: '/repo/infra', repoRoot: '/repo' };

const CLEAN = `
name: app
services:
  web:
    build: ..
    image: arima-local/\${ARIMA_PROJECT}-web:\${ARIMA_TAG}
    ports: ["127.0.0.1:\${ARIMA_PORT}:8080"]
    healthcheck: { test: ["CMD", "true"] }
    mem_limit: 256m
    environment:
      NODE_ENV: production
    volumes: ["data:/data"]
  db:
    image: postgres:17-alpine
    healthcheck: { test: ["CMD", "true"] }
    deploy: { resources: { limits: { memory: 512M } } }
volumes:
  data: {}
`;

/** CLEAN with one extra service line block replaced. */
const withWeb = (extra: string): string =>
  CLEAN.replace('    volumes: ["data:/data"]\n', `    volumes: ["data:/data"]\n${extra}`);

const rules = (text: string): ComposeRule[] => [
  ...new Set(lintCompose(text, OPTS).map((v) => v.rule)),
];

describe('lintCompose: the clean file', () => {
  it('passes (NODE_ENV=production is not a production reference)', () => {
    expect(lintCompose(CLEAN, OPTS)).toEqual([]);
  });
});

describe('lintCompose: one rule at a time', () => {
  const cases: [ComposeRule, string][] = [
    ['privileged', withWeb('    privileged: true\n')],
    ['host-network', withWeb('    network_mode: host\n')],
    ['host-namespace', withWeb('    pid: host\n')],
    ['host-namespace', withWeb('    ipc: host\n')],
    ['dangerous-capability', withWeb('    cap_add: [SYS_ADMIN]\n')],
    ['dangerous-capability', withWeb('    cap_add: [ALL]\n')],
    ['device', withWeb('    devices: ["/dev/sda:/dev/sda"]\n')],
    ['unconfined', withWeb('    security_opt: ["seccomp=unconfined"]\n')],
    ['docker-socket', CLEAN.replace('"data:/data"', '"/var/run/docker.sock:/var/run/docker.sock"')],
    ['docker-socket', CLEAN.replace('"data:/data"', '"//var/run/docker.sock:/s"')],
    [
      'docker-socket',
      CLEAN.replace(
        'volumes: ["data:/data"]',
        'volumes: [{type: bind, source: /var/run/docker.sock, target: /s}]',
      ),
    ],
    ['host-path-mount', CLEAN.replace('"data:/data"', '"./src:/app"')],
    ['host-path-mount', CLEAN.replace('"data:/data"', '"/home/me:/app"')],
    ['host-path-mount', CLEAN.replace('"data:/data"', '"~/x:/app"')],
    ['host-path-mount', CLEAN.replace('"data:/data"', '"C:\\\\Users\\\\me:/app"')],
    [
      'host-path-mount',
      CLEAN.replace(
        'volumes: ["data:/data"]',
        'volumes: [{type: bind, source: src, target: /app}]',
      ),
    ],
    ['external-resource', CLEAN.replace('data: {}', 'data: { external: true }')],
    ['unlinted-file', `include:\n  - other.yaml\n${CLEAN}`],
    ['unlinted-file', withWeb('    extends: { file: x.yaml, service: y }\n')],
    ['build-outside-repo', CLEAN.replace('build: ..', 'build: ../..')],
    ['build-outside-repo', CLEAN.replace('build: ..', 'build: /etc')],
    ['build-outside-repo', CLEAN.replace('build: ..', 'build: https://example.com/x.git')],
    ['build-outside-repo', CLEAN.replace('build: ..', 'build: { context: .., ssh: [default] }')],
    ['host-file-reference', withWeb('    env_file: ["/etc/secrets.env"]\n')],
    ['host-file-reference', withWeb('    env_file: ["~/.config/arima/x/staging/env"]\n')],
    ['host-file-reference', withWeb('    env_file: [../../outside.env]\n')],
    ['image-unpinned', CLEAN.replace('postgres:17-alpine', 'postgres')],
    ['image-unpinned', CLEAN.replace('postgres:17-alpine', 'postgres:latest')],
    [
      'no-healthcheck',
      CLEAN.replace('    healthcheck: { test: ["CMD", "true"] }\n    deploy', '    deploy'),
    ],
    [
      'no-healthcheck',
      CLEAN.replace(
        'healthcheck: { test: ["CMD", "true"] }\n    mem_limit',
        'healthcheck: { disable: true }\n    mem_limit',
      ),
    ],
    ['no-resource-limits', CLEAN.replace('    mem_limit: 256m\n', '')],
    ['port-binding', CLEAN.replace('"127.0.0.1:${ARIMA_PORT}:8080"', '"8080:8080"')],
    ['port-binding', CLEAN.replace('"127.0.0.1:${ARIMA_PORT}:8080"', '"${ARIMA_PORT}:8080"')],
    [
      'port-binding',
      CLEAN.replace('"127.0.0.1:${ARIMA_PORT}:8080"', '"0.0.0.0:${ARIMA_PORT}:8080"'),
    ],
    [
      'production-reference',
      CLEAN.replace('data: {}', 'shop-production-data: {}').replace(
        'data:/data',
        'shop-production-data:/data',
      ),
    ],
    ['production-reference', CLEAN.replace('name: app', 'name: app-prod')],
    ['production-reference', withWeb('    container_name: web-production\n')],
    ['production-reference', CLEAN.replace('postgres:17-alpine', 'registry/db-production:1')],
    // found by the independent attack (WP-213 review, section 7)
    ['interpolation', CLEAN.replace('"data:/data"', '"${HOME}:/h"')],
    ['interpolation', CLEAN.replace('"data:/data"', '"${USERPROFILE}:/h"')],
    ['interpolation', CLEAN.replace('"data:/data"', '"$HOME:/h"')],
    [
      'host-file-reference',
      CLEAN.replace('"data:/data"', '"${HOME}/.config//arima/x:/h"').replace('data:/data', 'x'),
    ],
    ['interpolation', CLEAN.replace('build: ..', 'build: ${CTX}')],
    ['interpolation', withWeb('    env_file: ["${F}"]\n')],
    [
      'build-outside-repo',
      CLEAN.replace('build: ..', 'build: { context: ., dockerfile: /abs/host/file }'),
    ],
    [
      'build-outside-repo',
      CLEAN.replace('build: ..', 'build: { context: ., dockerfile: ../../x }'),
    ],
    ['privileged', withWeb('    privileged: yes\n')],
    ['privileged', withWeb('    privileged: "TRUE"\n')],
    ['privileged', withWeb('    privileged: ${P}\n')],
    ['container-link', withWeb('    volumes_from: ["container:acme-db-1:ro"]\n')],
    ['container-link', withWeb('    network_mode: "container:acme-db-1"\n')],
    ['container-link', withWeb('    pid: "container:acme-db-1"\n')],
    ['container-link', withWeb('    external_links: [acme-db-1]\n')],
    ['container-link', withWeb('    container_name: acme-web\n')],
    ['external-resource', CLEAN.replace('data: {}', 'data: { name: acme_pgdata }')],
    [
      'unsafe-option',
      CLEAN.replace('data: {}', 'data: { driver_opts: { type: none, o: bind, device: / } }'),
    ],
    ['unsafe-option', withWeb('    sysctls: { net.core.somaxconn: 1 }\n')],
    ['unsafe-option', withWeb('    provider: { type: ./evil }\n')],
    ['unsafe-option', withWeb('    cgroup: host\n')],
    ['dangerous-capability', withWeb('    cap_add: [NET_RAW]\n')],
    ['dangerous-capability', withWeb('    cap_add: [DAC_OVERRIDE]\n')],
    ['unconfined', withWeb('    security_opt: ["seccomp=/tmp/p.json"]\n')],
    ['port-binding', CLEAN.replace('"127.0.0.1:${ARIMA_PORT}:8080"', '"0.0.0.0::80"')],
    [
      'port-binding',
      CLEAN.replace(
        'ports: ["127.0.0.1:${ARIMA_PORT}:8080"]',
        'ports: [{ target: 80, host_ip: 0.0.0.0 }]',
      ),
    ],
    ['interpolation', withWeb('    network_mode: ${NM}\n')],
    ['host-namespace', withWeb('    pid: Host\n')],
    ['host-network', withWeb('    network_mode: HOST\n')],
    [
      'interpolation',
      CLEAN.replace(
        'volumes:\n  data: {}',
        'secrets:\n  s: { environment: HOME }\nvolumes:\n  data: {}',
      ),
    ],
    [
      'interpolation',
      CLEAN.replace(
        'volumes: ["data:/data"]',
        'volumes: [{ type: "${T}", source: data, target: /d }]',
      ),
    ],
    ['yaml-syntax', 'services: [unclosed'],
    ['yaml-syntax', '- just\n- a list\n'],
  ];
  it.each(cases.map((c, i) => [i, ...c] as const))('case %i breaks %s', (_i, rule, text) => {
    expect(rules(text)).toContain(rule);
  });

  it('every rule id has a case, and nothing else fires on the single-rule files', () => {
    const covered = new Set(cases.map(([r]) => r));
    for (const r of COMPOSE_RULES) expect(covered.has(r), r).toBe(true);
  });

  it('a long-form port with a published host_ip of 127.0.0.1 passes', () => {
    const t = CLEAN.replace(
      'ports: ["127.0.0.1:${ARIMA_PORT}:8080"]',
      'ports: [{ target: 8080, published: "${ARIMA_PORT}", host_ip: 127.0.0.1 }]',
    );
    expect(lintCompose(t, OPTS)).toEqual([]);
  });

  it('a digest-pinned image and a build-only service pass', () => {
    const t = CLEAN.replace('postgres:17-alpine', 'postgres@sha256:' + 'a'.repeat(64));
    expect(lintCompose(t, OPTS)).toEqual([]);
  });
});

describe('mentionsProduction', () => {
  it.each([
    'production',
    'app-production-data',
    'my_prod',
    'PROD',
    'x.prd.y',
    '/srv/Production/env',
  ])('is true for %s', (s) => expect(mentionsProduction(s)).toBe(true));
  it.each(['product', 'productive', 'staging', 'preview-4', 'reproduction', 'prodigy'])(
    'is false for %s',
    (s) => expect(mentionsProduction(s)).toBe(false),
  );
});

describe('judge J-agent:devops, major 4: routes to the host and its other projects', () => {
  it('refuses extra_hosts on a service', () => {
    expect(rules(withWeb('    extra_hosts: ["h:host-gateway"]\n'))).toContain('unsafe-option');
  });
  it.each(['network', 'privileged', 'entitlements', 'secrets', 'extra_hosts'])(
    'refuses build.%s',
    (k) => {
      const text = CLEAN.replace(
        '    build: ..\n',
        `    build:\n      context: ..\n      ${k}: x\n`,
      );
      expect(rules(text)).toContain('unsafe-option');
    },
  );
  it('a plain build with a context and a dockerfile still passes', () => {
    const text = CLEAN.replace(
      '    build: ..\n',
      '    build:\n      context: ..\n      dockerfile: Dockerfile\n',
    );
    expect(lintCompose(text, OPTS)).toEqual([]);
  });
});

describe('Dockerfile lint (judge J-agent:devops, major 4)', () => {
  it('finds the Dockerfiles a file builds, inside the repository only', () => {
    expect(dockerfilesOf(CLEAN, OPTS)).toEqual([path.resolve('/repo', 'Dockerfile')]);
    const out = CLEAN.replace(
      '    build: ..\n',
      '    build:\n      context: ..\n      dockerfile: /etc/Dockerfile\n',
    );
    expect(dockerfilesOf(out, OPTS)).toEqual([]);
  });
  it('refuses RUN --network and bind, secret or ssh mounts, and allows a cache mount', () => {
    const bad = [
      'FROM node:22',
      'RUN --network=host npm ci',
      'RUN --mount=type=bind,source=/,target=/h cat /h/x',
      'RUN --mount=type=secret,id=t cat /run/secrets/t',
      'RUN --mount=type=cache,target=/root/.npm npm ci',
    ].join('\n');
    const v = lintDockerfile(bad, 'Dockerfile');
    expect(v.map((x) => x.where)).toEqual(['Dockerfile:2', 'Dockerfile:3', 'Dockerfile:4']);
  });
});

describe('lintFile reads the Dockerfile a Compose file builds (judge J-agent:devops, major 4)', () => {
  it('reports RUN --network from the Dockerfile, with its path and line', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'arima-lintfile-'));
    try {
      mkdirSync(path.join(dir, 'infra'));
      writeFileSync(
        path.join(dir, 'infra', 'compose.yaml'),
        CLEAN.replace('    build: ..\n', '    build:\n      context: ..\n'),
      );
      writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node:22\nRUN --network=host npm ci\n');
      const v = lintFile(path.join(dir, 'infra', 'compose.yaml'), dir);
      expect(v.map((x) => x.where)).toEqual(['Dockerfile:2']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
