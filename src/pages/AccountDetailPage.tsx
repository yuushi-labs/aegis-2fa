import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { buildOtpauthUri } from '../../shared/otpauth';
import { trashRemainingDays } from '../../shared/trash';
import { AccountForm } from '../components/AccountForm';
import { accountToDraft, draftToAccount, type AccountDraft } from '../lib/accountDraft';
import { Modal } from '../components/Modal';
import { useI18n, useNow, useToast } from '../lib/hooks';
import { useVaultStore } from '../lib/vaultStore';
import { copyText, scheduleClipboardClear } from '../lib/clipboard';
import { downloadBlob, timestampForFilename } from '../lib/format';
import { renderQrPng } from '../lib/qr';
import { useQrDataUrl } from '../lib/useQrDataUrl';
import { Avatar } from '../components/Avatar';
import { Code } from '../components/Code';
import { generateTOTPPair } from '../../shared/totp';
import { generateHOTP } from '../../shared/hotp';
import { decodeBase32 } from '../../shared/base32';

export function AccountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const accounts = useVaultStore((state) => state.accounts);
  const upsertAccount = useVaultStore((state) => state.upsertAccount);
  const removeAccount = useVaultStore((state) => state.removeAccount);
  const restoreAccount = useVaultStore((state) => state.restoreAccount);
  const purgeAccount = useVaultStore((state) => state.purgeAccount);
  const settings = useVaultStore((state) => state.settings);
  const now = useNow(1000);

  const account = useMemo(() => accounts.find((item) => item.id === id) ?? null, [accounts, id]);
  // account が入れ替わったら編集内容を破棄する（キーで remount する代わりに id を保持）。
  const [edited, setEdited] = useState<{ id: string; draft: AccountDraft } | null>(null);
  const draft =
    edited !== null && account !== null && edited.id === account.id
      ? edited.draft
      : account === null
        ? null
        : accountToDraft(account);
  const setDraft = (next: AccountDraft): void => {
    if (account !== null) setEdited({ id: account.id, draft: next });
  };
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const qrDataUrl = useQrDataUrl(qrOpen && account !== null ? buildOtpauthUri(account) : null, 260);
  const [code, setCode] = useState('');

  useEffect(() => {
    if (account === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const value =
          account.type === 'totp'
            ? (
                await generateTOTPPair(account.secret, now, {
                  algorithm: account.algorithm,
                  digits: account.digits,
                  period: account.period,
                  skew: settings.clockSkew,
                })
              ).current
            : await generateHOTP(decodeBase32(account.secret), account.counter, {
                algorithm: account.algorithm,
                digits: account.digits,
              });
        if (!cancelled) setCode(value);
      } catch {
        if (!cancelled) setCode('—');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account, now, settings.clockSkew]);

  if (account === null || draft === null) {
    return (
      <main className="mx-auto max-w-2xl px-4 pt-6">
        <p className="text-[0.9rem]" style={{ color: 'var(--text-muted)' }}>
          {t('list.noResults')}
        </p>
        <button type="button" className="btn btn-secondary mt-3" onClick={() => navigate('/')}>
          {t('common.back')}
        </button>
      </main>
    );
  }

  // ゴミ箱にあるアカウントは、編集ではなく復元・完全削除だけを出す
  // （編集して保存すると、意図せず復活する）。
  if (account.deletedAt !== undefined) {
    const days = trashRemainingDays(account, now * 1000);
    return (
      <main className="mx-auto max-w-2xl px-4 pt-5 pb-8">
        <button type="button" className="btn btn-ghost -ml-2 text-[0.82rem]" onClick={() => navigate('/trash')}>
          ← {t('trash.title')}
        </button>
        <div className="mt-2 flex items-center gap-3">
          <Avatar issuer={account.issuer} label={account.label} size={44} />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[1.3rem]">{account.issuer !== '' ? account.issuer : account.label}</h1>
            <p className="truncate text-[0.8rem]" style={{ color: 'var(--text-muted)' }}>
              {account.label}
            </p>
          </div>
        </div>
        <div className="card mt-5 p-5" data-testid="trash-detail">
          <p className="text-[0.9rem]">{t('trash.banner')}</p>
          <p className="mt-1 text-[0.78rem]" style={{ color: 'var(--clay)' }}>
            {t('trash.expiresIn', { days })}
          </p>
          {account.notes !== undefined && account.notes !== '' && (
            <p className="mt-3 whitespace-pre-wrap text-[0.84rem]" style={{ color: 'var(--text-muted)' }}>
              {account.notes}
            </p>
          )}
          <hr className="rule my-4" />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary" onClick={() => void handleRestore()}>
              {t('trash.restore')}
            </button>
            <button type="button" className="btn btn-danger" onClick={() => setPurgeOpen(true)}>
              {t('trash.purge')}
            </button>
          </div>
        </div>
        <Modal
          open={purgeOpen}
          title={t('trash.purge')}
          onClose={() => setPurgeOpen(false)}
          width="sm"
          footer={
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setPurgeOpen(false)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="btn btn-danger" onClick={() => void handlePurge()}>
                {t('trash.purge')}
              </button>
            </>
          }
        >
          <p className="text-[0.88rem] leading-relaxed">{t('trash.purgeConfirm', { title: account.issuer || account.label })}</p>
        </Modal>
      </main>
    );
  }

  const canSave = draft.secret.trim() !== '' && (draft.issuer.trim() !== '' || draft.label.trim() !== '');

  async function handleSave(): Promise<void> {
    if (account === null || draft === null) return;
    const updated = draftToAccount(draft, account, account.id, new Date().toISOString());
    try {
      await upsertAccount(updated);
    } catch {
      toast(t('common.error'), 'error');
      return;
    }
    toast(t('detail.updated'), 'success');
    navigate('/');
  }

  async function handleDelete(): Promise<void> {
    if (account === null) return;
    setDeleteOpen(false);
    try {
      await removeAccount(account.id);
    } catch {
      toast(t('common.error'), 'error');
      return;
    }
    toast(t('detail.deleted'), 'success');
    navigate('/');
  }

  async function handleRestore(): Promise<void> {
    if (account === null) return;
    try {
      await restoreAccount(account.id);
      toast(t('trash.restored'), 'success');
    } catch {
      toast(t('common.error'), 'error');
    }
  }

  async function handlePurge(): Promise<void> {
    if (account === null) return;
    setPurgeOpen(false);
    try {
      await purgeAccount(account.id);
      toast(t('trash.purged'), 'success');
      navigate('/trash');
    } catch {
      toast(t('common.error'), 'error');
    }
  }

  async function handleCopyUri(): Promise<void> {
    if (account === null) return;
    const uri = buildOtpauthUri(account);
    const ok = await copyText(uri);
    if (ok) {
      void scheduleClipboardClear(uri, settings.clearClipboard).then((outcome) => {
        if (outcome === 'failed') toast(t('common.clipboardClearFailed'), 'warning');
      });
    }
    toast(ok ? t('common.copied') : t('common.copyFailed'), ok ? 'success' : 'error');
  }

  async function handleDownloadQr(): Promise<void> {
    if (account === null) return;
    try {
      const blob = await renderQrPng(buildOtpauthUri(account), 640);
      downloadBlob(blob, `zekey-${(account.issuer || account.label || 'account').replace(/[^\w-]+/g, '-')}-${timestampForFilename()}.png`);
    } catch {
      toast(t('common.error'), 'error');
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 pt-5 pb-8">
      <button type="button" className="btn btn-ghost -ml-2 text-[0.82rem]" onClick={() => navigate('/')}>
        ← {t('common.back')}
      </button>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Avatar issuer={account.issuer} label={account.label} size={44} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[1.3rem]">{account.issuer !== '' ? account.issuer : account.label}</h1>
          <p className="truncate text-[0.8rem]" style={{ color: 'var(--text-muted)' }}>
            {account.label}
          </p>
        </div>
        <div className="ml-auto shrink-0">
          <Code code={code} size="lg" />
        </div>
      </div>

      <div className="card mt-5 p-5">
        <AccountForm value={draft} onChange={setDraft} showAdvancedByDefault idPrefix="edit" />
        <hr className="rule my-4" />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-primary w-full sm:w-auto"
            onClick={() => void handleSave()}
            disabled={!canSave}
            data-testid="save-changes"
          >
            {t('common.save')}
          </button>
          <button type="button" className="btn btn-secondary flex-1 sm:flex-none" onClick={() => setQrOpen(true)}>
            {t('detail.showQr')}
          </button>
          <button type="button" className="btn btn-secondary flex-1 sm:flex-none" onClick={() => void handleCopyUri()}>
            {t('detail.copyUri')}
          </button>
        </div>

        {/*
          削除は取り返しがつかないので、保存ボタンに並べず、説明を添えて一段下に置く。
          スマホでは横幅いっぱいにして、迷わず押せる位置にする。
        */}
        <hr className="rule my-4" />
        <div className="flex flex-col gap-2 sm:flex-row-reverse sm:items-center sm:justify-between">
          <button
            type="button"
            className="btn btn-danger w-full sm:w-auto"
            onClick={() => setDeleteOpen(true)}
            data-testid="delete-account-detail"
          >
            {t('detail.delete')}
          </button>
          <p className="text-[0.76rem] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
            {t('detail.deleteHint')}
          </p>
        </div>
      </div>

      <Modal
        open={deleteOpen}
        title={t('detail.delete')}
        onClose={() => setDeleteOpen(false)}
        width="sm"
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setDeleteOpen(false)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void handleDelete()}>
              {t('common.delete')}
            </button>
          </>
        }
      >
        <p className="text-[0.88rem]">{t('list.deleteToTrashConfirm', { title: account.issuer || account.label })}</p>
      </Modal>

      <Modal
        open={qrOpen}
        title={t('detail.qr.title')}
        onClose={() => setQrOpen(false)}
        width="sm"
        footer={
          <button type="button" className="btn btn-secondary" onClick={() => void handleDownloadQr()}>
            {t('detail.qr.download')}
          </button>
        }
      >
        <p className="mb-3 text-[0.8rem]" style={{ color: 'var(--clay)' }}>
          {t('detail.qr.warning')}
        </p>
        {qrDataUrl.error ? (
          <p className="field-error" role="alert">
            {t('common.qrTooLarge')}
          </p>
        ) : qrDataUrl.dataUrl !== null ? (
          <img
            src={qrDataUrl.dataUrl}
            alt={t('detail.qr.title')}
            className="mx-auto block w-full max-w-[260px] rounded-md"
            data-testid="account-qr"
          />
        ) : (
          <p className="text-[0.82rem]" style={{ color: 'var(--text-faint)' }}>
            {t('common.loading')}
          </p>
        )}
      </Modal>
    </main>
  );
}
