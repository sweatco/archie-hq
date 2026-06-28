/**
 * Per-key async serialization.
 *
 * `createKeyedLock()` returns a `run(key, fn)` that guarantees calls sharing a
 * key execute one at a time, in arrival order; different keys are independent.
 * `fn` runs regardless of whether the previous op for that key resolved or
 * rejected (one failure never wedges the chain), and the returned promise
 * reflects `fn`'s own outcome. Map entries are dropped when a key's chain
 * drains, so the backing map stays bounded.
 *
 * Used to make a task's PR-card writes mutually exclusive across callers (a PM
 * turn-end resurface vs. an async webhook refresh) and across separate Task
 * instances loaded from disk.
 */
export function createKeyedLock() {
  const chains = new Map<string, Promise<void>>();
  return function run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = chains.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn); // run fn whatever the previous outcome
    const tracked = result.then(() => {}, () => {}); // never-rejecting chain link
    chains.set(key, tracked);
    void tracked.then(() => {
      // Drop the entry only if no later call has extended the chain.
      if (chains.get(key) === tracked) chains.delete(key);
    });
    return result;
  };
}
