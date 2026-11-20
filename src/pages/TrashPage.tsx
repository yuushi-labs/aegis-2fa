import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Account } from '../../shared/types';
import { trashRemainingDays } from '../../shared/trash';
import { Avatar } from '../components/Avatar';
import { Modal } from '../components/Modal';
import { useI18n, useNow, useToast } from '../lib/hooks';
import { formatTime } from '../lib/format';
import { useVaultStore } from '../lib/vaultStore';

/**
 * ゴミ箱。削除したアカウントは 30 日間ここに残り、復元できる。
 * 期限を過ぎたものは読み込み・保存のたびに自動で完全削除される。
 */
export function TrashPage() {
  const { t, language } = useI18n();
  const toast = useToast();
  const accounts = useVaultStore((state) => state.accounts);
  const restoreAccount = useVaultStore((state) => state.restoreAccount);
  const purgeAccount = useVaultStore((state) => state.purgeAccount);
  const emptyTrash = useVaultStore((state) => state.emptyTrash);
  // 残り日数は日付境界で変わるので、分単位で更新する（表示だけの再計算）。
  const nowSeconds = useNow(60_000);

  const [purgeTarget, setPurgeTarget] = useState<Account | null>(null);
  const [emptyOpen, setEmptyOpen] = useState(false);

  const trashed = useMemo(
    () =>
      accounts
        .filter((account) => account.deletedAt !== undefined)
        .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? '')),
    [accounts],
  );

  function titleOf(account: Account): string {
    if (account.issuer !== '' && account.label !== '') return `${account.issuer} · ${account.label}`;
    return account.issuer !== '' ? account.issuer : account.label;
  }

  async function handleRestore(account: Account): Promise<void> {
    try {
      await restoreAccount(account.id);
      toast(t('trash.restored'), 'success');
    } catch {
      toast(t('common.error'), 'error');
    }
  }

  async function handlePurge(): Promise<void> {
    if (purgeTarget === null) return;
    const target = purgeTarget;
    setPurgeTarget(null);
    try {
      await purgeAccount(target.id);
      toast(t('trash.purged'), 'success');
    } catch {
      toast(t('common.error'), 'error');
    }
  }

  async function handleEmpty(): Promise<void> {
    setEmptyOpen(false);
    try {
      await emptyTrash();
      toast(t('trash.purged'), 'success');
    } catch {
      toast(t('common.error'), 'error');
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 pt-5 pb-10">
      <Link to="/" className="btn btn-ghost -ml-2 text-[0.82rem]">
        ← {t('trash.backToList')}
      </Link>

      <div className="mt-2 flex items-end justify-between gap-3">
        <div>
          <h1 className="text-[1.35rem]">{t('trash.title')}</h1>
          <p className="text-[0.76rem]" style={{ color: 'var(--text-faint)' }}>
            {t('trash.count', { count: trashed.length })}
          </p>
        </div>
        {trashed.length > 0 && (
          <button
            type="button"
            className="btn btn-danger text-[0.8rem]"
            onClick={() => setEmptyOpen(true)}
            data-testid="trash-empty"
          >
            {t('trash.emptyAll')}
          </button>
        )}
      </div>

      <p className="mt-3 text-[0.8rem] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        {t('trash.lead')}
      </p>

      {trashed.length === 0 ? (
        <div className="card mt-6 px-5 py-10 text-center" data-testid="trash-empty-state">
          <p className="font-serif text-[1.02rem]">{t('trash.empty')}</p>
        </div>
      ) : (
        <ul className="mt-4 flex flex-col gap-2" data-testid="trash-list">
          {trashed.map((account) => {
            const days = trashRemainingDays(account, nowSeconds * 1000);
            return (
              <li
                key={account.id}
                className="card flex flex-wrap items-center gap-3 px-3.5 py-3"
                data-testid="trash-row"
                data-account-id={account.id}
              >
                <Avatar issuer={account.issuer} label={account.label} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[0.92rem] font-medium">{titleOf(account)}</p>
                  <p className="text-[0.74rem]" style={{ color: 'var(--text-faint)' }}>
                    {t('trash.deletedAt')}: {formatTime(account.deletedAt ?? null, language)}
                  </p>
                  <p className="text-[0.74rem]" style={{ color: 'var(--clay)' }}>
                    {t('trash.expiresIn', { days })}
                  </p>
                </div>
                <div className="flex w-full flex-wrap justify-end gap-1 sm:w-auto">
                  <button
                    type="button"
                    className="btn btn-secondary text-[0.78rem]"
                    onClick={() => void handleRestore(account)}
                    data-testid="trash-restore"
                  >
                    {t('trash.restore')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost text-[0.78rem]"
                    onClick={() => setPurgeTarget(account)}
                    style={{ color: 'var(--danger)' }}
                    data-testid="trash-purge"
                  >
                    {t('trash.purge')}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Modal
        open={purgeTarget !== null}
        title={t('trash.purge')}
        onClose={() => setPurgeTarget(null)}
        width="sm"
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setPurgeTarget(null)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void handlePurge()} data-testid="trash-purge-confirm">
              {t('trash.purge')}
            </button>
          </>
        }
      >
        <p className="text-[0.88rem] leading-relaxed">
          {t('trash.purgeConfirm', { title: purgeTarget === null ? '' : titleOf(purgeTarget) })}
        </p>
      </Modal>

      <Modal
        open={emptyOpen}
        title={t('trash.emptyAll')}
        onClose={() => setEmptyOpen(false)}
        width="sm"
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setEmptyOpen(false)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void handleEmpty()} data-testid="trash-empty-confirm">
              {t('trash.purge')}
            </button>
          </>
        }
      >
        <p className="text-[0.88rem] leading-relaxed">
          {t('trash.emptyConfirm', { count: trashed.length })}
        </p>
      </Modal>
    </main>
  );
}
