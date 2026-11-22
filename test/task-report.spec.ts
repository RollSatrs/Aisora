import { describe, expect, it } from 'vitest';
import type { AssignmentSnapshot, StoredAssignment } from '../src/domain/models';
import { formatTaskCategory, formatTaskOverview, formatTaskType, taskCategory } from '../src/bot/task-report';
import { deduplicateAssignmentSnapshots } from '../src/sync/sync.service';
import { resolveAssignmentStatus } from '../src/sync/status-resolver';

function stored(overrides: Partial<StoredAssignment>): StoredAssignment {
  return {
    externalRef: 'task',
    courseRef: 'course',
    courseName: 'Тестовая дисциплина',
    type: 'LAB',
    title: 'Лабораторная работа №1',
    weekNumber: 10,
    content: '',
    requiredState: 'REQUIRED',
    source: 'CONTENT',
    submitted: false,
    submissionState: 'ABSENT',
    status: 'NOT_STARTED',
    contentHash: 'hash',
    versions: ['hash'],
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    ...overrides,
  };
}

describe('student-friendly task classification', () => {
  it('separates past debts, current work and future assignments', () => {
    expect(taskCategory(stored({ weekNumber: 10 }), 11)).toBe('DEBT');
    expect(taskCategory(stored({ weekNumber: 11 }), 11)).toBe('CURRENT');
    expect(taskCategory(stored({ weekNumber: 13, status: 'UPCOMING' }), 11)).toBe('UPCOMING');
  });

  it('never treats an upcoming assignment as clarification or debt', () => {
    const snapshot: AssignmentSnapshot = stored({ weekNumber: 13 });
    expect(resolveAssignmentStatus(snapshot, 11)).toBe('UPCOMING');
  });

  it('explains both assessment periods in the overview', () => {
    const overview = formatTaskOverview([
      stored({ externalRef: 'first', weekNumber: 8 }),
      stored({ externalRef: 'second', weekNumber: 10 }),
    ], 11);
    expect(overview).toContain('I период, недели 1–8: 1');
    expect(overview).toContain('II период, прошедшие недели: 1');
  });

  it('deduplicates a numbered content item repeated while AJAX switches weeks', () => {
    const base = stored({ title: 'Лабораторная работа №4', source: 'CONTENT' });
    const snapshots: AssignmentSnapshot[] = [
      { ...base, externalRef: 'week-8', weekNumber: 8 },
      { ...base, externalRef: 'week-11', weekNumber: 11 },
    ];
    expect(deduplicateAssignmentSnapshots(snapshots)).toMatchObject([{ externalRef: 'week-11', weekNumber: 11 }]);
  });

  it('keeps generic weekly laboratory entries separate', () => {
    const base = stored({ title: 'Лабораторная работа', source: 'CONTENT' });
    const snapshots: AssignmentSnapshot[] = [
      { ...base, externalRef: 'week-9', weekNumber: 9 },
      { ...base, externalRef: 'week-10', weekNumber: 10 },
    ];
    expect(deduplicateAssignmentSnapshots(snapshots)).toHaveLength(2);
  });

  it('formats a visually distinct list for each assignment type', () => {
    const messages = formatTaskType([
      stored({ type: 'SRO', title: 'Самостоятельная работа 10 неделя' }),
    ], 11, 'SRO');
    expect(messages.join('\n')).toContain('📝 СРО');
    expect(messages.join('\n')).toContain('🔴 Неделя 10');
    expect(messages.join('\n')).toContain('долг');
  });

  it('shows prioritized debts with focused laboratories first', () => {
    const messages = formatTaskCategory([
      stored({ externalRef: 'sro', type: 'SRO', title: 'СРО 10 неделя', weekNumber: 10 }),
      stored({ externalRef: 'lab', type: 'LAB', title: 'Лабораторная №4', weekNumber: 9, labFocus: true }),
    ], 11, 'DEBT').join('\n');
    expect(messages).toContain('🔴 У ВАС 2 ДОЛГА');
    expect(messages.indexOf('⭐ 🧪 Лабораторная №4')).toBeLessThan(messages.indexOf('📝 СРО 10 неделя'));
    expect(messages).toContain('📘 Тестовая дисциплина');
  });
});
