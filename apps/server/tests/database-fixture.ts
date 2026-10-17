import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { vi } from 'vitest';

// Keep real SQLite behavior, but own every connection so Windows can remove the fixture.
export function databaseFixture(prefix: string) {
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  const connections: DatabaseSync[] = [];
  vi.stubEnv('DOGEBOT_DATA_DIR', dataDir);
  vi.doMock('node:sqlite', () => ({
    DatabaseSync: class extends DatabaseSync {
      constructor(...args: ConstructorParameters<typeof DatabaseSync>) {
        super(...args); connections.push(this);
      }
    }
  }));
  return () => {
    for (const connection of connections) connection.close();
    vi.doUnmock('node:sqlite'); vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  };
}
