import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CloudCredentialService } from './cloud-credential.service';

@Injectable()
export class CloudSyncDispatcher {
  private readonly logger = new Logger(CloudSyncDispatcher.name);
  constructor(private readonly config: ConfigService, private readonly credentials: CloudCredentialService) {}

  configured(): boolean {
    return Boolean(this.config.get('GITHUB_ACTIONS_TOKEN') && this.config.get('GITHUB_SYNC_REPO'));
  }

  async dispatch(accountRef: string): Promise<void> {
    if (!this.configured()) {
      throw new ServiceUnavailableException('Cloud sync dispatcher is not configured');
    }
    if (!await this.credentials.hasCredentials(accountRef)) {
      throw new ServiceUnavailableException('AIS credentials not connected');
    }
    const repo = this.config.get<string>('GITHUB_SYNC_REPO') ?? '';
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
      throw new ServiceUnavailableException('Invalid sync repository');
    }
    const response = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/cloud-ais-sync.yml/dispatches`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.config.get<string>('GITHUB_ACTIONS_TOKEN')}`,
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        'user-agent': 'AisoraCloud/1.0',
      },
      body: JSON.stringify({ ref: 'main', inputs: { account_ref: accountRef } }),
      signal: AbortSignal.timeout(9000),
    });
    if (response.status !== 204) {
      this.logger.warn(`Cloud sync dispatch failed: HTTP ${response.status}`);
      throw new ServiceUnavailableException('Cloud sync could not start');
    }
  }
}
