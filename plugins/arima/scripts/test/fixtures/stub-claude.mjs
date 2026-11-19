// Stand-in for the `claude` CLI. Behaviour is chosen by STUB_MODE; what it was called with is
// written to STUB_RECORD so tests can assert on flags, env and prompt. No network, no cost.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const mode = process.env.STUB_MODE ?? 'success';
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const stdin = Buffer.concat(chunks).toString('utf8');

if (process.env.STUB_RECORD) {
  writeFileSync(
    process.env.STUB_RECORD,
    JSON.stringify({
      argv: process.argv.slice(2),
      stdin,
      cwd: process.cwd(),
      otel: process.env.OTEL_RESOURCE_ATTRIBUTES ?? null,
      hasNotionToken: process.env.ARIMA_NOTION_TOKEN !== undefined,
      hasGithubToken: process.env.ARIMA_GITHUB_TOKEN !== undefined,
    }),
  );
}

const base = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 1500,
  duration_api_ms: 1000,
  num_turns: 3,
  session_id: '55555555-5555-4555-8555-555555555555',
  total_cost_usd: 0.25,
  usage: {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 200,
    cache_creation_input_tokens: 10,
  },
};

switch (mode) {
  case 'success':
    base.result = 'done';
    console.log(JSON.stringify(base));
    break;
  case 'max_turns':
    console.log(JSON.stringify({ ...base, subtype: 'error_max_turns' }));
    break;
  case 'max_budget':
    console.log(
      JSON.stringify({
        ...base,
        subtype: 'error_max_budget_usd',
        is_error: true,
        total_cost_usd: 2,
      }),
    );
    break;
  case 'usage_limit':
    console.log(
      JSON.stringify({
        ...base,
        is_error: true,
        result: 'Claude usage limit reached. Your limit will reset at 7pm.',
        total_cost_usd: 0,
      }),
    );
    process.exitCode = 1;
    break;
  case 'usage_limit_text':
    console.error('You have hit your weekly limit');
    process.exitCode = 1;
    break;
  case 'garbage':
    console.log('this is not json');
    break;
  case 'crash':
    console.error('boom');
    process.exitCode = 9;
    break;
  case 'secret':
    console.log(JSON.stringify({ ...base, result: `leaked ntn_${'a'.repeat(30)}` }));
    break;
  case 'message': {
    // Final message from a file; __RUN_ID__ becomes this run's id (the wrapper sets ARIMA_RUN_ID).
    base.result = readFileSync(process.env.STUB_MESSAGE_FILE, 'utf8').replaceAll(
      '__RUN_ID__',
      process.env.ARIMA_RUN_ID ?? '',
    );
    console.log(JSON.stringify(base));
    break;
  }
  case 'sequence': {
    // Call n answers with step n of a JSON array [{message, cost?}]; the counter is a file.
    const steps = JSON.parse(readFileSync(process.env.STUB_SEQ_FILE, 'utf8'));
    let n;
    try {
      n = Number(readFileSync(process.env.STUB_SEQ_COUNTER, 'utf8'));
    } catch {
      n = 0;
    }
    writeFileSync(process.env.STUB_SEQ_COUNTER, String(n + 1));
    const step = steps[Math.min(n, steps.length - 1)];
    base.result = step.message.replaceAll('__RUN_ID__', process.env.ARIMA_RUN_ID ?? '');
    base.total_cost_usd = step.cost ?? 0.25;
    console.log(JSON.stringify(base));
    break;
  }
  case 'hang':
    setInterval(() => undefined, 1000);
    break;
  case 'hang_tree': {
    // Starts a grandchild that OUTLIVES a plain kill of this process. On Windows, libuv puts a
    // Node child into a job object that dies with its parent, so the grandchild must break away
    // (detached) or the test could never fail. On POSIX it stays in this process group, which is
    // what the wrapper kills.
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      detached: process.platform === 'win32',
      windowsHide: true,
    });
    grandchild.unref();
    writeFileSync(process.env.STUB_PIDFILE, String(grandchild.pid));
    setInterval(() => undefined, 1000);
    break;
  }
  case 'echo_resume':
    console.log(
      JSON.stringify({
        ...base,
        total_cost_usd: Number(readFileSync(process.env.STUB_COST_FILE, 'utf8')),
      }),
    );
    break;
  default:
    process.exitCode = 3;
}
