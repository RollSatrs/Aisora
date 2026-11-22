import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AutonomousService } from '../autonomous/autonomous.service';
import { SyncService } from '../sync/sync.service';

interface AccountBody { accountId?: string; }

@Controller()
export class AppController {
  constructor(
    private readonly syncService: SyncService,
    private readonly autonomousService: AutonomousService,
  ) {}

  @Get('health')
  health() { return { status: 'ok', adapter: 'abu-ais', integrationState: 'read-only', submissionEnabled: false }; }

  @Post('sync')
  sync(@Body() body: AccountBody) {
    return this.syncService.synchronize(body.accountId ?? 'local-demo');
  }

  @Get('tasks/:accountId')
  tasks(@Param('accountId') accountId: string) {
    return this.syncService.listTasks(accountId);
  }

  @Post('autonomous/start')
  start(@Body() body: AccountBody) {
    return this.autonomousService.start(body.accountId ?? 'local-demo');
  }

  @Post('autonomous/stop')
  async stop(@Body() body: AccountBody) {
    await this.autonomousService.stop(body.accountId ?? 'local-demo');
    return { status: 'STOPPED' };
  }

  @Get('status/:accountId')
  status(@Param('accountId') accountId: string) {
    return this.autonomousService.status(accountId);
  }
}
