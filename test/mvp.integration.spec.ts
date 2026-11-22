import { describe, expect, it } from 'vitest';
import { AutonomousService } from '../src/autonomous/autonomous.service';
import { InMemoryAcademicRepository } from '../src/persistence/in-memory-academic.repository';
import { SyncService } from '../src/sync/sync.service';
import { MockUniversityAdapter } from '../src/university/mock-university.adapter';

describe('MVP flow (integration)', () => {
  it('runs mock initial sync, exposes tasks and enables autonomous mode', async () => {
    const repository = new InMemoryAcademicRepository();
    const sync = new SyncService(new MockUniversityAdapter(), repository);
    const autonomous = new AutonomousService(repository);

    const summary = await sync.synchronize('integration-user');
    const tasks = await sync.listTasks('integration-user');
    const checks = await autonomous.start('integration-user');

    expect(summary.assignments).toBe(4);
    expect(tasks.some((task) => task.status === 'REQUIRES_CLARIFICATION')).toBe(true);
    expect(checks).toHaveLength(1);
    expect((await autonomous.status('integration-user')).autonomousStatus).toBe('RUNNING');
  });
});
