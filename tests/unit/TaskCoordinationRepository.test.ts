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
