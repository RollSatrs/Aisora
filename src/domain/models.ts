export type AssignmentType = 'SRO' | 'SRSP' | 'LAB';
export type RequiredState = 'REQUIRED' | 'NOT_REQUIRED' | 'UNKNOWN';
export type AssignmentStatus =
  | 'DISCOVERED'
  | 'UPCOMING'
  | 'REQUIRES_CLARIFICATION'
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'READY_FOR_REVIEW'
  | 'APPROVED'
  | 'SUBMITTED_UNVERIFIED'
  | 'SUBMITTED_CONFIRMED'
  | 'GRADED'
  | 'RETURNED'
  | 'UNKNOWN';

export interface CourseSnapshot {
  externalRef: string;
  name: string;
  teacherRef?: string;
}

export interface WeekSnapshot {
  externalRef: string;
  number: number;
  current: boolean;
}

export interface AssignmentSnapshot {
  externalRef: string;
  courseRef: string;
  type: AssignmentType;
  title: string;
  weekNumber: number;
  assignmentNumber?: number;
  content: string;
  requiredState: RequiredState;
  source: 'SRO_TAB' | 'CONTENT' | 'JOURNAL';
  submitted: boolean;
  submissionState?: 'CONFIRMED' | 'ABSENT' | 'UNKNOWN';
  grade?: string;
}

export interface ScheduleEventSnapshot {
  externalRef: string;
  courseRef: string;
  startsAt: Date;
  endsAt: Date;
}

export interface UniversitySnapshot {
  session: 'ACTIVE' | 'EXPIRED';
  currentWeek: number;
  courses: CourseSnapshot[];
  weeks: WeekSnapshot[];
  assignments: AssignmentSnapshot[];
  schedule: ScheduleEventSnapshot[];
}

export interface StoredAssignment extends AssignmentSnapshot {
  courseName?: string;
  labFocus?: boolean;
  contentHash: string;
  status: AssignmentStatus;
  versions: string[];
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface CourseFocusSetting {
  courseRef: string;
  courseName: string;
  labFocus: boolean;
}

export interface SyncSummary {
  currentWeek: number;
  courses: number;
  assignments: number;
  debts: number;
  clarification: number;
  completed: number;
  changed: number;
}

export interface ScheduledCheck {
  idempotencyKey: string;
  accountId: string;
  courseRef: string;
  lessonRef: string;
  runAt: Date;
  reason: 'POST_CLASS' | 'CATCH_UP';
}

export interface AccountState {
  accountId: string;
  currentWeek?: number;
  initialSyncCompletedAt?: Date;
  lastSyncAt?: Date;
  autonomousStatus: 'STOPPED' | 'RUNNING' | 'PAUSED_SESSION';
  watermark?: Date;
}
