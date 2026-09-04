import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

let tempRoot: string;
const originalMemoryFlag = process.env.ARCHIE_MEMORY;

const { onEventMock, readPendingMock, linkMock } = vi.hoisted(() => ({
  onEventMock: vi.fn(),
  readPendingMock: vi.fn(),
  linkMock: vi.fn(),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  linkMock.mockImplementation(async (from, to) => {
    const { dirname } = await import('path');
    if (dirname(String(from)) !== dirname(String(to))) {
      const error = new Error('cross-device link not permitted') as NodeJS.ErrnoException;
      error.code = 'EXDEV';
      throw error;
    }
    return actual.link(from, to);
  });
  return { ...actual, link: linkMock };
});

vi.mock('../../system/workdir.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../system/workdir.js')>()),
  WORKDIR: tempRoot,
}));

vi.mock('../../system/event-bus.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../system/event-bus.js')>()),
  onEvent: onEventMock,
}));

vi.mock('../lifecycle.js', () => ({
  handleTaskCompleted: vi.fn(),
  rescheduleTaskCompleted: vi.fn(),
}));

vi.mock('../pending-queue.js', () => ({
  readPending: readPendingMock,
}));

vi.mock('../../system/logger.js', () => ({
  logger: {
    system: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn(),
  },
}));

async function loadMemory() {
  vi.resetModules();
  return import('../index.js');
}

