import { describe, expect, it } from 'vitest';
import { InMemoryAcademicRepository } from '../src/persistence/in-memory-academic.repository';
import { SyncService } from '../src/sync/sync.service';
import { parseContentAssignments } from '../src/university/abu-parsers';
import type { AssignmentSnapshot, StoredAssignment, UniversitySnapshot } from '../src/domain/models';
import type { UniversityAdapter } from '../src/university/university-adapter';

const courseRef = 'test-course';
const weekNumber = 12;
const title = 'СРСП №4';
const assignmentRef = 'test-assignment';
const oldAssignment: StoredAssignment = {
  externalRef: assignmentRef,
  courseRef, weekNumber, type: 'SRSP', title,
  content: 'СРСП №4: полное задание из предыдущей успешной синхронизации',
  source: 'CONTENT', requiredState: 'REQUIRED',
  submitted: true, submissionState: 'CONFIRMED',
  contentHash: 'old-hash', status: 'SUBMITTED_CONFIRMED',
  versions: ['old-hash'],
  firstSeenAt: new Date('2026-10-01T00:00:00Z'),
  lastSeenAt: new Date('2026-10-01T00:00:00Z'),
};
function snapshot(assignments: AssignmentSnapshot[], verifiedContentWeeks?: UniversitySnapshot['verifiedContentWeeks']): UniversitySnapshot {
  return {
    session: 'ACTIVE',
    currentWeek: 13,
    courses: [{ externalRef: courseRef, name: 'Тестовая дисциплина' }],
    weeks: [],
    assignments,
    schedule: [],
    verifiedContentWeeks,
  };
}
async function setup(value: UniversitySnapshot) {
  const repository = new InMemoryAcademicRepository();
  const accountId = 'test-telegram-account';
  await repository.upsertAssignment(accountId, oldAssignment);
  const adapter: UniversityAdapter = {
    key: 'test', readSnapshot: async () => value,
  };
  return { repository, accountId, sync: new SyncService(adapter, repository) };
}

describe('safe incremental Aisora synchronization', () => {
  it('does not delete previously saved assignments when a week was not verified', async () => {
    const { sync, repository, accountId } = await setup(snapshot([]));
    await sync.synchronize(accountId);
    const assignments = await repository.listAssignments(accountId);
    expect(assignments.map((item) => item.externalRef)).toContain(assignmentRef);
  });

  it('permits stale CONTENT cleanup only for an explicitly verified week', async () => {
    const { sync, repository, accountId } = await setup(
      snapshot([], [{ courseRef, weekNumber }]),
    );
    await sync.synchronize(accountId);
    const assignments = await repository.listAssignments(accountId);
    expect(assignments.find((item) => item.externalRef === assignmentRef)).toBeUndefined();
  });

  it('preserves a confirmed submission and real content when a new scan is UNKNOWN', async () => {
    const incomplete: AssignmentSnapshot = {
      externalRef: assignmentRef, courseRef, weekNumber,
      type: 'SRSP', title, content: title, requiredState: 'REQUIRED',
      source: 'CONTENT', submitted: false, submissionState: 'UNKNOWN',
    };
    const { sync, repository, accountId } = await setup(snapshot([incomplete]));
    await sync.synchronize(accountId);
    const stored = (await repository.listAssignments(accountId))
      .find((item) => item.externalRef === assignmentRef);
    expect(stored?.content).toBe(oldAssignment.content);
    expect(stored?.submitted).toBe(true);
    expect(stored?.submissionState).toBe('CONFIRMED');
    expect(stored?.status).toBe('SUBMITTED_CONFIRMED');
  });

  it('marks unmatched sent messages UNKNOWN when message reading was incomplete', () => {
    const incomplete = parseContentAssignments(courseRef, weekNumber, [title], [], new Map(), false);
    const complete = parseContentAssignments(courseRef, weekNumber, [title], [], new Map(), true);
    expect(incomplete[0]?.submissionState).toBe('UNKNOWN');
    expect(complete[0]?.submissionState).toBe('ABSENT');
  });

  it('does not treat a different course/week as verification for stale deletion', async () => {
    const { sync, repository, accountId } = await setup(
      snapshot([], [{ courseRef: 'other-course', weekNumber }, { courseRef, weekNumber: 13 }]),
    );
    await sync.synchronize(accountId);
    expect((await repository.listAssignments(accountId)).some((a) => a.externalRef === assignmentRef)).toBe(true);
  });
});
