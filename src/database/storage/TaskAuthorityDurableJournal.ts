/** Desktop-only durability boundary. No legacy writer is used or advertised as
 * fsync-capable. The lock is never stolen by expiry; a crash requires deliberate
 * recovery of the owner lock after proving the old process cannot write. */
import { desktopRequire } from '../../utils/desktopRequire';
import type { AuthorityJournal, AuthorityJournalEvent } from '../repositories/interfaces/ITaskCoordinationRepository';
import { decodeAuthorityJournal } from './TaskAuthorityJournalReader';
import { canonicalJson } from '../../agents/taskManager/authority/TaskAuthorityPlanning';
export class TaskAuthorityDurableJournal implements AuthorityJournal {
  private token: string | null = null;
  private storageLockPath():string { const path=desktopRequire<typeof import('node:path')>('node:path'); return path.join(path.dirname(path.dirname(this.directory)),'task-authority-writer.lock'); }
  constructor(private readonly directory: string) {}
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
    const global=await fs.open(storageLock,'wx',0o600);
    try { await global.writeFile(JSON.stringify({protocol:'task-authority-owner/v1',token,pid:process.pid}));await global.sync();const storage=await fs.open(path.dirname(storageLock),'r');try{await storage.sync();}finally{await storage.close();} }
    catch(error){await global.close();await fs.unlink(storageLock);throw error;}
    await global.close();
    try {
      // Refuse pre-existing per-authority owners, including those from older
      // installations. Their lock can only be recovered deliberately.
      for(const entry of await fs.readdir(path.dirname(this.directory),{withFileTypes:true})) {
        if(!entry.isDirectory())continue;
        try { await fs.lstat(path.join(path.dirname(this.directory),entry.name,'owner.lock'));throw new Error('authority_unavailable'); }
        catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; }
      }
      const lock = await fs.open(`${this.directory}/owner.lock`, 'wx', 0o600);
      try { await lock.writeFile(JSON.stringify({ protocol: 'task-authority-owner/v1', token, pid: process.pid })); await lock.sync(); await this.flushDirectory(); this.token = token; }
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
