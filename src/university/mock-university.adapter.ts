import { Injectable } from '@nestjs/common';
import type { UniversitySnapshot } from '../domain/models';
import type { SyncProgress, UniversityAdapter, UniversityReadOptions } from './university-adapter';

@Injectable()
export class MockUniversityAdapter implements UniversityAdapter {
  readonly key = 'mock';
  private snapshot: UniversitySnapshot;

  constructor() {
    const now = new Date();
    this.snapshot = {
      session: 'ACTIVE',
      currentWeek: 11,
      courses: [
        { externalRef: 'course-programming', name: 'Программирование' },
        { externalRef: 'course-architecture', name: 'Архитектура ИС' },
      ],
      weeks: [9, 10, 11].map((number) => ({ externalRef: `week-${number}`, number, current: number === 11 })),
      assignments: [
        {
          externalRef: 'sro-9', courseRef: 'course-programming', type: 'SRO', title: 'СРО 1', weekNumber: 9,
          assignmentNumber: 1, content: 'Подготовить отчёт', requiredState: 'REQUIRED', source: 'SRO_TAB', submitted: false,
        },
        {
          externalRef: 'srsp-10', courseRef: 'course-architecture', type: 'SRSP', title: 'СРСП 10 неделя', weekNumber: 10,
          content: 'Сравнить архитектурные стили', requiredState: 'REQUIRED', source: 'CONTENT', submitted: true,
        },
        {
          externalRef: 'journal-sro-10', courseRef: 'course-programming', type: 'SRO', title: 'СРО в журнале', weekNumber: 10,
          content: 'Запись журнала без формы сдачи', requiredState: 'NOT_REQUIRED', source: 'JOURNAL', submitted: false,
        },
        {
          externalRef: 'lab-11', courseRef: 'course-programming', type: 'LAB', title: 'Лабораторная 3', weekNumber: 11,
          assignmentNumber: 3, content: 'Выполнить программу', requiredState: 'UNKNOWN', source: 'CONTENT', submitted: false,
        },
      ],
      schedule: [{
        externalRef: 'lesson-today', courseRef: 'course-programming',
        startsAt: new Date(now.getTime() - 30 * 60_000), endsAt: new Date(now.getTime() + 30 * 60_000),
      }],
    };
  }

  async readSnapshot(accountId: string, onProgress?: SyncProgress, options?: UniversityReadOptions): Promise<UniversitySnapshot> {
    void accountId;
    void options;
    await onProgress?.('Тестовые данные загружены');
    return structuredClone(this.snapshot);
  }

  setSnapshot(snapshot: UniversitySnapshot): void {
    this.snapshot = structuredClone(snapshot);
  }

  mutateAssignment(externalRef: string, content: string): void {
    const assignment = this.snapshot.assignments.find((item) => item.externalRef === externalRef);
    if (!assignment) throw new Error(`Unknown mock assignment: ${externalRef}`);
    assignment.content = content;
  }

  expireSession(): void {
    this.snapshot.session = 'EXPIRED';
  }
}
