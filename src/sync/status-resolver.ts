import type { AssignmentSnapshot, AssignmentStatus } from '../domain/models';

export function resolveAssignmentStatus(snapshot: AssignmentSnapshot, currentWeek?: number): AssignmentStatus {
  if (snapshot.grade !== undefined) return 'GRADED';
  const submissionState = snapshot.submissionState ?? (snapshot.submitted ? 'CONFIRMED' : 'ABSENT');
  if (snapshot.submitted || submissionState === 'CONFIRMED') return 'SUBMITTED_CONFIRMED';
  if (currentWeek !== undefined && snapshot.weekNumber > currentWeek) return 'UPCOMING';
  if (submissionState === 'UNKNOWN') return 'REQUIRES_CLARIFICATION';
  if (snapshot.requiredState === 'UNKNOWN') return 'REQUIRES_CLARIFICATION';
  if (snapshot.requiredState === 'NOT_REQUIRED') return 'DISCOVERED';
  if (snapshot.requiredState === 'REQUIRED') return 'NOT_STARTED';
  return 'UNKNOWN';
}
