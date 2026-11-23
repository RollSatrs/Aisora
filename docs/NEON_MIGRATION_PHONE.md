# Neon schema setup from a phone

The Vercel HTTP smoke test already has pooled `DATABASE_URL`. Do not expose it in chat, screenshots, source files, public API endpoints, or workflow logs.

The repo has four versioned Drizzle SQL migrations (`drizzle/meta/_journal.json`). A manual-only GitHub workflow is available at **Actions → Migrate Neon database → Run workflow → main → Run workflow**.

## First-time setup on GitHub

1. In Neon **Connect**, use the same `production` branch and Postgres database as in Vercel.
2. For schema migrations, **switch OFF Connection pooling** and copy the **direct**, non-pooled PostgreSQL connection URL. This is only for the migration runner; keep pooled `DATABASE_URL` on Vercel.
3. From your phone visit GitHub `RollSatrs/Aisora` → **Settings → Secrets and variables → Actions → New repository secret**.
4. Name: `NEON_DATABASE_URL`. Value: the Neon **direct** connection URL. Save. Never show the URL to ChatGPT.
5. Open **Actions → Migrate Neon database**, select **Run workflow**, branch **main**, and press **Run workflow**. It is not triggered by push or Vercel deployment.
6. Wait for the green checkmark. The job executes `pnpm db:migrate` and confirms eight essential tables exist without reading users' content.
7. If it fails, share only the error text with passwords/connection URLs redacted.

## Safety

- Do not trigger the job against an existing local database or an unrelated Neon project.
- The workflow operates on whichever database `NEON_DATABASE_URL` points to.
- Never insert a database URL into YAML, a GitHub issue, a PR or ChatGPT.
- Drizzle migrations are versioned and recorded so already applied migrations aren't run again.
- Database schema creation alone does NOT enable `/sync`, `/connect`, `/tasks`, `/status`, or `/srocheck` in the Vercel webhook smoke test.
