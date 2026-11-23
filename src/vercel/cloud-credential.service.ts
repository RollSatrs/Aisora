import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { decryptCredentials, encryptCredentials, parseMasterKey } from '../auth/credential-vault.service';

type Setup = { login: string; createdAt: number };

/**
 * Stateless two-step /connect store. Pending login and permanent credentials
 * are AES-256-GCM encrypted using distinct account-specific AAD values.
 * Password is never stored as plaintext in Postgres or in-process session maps.
 */
@Injectable()
export class CloudCredentialService {
  private readonly logger = new Logger(CloudCredentialService.name);
  private pool?: Pool;
  constructor(private readonly config: ConfigService) {}

  configured(): boolean {
    try {
      parseMasterKey(this.config.get<string>('CREDENTIALS_MASTER_KEY'));
      return Boolean(this.config.get<string>('DATABASE_URL'));
    } catch {
      return false;
    }
  }

  private key(): Buffer {
    return parseMasterKey(this.config.get<string>('CREDENTIALS_MASTER_KEY'));
  }
  private db(): Pool {
    const connectionString = this.config.get<string>('DATABASE_URL');
    if (!connectionString || !this.configured()) {
      throw new ServiceUnavailableException('Cloud credential storage not configured');
    }
    if (!this.pool) {
      this.pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000, allowExitOnIdle: true });
      this.pool.on('error', () => this.logger.warn('Idle credentials database connection closed'));
    }
    return this.pool;
  }

  private draftRef(accountRef: string): string {
    return `connect-draft:${accountRef}`;
  }

  async begin(accountRef: string): Promise<void> {
    // Remove any previous unfinished state before new enrollment.
    await this.cancel(accountRef);
    const draft: Setup = { login: '', createdAt: Date.now() };
    const ref = this.draftRef(accountRef);
    const payload = encryptCredentials({ login: JSON.stringify(draft), password: '' }, this.key(), ref);
    await this.db().query(
      'INSERT INTO credential_vault (account_ref, encrypted_payload) VALUES ($1, $2) ON CONFLICT (account_ref) DO UPDATE SET encrypted_payload = EXCLUDED.encrypted_payload, updated_at = now()',
      [ref, payload],
    );
  }

  async getDraft(accountRef: string): Promise<Setup | undefined> {
    const ref = this.draftRef(accountRef);
    const result = await this.db().query<{ encrypted_payload: string }>(
      'SELECT encrypted_payload FROM credential_vault WHERE account_ref = $1', [ref],
    );
    if (!result.rows[0]) return undefined;
    try {
      const saved = decryptCredentials(result.rows[0].encrypted_payload, this.key(), ref);
      const draft = JSON.parse(saved.login) as Setup;
      if (typeof draft.createdAt !== 'number' || Date.now() - draft.createdAt > 10 * 60_000) {
        await this.cancel(accountRef);
        return undefined;
      }
      return draft;
    } catch {
      this.logger.warn('Invalid or expired encrypted connect draft');
      await this.cancel(accountRef);
      return undefined;
    }
  }

  async setLogin(accountRef: string, login: string): Promise<void> {
    const ref = this.draftRef(accountRef);
    const draft = await this.getDraft(accountRef);
    if (!draft) throw new Error('Connection session expired');
    const payload = encryptCredentials({
      login: JSON.stringify({ createdAt: draft.createdAt, login } satisfies Setup),
      password: '',
    }, this.key(), ref);
    await this.db().query('UPDATE credential_vault SET encrypted_payload = $1, updated_at = now() WHERE account_ref = $2', [payload, ref]);
  }

  async finish(accountRef: string, password: string): Promise<void> {
    const draft = await this.getDraft(accountRef);
    if (!draft?.login) throw new Error('Connection session expired');
    const encrypted = encryptCredentials({ login: draft.login, password }, this.key(), accountRef);
    await this.db().query(
      'INSERT INTO credential_vault (account_ref, encrypted_payload) VALUES ($1, $2) ON CONFLICT (account_ref) DO UPDATE SET encrypted_payload = EXCLUDED.encrypted_payload, key_version = 1, updated_at = now()',
      [accountRef, encrypted],
    );
    await this.cancel(accountRef);
  }

  async hasCredentials(accountRef: string): Promise<boolean> {
    const result = await this.db().query(
      'SELECT 1 FROM credential_vault WHERE account_ref = $1 LIMIT 1', [accountRef],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async cancel(accountRef: string): Promise<void> {
    await this.db().query('DELETE FROM credential_vault WHERE account_ref = $1', [this.draftRef(accountRef)]);
  }
}
