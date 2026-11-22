import type {
  AccountState,
  CourseFocusSetting,
  CourseSnapshot,
  ScheduleEventSnapshot,
  ScheduledCheck,
  StoredAssignment,
} from '../domain/models';

export const ACADEMIC_REPOSITORY = Symbol('ACADEMIC_REPOSITORY');

export interface AcademicRepository {
  getAccount(accountId: string): Promise<AccountState>;
  saveAccount(state: AccountState): Promise<void>;
  upsertCourses(accountId: string, courses: CourseSnapshot[]): Promise<void>;
  listCourses(accountId: string): Promise<CourseSnapshot[]>;
  listCourseFocus(accountId: string): Promise<CourseFocusSetting[]>;
  setCourseLabFocus(accountId: string, courseRef: string, enabled: boolean): Promise<void>;
  upsertAssignment(accountId: string, assignment: StoredAssignment): Promise<{ created: boolean; changed: boolean }>;
  deleteAssignments(accountId: string, externalRefs: string[]): Promise<void>;
  listAssignments(accountId: string): Promise<StoredAssignment[]>;
  replaceSchedule(accountId: string, events: ScheduleEventSnapshot[]): Promise<void>;
  listSchedule(accountId: string): Promise<ScheduleEventSnapshot[]>;
  enqueueCheck(check: ScheduledCheck): Promise<boolean>;
  listChecks(accountId: string): Promise<ScheduledCheck[]>;
}
