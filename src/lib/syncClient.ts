/**
 * 同期 API クライアント。送るのは暗号文封筒だけ。
 */

import type { VaultEnvelope } from '../../shared/types';

export type RemoteVault = {
  envelope: VaultEnvelope;
  revision: number;
};

export type RemoteMeta = {
  revision: number;
  updatedAt: string;
};

export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`sync request failed: ${status}`);
    this.name = 'SyncHttpError';
  }
}

export class SyncConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super('sync conflict');
    this.name = 'SyncConflictError';
  }
}

export class SyncNotFoundError extends Error {
  constructor() {
    super('vault not found');
    this.name = 'SyncNotFoundError';
  }
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

export type SyncClientOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export function createSyncClient(options: SyncClientOptions = {}) {
  const baseUrl = options.baseUrl ?? '';
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  return {
    async getMeta(vaultId: string, token: string): Promise<RemoteMeta> {
      const response = await doFetch(`${baseUrl}/api/vault/${vaultId}/meta`, {
        headers: authHeaders(token),
      });
      if (response.status === 404) throw new SyncNotFoundError();
      if (!response.ok) throw new SyncHttpError(response.status, await parseJson(response));
      return (await response.json()) as RemoteMeta;
    },

    async get(vaultId: string, token: string): Promise<RemoteVault> {
      const response = await doFetch(`${baseUrl}/api/vault/${vaultId}`, {
        headers: authHeaders(token),
      });
      if (response.status === 404) throw new SyncNotFoundError();
      if (!response.ok) throw new SyncHttpError(response.status, await parseJson(response));
      return (await response.json()) as RemoteVault;
    },

    async put(
      vaultId: string,
      token: string,
      envelope: VaultEnvelope,
      baseRevision: number,
    ): Promise<{ revision: number }> {
      const response = await doFetch(`${baseUrl}/api/vault/${vaultId}`, {
        method: 'PUT',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ envelope, revision: baseRevision }),
      });
      if (response.status === 409) {
        const body = (await parseJson(response)) as { currentRevision?: number } | null;
        throw new SyncConflictError(body?.currentRevision ?? baseRevision);
      }
      if (!response.ok) throw new SyncHttpError(response.status, await parseJson(response));
      return (await response.json()) as { revision: number };
    },

    async remove(vaultId: string, token: string): Promise<void> {
      const response = await doFetch(`${baseUrl}/api/vault/${vaultId}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      });
      if (response.status === 404) return;
      if (!response.ok) throw new SyncHttpError(response.status, await parseJson(response));
    },

    async health(): Promise<boolean> {
      try {
        const response = await doFetch(`${baseUrl}/api/health`);
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}

export type SyncClient = ReturnType<typeof createSyncClient>;
