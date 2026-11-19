import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';

/**
 * The allow-list egress proxy of the sandbox (ADR-0006). It speaks HTTP CONNECT only (HTTPS
 * tunnels): a host on the allow-list is connected, everything else gets 403 and is logged. Plain
 * HTTP proxying is refused (405): the allowed services are all HTTPS. It runs inside a small
 * sidecar container that sits on both the run's `--internal` network and the outside network, so a
 * role container, which is on the internal network only, has no other way out.
 */

export function hostAllowed(host: string, allow: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allow.some((a) => {
    const p = a.toLowerCase();
    return p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p;
  });
}

export interface ProxyEvent {
  host: string;
  port: number;
  allowed: boolean;
}

export interface EgressProxy {
  port: number;
  close: () => Promise<void>;
}

export function startEgressProxy(
  allow: readonly string[],
  opts: { port?: number; host?: string; onRequest?: (e: ProxyEvent) => void } = {},
): Promise<EgressProxy> {
  const server = http.createServer((_req, res) => {
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('only CONNECT to an allowed host is supported\n');
  });
  server.on('connect', (req, client: Duplex, head) => {
    const m = /^(.+):(\d+)$/.exec(req.url ?? '');
    const host = m?.[1] ?? '';
    const port = Number(m?.[2] ?? 0);
    // Only the HTTPS port, and never a bare IP: an allow-list is names, and an IP would bypass it.
    const allowed = m !== null && port === 443 && !net.isIP(host) && hostAllowed(host, allow);
    opts.onRequest?.({ host, port, allowed });
    if (!allowed) {
      client.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n');
      return;
    }
    const upstream = net.connect(port, host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    const end = (): void => {
      upstream.destroy();
      client.destroy();
    };
    upstream.on('error', () => {
      if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n');
      end();
    });
    client.on('error', end);
    client.on('close', end);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        port: addr.port,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}
