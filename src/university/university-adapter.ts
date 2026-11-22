import type { UniversitySnapshot } from '../domain/models';

export const UNIVERSITY_ADAPTER = Symbol('UNIVERSITY_ADAPTER');
export type SyncProgress = (stage: string) => void | Promise<void>;
export interface UniversityReadOptions {
  disabledLabCourseRefs?: ReadonlySet<string>;
}

export interface UniversityAdapter {
  readonly key: string;
  readSnapshot(accountId: string, onProgress?: SyncProgress, options?: UniversityReadOptions): Promise<UniversitySnapshot>;
}
