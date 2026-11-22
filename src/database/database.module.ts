import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export const DATABASE = Symbol('DATABASE');
export const PG_POOL = Symbol('PG_POOL');
export type AisoraDatabase = NodePgDatabase<typeof schema>;

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new Pool({
        connectionString: config.get<string>('DATABASE_URL') ?? 'postgres://aisora:aisora@localhost:5432/aisora',
        max: 5,
      }),
    },
    {
      provide: DATABASE,
      inject: [PG_POOL],
      useFactory: (pool: Pool) => drizzle(pool, { schema }),
    },
  ],
  exports: [DATABASE, PG_POOL],
})
export class DatabaseModule {}
