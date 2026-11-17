import type { App } from 'obsidian';
import type { AuthorityJournalEvent } from '../repositories/interfaces/ITaskCoordinationRepository';
import { authorityHash } from '../../agents/taskManager/authority/TaskAuthorityPlanning';
import { parseCoordinationShard } from '../sync/TaskCoordinationEventApplier';
/** Strict reader used on every platform, independent of forgiving legacy JSONL. */
export async function decodeAuthorityJournal(text: string): Promise<AuthorityJournalEvent[]> {
  if (text && !text.endsWith('\n')) throw new Error('incomplete authority journal');
  const rows = parseCoordinationShard(text); const result: AuthorityJournalEvent[] = []; let prior = '0'.repeat(64);
  for (const [index, row] of rows.entries()) {
    if (row.type !== 'task_authority_journal/v1' || row.sequence !== index + 1 || row.previousHash !== prior || !row.event) throw new Error('authority journal sequence gap');
    // The journal hashes canonical sorted JSON, allowing consistent verification
    // on mobile without importing Node crypto.
    const digest = await authorityHash({ type: row.type, sequence: row.sequence, previousHash: row.previousHash, event: row.event });
    if (digest !== row.hash) throw new Error('authority journal corruption');
    prior = digest; result.push(row.event as AuthorityJournalEvent);
  }
  return result;
}
export async function readAuthorityJournals(app: App, dataPath: string): Promise<AuthorityJournalEvent[][]> {
  const root = `${dataPath}/task-authority`; const adapter = app.vault.adapter;
  if (!await adapter.exists(root)) return [];
  const list = await adapter.list(root);
  if (list.files.length) throw new Error('unexpected authority journal root file');
  const journals: AuthorityJournalEvent[][] = [];
  for (const directory of list.folders.sort()) {
    if (!/\/[a-f0-9]{64}$/.test(directory)) throw new Error('unknown authority journal directory');
    const contents = await adapter.list(directory);
    if (contents.folders.length || contents.files.some(p => !p.endsWith('/events.jsonl') && !p.endsWith('/owner.lock'))) throw new Error('authority journal conflict copy or unknown file');
    const path = `${directory}/events.jsonl`;
    if (!contents.files.includes(path)) {
      // An empty prepared directory is harmless only when no owner claimed it.
      if (contents.files.length) throw new Error('authority journal missing');
      continue;
    }
    journals.push(await decodeAuthorityJournal(await adapter.read(path)));
  }
  return journals;
}
