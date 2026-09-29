let active = false;

export async function withReplayDate<T>(at: string, run: () => Promise<T>): Promise<T> {
  if (active) throw new Error('overlapping memory replays cannot share a clock');
  const actualDate = globalThis.Date;
  const fixedTime = actualDate.parse(at);
  if (!Number.isFinite(fixedTime)) throw new Error(`invalid replay completion time: ${at}`);
  active = true;
  // Keep Date.now() real so SDK timeouts and usage timing continue to work.
  globalThis.Date = new Proxy(actualDate, {
    apply: () => new actualDate(fixedTime).toString(),
    construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [fixedTime], newTarget),
  });
  try {
    return await run();
  } finally {
    globalThis.Date = actualDate;
    active = false;
  }
}
