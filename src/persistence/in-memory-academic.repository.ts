import { Injectable } from '@nestjs/common';
import type {
  AccountState,
  CourseFocusSetting,
  CourseSnapshot,
  ScheduleEventSnapshot,
  ScheduledCheck,
  StoredAssignment,
} from '../domain/models';
import type { AcademicRepository } from './academic.repository';

interface MemoryState {
  accounts: Map<string, AccountState>;
  courses: Map<string, CourseSnapshot[]>;
  assignments: Map<string, Map<string, StoredAssignment>>;
  schedules: Map<string, ScheduleEventSnapshot[]>;
  checks: Map<string, ScheduledCheck>;
  labFocus: Map<string, boolean>;
}

@Injectable()
export class InMemoryAcademicRepository implements AcademicRepository {
  private readonly state: MemoryState;

  constructor(state?: MemoryState) {
    this.state = state ?? {
      accounts: new Map(), courses: new Map(), assignments: new Map(), schedules: new Map(), checks: new Map(), labFocus: new Map(),
    };
  }

  async getAccount(accountId: string): Promise<AccountState> {
    return structuredClone(this.state.accounts.get(accountId) ?? { accountId, autonomousStatus: 'STOPPED' });
  }

  async saveAccount(state: AccountState): Promise<void> {
    this.state.accounts.set(state.accountId, structuredClone(state));
  }

  async upsertCourses(accountId: string, courses: CourseSnapshot[]): Promise<void> {
    this.state.courses.set(accountId, structuredClone(courses));
  }

  async listCourses(accountId: string): Promise<CourseSnapshot[]> {
    return structuredClone(this.state.courses.get(accountId) ?? []);
  }

  async listCourseFocus(accountId: string): Promise<CourseFocusSetting[]> {
    return (this.state.courses.get(accountId) ?? []).map((course) => ({
      courseRef: course.externalRef,
      courseName: course.name,
      labFocus: this.state.labFocus.get(`${accountId}:${course.externalRef}`) ?? true,
    }));
  }

  async setCourseLabFocus(accountId: string, courseRef: string, enabled: boolean): Promise<void> {
    this.state.labFocus.set(`${accountId}:${courseRef}`, enabled);
  }

  async upsertAssignment(accountId: string, assignment: StoredAssignment): Promise<{ created: boolean; changed: boolean }> {
    const bucket = this.state.assignments.get(accountId) ?? new Map<string, StoredAssignment>();
    const previous = bucket.get(assignment.externalRef);
    const changed = Boolean(previous && previous.contentHash !== assignment.contentHash);
    bucket.set(assignment.externalRef, structuredClone(assignment));
    this.state.assignments.set(accountId, bucket);
    return { created: !previous, changed };
  }

  async listAssignments(accountId: string): Promise<StoredAssignment[]> {
    const courses = this.state.courses.get(accountId) ?? [];
    return structuredClone([...this.state.assignments.get(accountId)?.values() ?? []].map((assignment) => ({
      ...assignment,
      courseName: courses.find((course) => course.externalRef === assignment.courseRef)?.name,
      labFocus: this.state.labFocus.get(`${accountId}:${assignment.courseRef}`) ?? true,
    })));
  }

  async deleteAssignments(accountId: string, externalRefs: string[]): Promise<void> {
    const bucket = this.state.assignments.get(accountId);
    if (!bucket) return;
    for (const externalRef of externalRefs) bucket.delete(externalRef);
  }

  async replaceSchedule(accountId: string, events: ScheduleEventSnapshot[]): Promise<void> {
    this.state.schedules.set(accountId, structuredClone(events));
  }

  async listSchedule(accountId: string): Promise<ScheduleEventSnapshot[]> {
    return structuredClone(this.state.schedules.get(accountId) ?? []);
  }

  async enqueueCheck(check: ScheduledCheck): Promise<boolean> {
    if (this.state.checks.has(check.idempotencyKey)) return false;
    this.state.checks.set(check.idempotencyKey, structuredClone(check));
    return true;
  }

  async listChecks(accountId: string): Promise<ScheduledCheck[]> {
    return structuredClone([...this.state.checks.values()].filter((check) => check.accountId === accountId));
  }
}