describe('scoped memory initialization', () => {
  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'archie-memory-init-'));
  });

  beforeEach(async () => {
    await rm(join(tempRoot, 'memory'), { recursive: true, force: true });
    delete process.env.ARCHIE_MEMORY;
    vi.clearAllMocks();
    readPendingMock.mockResolvedValue([]);
  });

  afterAll(async () => {
    if (originalMemoryFlag === undefined) delete process.env.ARCHIE_MEMORY;
    else process.env.ARCHIE_MEMORY = originalMemoryFlag;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('creates and binds an empty store to the authenticated workspace', async () => {
    const memory = await loadMemory();

    await expect(memory.initMemory('TWORKSPACE')).resolves.toBe(true);

    const marker = JSON.parse(await readFile(join(tempRoot, 'memory', '.scoped-v1.json'), 'utf-8'));
    expect(marker).toEqual({ version: 1, team_id: 'TWORKSPACE' });
    expect(linkMock).toHaveBeenCalledTimes(1);
    const [[from, to]] = linkMock.mock.calls;
    expect(dirname(String(from))).toBe(join(tempRoot, 'memory'));
    expect(String(from)).toMatch(/\.scoped-v1\.json\.\d+\.[0-9a-f-]{36}\.tmp$/);
    expect(to).toBe(join(tempRoot, 'memory', '.scoped-v1.json'));
    expect((await readdir(join(tempRoot, 'memory'))).some((entry) => /\.tmp$/.test(entry))).toBe(false);
    await expect(readdir(join(tempRoot, 'memory'))).resolves.toEqual(
      expect.arrayContaining(['.scoped-v1.json', 'public', 'private', 'runtime']),
    );
    await expect(readdir(join(tempRoot, 'memory', 'private'))).resolves.toEqual(
      expect.arrayContaining(['channels', 'users']),
    );
    expect(memory.isMemoryReady()).toBe(true);
    expect(onEventMock).toHaveBeenCalledTimes(1);
  });

  it('accepts an existing marker for the same workspace', async () => {
    const memoryDir = join(tempRoot, 'memory');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(
      join(memoryDir, '.scoped-v1.json'),
      JSON.stringify({ version: 1, team_id: 'TWORKSPACE' }),
    );
    const memory = await loadMemory();

    await expect(memory.initMemory('TWORKSPACE')).resolves.toBe(true);
    expect(memory.isMemoryReady()).toBe(true);
  });

  it('rereads and validates the winner when exclusive publication loses a race', async () => {
    const memoryDir = join(tempRoot, 'memory');
    linkMock.mockImplementationOnce(async (_from, to) => {
      await writeFile(String(to), JSON.stringify({ version: 1, team_id: 'TWORKSPACE' }));
      const error = new Error('already exists') as NodeJS.ErrnoException;
      error.code = 'EEXIST';
      throw error;
    });
    const memory = await loadMemory();

    await expect(memory.initMemory('TWORKSPACE')).resolves.toBe(true);
    await expect(readdir(memoryDir)).resolves.not.toEqual(expect.arrayContaining([
      expect.stringMatching(new RegExp(`^\\.scoped-v1\\.json\\.${process.pid}\\..+\\.tmp$`)),
    ]));
  });

  it('removes an exact stale crashed marker temp before initializing', async () => {
    const memoryDir = join(tempRoot, 'memory');
    await mkdir(memoryDir, { recursive: true });
    const stale = join(memoryDir, '.scoped-v1.json.123.tmp');
    await writeFile(stale, 'partial');
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(stale, old, old);
    const memory = await loadMemory();

    await expect(memory.initMemory('TWORKSPACE')).resolves.toBe(true);
    await expect(readdir(memoryDir)).resolves.not.toContain('.scoped-v1.json.123.tmp');
  });

  it('does not delete a fresh overlapping initializer temp', async () => {
    const memoryDir = join(tempRoot, 'memory');
    await mkdir(memoryDir, { recursive: true });
    const fresh = '.scoped-v1.json.456.123e4567-e89b-12d3-a456-426614174000.tmp';
    await writeFile(join(memoryDir, fresh), 'in flight');
    const memory = await loadMemory();

    await expect(memory.initMemory('TWORKSPACE')).resolves.toBe(true);
    await expect(readFile(join(memoryDir, fresh), 'utf-8')).resolves.toBe('in flight');
  });

  it('wipes a near-match marker temp name as part of an unmarked store reset', async () => {
    const memoryDir = join(tempRoot, 'memory');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(join(memoryDir, '.scoped-v1.json.123.tmp.bak'), 'keep');
    const memory = await loadMemory();

    await expect(memory.initMemory('TWORKSPACE')).resolves.toBe(true);
    await expect(readFile(join(memoryDir, '.scoped-v1.json.123.tmp.bak'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed on workspace mismatch without changing existing data', async () => {
    const memoryDir = join(tempRoot, 'memory');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(join(memoryDir, '.scoped-v1.json'), JSON.stringify({ version: 1, team_id: 'TOTHER' }));
    await writeFile(join(memoryDir, 'keep.txt'), 'untouched');
    const memory = await loadMemory();

    await expect(memory.initMemory('TWORKSPACE')).resolves.toBe(false);
    await expect(readFile(join(memoryDir, 'keep.txt'), 'utf-8')).resolves.toBe('untouched');
    expect(memory.isMemoryReady()).toBe(false);
    expect(onEventMock).not.toHaveBeenCalled();
  });

  it('wipes and initializes a non-empty unmarked legacy store', async () => {
    const memoryDir = join(tempRoot, 'memory');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(join(memoryDir, 'legacy.md'), 'old memory');
    const memory = await loadMemory();

    await expect(memory.initMemory('TWORKSPACE')).resolves.toBe(true);
    await expect(readFile(join(memoryDir, 'legacy.md'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(memoryDir, '.scoped-v1.json'), 'utf-8')).resolves.toContain('TWORKSPACE');
    expect(memory.isMemoryReady()).toBe(true);
    expect(onEventMock).toHaveBeenCalledTimes(1);
  });

  it('does not initialize without an authenticated workspace', async () => {
    const memory = await loadMemory();

    await expect(memory.initMemory(null)).resolves.toBe(false);
    await expect(readdir(tempRoot)).resolves.toEqual([]);
    expect(memory.isMemoryReady()).toBe(false);
  });

  it('registers the completion listener once across repeated calls', async () => {
    const memory = await loadMemory();

    await memory.initMemory('TWORKSPACE');
    await memory.initMemory('TWORKSPACE');

    expect(onEventMock).toHaveBeenCalledTimes(1);
  });
});
