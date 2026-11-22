CREATE TABLE "credential_vault" (
	"account_ref" text PRIMARY KEY NOT NULL,
	"encrypted_payload" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
