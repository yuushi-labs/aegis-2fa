import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { deriveVaultId, formatSyncCode, normalizeSyncCode } from '../../shared/sync';
import { useI18n, useToast } from '../lib/hooks';
import { useVaultStore } from '../lib/vaultStore';
import { Modal } from '../components/Modal';
import { createSyncClient, SyncNotFoundError } from '../lib/syncClient';

export function SyncPage() {
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const attachSync = useVaultStore((state) => state.attachSync);
  const hasVault = useVaultStore((state) => state.envelope !== null);

  const [code, setCode] = useState(() => params.get('code') ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function connect(): Promise<void> {
    const token = normalizeSyncCode(code);
    if (token === '') return;
    setBusy(true);
    setError(null);
    try {
      // 先に存在確認してからボルトを置き換える（失敗時に壊さない）。
      const client = createSyncClient();
      const vaultId = await deriveVaultId(token);
      await client.getMeta(vaultId, token);
      await attachSync(token);
      toast(t('sync.connected'), 'success');
      navigate('/');
    } catch (connectError) {
      setError(connectError instanceof SyncNotFoundError ? t('sync.notFound') : t('toast.syncFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-sm px-5 pt-8 pb-10">
      <h1 className="text-[1.35rem]">{t('sync.title')}</h1>
      <p className="mt-1.5 text-[0.86rem] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        {t('sync.lead')}
      </p>

      <form
        className="card mt-5 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (hasVault) setConfirmOpen(true);
          else void connect();
        }}
      >
        <label className="field-label" htmlFor="sync-code-input">
          {t('sync.code')}
        </label>
        <input
          id="sync-code-input"
          type="text"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="abcd efgh ijkl …"
          className="code-text text-[0.86rem]"
          spellCheck={false}
          autoComplete="off"
          autoFocus
          data-testid="sync-code-input"
        />
        {code.trim() !== '' && (
          <p className="field-hint code-text break-all">{formatSyncCode(normalizeSyncCode(code))}</p>
        )}
        {error !== null && (
          <p className="field-error mt-2" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="btn btn-primary mt-4 w-full"
          disabled={busy || code.trim() === ''}
          data-testid="sync-connect"
        >
          {busy ? t('common.loading') : t('sync.submit')}
        </button>
      </form>

      <Modal
        open={confirmOpen}
        title={t('sync.haveVault')}
        onClose={() => setConfirmOpen(false)}
        width="sm"
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setConfirmOpen(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setConfirmOpen(false);
                void connect();
              }}
            >
              {t('common.confirm')}
            </button>
          </>
        }
      >
        <p className="text-[0.88rem]">{t('sync.haveVaultConfirm')}</p>
      </Modal>
    </main>
  );
}
