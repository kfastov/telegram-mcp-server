// CLI-boundary hints for negative chat ids: the parser hook appends the exact
// quoting workaround when a bare `-100...` value trips commander's
// unknown-option error (the hook is installed once on the root program and
// shared with every subcommand by reference, via commander's
// copyInheritedSettings), and writeError restates the client layer's neutral
// sign-retry suggestion in --chat flag syntax.

import { describe, expect, it, vi } from 'vitest';

import { buildProgram, writeError } from '../cli.js';
import { PEER_SIGN_RETRY_PATTERN } from '../core/peer-hints.js';
import { SendCommandError } from '../core/send-utils.js';

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

describe('peer resolution sign-retry hint at the writeError boundary', () => {
  function captureStderr(fn) {
    const writes = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((str) => {
      writes.push(String(str));
      return true;
    });
    try {
      fn();
    } finally {
      spy.mockRestore();
    }
    return writes.join('');
  }

  it('restates the client layer\'s neutral suggestion in --chat flag syntax', () => {
    const error = new Error(
      'Peer 4701666782 is not found in local cache — group and channel ids are '
      + `negative — retry with the negative id "${NEGATIVE_ID}"`,
    );

    const output = captureStderr(() => writeError(error, false));

    expect(PEER_SIGN_RETRY_PATTERN.test(error.message)).toBe(true);
    expect(output).toContain(error.message);
    expect(output).toContain(`--chat="${NEGATIVE_ID}"`);
    expect(output).toContain(`--chat=${NEGATIVE_ID}`);
  });

  it('leaves unrelated errors without the flag hint', () => {
    const output = captureStderr(() => writeError(new Error('connection lost'), false));

    expect(output).toBe('connection lost\n');
  });

  it('restates the suggestion for send failures that carry it in details', () => {
    const error = new SendCommandError({
      type: 'telegram',
      method: 'sendText',
      message: 'Peer 4701666782 is not found in local cache — group and channel ids are '
        + `negative — retry with the negative id "${NEGATIVE_ID}"`,
      attempt: 1,
      retries: 0,
      retryable: false,
    });

    const output = captureStderr(() => writeError(error, false));

    expect(output).toContain('sendText failed [telegram]');
    expect(output).toContain(`--chat="${NEGATIVE_ID}"`);
  });

  it('keeps JSON error output machine-readable, without the appended hint', () => {
    const error = new Error(`retry with the negative id "${NEGATIVE_ID}"`);

    const output = captureStderr(() => writeError(error, true));

    expect(JSON.parse(output)).toEqual({ ok: false, error: error.message });
  });
});
