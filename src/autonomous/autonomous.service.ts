import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ScheduledCheck } from '../domain/models';
import { ACADEMIC_REPOSITORY, type AcademicRepository } from '../persistence/academic.repository';

export class InitialSyncRequiredError extends Error {
  constructor() { super('Initial synchronization is required'); }
}

export const CHECK_DISPATCHER = Symbol('CHECK_DISPATCHER');
export interface CheckDispatcher { dispatch(check: ScheduledCheck): Promise<void>; }

@Injectable()
export class AutonomousService {
  constructor(
    @Inject(ACADEMIC_REPOSITORY) private readonly repository: AcademicRepository,
    @Optional() @Inject(CHECK_DISPATCHER) private readonly dispatcher?: CheckDispatcher,
  ) {}

  async start(accountId: string, now = new Date()): Promise<ScheduledCheck[]> {
    const account = await this.repository.getAccount(accountId);
    if (!account.initialSyncCompletedAt) throw new InitialSyncRequiredError();
    if (account.autonomousStatus === 'PAUSED_SESSION') return [];
    account.autonomousStatus = 'RUNNING';
    const scheduled: ScheduledCheck[] = [];
    for (const lesson of await this.repository.listSchedule(accountId)) {
      const nominalRunAt = new Date(lesson.endsAt.getTime() + 5 * 60_000);
      const runAt = nominalRunAt <= now ? now : nominalRunAt;
      const check: ScheduledCheck = {
        idempotencyKey: `${accountId}:${lesson.courseRef}:${lesson.externalRef}:post-class`,
        accountId,
        courseRef: lesson.courseRef,
        lessonRef: lesson.externalRef,
        runAt,
        reason: nominalRunAt <= now ? 'CATCH_UP' : 'POST_CLASS',
      };
      if (await this.repository.enqueueCheck(check)) {
        scheduled.push(check);
        await this.dispatcher?.dispatch(check);
      }
    }
    account.watermark = now;
    await this.repository.saveAccount(account);
    return scheduled;
  }

  async stop(accountId: string): Promise<void> {
    const account = await this.repository.getAccount(accountId);
    account.autonomousStatus = 'STOPPED';
    await this.repository.saveAccount(account);
  }

  async status(accountId: string) {
    return this.repository.getAccount(accountId);
  }
}
