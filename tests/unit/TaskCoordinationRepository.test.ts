import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../../src/database/schema/SchemaMigrator';
import { SCHEMA_SQL } from '../../src/database/schema/schema';

describe('coordination cache schema', () => {
  it('installs the same coordination tables for fresh databases and upgrades', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(19);
    const migration = MIGRATIONS.find(item => item.version === 19);
    expect(migration).toBeDefined();
    for (const table of ['task_coordination_state', 'task_coordination_receipts']) {
      expect(migration!.sql.join('\n')).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(SCHEMA_SQL).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });
});

import { fixture } from '../helpers/taskAuthorityFixture';
describe('strict canonical history validation',()=>{
  it('accepts byte-identical duplicates but rejects a revision gap and conflicting duplicate',async()=>{const f=await fixture();try{await f.admit();const history=await(await f.repository.journal('v','a')).read();const event=history.find(item=>item.type==='project_coordination_committed');if(!event||event.type!=='project_coordination_committed')throw new Error('missing event');expect(()=>f.repository.validateHistory([...history,event])).not.toThrow();expect(()=>f.repository.validateHistory([...history,{...event,revision:3,previousRevision:2,operationId:'new',operationKey:'["human","new"]',state:{...event.state,revision:3},receipt:{...event.receipt,revision:3}}])).toThrow('revision gap');expect(()=>f.repository.validateHistory([...history,{...event,id:'different'}])).toThrow('conflicting');}finally{await f.cleanup();}});
});
