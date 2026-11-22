ALTER TYPE "public"."assignment_status" ADD VALUE 'UPCOMING' BEFORE 'REQUIRES_CLARIFICATION';--> statement-breakpoint
ALTER TABLE "university_accounts" ADD COLUMN "current_week" integer;