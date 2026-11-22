import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { StoredAssignment, SyncSummary } from '../domain/models';
import type { AssignmentSnapshot } from '../domain/models';
import { ACADEMIC_REPOSITORY, type AcademicRepository } from '../persistence/academic.repository';
import { UNIVERSITY_ADAPTER, type UniversityAdapter } from '../university/university-adapter';
import { AbuSessionRequiredError } from '../university/abu-university.adapter';
import { activePeriodWeeks } from '../university/abu-university.adapter';
import type { SyncProgress } from '../university/university-adapter';
import { resolveAssignmentStatus } from './status-resolver';

export class SessionExpiredError extends Error {
  constructor() { super('University session expired'); }
}

function normalizedIdentity(value: string): string {
  return value.toLocaleLowerCase('ru-RU').replace(/[^a-zа-яё0-9]+/gi, ' ').trim();
}

export function deduplicateAssignmentSnapshots(items: AssignmentSnapshot[]): AssignmentSnapshot[] {
  const selected = new Map<string, AssignmentSnapshot>();
  for (const item of items) {
    const hasSpecificNumber = /\d/.test(item.title);
    const key = item.source === 'CONTENT' && hasSpecificNumber
      ? `${item.courseRef}|${item.type}|${normalizedIdentity(item.title)}`
      : item.externalRef;
    const previous = selected.get(key);
    if (!previous || item.weekNumber >= previous.weekNumber) selected.set(key, item);
  }
  return [...selected.values()];
}

@Injectable()
export class SyncService {
  constructor(
    @Inject(UNIVERSITY_ADAPTER) private readonly adapter: UniversityAdapter,
    @Inject(ACADEMIC_REPOSITORY) private readonly repository: AcademicRepository,
  ) {}

  async synchronize(accountId: string, now = new Date(), onProgress?: SyncProgress): Promise<SyncSummary> {
    let snapshot;
    try {
      const disabledLabCourseRefs = new Set((await this.repository.listCourseFocus(accountId))
        .filter((setting) => !setting.labFocus).map((setting) => setting.courseRef));
      snapshot = await this.adapter.readSnapshot(accountId, onProgress, { disabledLabCourseRefs });
    } catch (error) {
      if (error instanceof AbuSessionRequiredError) {
        const account = await this.repository.getAccount(accountId);
        account.autonomousStatus = 'PAUSED_SESSION';
        await this.repository.saveAccount(account);
      }
      throw error;
    }
    if (snapshot.session === 'EXPIRED') {
      const account = await this.repository.getAccount(accountId);
      account.autonomousStatus = 'PAUSED_SESSION';
      await this.repository.saveAccount(account);
      throw new SessionExpiredError();
    }

    const snapshotAssignments = deduplicateAssignmentSnapshots(snapshot.assignments);
    await onProgress?.('Сохраняю данные в PostgreSQL');
    await this.repository.upsertCourses(accountId, snapshot.courses);
    await this.repository.replaceSchedule(accountId, snapshot.schedule);
    const previousAssignments = await this.repository.listAssignments(accountId);
    let changed = 0;
    for (const item of snapshotAssignments) {
      const hash = createHash('sha256').update(JSON.stringify({
        type: item.type, title: item.title, weekNumber: item.weekNumber, content: item.content,
        requiredState: item.requiredState, source: item.source, submitted: item.submitted,
        submissionState: item.submissionState, grade: item.grade,
      })).digest('hex');
      const previous = previousAssignments.find((assignment) => assignment.externalRef === item.externalRef);
      const stored: StoredAssignment = {
        ...item,
        contentHash: hash,
        status: resolveAssignmentStatus(item, snapshot.currentWeek),
        versions: previous?.versions.includes(hash) ? previous.versions : [...(previous?.versions ?? []), hash],
        firstSeenAt: previous?.firstSeenAt ?? now,
        lastSeenAt: now,
      };
      const result = await this.repository.upsertAssignment(accountId, stored);
      if (result.changed) changed += 1;
    }
    const selectedRefs = new Set(snapshotAssignments.map((item) => item.externalRef));
    const duplicateRefs = snapshot.assignments
      .map((item) => item.externalRef)
      .filter((externalRef) => !selectedRefs.has(externalRef));
    const scannedCourseRefs = new Set(snapshot.courses.map((course) => course.externalRef));
    const scannedWeeks = new Set(activePeriodWeeks(snapshot.currentWeek));
    const staleContentRefs = previousAssignments
      .filter((item) => item.source === 'CONTENT'
        && scannedCourseRefs.has(item.courseRef)
        && scannedWeeks.has(item.weekNumber)
        && !selectedRefs.has(item.externalRef))
      .map((item) => item.externalRef);
    await this.repository.deleteAssignments(accountId, [...new Set([...duplicateRefs, ...staleContentRefs])]);

    const account = await this.repository.getAccount(accountId);
    account.initialSyncCompletedAt ??= now;
    account.lastSyncAt = now;
    account.currentWeek = snapshot.currentWeek;
    await this.repository.saveAccount(account);
    const assignments = await this.repository.listAssignments(accountId);
    return {
      currentWeek: snapshot.currentWeek,
      courses: snapshot.courses.length,
      assignments: assignments.length,
      debts: assignments.filter((item) => item.status === 'NOT_STARTED' && item.weekNumber < snapshot.currentWeek).length,
      clarification: assignments.filter((item) => item.status === 'REQUIRES_CLARIFICATION').length,
      completed: assignments.filter((item) => item.status === 'SUBMITTED_CONFIRMED' || item.status === 'GRADED').length,
      changed,
    };
  }

  listTasks(accountId: string): Promise<StoredAssignment[]> {
    return this.repository.listAssignments(accountId);
  }

  async taskContext(accountId: string): Promise<{ tasks: StoredAssignment[]; currentWeek: number }> {
    const [tasks, account] = await Promise.all([
      this.repository.listAssignments(accountId),
      this.repository.getAccount(accountId),
    ]);
    return { tasks, currentWeek: account.currentWeek ?? 1 };
  }

  listCourseFocus(accountId: string) {
    return this.repository.listCourseFocus(accountId);
  }

  setCourseLabFocus(accountId: string, courseRef: string, enabled: boolean): Promise<void> {
    return this.repository.setCourseLabFocus(accountId, courseRef, enabled);
  }
}
