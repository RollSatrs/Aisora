import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DATABASE, type AisoraDatabase } from '../database/database.module';
import {
  assignmentVersions,
  assignments,
  autonomousStates,
  coursePreferences,
  courses,
  jobExecutions,
  scheduleEvents,
  universityAccounts,
  users,
} from '../database/schema';
import type {
  AccountState,
  AssignmentSnapshot,
  CourseFocusSetting,
  CourseSnapshot,
  ScheduleEventSnapshot,
  ScheduledCheck,
  StoredAssignment,
} from '../domain/models';
import type { AcademicRepository } from './academic.repository';

@Injectable()
export class PostgresAcademicRepository implements AcademicRepository {
  constructor(@Inject(DATABASE) private readonly db: AisoraDatabase) {}

  private syntheticTelegramId(accountRef: string): bigint {
    return BigInt(`0x${createHash('sha256').update(accountRef).digest('hex').slice(0, 14)}`);
  }

  private async ensureAccount(accountRef: string) {
    const telegramUserId = this.syntheticTelegramId(accountRef);
    await this.db.insert(users).values({ telegramUserId }).onConflictDoNothing({ target: users.telegramUserId });
    const [user] = await this.db.select().from(users).where(eq(users.telegramUserId, telegramUserId)).limit(1);
    if (!user) throw new Error('Failed to provision local user');
    await this.db.insert(universityAccounts).values({
      userId: user.id, adapterKey: 'mock', externalAccountRef: accountRef, status: 'MOCK',
    }).onConflictDoNothing({ target: [universityAccounts.adapterKey, universityAccounts.externalAccountRef] });
    const [account] = await this.db.select().from(universityAccounts).where(and(
      eq(universityAccounts.adapterKey, 'mock'), eq(universityAccounts.externalAccountRef, accountRef),
    )).limit(1);
    if (!account) throw new Error('Failed to provision local university account');
    return account;
  }

  async getAccount(accountId: string): Promise<AccountState> {
    const account = await this.ensureAccount(accountId);
    const [state] = await this.db.select().from(autonomousStates).where(eq(autonomousStates.accountId, account.id)).limit(1);
    return {
      accountId,
      initialSyncCompletedAt: account.initialSyncCompletedAt ?? undefined,
      lastSyncAt: account.lastSyncAt ?? undefined,
      currentWeek: account.currentWeek ?? undefined,
      autonomousStatus: state?.status ?? 'STOPPED',
      watermark: state?.watermark ?? undefined,
    };
  }

  async saveAccount(state: AccountState): Promise<void> {
    const account = await this.ensureAccount(state.accountId);
    await this.db.update(universityAccounts).set({
      initialSyncCompletedAt: state.initialSyncCompletedAt,
      lastSyncAt: state.lastSyncAt,
      currentWeek: state.currentWeek,
      updatedAt: new Date(),
    }).where(eq(universityAccounts.id, account.id));
    await this.db.insert(autonomousStates).values({
      accountId: account.id, status: state.autonomousStatus, watermark: state.watermark, updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: autonomousStates.accountId,
      set: { status: state.autonomousStatus, watermark: state.watermark, updatedAt: new Date() },
    });
  }

  async upsertCourses(accountId: string, snapshots: CourseSnapshot[]): Promise<void> {
    const account = await this.ensureAccount(accountId);
    for (const snapshot of snapshots) {
      await this.db.insert(courses).values({
        accountId: account.id, externalRef: snapshot.externalRef, name: snapshot.name, teacherRef: snapshot.teacherRef,
      }).onConflictDoUpdate({
        target: [courses.accountId, courses.externalRef],
        set: { name: snapshot.name, teacherRef: snapshot.teacherRef, active: true, updatedAt: new Date() },
      });
    }
  }

  async listCourses(accountId: string): Promise<CourseSnapshot[]> {
    const account = await this.ensureAccount(accountId);
    const rows = await this.db.select().from(courses).where(eq(courses.accountId, account.id));
    return rows.map((course) => ({
      externalRef: course.externalRef,
      name: course.name,
      teacherRef: course.teacherRef ?? undefined,
    }));
  }

