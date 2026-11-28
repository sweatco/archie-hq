import { describe, it, expect } from 'vitest';
import {
  readSecret,
  runCommand,
  storeSecret,
  type CommandResult,
  type RunCommand,
} from './secrets.js';

interface Call {
  cmd: string;
  args: string[];
  stdin: string | undefined;
}

/**
 * A fake `security`: `add` through stdin stores, `find-generic-password` reads back.
 * Exit codes follow the real tool, checked on macOS: 0 on success, 44 for an absent item, and
 * non-zero from `-i` when the command it was fed fails.
 */
function fakeKeychain(options: { locked?: boolean } = {}) {
  const items = new Map<string, string>();
  const calls: Call[] = [];
  const run: RunCommand = (cmd, args, stdin) => {
    calls.push({ cmd, args, stdin });
    const result = (code: number, stdout = ''): Promise<CommandResult> =>
      Promise.resolve({ code, stdout, stderr: '' });
    if (args[0] === '-i') {
      const match = /^add-generic-password -U -s (\S+) -a (\S+) -w (\S+)\n$/.exec(stdin ?? '');
      if (!match || options.locked) return result(1);
      items.set(`${match[1]}/${match[2]}`, match[3]);
      return result(0);
    }
    const stored = items.get(`${args[2]}/${args[4]}`);
    return stored === undefined ? result(44) : result(0, `${stored}\n`);
  };
  return { run, calls, items };
}

describe('runCommand', () => {
  it('feeds stdin to the command and returns its output and exit code', async () => {
    await expect(runCommand('cat', [], 'from stdin')).resolves.toEqual({
      code: 0,
      stdout: 'from stdin',
      stderr: '',
    });
  });

  it('reports a command that cannot start as exit 127 instead of rejecting', async () => {
    const result = await runCommand('persona-tools-no-such-command', [], 'unread input');
    expect(result.code).toBe(127);
    expect(result.stderr).toContain('failed to spawn');
  });
});

describe('readSecret', () => {
  it('reads an env reference from the given environment', async () => {
    const { run, calls } = fakeKeychain();
    await expect(readSecret('env:TOKEN_A', { env: { TOKEN_A: 'value-a' }, run })).resolves.toBe(
      'value-a',
    );
    expect(calls).toHaveLength(0);
  });

  it('fails when the env variable is missing or empty', async () => {
    const { run } = fakeKeychain();
    await expect(readSecret('env:TOKEN_A', { env: { TOKEN_A: '' }, run })).rejects.toThrow(
      /not set in the environment/,
    );
  });

  it('asks the Keychain for the exact service and account', async () => {
    const keychain = fakeKeychain();
    keychain.items.set('archie-personas/staging/alice', 'value-alice');
    await expect(
      readSecret('keychain:archie-personas/staging/alice', { env: {}, run: keychain.run }),
    ).resolves.toBe('value-alice');
    expect(keychain.calls[0]).toMatchObject({
      cmd: 'security',
      args: ['find-generic-password', '-s', 'archie-personas', '-a', 'staging/alice', '-w'],
    });
  });

  it('fails without a value when the item is absent', async () => {
    const { run } = fakeKeychain();
    await expect(
      readSecret('keychain:archie-personas/staging/alice', { env: {}, run }),
    ).rejects.toThrow(/not in the Keychain/);
  });
});

describe('storeSecret in the Keychain', () => {
  const reference = 'keychain:archie-personas/staging/alice';

  it('sends the secret on stdin, never in the argument list', async () => {
    const keychain = fakeKeychain();
    await storeSecret(reference, 'xoxp-1-2-abc', keychain.run);
    expect(keychain.items.get('archie-personas/staging/alice')).toBe('xoxp-1-2-abc');
    for (const call of keychain.calls) expect(call.args.join(' ')).not.toContain('xoxp-1-2-abc');
    expect(keychain.calls[0].stdin).toContain('xoxp-1-2-abc');
  });

  it('fails when the Keychain refuses the write', async () => {
    const { run } = fakeKeychain({ locked: true });
    await expect(storeSecret(reference, 'xoxp-1-2-abc', run)).rejects.toThrow(
      /could not store .* \(security exited 1\)/,
    );
  });

  it('refuses values or names that the command line would split or interpret', async () => {
    const keychain = fakeKeychain();
    await expect(storeSecret(reference, 'abc def', keychain.run)).rejects.toThrow(
      /refusing to store/,
    );
    await expect(storeSecret('keychain:svc/acc"ount', 'abc', keychain.run)).rejects.toThrow(
      /use only/,
    );
    expect(keychain.calls).toHaveLength(0);
  });

  it('refuses to write an env reference', async () => {
    const { run } = fakeKeychain();
    await expect(storeSecret('env:TOKEN_A', 'abc', run)).rejects.toThrow(
      /only op:\/\/ and keychain: references are writable/,
    );
  });
});

interface FakeField {
  id: string;
  type: string;
  label: string;
  value?: string;
}

/**
 * A fake `op` holding one item. It follows the real CLI (2.41, checked live) where the code
 * depends on it: `item get` conceals values unless `--reveal` is passed, and `item edit` takes a
 * template from stdin only through a real pipe (`cat | op …`). Spawned directly, it ignores
 * stdin and still exits 0. Any assignment argument is applied after the template.
 */
