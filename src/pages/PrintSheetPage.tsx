import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Account } from '../../shared/types';
import { buildOtpauthUri } from '../../shared/otpauth';
import { useI18n } from '../lib/hooks';
import { formatTime } from '../lib/format';
import { useQrDataUrl } from '../lib/useQrDataUrl';
import { sortAccounts, useVaultStore } from '../lib/vaultStore';

/** 1 アカウント分の印刷カード（QR は行ごとに生成する）。 */
function PrintAccount({ account, index }: { account: Account; index: number }) {
  const { t } = useI18n();
  const qr = useQrDataUrl(buildOtpauthUri(account), 132);
  const title = account.issuer !== '' ? account.issuer : account.label;
  const unusedCodes = (account.recoveryCodes ?? []).filter((entry) => !entry.used);

  return (
    <li className="print-account" data-testid="print-account">
      <div className="print-account-head">
        <span className="print-index">{index + 1}</span>
        <span className="print-service">{title}</span>
        <span className="print-type">
          {account.type.toUpperCase()} · {account.algorithm} · {account.digits}
        </span>
      </div>
      <div className="print-account-body">
        <div className="print-fields">
          {account.label !== '' && (
            <p>
              <span className="print-label">{t('print.account')}</span> {account.label}
            </p>
          )}
          <p>
            <span className="print-label">{t('print.secret')}</span>{' '}
            <code className="print-secret">{account.secret}</code>
          </p>
          {account.notes !== undefined && account.notes !== '' && (
            <p>
              <span className="print-label">{t('print.notes')}</span>{' '}
              <span className="print-notes">{account.notes}</span>
            </p>
          )}
          {unusedCodes.length > 0 && (
            <div>
              <span className="print-label">{t('print.codes')}</span>
              <ul className="print-codes">
                {unusedCodes.map((entry) => (
                  <li key={entry.id}>
                    <code>{entry.code}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        {qr.dataUrl !== null && (
          <img className="print-qr" src={qr.dataUrl} alt={t('print.qr')} />
        )}
      </div>
    </li>
  );
}

/**
 * 緊急バックアップ印刷シート。
 *
 * 平文の秘密鎖と復旧コードを載せるため、開く前に設定画面で警告を確認させ、
 * 印刷時だけ本文が出るようにする（画面の操作ボタンは印刷しない）。
 */
export function PrintSheetPage() {
  const { t, language } = useI18n();
  const navigate = useNavigate();
  const accounts = useVaultStore((state) => state.accounts);
  const profiles = useVaultStore((state) => state.profiles);
  const activeProfileId = useVaultStore((state) => state.activeProfileId);

  const active = useMemo(
    () =>
      sortAccounts(
        accounts.filter((account) => account.deletedAt === undefined),
        'manual',
      ),
    [accounts],
  );
  const vaultName =
    profiles.find((profile) => profile.id === activeProfileId)?.name ?? 'メイン';
  const printedAt = formatTime(new Date().toISOString(), language);

  return (
    <main className="print-sheet mx-auto max-w-3xl px-4 pt-5 pb-10">
      <div className="no-print flex flex-wrap items-center justify-between gap-2">
        <button type="button" className="btn btn-ghost -ml-2 text-[0.82rem]" onClick={() => navigate('/settings')}>
          ← {t('print.back')}
        </button>
        <button type="button" className="btn btn-primary text-[0.86rem]" onClick={() => window.print()} data-testid="print-button">
          {t('print.print')}
        </button>
      </div>

      <header className="mt-3 border-b pb-3" style={{ borderColor: 'var(--border-strong)' }}>
        <h1 className="text-[1.4rem]">{t('print.title')}</h1>
        <p className="mt-1 text-[0.8rem]" style={{ color: 'var(--text-muted)' }}>
          {t('print.vault')}: <strong>{vaultName}</strong> · {t('print.printedAt')}: {printedAt} ·{' '}
          {t('print.accounts', { count: active.length })}
        </p>
        <p className="mt-2 text-[0.74rem] leading-relaxed" style={{ color: 'var(--clay)' }}>
          {t('print.notice')}
        </p>
      </header>

      {active.length === 0 ? (
        <p className="mt-6 text-[0.88rem]" style={{ color: 'var(--text-muted)' }}>
          {t('print.empty')}
        </p>
      ) : (
        <ul className="print-list mt-4" data-testid="print-list">
          {active.map((account, index) => (
            <PrintAccount key={account.id} account={account} index={index} />
          ))}
        </ul>
      )}

      <footer className="mt-6 border-t pt-2 text-[0.68rem]" style={{ borderColor: 'var(--border)', color: 'var(--text-faint)' }}>
        {t('print.generatedBy')} · {printedAt}
      </footer>
    </main>
  );
}
