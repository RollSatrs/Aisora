CREATE TABLE "course_preferences" (
	"account_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"lab_focus" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_preferences_account_id_course_id_pk" PRIMARY KEY("account_id","course_id")
);
--> statement-breakpoint
ALTER TABLE "course_preferences" ADD CONSTRAINT "course_preferences_account_id_university_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."university_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_preferences" ADD CONSTRAINT "course_preferences_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;