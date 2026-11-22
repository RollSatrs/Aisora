import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import type { ScheduledCheck } from '../domain/models';
import { SyncService } from '../sync/sync.service';
import { COURSE_CHECK_QUEUE } from './check-queue.dispatcher';

@Processor(COURSE_CHECK_QUEUE)
export class CourseCheckProcessor extends WorkerHost {
  constructor(private readonly syncService: SyncService) { super(); }

  override async process(job: Job<ScheduledCheck>): Promise<void> {
    if (job.name !== 'check-course') return;
    await this.syncService.synchronize(job.data.accountId);
  }
}
