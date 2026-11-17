/** Process-wide serialization per authority and vault. This lock is only one
 * layer of coordination: exclusive authority activation and durable replay
 * must be established before commands are admitted. */
const queues = new Map<string, Promise<void>>();
export async function serializeAuthority<T>(vaultScope: string, authorityId: string, operation: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([vaultScope, authorityId]);
  const prior = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>(resolve => { release = resolve; });
  const tail = prior.then(() => turn);
  queues.set(key, tail);
  await prior;
  try { return await operation(); }
  finally {
    release();
    if (queues.get(key) === tail) queues.delete(key);
  }
}
