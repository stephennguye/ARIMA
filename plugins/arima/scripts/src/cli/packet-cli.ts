import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { writeFileAtomic } from '../lib/atomic-file.js';
import { PacketError, renderPacket, validatePacket } from '../packet.js';
import type { PacketInput } from '../packet.js';
import type { Io } from './config-cli.js';

export const PACKET_EXIT = { ok: 0, usage: 2, invalid: 20 } as const;

export const PACKET_USAGE = `Usage: arima-packet render --spec <packet-input.json> [--out <packet.md>]
       arima-packet validate <packet.md>
Exit codes: 0 ok, 2 usage, 20 packet invalid`;

/** `arima-packet`: renders and validates the run packet of 03-contracts 3.2. */
export function runPacketCli(argv: string[], io: Io): number {
  const [command, ...rest] = argv;
  let parsed: { values: { spec?: string; out?: string }; positionals: string[] };
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { spec: { type: 'string' }, out: { type: 'string' } },
    });
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n${PACKET_USAGE}\n`);
    return PACKET_EXIT.usage;
  }
  const abs = (p: string): string => path.resolve(io.cwd, p);

  if (command === 'render' && parsed.values.spec !== undefined && parsed.positionals.length === 0) {
    const specFile = abs(parsed.values.spec);
    if (!existsSync(specFile)) {
      io.err(`spec file not found: ${specFile}\n`);
      return PACKET_EXIT.usage;
    }
    let spec: PacketInput;
    try {
      spec = JSON.parse(readFileSync(specFile, 'utf8')) as PacketInput;
    } catch {
      io.err(`${specFile} is not valid JSON\n`);
      return PACKET_EXIT.usage;
    }
    try {
      const text = renderPacket(spec);
      if (parsed.values.out !== undefined) writeFileAtomic(abs(parsed.values.out), text);
      else io.out(text.endsWith('\n') ? text : `${text}\n`);
      return PACKET_EXIT.ok;
    } catch (e) {
      if (!(e instanceof PacketError)) throw e;
      io.err(`packet invalid: ${e.message}\n`);
      return PACKET_EXIT.invalid;
    }
  }

  if (
    command === 'validate' &&
    parsed.positionals.length === 1 &&
    parsed.values.spec === undefined
  ) {
    const file = abs(parsed.positionals[0] as string);
    if (!existsSync(file)) {
      io.err(`packet file not found: ${file}\n`);
      return PACKET_EXIT.usage;
    }
    const r = validatePacket(readFileSync(file, 'utf8'));
    if (r.ok) {
      io.out('packet ok\n');
      return PACKET_EXIT.ok;
    }
    for (const e of r.errors) io.err(`${e}\n`);
    return PACKET_EXIT.invalid;
  }

  io.err(`${PACKET_USAGE}\n`);
  return PACKET_EXIT.usage;
}
