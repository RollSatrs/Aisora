import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';

async function bootstrap(): Promise<void> {
  // Vercel provides short-lived HTTP functions, not a persistent NestJS
  // process. Load a separate module so a cold start never opens Redis workers,
  // PostgreSQL connections, Playwright, or a Telegram polling loop.
  const cloudMode = process.env.VERCEL === '1' || process.env.AISORA_RUNTIME === 'vercel';
  const moduleClass = cloudMode
    ? (await import('./vercel/vercel-app.module')).VercelAppModule
    : (await import('./app.module')).AppModule;

  const app = await NestFactory.create(moduleClass);
  if (!cloudMode) app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

void bootstrap();