  async listCourseFocus(accountId: string): Promise<CourseFocusSetting[]> {
    const account = await this.ensureAccount(accountId);
    const rows = await this.db.select({
      courseRef: courses.externalRef,
      courseName: courses.name,
      labFocus: coursePreferences.labFocus,
    }).from(courses).leftJoin(coursePreferences, and(
      eq(coursePreferences.accountId, account.id),
      eq(coursePreferences.courseId, courses.id),
    )).where(eq(courses.accountId, account.id));
    return rows.map((row) => ({
      courseRef: row.courseRef,
      courseName: row.courseName,
      labFocus: row.labFocus ?? true,
    }));
  }

  async setCourseLabFocus(accountId: string, courseRef: string, enabled: boolean): Promise<void> {
    const account = await this.ensureAccount(accountId);
    const [course] = await this.db.select().from(courses).where(and(
      eq(courses.accountId, account.id),
      eq(courses.externalRef, courseRef),
    )).limit(1);
    if (!course) throw new Error(`Course not found: ${courseRef}`);
    await this.db.insert(coursePreferences).values({
      accountId: account.id,
      courseId: course.id,
      labFocus: enabled,
    }).onConflictDoUpdate({
      target: [coursePreferences.accountId, coursePreferences.courseId],
      set: { labFocus: enabled, updatedAt: new Date() },
    });
  }

  async upsertAssignment(accountId: string, assignment: StoredAssignment): Promise<{ created: boolean; changed: boolean }> {
    const account = await this.ensureAccount(accountId);
    const [course] = await this.db.select().from(courses).where(and(
      eq(courses.accountId, account.id), eq(courses.externalRef, assignment.courseRef),
    )).limit(1);
    if (!course) throw new Error(`Course not found: ${assignment.courseRef}`);
    const [previous] = await this.db.select().from(assignments).where(and(
      eq(assignments.accountId, account.id), eq(assignments.externalRef, assignment.externalRef),
    )).limit(1);
    await this.db.insert(assignments).values({
      accountId: account.id,
      courseId: course.id,
      externalRef: assignment.externalRef,
      type: assignment.type,
      assignmentNumber: assignment.assignmentNumber,
      title: assignment.title,
      weekNumber: assignment.weekNumber,
      requiredState: assignment.requiredState,
      status: assignment.status,
      currentContentHash: assignment.contentHash,
      lastSeenAt: assignment.lastSeenAt,
    }).onConflictDoUpdate({
      target: [assignments.accountId, assignments.externalRef],
      set: {
        title: assignment.title,
        requiredState: assignment.requiredState,
        status: assignment.status,
        currentContentHash: assignment.contentHash,
        lastSeenAt: assignment.lastSeenAt,
        updatedAt: new Date(),
      },
    });
    const [stored] = await this.db.select().from(assignments).where(and(
      eq(assignments.accountId, account.id), eq(assignments.externalRef, assignment.externalRef),
    )).limit(1);
    if (!stored) throw new Error('Assignment upsert failed');
    await this.db.insert(assignmentVersions).values({
      assignmentId: stored.id,
      contentHash: assignment.contentHash,
      normalizedPayload: assignment,
      observedAt: assignment.lastSeenAt,
    }).onConflictDoNothing({ target: [assignmentVersions.assignmentId, assignmentVersions.contentHash] });
    return { created: !previous, changed: Boolean(previous && previous.currentContentHash !== assignment.contentHash) };
  }

