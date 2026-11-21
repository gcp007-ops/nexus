/** Desktop-only durability boundary. No legacy writer is used or advertised as
 * fsync-capable. The lock is never stolen by expiry. A lock left by a quit or a
 * crash is recovered only when its owner is provably gone: same host and a dead
 * PID, or a live PID whose start instant differs (PID reuse). Any doubt keeps
 * the refusal. */
import { desktopRequire } from '../../utils/desktopRequire';
import type { AuthorityJournal, AuthorityJournalEvent } from '../repositories/interfaces/ITaskCoordinationRepository';
import { decodeAuthorityJournal } from './TaskAuthorityJournalReader';
import { canonicalJson } from '../../agents/taskManager/authority/TaskAuthorityPlanning';
const OWNER_PROTOCOL = 'task-authority-owner/v1';
/** What the lock recovery needs to know about processes. Injected in tests. */
export interface LockProcessProbe {
  hostname(): string;
  /** true alive, false provably gone, null unknown. */
  alive(pid: number): boolean | null;
  /** Start instant of a live process, comparable with the one recorded in the lock; null when unreadable. */
  startTime(pid: number): Promise<string | null>;
}
export const nodeProcessProbe: LockProcessProbe = {
  hostname: () => desktopRequire<typeof import('node:os')>('node:os').hostname(),
  alive: pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { const code = (error as NodeJS.ErrnoException).code; return code === 'ESRCH' ? false : code === 'EPERM' ? true : null; }
  },
  startTime: pid => new Promise(resolve => {
    if (process.platform === 'win32') { resolve(null); return; }
    try {
      desktopRequire<typeof import('node:child_process')>('node:child_process').execFile('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 2000, env: { LC_ALL: 'C', TZ: 'UTC' } },
        (error, stdout) => resolve(error ? null : (String(stdout).trim() || null)));
    } catch { resolve(null); }
  })
};
function authorityUnavailable(): Error { return new Error('authority_unavailable'); }
export class TaskAuthorityDurableJournal implements AuthorityJournal {
  private token: string | null = null;
  private storageLockPath():string { const path=desktopRequire<typeof import('node:path')>('node:path'); return path.join(path.dirname(path.dirname(this.directory)),'task-authority-writer.lock'); }
  constructor(private readonly directory: string, private readonly probe: LockProcessProbe = nodeProcessProbe) {}
  private async ownerRecord(token: string): Promise<string> {
    return JSON.stringify({ protocol: OWNER_PROTOCOL, token, pid: process.pid, hostname: this.probe.hostname(), startedAt: await this.probe.startTime(process.pid) });
  }
  /** True only when the lock's owner is provably gone. A lock without hostname
   * (older builds) cannot prove the same host and is never recovered. */
  private async ownerProvablyGone(raw: string): Promise<boolean> {
    let owner: unknown; try { owner = JSON.parse(raw); } catch { return false; }
    if (!owner || typeof owner !== 'object') return false;
    const { protocol, pid, hostname, startedAt } = owner as { protocol?: unknown; pid?: unknown; hostname?: unknown; startedAt?: unknown };
    if (protocol !== OWNER_PROTOCOL || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
    if (typeof hostname !== 'string' || hostname !== this.probe.hostname()) return false;
    const alive = this.probe.alive(pid);
    if (alive === false) return true;
    if (alive !== true || typeof startedAt !== 'string') return false;
    const current = await this.probe.startTime(pid);
    return current !== null && current !== startedAt;
  }
  /** Replaces an orphan writer lock by an atomic rename, after re-reading it
   * unchanged. A `.recovery` mutex (wx) admits one recoverer at a time; a
   * second one, or a mutex left by a crash mid-recovery, refuses. */
  private async recoverWriterLock(lockPath: string, staleRaw: string, record: string, token: string): Promise<void> {
    const { fs } = this.modules(); const path = desktopRequire<typeof import('node:path')>('node:path');
    const mutex = await fs.open(`${lockPath}.recovery`, 'wx', 0o600);
    const temporary = `${lockPath}.${token}.tmp`;
    try {
      let current: string;
      try { current = await fs.readFile(lockPath, 'utf8'); } catch { throw authorityUnavailable(); }
      if (current !== staleRaw) throw authorityUnavailable();
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(record); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, lockPath);
      const parent = await fs.open(path.dirname(lockPath), 'r'); try { await parent.sync(); } finally { await parent.close(); }
      console.warn(`[TaskAuthority] recovered orphan writer lock ${lockPath}`);
    } finally {
      await mutex.close(); await fs.unlink(`${lockPath}.recovery`);
      await fs.unlink(temporary).catch(() => undefined);
    }
  }
  private async acquireWriterLock(lockPath: string, record: string, token: string): Promise<void> {
    const { fs } = this.modules(); const path = desktopRequire<typeof import('node:path')>('node:path');
    let global;
    try { global = await fs.open(lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let staleRaw: string;
      try { staleRaw = await fs.readFile(lockPath, 'utf8'); } catch { throw error; }
      if (!await this.ownerProvablyGone(staleRaw)) throw error;
      await this.recoverWriterLock(lockPath, staleRaw, record, token);
      return;
    }
    try { await global.writeFile(record); await global.sync(); const storage = await fs.open(path.dirname(lockPath), 'r'); try { await storage.sync(); } finally { await storage.close(); } }
    catch (error) { await global.close(); await fs.unlink(lockPath); throw error; }
    await global.close();
  }
  private modules() { return { fs: desktopRequire<typeof import('node:fs')>('node:fs').promises, crypto: desktopRequire<typeof import('node:crypto')>('node:crypto') }; }
  private async flushDirectory(): Promise<void> { const { fs } = this.modules(); const dir = await fs.open(this.directory, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
  async activate(): Promise<void> {
    if (this.token) { await this.assertActive(); return; }
    const { fs, crypto } = this.modules();
    await fs.mkdir(this.directory, { recursive: true });
    if(await fs.realpath(this.directory)!==this.directory)throw new Error('authority storage symlink');
    // Flush the directory link as well as its content before claiming ownership.
    const path = desktopRequire<typeof import('node:path')>('node:path');
    const parent = await fs.open(path.dirname(this.directory), 'r'); try { await parent.sync(); } finally { await parent.close(); }
    const token = crypto.randomBytes(32).toString('hex');
    const storageLock=this.storageLockPath();
    const record = await this.ownerRecord(token);
    await this.acquireWriterLock(storageLock, record, token);
    try {
      // Pre-existing per-authority owners are refused unless provably gone.
      // Holding the writer lock, no other activator can create or recover one
      // concurrently, so removing a provably orphan owner lock here is safe.
      for(const entry of await fs.readdir(path.dirname(this.directory),{withFileTypes:true})) {
        if(!entry.isDirectory())continue;
        const ownerLock=path.join(path.dirname(this.directory),entry.name,'owner.lock');
        let raw: string;
        try { await fs.lstat(ownerLock); raw=await fs.readFile(ownerLock,'utf8'); }
        catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT')continue; throw error; }
        if(!await this.ownerProvablyGone(raw))throw authorityUnavailable();
        await fs.unlink(ownerLock);
        console.warn(`[TaskAuthority] removed orphan owner lock ${ownerLock}`);
      }
      const lock = await fs.open(`${this.directory}/owner.lock`, 'wx', 0o600);
      try { await lock.writeFile(record); await lock.sync(); await this.flushDirectory(); this.token = token; }
      finally { await lock.close(); }
    } catch(error) { await fs.unlink(storageLock);throw error; }
  }
  async assertActive(): Promise<void> {
    if (!this.token) throw new Error('authority_unavailable');
    const { fs } = this.modules();
    for(const lock of [this.storageLockPath(),`${this.directory}/owner.lock`]) {
      const owner: unknown = JSON.parse(await fs.readFile(lock, 'utf8'));
      if (!owner || typeof owner !== 'object' || (owner as {token?: unknown}).token !== this.token) { this.token = null; throw new Error('authority_unavailable'); }
    }
  }
  async read(): Promise<AuthorityJournalEvent[]> {
    const { fs } = this.modules();
    let text: string;
    try { text = await fs.readFile(`${this.directory}/events.jsonl`, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    return decodeAuthorityJournal(text);
  }
  async append(event: AuthorityJournalEvent): Promise<void> {
    await this.assertActive(); const { fs, crypto } = this.modules();
    // Re-read strictly before every append; no in-memory tail can conceal a
    // changed/truncated journal. The caller holds the shared authority queue.
    await this.read();
    let prior = '0'.repeat(64); let sequence = 1;
    try { const text = await fs.readFile(`${this.directory}/events.jsonl`, 'utf8'); const rows = text.trim() ? text.trim().split('\n') : []; if (rows.length) { const tail = JSON.parse(rows[rows.length - 1]) as {hash: string; sequence: number}; prior = tail.hash; sequence = tail.sequence + 1; } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const row = { type: 'task_authority_journal/v1', sequence, previousHash: prior, event };
    const hash = crypto.createHash('sha256').update(canonicalJson(row)).digest('hex');
    const flags=desktopRequire<typeof import('node:fs')>('node:fs').constants;
    const handle = await fs.open(`${this.directory}/events.jsonl`, flags.O_WRONLY|flags.O_CREAT|flags.O_APPEND|flags.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify({ ...row, hash }) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await this.flushDirectory();
  }
  async deactivate(): Promise<void> { if (!this.token) return; await this.assertActive(); const { fs } = this.modules(); await fs.unlink(`${this.directory}/owner.lock`); await this.flushDirectory(); await fs.unlink(this.storageLockPath()); const path=desktopRequire<typeof import('node:path')>('node:path');const parent=await fs.open(path.dirname(this.storageLockPath()),'r');try{await parent.sync();}finally{await parent.close();} this.token = null; }
}
