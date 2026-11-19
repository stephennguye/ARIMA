import { EGRESS_ALLOW_DEFAULT } from '../sandbox.js';
import { startEgressProxy } from '../egress-proxy.js';

// Runs inside the sandbox sidecar container: arima-egress-proxy [--allow a,b] [--port 3128] [--host 0.0.0.0]
const args = process.argv.slice(2);
const val = (n: string): string | undefined => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const port = Number(val('--port') ?? 3128);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write(
    'usage: arima-egress-proxy [--allow a,b] [--port 3128] [--host 0.0.0.0]' +
      String.fromCharCode(10),
  );
  process.exit(2);
}
const allow = (val('--allow') ?? '').split(',').filter(Boolean);
const proxy = await startEgressProxy(allow.length > 0 ? allow : EGRESS_ALLOW_DEFAULT, {
  port,
  host: val('--host') ?? '127.0.0.1',
  onRequest: (e) => process.stderr.write(`${e.allowed ? 'allow' : 'DENY'} ${e.host}:${e.port}\n`),
});
process.stderr.write(`egress proxy listening on ${proxy.port}\n`);
const stop = (): void => void proxy.close().then(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