  async listAssignments(accountId: string): Promise<StoredAssignment[]> {
    const account = await this.ensureAccount(accountId);
    const rows = await this.db.select({
      assignment: assignments,
      courseRef: courses.externalRef,
      courseName: courses.name,
      labFocus: coursePreferences.labFocus,
    })
      .from(assignments).innerJoin(courses, eq(assignments.courseId, courses.id))
      .leftJoin(coursePreferences, and(
        eq(coursePreferences.accountId, account.id),
        eq(coursePreferences.courseId, courses.id),
      ))
      .where(eq(assignments.accountId, account.id));
    const result: StoredAssignment[] = [];
    for (const row of rows) {
      const versions = await this.db.select().from(assignmentVersions).where(eq(assignmentVersions.assignmentId, row.assignment.id));
      const current = versions.find((version) => version.contentHash === row.assignment.currentContentHash);
      const payload = (current?.normalizedPayload ?? {}) as Partial<AssignmentSnapshot>;
      result.push({
        externalRef: row.assignment.externalRef,
        courseRef: row.courseRef,
        courseName: row.courseName,
        labFocus: row.labFocus ?? true,
        type: row.assignment.type,
        title: row.assignment.title,
        weekNumber: row.assignment.weekNumber,
        assignmentNumber: row.assignment.assignmentNumber ?? undefined,
        content: payload.content ?? '',
        requiredState: row.assignment.requiredState,
        source: payload.source ?? 'CONTENT',
        submitted: payload.submitted ?? false,
        submissionState: payload.submissionState,
        grade: payload.grade,
        contentHash: row.assignment.currentContentHash,
        status: row.assignment.status,
        versions: versions.map((version) => version.contentHash),
        firstSeenAt: row.assignment.createdAt,
        lastSeenAt: row.assignment.lastSeenAt,
      });
    }
    return result;
  }

  async deleteAssignments(accountId: string, externalRefs: string[]): Promise<void> {
    if (!externalRefs.length) return;
    const account = await this.ensureAccount(accountId);
    await this.db.delete(assignments).where(and(
      eq(assignments.accountId, account.id),
      inArray(assignments.externalRef, externalRefs),
    ));
  }

  async replaceSchedule(accountId: string, events: ScheduleEventSnapshot[]): Promise<void> {
    const account = await this.ensureAccount(accountId);
    for (const event of events) {
      const [course] = await this.db.select().from(courses).where(and(
        eq(courses.accountId, account.id), eq(courses.externalRef, event.courseRef),
      )).limit(1);
      if (!course) continue;
      await this.db.insert(scheduleEvents).values({
        accountId: account.id, courseId: course.id, externalRef: event.externalRef, startsAt: event.startsAt, endsAt: event.endsAt,
      }).onConflictDoUpdate({
        target: [scheduleEvents.accountId, scheduleEvents.externalRef],
        set: { startsAt: event.startsAt, endsAt: event.endsAt, updatedAt: new Date() },
      });
    }
  }

  async listSchedule(accountId: string): Promise<ScheduleEventSnapshot[]> {
    const account = await this.ensureAccount(accountId);
    const rows = await this.db.select({ event: scheduleEvents, courseRef: courses.externalRef })
      .from(scheduleEvents).innerJoin(courses, eq(scheduleEvents.courseId, courses.id))
      .where(eq(scheduleEvents.accountId, account.id));
    return rows.map(({ event, courseRef }) => ({ externalRef: event.externalRef, courseRef, startsAt: event.startsAt, endsAt: event.endsAt }));
  }

  async enqueueCheck(check: ScheduledCheck): Promise<boolean> {
    const account = await this.ensureAccount(check.accountId);
    const result = await this.db.insert(jobExecutions).values({
      accountId: account.id,
      idempotencyKey: check.idempotencyKey,
      jobType: check.reason,
      state: 'SCHEDULED',
      scheduledAt: check.runAt,
    }).onConflictDoNothing({ target: jobExecutions.idempotencyKey }).returning({ id: jobExecutions.id });
    return result.length === 1;
  }

  async listChecks(accountId: string): Promise<ScheduledCheck[]> {
    const account = await this.ensureAccount(accountId);
    const rows = await this.db.select().from(jobExecutions).where(eq(jobExecutions.accountId, account.id));
    return rows.map((row) => {
      const parts = row.idempotencyKey.split(':');
      return {
        idempotencyKey: row.idempotencyKey,
        accountId,
        courseRef: parts[1] ?? 'unknown',
        lessonRef: parts[2] ?? 'unknown',
        runAt: row.scheduledAt,
        reason: row.jobType === 'CATCH_UP' ? 'CATCH_UP' : 'POST_CLASS',
      };
    });
  }
}
