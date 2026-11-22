import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { type AisoraDatabase, DATABASE } from '../database/database.module';
import { credentialVault } from '../database/schema';

export interface UniversityCredentials {
  login: string;
  password: string;
}

interface EncryptedPayload {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class CredentialVaultUnavailableError extends Error {
  constructor(message = 'CREDENTIALS_MASTER_KEY must be a base64-encoded 32-byte key') {
    super(message);
    this.name = 'CredentialVaultUnavailableError';
  }
}

export function parseMasterKey(value: string | undefined): Buffer {
  if (!value) throw new CredentialVaultUnavailableError();
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== value.trim().replace(/=+$/, '')) {
    throw new CredentialVaultUnavailableError();
  }
  return key;
}

export function encryptCredentials(credentials: UniversityCredentials, key: Buffer, accountRef: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(accountRef));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
  const payload: EncryptedPayload = {
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
  return JSON.stringify(payload);
}

export function decryptCredentials(payloadText: string, key: Buffer, accountRef: string): UniversityCredentials {
  const payload = JSON.parse(payloadText) as EncryptedPayload;
  if (payload.version !== 1) throw new CredentialVaultUnavailableError('Unsupported credential encryption version');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
  decipher.setAAD(Buffer.from(accountRef));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plaintext) as UniversityCredentials;
}

@Injectable()
export class CredentialVaultService {
  constructor(
    @Inject(DATABASE) private readonly database: AisoraDatabase,
    private readonly config: ConfigService,
  ) {}

  async save(accountRef: string, credentials: UniversityCredentials): Promise<void> {
    const encryptedPayload = encryptCredentials(credentials, this.masterKey(), accountRef);
    await this.database.insert(credentialVault).values({ accountRef, encryptedPayload }).onConflictDoUpdate({
      target: credentialVault.accountRef,
      set: { encryptedPayload, keyVersion: 1, updatedAt: new Date() },
    });
  }

  async get(accountRef: string): Promise<UniversityCredentials | undefined> {
    const [record] = await this.database.select().from(credentialVault)
      .where(eq(credentialVault.accountRef, accountRef)).limit(1);
    return record ? decryptCredentials(record.encryptedPayload, this.masterKey(), accountRef) : undefined;
  }

  async delete(accountRef: string): Promise<void> {
    await this.database.delete(credentialVault).where(eq(credentialVault.accountRef, accountRef));
  }

  private masterKey(): Buffer {
    return parseMasterKey(this.config.get<string>('CREDENTIALS_MASTER_KEY'));
  }
}
