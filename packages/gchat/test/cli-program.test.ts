import { describe, expect, it } from 'vitest';

import { createProgram } from '../src/cli/program.ts';

describe('gchat CLI program', () => {
  it('registers expected top-level commands', () => {
    const program = createProgram();
    const names = program.commands.map((c) => c.name());

    expect(names).toContain('auth');
    expect(names).toContain('spaces');
    expect(names).toContain('threads');
    expect(names).toContain('export');
    expect(names).toContain('stay-online');
    expect(names).toContain('api');
  });

  it('registers auth subcommands', () => {
    const program = createProgram();
    const auth = program.commands.find((c) => c.name() === 'auth');
    expect(auth).toBeTruthy();

    const subNames = (auth?.commands ?? []).map((c) => c.name());
    expect(subNames).toContain('status');
    expect(subNames).toContain('refresh');
  });
});

