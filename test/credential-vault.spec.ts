import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CredentialVaultUnavailableError,
  decryptCredentials,
  encryptCredentials,
  parseMasterKey,
} from '../src/auth/credential-vault.service';

describe('credential vault encryption', () => {
  it('encrypts and decrypts credentials for the same account', () => {
    const key = randomBytes(32);
    const credentials = { login: '12345', password: 'secret-password' };
    const encrypted = encryptCredentials(credentials, key, 'telegram:1');

    expect(encrypted).not.toContain(credentials.login);
    expect(encrypted).not.toContain(credentials.password);
    expect(decryptCredentials(encrypted, key, 'telegram:1')).toEqual(credentials);
  });

  it('rejects another account as authenticated additional data', () => {
    const key = randomBytes(32);
    const encrypted = encryptCredentials({ login: '12345', password: 'secret-password' }, key, 'telegram:1');

    expect(() => decryptCredentials(encrypted, key, 'telegram:2')).toThrow();
  });

  it('requires a valid 32-byte base64 master key', () => {
    expect(() => parseMasterKey(undefined)).toThrow(CredentialVaultUnavailableError);
    expect(() => parseMasterKey(Buffer.alloc(31).toString('base64'))).toThrow(CredentialVaultUnavailableError);
    expect(parseMasterKey(Buffer.alloc(32).toString('base64'))).toHaveLength(32);
  });
});
