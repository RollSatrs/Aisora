import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { ScheduledCheck } from '../domain/models';
import type { CheckDispatcher } from '../autonomous/autonomous.service';

export const COURSE_CHECK_QUEUE = 'course-checks';
export const LEGACY_DEBT_QUEUE = 'legacy-debts';

@Injectable()
export class BullMqCheckDispatcher implements CheckDispatcher {
  constructor(@InjectQueue(COURSE_CHECK_QUEUE) private readonly queue: Queue) {}

  async dispatch(check: ScheduledCheck): Promise<void> {
    const delay = Math.max(0, check.runAt.getTime() - Date.now());
    await this.queue.add('check-course', check, {
      jobId: check.idempotencyKey.replaceAll(':', '-'),
      delay,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  }
}
