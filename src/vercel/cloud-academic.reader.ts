import { Injectable, Logger, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { AccountState, AssignmentSnapshot, StoredAssignment } from '../domain/models';

type DbAccount = {
  account_id: string;
  current_week: number | null;
  last_sync_at: Date | null;
  initial_sync_completed_at: Date | null;
  autonomous_status: AccountState['autonomousStatus'] | null;
};
type DbTask = {
  external_ref: string;
  course_ref: string;
  course_name: string;
  lab_focus: boolean | null;
  type: StoredAssignment['type'];
  title: string;
  week_number: number;
  assignment_number: number | null;
  required_state: StoredAssignment['requiredState'];
  status: StoredAssignment['status'];
  content_hash: string;
  payload: Partial<AssignmentSnapshot> | null;
  created_at: Date;
  last_seen_at: Date;
};

/**
 * Vercel reads the existing Drizzle-managed tables without provisioning
 * accounts, modifying tasks, starting workers, or running browser automation.
 * Only the Telegram sender's own accountRef can be queried.
 */
@Injectable()
export class CloudAcademicReader implements OnModuleDestroy {
  private readonly logger = new Logger(CloudAcademicReader.name);
  private pool?: Pool;

  constructor(private readonly config: ConfigService) {}

  private connection(): Pool {
    const connectionString = this.config.get<string>('DATABASE_URL');
    if (!connectionString) throw new ServiceUnavailableException('PostgreSQL is not configured');
    this.pool ??= new Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 1000,
      allowExitOnIdle: true,
    });
    this.pool.on('error', () => this.logger.warn('Idle PostgreSQL connection closed'));
    return this.pool;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  async readAccount(accountRef: string): Promise<AccountState | undefined> {
    const result = await this.connection().query<DbAccount>(
      `SELECT ua.id AS account_id, ua.current_week, ua.last_sync_at,
              ua.initial_sync_completed_at, st.status AS autonomous_status
         FROM university_accounts ua
         LEFT JOIN autonomous_states st ON st.account_id = ua.id
        WHERE ua.adapter_key = $1 AND ua.external_account_ref = $2
        LIMIT 1`,
      ['mock', accountRef],
    );
    const data = result.rows[0];
    if (!data) return undefined;
    return {
      accountId: accountRef,
      currentWeek: data.current_week ?? undefined,
      lastSyncAt: data.last_sync_at ?? undefined,
      initialSyncCompletedAt: data.initial_sync_completed_at ?? undefined,
      autonomousStatus: data.autonomous_status ?? 'STOPPED',
    };
  }

  async readTasks(accountRef: string): Promise<StoredAssignment[]> {
    const result = await this.connection().query<DbTask>(
      `SELECT a.external_ref, c.external_ref AS course_ref, c.name AS course_name,
              cp.lab_focus, a.type, a.title, a.week_number, a.assignment_number,
              a.required_state, a.status, a.current_content_hash AS content_hash,
              av.normalized_payload AS payload, a.created_at, a.last_seen_at
         FROM university_accounts ua
         JOIN assignments a ON a.account_id = ua.id
         JOIN courses c ON c.id = a.course_id AND c.account_id = ua.id
         LEFT JOIN course_preferences cp ON cp.account_id = ua.id AND cp.course_id = c.id
         LEFT JOIN assignment_versions av ON av.assignment_id = a.id
              AND av.content_hash = a.current_content_hash
        WHERE ua.adapter_key = $1 AND ua.external_account_ref = $2
        ORDER BY c.name, a.week_number, a.title`,
      ['mock', accountRef],
    );
    return result.rows.map((row) => {
      const details = row.payload ?? {};
      return {
        externalRef: row.external_ref,
        courseRef: row.course_ref,
        courseName: row.course_name,
        labFocus: row.lab_focus ?? true,
        type: row.type,
        title: row.title,
        weekNumber: row.week_number,
        assignmentNumber: row.assignment_number ?? undefined,
        requiredState: row.required_state,
        status: row.status,
        contentHash: row.content_hash,
        content: details.content ?? '',
        source: details.source ?? 'CONTENT',
        submitted: details.submitted ?? false,
        submissionState: details.submissionState,
        grade: details.grade,
        versions: [row.content_hash],
        firstSeenAt: row.created_at,
        lastSeenAt: row.last_seen_at,
      };
    });
  }
}
