// WP-213 step 7: the shared output contract spells out what real agents got wrong (found by the
// real-agent evals): question fields, the status rule for blocking questions, unknown keys.
import { describe, expect, it } from 'vitest';
import { outputContractFor, taskFor } from '../src/dispatch-units.js';
import { HARD_STOPS } from '../src/hardstops.js';

describe('output contract for a devops run', () => {
  const text = outputContractFor('deploy-staging');

  it('names the question fields hard_stop and default and every hard-stop id', () => {
    expect(text).toContain('hard_stop? (one of');
    expect(text).toContain('default?');
    for (const id of HARD_STOPS.filter((h) => !/^G\d$/i.test(h))) expect(text).toContain(id);
  });

  it('forbids status done while a question is blocking', () => {
    expect(text).toContain(
      'when any question has `blocking` true the status MUST be `needs_input` or `blocked`, never `done`',
    );
  });

  it('forbids keys other than the listed ones', () => {
    expect(text).toContain('Use exactly the keys listed for each object and no others');
  });

  it('the deploy-staging task is verify and diagnose', () => {
    expect(
      taskFor({ kind: 'deploy-staging', role: 'devops', item: 'none', why: 'x' } as never),
    ).toMatch(/verif/i);
  });
});
