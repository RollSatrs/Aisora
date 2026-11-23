import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { VercelController } from './vercel.controller';
import { CloudAcademicReader } from './cloud-academic.reader';
import { VercelTelegramService } from './vercel-telegram.service';

/**
 * Lightweight HTTP-only deployment for Vercel.
 * Unlike AppModule it never starts BullMQ workers, PostgreSQL clients,
 * AIS Playwright sessions, or Telegram long polling during cold start.
 */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [VercelController],
  providers: [CloudAcademicReader, VercelTelegramService],
})
export class VercelAppModule {}