function fakeOnePassword(options: { locked?: boolean } = {}) {
  const item = {
    id: 'item1',
    title: 'Archie Test Personas',
    fields: [
      { id: 'f1', type: 'CONCEALED', label: 'client-secret', value: 'app-secret' },
    ] as FakeField[],
  };
  const calls: Call[] = [];
  const run: RunCommand = (cmd, shellOrOpArgs, stdin) => {
    const throughPipe = cmd === 'sh' && shellOrOpArgs[1] === 'cat | "$@"';
    const args = throughPipe ? shellOrOpArgs.slice(4) : shellOrOpArgs;
    calls.push({ cmd, args, stdin });
    const result = (code: number, stdout = '', stderr = ''): Promise<CommandResult> =>
      Promise.resolve({ code, stdout, stderr });
    if (options.locked) return result(1, '', '[ERROR] 1Password is locked\nmore detail');
    const [command, verb, title] = args;
    if (command === 'read') {
      const label = (args.at(-1) ?? '').split('/').at(-1);
      const field = item.fields.find((candidate) => candidate.label === label);
      return field?.value ? result(0, field.value) : result(1, '', '[ERROR] no such field');
    }
    if (title !== item.title || !args.includes('Private')) return result(1, '', '[ERROR] no item');
    if (verb === 'get') {
      const fields = args.includes('--reveal')
        ? item.fields
        : item.fields.map(({ value: _concealed, ...rest }) => rest);
      return result(0, JSON.stringify({ ...item, fields }));
    }
    if (throughPipe && stdin) item.fields = (JSON.parse(stdin) as typeof item).fields;
    const assignment = /^([\w-]+)\[concealed\]=(.*)$/.exec(args.at(-1) ?? '');
    if (assignment) {
      item.fields.push({
        id: `f${item.fields.length + 1}`,
        type: 'CONCEALED',
        label: assignment[1],
        value: assignment[2],
      });
    }
    return result(0);
  };
  const valueOf = (label: string) => item.fields.find((field) => field.label === label)?.value;
  return { run, calls, valueOf };
}

describe('readSecret from 1Password', () => {
  it('hands the reference to op read unchanged', async () => {
    const vault = fakeOnePassword();
    const reference = 'op://Private/Archie Test Personas/client-secret';
    await expect(readSecret(reference, { env: {}, run: vault.run })).resolves.toBe('app-secret');
    expect(vault.calls).toEqual([
      { cmd: 'op', args: ['read', '--no-newline', reference], stdin: undefined },
    ]);
  });

  it("fails with op's own first line of explanation", async () => {
    const { run } = fakeOnePassword({ locked: true });
    await expect(
      readSecret('op://Private/Archie Test Personas/client-secret', { env: {}, run }),
    ).rejects.toThrow(
      'could not be read from 1Password (op exited 1: [ERROR] 1Password is locked)',
    );
  });
});

describe('storeSecret in 1Password', () => {
  const reference = 'op://Private/Archie Test Personas/alice';
  const secretInArguments = (calls: Call[], secret: string) =>
    calls.some((call) => call.args.join(' ').includes(secret));

  it('adds a missing field with a placeholder, then sends the secret on stdin only', async () => {
    const vault = fakeOnePassword();
    await storeSecret(reference, 'xoxp-1-2-abc', vault.run);
    expect(vault.valueOf('alice')).toBe('xoxp-1-2-abc');
    expect(secretInArguments(vault.calls, 'xoxp-1-2-abc')).toBe(false);
    expect(vault.calls.map((call) => call.args.slice(0, 2).join(' '))).toEqual([
      'item get',
      'item edit',
      'item get',
      'item edit',
    ]);
  });

  it('replaces an existing value without touching the other secrets of the item', async () => {
    const vault = fakeOnePassword();
    await storeSecret(reference, 'xoxp-first', vault.run);
    await storeSecret(reference, 'xoxp-second', vault.run);
    expect(vault.valueOf('alice')).toBe('xoxp-second');
    // Fails if the item were fetched without --reveal: its concealed values would be sent back empty.
    expect(vault.valueOf('client-secret')).toBe('app-secret');
  });

  it('refuses a section or a field name that op would interpret', async () => {
    const vault = fakeOnePassword();
    for (const unsupported of [
      'op://Private/Archie Test Personas/tokens/alice',
      'op://Private/Archie Test Personas/alice.token',
    ]) {
      await expect(storeSecret(unsupported, 'abc', vault.run)).rejects.toThrow(/no section/);
    }
    expect(vault.calls).toHaveLength(0);
  });

  it('fails when the item does not exist or 1Password is locked', async () => {
    await expect(
      storeSecret('op://Private/No Such Item/alice', 'abc', fakeOnePassword().run),
    ).rejects.toThrow(/item could not be read \(op exited 1: \[ERROR\] no item\)/);
    await expect(
      storeSecret(reference, 'abc', fakeOnePassword({ locked: true }).run),
    ).rejects.toThrow(/1Password is locked/);
  });
});
