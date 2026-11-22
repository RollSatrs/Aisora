CREATE TYPE "public"."account_status" AS ENUM('MOCK', 'CONNECTED', 'SESSION_EXPIRED', 'DISCONNECTED');--> statement-breakpoint
CREATE TYPE "public"."assignment_status" AS ENUM('DISCOVERED', 'REQUIRES_CLARIFICATION', 'NOT_STARTED', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'APPROVED', 'SUBMITTED_UNVERIFIED', 'SUBMITTED_CONFIRMED', 'GRADED', 'RETURNED', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."assignment_type" AS ENUM('SRO', 'SRSP', 'LAB');--> statement-breakpoint
CREATE TYPE "public"."autonomous_status" AS ENUM('STOPPED', 'RUNNING', 'PAUSED_SESSION');--> statement-breakpoint
CREATE TYPE "public"."required_state" AS ENUM('REQUIRED', 'NOT_REQUIRED', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('RUNNING', 'SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TABLE "academic_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"external_ref" text NOT NULL,
	"name" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"current_week" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "academic_weeks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"term_id" uuid NOT NULL,
	"external_ref" text NOT NULL,
	"number" integer NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignment_evidence" (
	"assignment_id" uuid NOT NULL,
	"evidence_key" text NOT NULL,
	"evidence_type" text NOT NULL,
	"strength" integer NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "assignment_evidence_assignment_id_evidence_key_pk" PRIMARY KEY("assignment_id","evidence_key")
);
--> statement-breakpoint
CREATE TABLE "assignment_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"normalized_payload" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"week_id" uuid,
	"external_ref" text NOT NULL,
	"type" "assignment_type" NOT NULL,
	"assignment_number" integer,
	"title" text NOT NULL,
	"week_number" integer NOT NULL,
	"due_at" timestamp with time zone,
	"required_state" "required_state" NOT NULL,
	"status" "assignment_status" NOT NULL,
	"current_content_hash" text NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "autonomous_states" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"status" "autonomous_status" DEFAULT 'STOPPED' NOT NULL,
	"watermark" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "courses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"term_id" uuid,
	"external_ref" text NOT NULL,
	"name" text NOT NULL,
	"teacher_ref" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"job_type" text NOT NULL,
	"state" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"external_ref" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"check_queued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"external_ref" text NOT NULL,
	"fingerprint" text NOT NULL,
	"payload_redacted" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"status" "sync_status" NOT NULL,
	"summary" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "university_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"adapter_key" text NOT NULL,
	"external_account_ref" text NOT NULL,
	"status" "account_status" DEFAULT 'MOCK' NOT NULL,
	"initial_sync_completed_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"timezone" text DEFAULT 'Asia/Almaty' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_telegram_user_id_unique" UNIQUE("telegram_user_id")
);
--> statement-breakpoint
ALTER TABLE "academic_terms" ADD CONSTRAINT "academic_terms_account_id_university_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."university_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_weeks" ADD CONSTRAINT "academic_weeks_term_id_academic_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."academic_terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_evidence" ADD CONSTRAINT "assignment_evidence_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_versions" ADD CONSTRAINT "assignment_versions_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_account_id_university_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."university_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_week_id_academic_weeks_id_fk" FOREIGN KEY ("week_id") REFERENCES "public"."academic_weeks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomous_states" ADD CONSTRAINT "autonomous_states_account_id_university_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."university_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_account_id_university_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."university_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_term_id_academic_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."academic_terms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_executions" ADD CONSTRAINT "job_executions_account_id_university_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."university_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_events" ADD CONSTRAINT "schedule_events_account_id_university_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."university_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_events" ADD CONSTRAINT "schedule_events_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_observations" ADD CONSTRAINT "source_observations_account_id_university_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."university_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_account_id_university_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."university_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "university_accounts" ADD CONSTRAINT "university_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "academic_week_term_ref_uq" ON "academic_weeks" USING btree ("term_id","external_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_version_hash_uq" ON "assignment_versions" USING btree ("assignment_id","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_account_ref_uq" ON "assignments" USING btree ("account_id","external_ref");--> statement-breakpoint
CREATE INDEX "assignment_status_idx" ON "assignments" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "assignment_due_idx" ON "assignments" USING btree ("account_id","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "course_account_ref_uq" ON "courses" USING btree ("account_id","external_ref");--> statement-breakpoint
CREATE INDEX "course_account_idx" ON "courses" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_idempotency_uq" ON "job_executions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "job_account_state_idx" ON "job_executions" USING btree ("account_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_event_account_ref_uq" ON "schedule_events" USING btree ("account_id","external_ref");--> statement-breakpoint
CREATE INDEX "schedule_event_end_idx" ON "schedule_events" USING btree ("account_id","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "observation_fingerprint_uq" ON "source_observations" USING btree ("account_id","fingerprint");--> statement-breakpoint
CREATE INDEX "sync_run_account_started_idx" ON "sync_runs" USING btree ("account_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "university_account_adapter_ref_uq" ON "university_accounts" USING btree ("adapter_key","external_account_ref");--> statement-breakpoint
CREATE INDEX "university_account_user_idx" ON "university_accounts" USING btree ("user_id");