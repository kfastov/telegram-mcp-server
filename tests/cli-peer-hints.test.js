// The negative-chat-id parser hint: a bare `-100...` value parses as a flag and
// trips commander's unknown-option error, which must carry the exact quoting
// workaround. The hook is installed once on the root program and shared with
// every subcommand by reference (commander's copyInheritedSettings).

import { describe, expect, it } from 'vitest';

import { buildProgram } from '../cli.js';

const NEGATIVE_ID = '-4701666782';

// exitOverride must be applied to every command: subcommands copy the exit
// callback at creation time, so setting it on the root after buildProgram()
// would not reach them.
function applyExitOverride(command) {
  command.exitOverride();
  for (const sub of command.commands) {
    applyExitOverride(sub);
  }
}

function parseCapturingErrors(args) {
  const program = buildProgram();
  applyExitOverride(program);
  let output = '';
  program.configureOutput({
    writeErr: (str) => {
      output += str;
    },
  });
  let thrown = null;
  try {
    program.parse(args, { from: 'user' });
  } catch (error) {
    thrown = error;
  }
  return { output, thrown };
}

describe('negative chat id parser hint', () => {
  it('appends the quoting workaround when a bare negative id parses as a flag', () => {
    const { output, thrown } = parseCapturingErrors(['messages', 'list', NEGATIVE_ID]);

    expect(thrown?.code).toBe('commander.unknownOption');
    expect(output).toContain(`error: unknown option '${NEGATIVE_ID}'`);
    expect(output).toContain(`--chat="${NEGATIVE_ID}"`);
    expect(output).toContain(`--chat=${NEGATIVE_ID}`);
  });

  it('leaves non-numeric unknown-option errors without the hint', () => {
    const { output, thrown } = parseCapturingErrors(['messages', 'list', '--definitely-not-an-option']);

    expect(thrown?.code).toBe('commander.unknownOption');
    expect(output).toContain("error: unknown option '--definitely-not-an-option'");
    expect(output).not.toContain('Negative chat ids');
  });

  it('fires on nested subcommands via the shared output configuration', () => {
    const { output, thrown } = parseCapturingErrors(['backfill', 'jobs', 'add', NEGATIVE_ID]);

    expect(thrown?.code).toBe('commander.unknownOption');
    expect(output).toContain(`--chat="${NEGATIVE_ID}"`);
  });
});
