import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const accountStatus = pgEnum('account_status', [
  'MOCK',
  'CONNECTED',
  'SESSION_EXPIRED',
  'DISCONNECTED',
]);
export const assignmentType = pgEnum('assignment_type', ['SRO', 'SRSP', 'LAB']);
export const requiredState = pgEnum('required_state', ['REQUIRED', 'NOT_REQUIRED', 'UNKNOWN']);
export const assignmentStatus = pgEnum('assignment_status', [
  'DISCOVERED',
  'UPCOMING',
  'REQUIRES_CLARIFICATION',
  'NOT_STARTED',
  'IN_PROGRESS',
  'READY_FOR_REVIEW',
  'APPROVED',
  'SUBMITTED_UNVERIFIED',
  'SUBMITTED_CONFIRMED',
  'GRADED',
  'RETURNED',
  'UNKNOWN',
]);
export const syncStatus = pgEnum('sync_status', ['RUNNING', 'SUCCEEDED', 'FAILED']);
export const autonomousStatus = pgEnum('autonomous_status', ['STOPPED', 'RUNNING', 'PAUSED_SESSION']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  telegramUserId: bigint('telegram_user_id', { mode: 'bigint' }).notNull().unique(),
  timezone: text('timezone').notNull().default('Asia/Almaty'),
  ...timestamps,
});

export const universityAccounts = pgTable(
  'university_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    adapterKey: text('adapter_key').notNull(),
    externalAccountRef: text('external_account_ref').notNull(),
    status: accountStatus('status').notNull().default('MOCK'),
    initialSyncCompletedAt: timestamp('initial_sync_completed_at', { withTimezone: true }),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    currentWeek: integer('current_week'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('university_account_adapter_ref_uq').on(table.adapterKey, table.externalAccountRef),
    index('university_account_user_idx').on(table.userId),
  ],
);

export const credentialVault = pgTable('credential_vault', {
  accountRef: text('account_ref').primaryKey(),
  encryptedPayload: text('encrypted_payload').notNull(),
  keyVersion: integer('key_version').notNull().default(1),
  ...timestamps,
});

export const academicTerms = pgTable('academic_terms', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => universityAccounts.id, { onDelete: 'cascade' }),
  externalRef: text('external_ref').notNull(),
  name: text('name').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  currentWeek: integer('current_week'),
  ...timestamps,
});

export const academicWeeks = pgTable(
  'academic_weeks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    termId: uuid('term_id').notNull().references(() => academicTerms.id, { onDelete: 'cascade' }),
    externalRef: text('external_ref').notNull(),
    number: integer('number').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [uniqueIndex('academic_week_term_ref_uq').on(table.termId, table.externalRef)],
);

export const courses = pgTable(
  'courses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull().references(() => universityAccounts.id, { onDelete: 'cascade' }),
    termId: uuid('term_id').references(() => academicTerms.id, { onDelete: 'set null' }),
    externalRef: text('external_ref').notNull(),
    name: text('name').notNull(),
    teacherRef: text('teacher_ref'),
    active: boolean('active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('course_account_ref_uq').on(table.accountId, table.externalRef),
    index('course_account_idx').on(table.accountId),
  ],
);

export const coursePreferences = pgTable(
  'course_preferences',
  {
    accountId: uuid('account_id').notNull().references(() => universityAccounts.id, { onDelete: 'cascade' }),
    courseId: uuid('course_id').notNull().references(() => courses.id, { onDelete: 'cascade' }),
    labFocus: boolean('lab_focus').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.courseId] })],
);

export const scheduleEvents = pgTable(
  'schedule_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull().references(() => universityAccounts.id, { onDelete: 'cascade' }),
    courseId: uuid('course_id').notNull().references(() => courses.id, { onDelete: 'cascade' }),
    externalRef: text('external_ref').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    checkQueuedAt: timestamp('check_queued_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('schedule_event_account_ref_uq').on(table.accountId, table.externalRef),
    index('schedule_event_end_idx').on(table.accountId, table.endsAt),
  ],
);

export const assignments = pgTable(
  'assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull().references(() => universityAccounts.id, { onDelete: 'cascade' }),
    courseId: uuid('course_id').notNull().references(() => courses.id, { onDelete: 'cascade' }),
    weekId: uuid('week_id').references(() => academicWeeks.id, { onDelete: 'set null' }),
    externalRef: text('external_ref').notNull(),
    type: assignmentType('type').notNull(),
    assignmentNumber: integer('assignment_number'),
    title: text('title').notNull(),
    weekNumber: integer('week_number').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }),
    requiredState: requiredState('required_state').notNull(),
    status: assignmentStatus('status').notNull(),
    currentContentHash: text('current_content_hash').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('assignment_account_ref_uq').on(table.accountId, table.externalRef),
    index('assignment_status_idx').on(table.accountId, table.status),
    index('assignment_due_idx').on(table.accountId, table.dueAt),
  ],
);

export const assignmentVersions = pgTable(
  'assignment_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assignmentId: uuid('assignment_id').notNull().references(() => assignments.id, { onDelete: 'cascade' }),
    contentHash: text('content_hash').notNull(),
    normalizedPayload: jsonb('normalized_payload').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex('assignment_version_hash_uq').on(table.assignmentId, table.contentHash)],
);

export const sourceObservations = pgTable(
  'source_observations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull().references(() => universityAccounts.id, { onDelete: 'cascade' }),
    sourceType: text('source_type').notNull(),
    externalRef: text('external_ref').notNull(),
    fingerprint: text('fingerprint').notNull(),
    payloadRedacted: jsonb('payload_redacted').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex('observation_fingerprint_uq').on(table.accountId, table.fingerprint)],
);

export const assignmentEvidence = pgTable(
  'assignment_evidence',
  {
    assignmentId: uuid('assignment_id').notNull().references(() => assignments.id, { onDelete: 'cascade' }),
    evidenceKey: text('evidence_key').notNull(),
    evidenceType: text('evidence_type').notNull(),
    strength: integer('strength').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.assignmentId, table.evidenceKey] })],
);

export const syncRuns = pgTable(
  'sync_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull().references(() => universityAccounts.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    status: syncStatus('status').notNull(),
    summary: jsonb('summary'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [index('sync_run_account_started_idx').on(table.accountId, table.startedAt)],
);

export const autonomousStates = pgTable('autonomous_states', {
  accountId: uuid('account_id').primaryKey().references(() => universityAccounts.id, { onDelete: 'cascade' }),
  status: autonomousStatus('status').notNull().default('STOPPED'),
  watermark: timestamp('watermark', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const jobExecutions = pgTable(
  'job_executions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull().references(() => universityAccounts.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    jobType: text('job_type').notNull(),
    state: text('state').notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('job_idempotency_uq').on(table.idempotencyKey),
    index('job_account_state_idx').on(table.accountId, table.state),
  ],
);
