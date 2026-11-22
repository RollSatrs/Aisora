import { describe, expect, it } from 'vitest';
import { AutonomousService } from '../src/autonomous/autonomous.service';
import { InMemoryAcademicRepository } from '../src/persistence/in-memory-academic.repository';
import { SessionExpiredError, SyncService } from '../src/sync/sync.service';
import { MockUniversityAdapter } from '../src/university/mock-university.adapter';

function setup() {
  const repository = new InMemoryAcademicRepository();
  const adapter = new MockUniversityAdapter();
  const sync = new SyncService(adapter, repository);
  const autonomous = new AutonomousService(repository);
  return { repository, adapter, sync, autonomous };
}

describe('initial synchronization', () => {
  it('connects on week 11 and finds debts from weeks 9 and 10 without mass-processing them', async () => {
    const { sync } = setup();
    const result = await sync.synchronize('student');
    expect(result.currentWeek).toBe(11);
    expect(result.debts).toBe(1);
    expect((await sync.listTasks('student')).map((task) => task.weekNumber)).toEqual(expect.arrayContaining([9, 10]));
  });

  it('treats a submission without a grade as submitted', async () => {
    const { sync } = setup();
    await sync.synchronize('student');
    const task = (await sync.listTasks('student')).find((item) => item.externalRef === 'srsp-10');
    expect(task?.status).toBe('SUBMITTED_CONFIRMED');
    expect(task?.grade).toBeUndefined();
  });

  it('does not mark journal-only SRO as a required debt', async () => {
    const { sync } = setup();
    await sync.synchronize('student');
    const task = (await sync.listTasks('student')).find((item) => item.externalRef === 'journal-sro-10');
    expect(task?.requiredState).toBe('NOT_REQUIRED');
    expect(task?.status).toBe('DISCOVERED');
  });

  it('keeps laboratory obligation uncertain', async () => {
    const { sync } = setup();
    await sync.synchronize('student');
    const task = (await sync.listTasks('student')).find((item) => item.externalRef === 'lab-11');
    expect(task?.status).toBe('REQUIRES_CLARIFICATION');
  });

  it('creates a new assignment version when a teacher changes content', async () => {
    const { adapter, sync } = setup();
    await sync.synchronize('student');
    adapter.mutateAssignment('sro-9', 'Обновлённые требования');
    const result = await sync.synchronize('student');
    const task = (await sync.listTasks('student')).find((item) => item.externalRef === 'sro-9');
    expect(result.changed).toBe(1);
    expect(task?.versions).toHaveLength(2);
  });

  it('pauses autonomous mode when the university session expires', async () => {
    const { adapter, repository, sync } = setup();
    await sync.synchronize('student');
    adapter.expireSession();
    await expect(sync.synchronize('student')).rejects.toBeInstanceOf(SessionExpiredError);
    expect((await repository.getAccount('student')).autonomousStatus).toBe('PAUSED_SESSION');
  });

  it('re-synchronizes without duplicating assignments', async () => {
    const { sync } = setup();
    await sync.synchronize('student');
    await sync.synchronize('student');
    expect(await sync.listTasks('student')).toHaveLength(4);
  });

  it('removes a phantom weekly content assignment after a verified rescan', async () => {
    const { adapter, sync } = setup();
    const first = await adapter.readSnapshot('student');
    first.assignments.push({
      externalRef: 'phantom-srsp-11', courseRef: 'course-architecture', type: 'SRSP',
      title: 'СРСП №3: Невзаимозаменяемые токены NFT', weekNumber: 11,
      content: 'Старый AJAX-контент другой недели', requiredState: 'REQUIRED',
      source: 'CONTENT', submitted: false, submissionState: 'ABSENT',
    });
    adapter.setSnapshot(first);
    await sync.synchronize('student');
    expect((await sync.listTasks('student')).some((task) => task.externalRef === 'phantom-srsp-11')).toBe(true);

    const corrected = await adapter.readSnapshot('student');
    corrected.assignments = corrected.assignments.filter((task) => task.externalRef !== 'phantom-srsp-11');
    adapter.setSnapshot(corrected);
    await sync.synchronize('student');

    expect((await sync.listTasks('student')).some((task) => task.externalRef === 'phantom-srsp-11')).toBe(false);
  });

  it('persists per-course laboratory focus settings', async () => {
    const { sync } = setup();
    await sync.synchronize('student');
    const [course] = await sync.listCourseFocus('student');
    expect(course?.labFocus).toBe(true);
    await sync.setCourseLabFocus('student', course!.courseRef, false);
    expect((await sync.listCourseFocus('student'))[0]?.labFocus).toBe(false);
    const lab = (await sync.listTasks('student')).find((task) => task.type === 'LAB' && task.courseRef === course!.courseRef);
    expect(lab?.labFocus).toBe(false);
  });
});

describe('autonomous mode', () => {
  it('schedules a check five minutes after a lesson that is still running', async () => {
    const { adapter, sync, autonomous } = setup();
    const now = new Date('2026-11-12T08:00:00.000Z');
    const snapshot = await adapter.readSnapshot('student');
    snapshot.schedule = [{
      externalRef: 'lesson', courseRef: 'course-programming',
      startsAt: new Date('2026-11-12T07:30:00.000Z'), endsAt: new Date('2026-11-12T08:30:00.000Z'),
    }];
    adapter.setSnapshot(snapshot);
    await sync.synchronize('student', now);
    const checks = await autonomous.start('student', now);
    expect(checks[0]?.runAt.toISOString()).toBe('2026-11-12T08:35:00.000Z');
    expect(checks[0]?.reason).toBe('POST_CLASS');
  });

  it('runs catch-up immediately after a missed lesson', async () => {
    const { adapter, sync, autonomous } = setup();
    const now = new Date('2026-11-12T09:00:00.000Z');
    const snapshot = await adapter.readSnapshot('student');
    snapshot.schedule = [{
      externalRef: 'missed', courseRef: 'course-programming',
      startsAt: new Date('2026-11-12T07:00:00.000Z'), endsAt: new Date('2026-11-12T08:00:00.000Z'),
    }];
    adapter.setSnapshot(snapshot);
    await sync.synchronize('student', now);
    const checks = await autonomous.start('student', now);
    expect(checks[0]?.runAt.toISOString()).toBe(now.toISOString());
    expect(checks[0]?.reason).toBe('CATCH_UP');
  });

  it('restores persisted state after service restart and does not duplicate checks', async () => {
    const { repository, sync, autonomous } = setup();
    const now = new Date();
    await sync.synchronize('student', now);
    await autonomous.start('student', now);
    const restarted = new AutonomousService(repository);
    expect((await restarted.status('student')).autonomousStatus).toBe('RUNNING');
    expect(await restarted.start('student', now)).toHaveLength(0);
    expect(await repository.listChecks('student')).toHaveLength(1);
  });
});
