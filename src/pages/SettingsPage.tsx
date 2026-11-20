import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MIN_PASSWORD_LENGTH } from '../../shared/types';
import type { VaultEnvelope } from '../../shared/types';
import { encodeMigrationPayload, partitionMigratableAccounts } from '../../shared/migration';
import { CryptoError, WrongPasswordError } from '../../shared/crypto';
import { formatSyncCode } from '../../shared/sync';
import { AUTO_LOCK_OPTIONS, type AutoLockMinutes, type ThemeMode } from '../lib/settings';
import { useI18n, useToast } from '../lib/hooks';
import { useVaultStore, VaultChangedError, VaultLockedError } from '../lib/vaultStore';
import { Modal } from '../components/Modal';
import { copyText, scheduleClipboardClear } from '../lib/clipboard';
import { downloadBlob, formatTime, timestampForFilename } from '../lib/format';
import { renderQrPng } from '../lib/qr';
import { useQrDataUrl } from '../lib/useQrDataUrl';

type SectionProps = { title: string; children: React.ReactNode; id?: string };

function Section({ title, children, id }: SectionProps) {
  return (
    <section className="card p-5" id={id}>
      <h2 className="text-[1.02rem]">{title}</h2>
      <div className="mt-3.5 flex flex-col gap-4">{children}</div>
    </section>
  );
}

export function SettingsPage() {
  const { t, language } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();

  const settings = useVaultStore((state) => state.settings);
  const updateSettings = useVaultStore((state) => state.updateSettings);
  const token = useVaultStore((state) => state.token);
  const syncState = useVaultStore((state) => state.syncState);
  const lastSyncedAt = useVaultStore((state) => state.lastSyncedAt);
  const disableSync = useVaultStore((state) => state.disableSync);
  const changePassword = useVaultStore((state) => state.changePassword);
  const accounts = useVaultStore((state) => state.accounts);
  const envelope = useVaultStore((state) => state.envelope);
  const syncNow = useVaultStore((state) => state.syncNow);
  const importEnvelope = useVaultStore((state) => state.importEnvelope);
  const wipe = useVaultStore((state) => state.wipe);
  const lock = useVaultStore((state) => state.lock);

  const [revealToken, setRevealToken] = useState(false);
  const [syncQrOpen, setSyncQrOpen] = useState(false);

  const [disableOpen, setDisableOpen] = useState(false);
  const [csvOpen, setCsvOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [migrationOpen, setMigrationOpen] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [importMode, setImportMode] = useState<'replace' | 'merge'>('merge');
  const [importPassword, setImportPassword] = useState('');
  const [pendingImport, setPendingImport] = useState<VaultEnvelope | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // QR は描画時に生成する（モーダルが開いている間だけ）。
  const syncQr = useQrDataUrl(
    syncQrOpen && token !== null ? `${window.location.origin}/sync?code=${token}` : null,
    240,
  );
  // 移行形式は周期を持てないため、30 秒以外の TOTP は黙って含めない。
  const migration = partitionMigratableAccounts(accounts);
  const migrationQrText = migrationOpen && migration.unsupported.length === 0 && migration.entries.length > 0
    ? safeEncodeMigration(migration)
    : null;
  const migrationQr = useQrDataUrl(migrationQrText, 260);

  async function handleChangePassword(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setPasswordError(null);
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setPasswordError(t('setup.tooShort'));
      return;
    }
    setPasswordBusy(true);
    try {
      const ok = await changePassword(currentPassword, newPassword);
      if (ok) {
        toast(t('settings.password.changed'), 'success');
        setCurrentPassword('');
        setNewPassword('');
      } else {
        setPasswordError(t('lock.wrong'));
      }
    } finally {
      setPasswordBusy(false);
    }
  }

  async function handleBackupFile(file: File): Promise<void> {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { format?: string; envelope?: VaultEnvelope } & Partial<VaultEnvelope>;
      const candidate: VaultEnvelope =
        parsed.envelope !== undefined ? parsed.envelope : (parsed as VaultEnvelope);
      if (candidate.format !== 'aegis-vault') {
        toast(t('settings.import.invalid'), 'error');
        return;
      }
      setPendingImport(candidate);
    } catch {
      toast(t('settings.import.invalid'), 'error');
    }
  }

  async function handleConfirmImport(): Promise<void> {
    if (pendingImport === null) return;
    try {
      // 復号はストア側で行う（merge はバックアップ自身のパスワードで復号して現在の DEK で保存する）。
      const count = await importEnvelope(pendingImport, importMode, importPassword);
      toast(
        importMode === 'replace' ? t('toast.restored') : t('settings.import.success', { count }),
        'success',
      );
      setPendingImport(null);
      setImportPassword('');
      if (importMode === 'replace') {
        lock();
      } else {
        navigate('/');
      }
    } catch (error) {
      if (error instanceof VaultChangedError) {
        toast(t('settings.import.changed'), 'error');
        setPendingImport(null);
        setImportPassword('');
        return;
      }
      if (error instanceof VaultLockedError) {
        toast(t('conflict.mergeFailed'), 'error');
        setPendingImport(null);
        setImportPassword('');
        return;
      }
      if (error instanceof WrongPasswordError) {
        toast(t('settings.import.wrongPassword'), 'error');
      } else if (error instanceof CryptoError) {
        toast(t('settings.import.invalid'), 'error');
      } else {
        toast(t('settings.import.invalid'), 'error');
      }
    }
  }

  function downloadBackup(): void {
    if (envelope === null) return;
    const blob = new Blob([JSON.stringify({ format: 'aegis-backup', version: 1, exportedAt: new Date().toISOString(), envelope }, null, 2)], {
      type: 'application/json',
    });
    downloadBlob(blob, `aegis-backup-${timestampForFilename()}.aegis`);
  }

  function downloadCsv(): void {
    setCsvOpen(false);
    const header = ['issuer', 'label', 'secret', 'type', 'algorithm', 'digits', 'period', 'counter'];
    // 表計算ソフトが数式として評価する先頭文字を無効化する（CSV インジェクション対策）。
    const neutralise = (value: string): string =>
      /^[=+\-@\t\r]/.test(value) || value.startsWith('\u0000') ? `'${value}` : value;
    const escape = (value: string) => `"${neutralise(value).replace(/"/g, '""')}"`;
    const rows = accounts.map((account) =>
      [
        escape(account.issuer),
        escape(account.label),
        escape(account.secret),
        account.type,
        account.algorithm,
        String(account.digits),
        String(account.period),
        String(account.counter),
      ].join(','),
    );
    const blob = new Blob([[header.join(','), ...rows].join('\n')], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, `aegis-accounts-${timestampForFilename()}.csv`);
  }

  async function handleCopyToken(): Promise<void> {
    if (token === null) return;
    const ok = await copyText(token);
    if (ok) {
      void scheduleClipboardClear(token, settings.clearClipboard).then((outcome) => {
        if (outcome === 'failed') toast(t('common.clipboardClearFailed'), 'warning');
      });
    }
    toast(ok ? t('common.copied') : t('common.copyFailed'), ok ? 'success' : 'error');
  }

  async function handleDownloadMigrationQr(): Promise<void> {
    if (migrationQrText === null) return;
    try {
      const blob = await renderQrPng(migrationQrText, 640);
      downloadBlob(blob, `aegis-migration-${timestampForFilename()}.png`);
    } catch {
      toast(t('common.error'), 'error');
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 pt-5 pb-8">
      <h1 className="text-[1.35rem]">{t('settings.title')}</h1>

      <div className="mt-4 flex flex-col gap-4">
        <Section title={t('settings.security')}>
          <div>
            <label className="field-label" htmlFor="auto-lock">
              {t('settings.autoLock')}
            </label>
            <select
              id="auto-lock"
              value={settings.autoLockMinutes}
              onChange={(event) =>
                void updateSettings({ autoLockMinutes: Number.parseInt(event.target.value, 10) as AutoLockMinutes })
              }
              aria-describedby="auto-lock-hint"
              data-testid="auto-lock-select"
            >
              {AUTO_LOCK_OPTIONS.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes === 0 ? t('common.never') : t('settings.autoLockValue', { minutes })}
                </option>
              ))}
            </select>
            <p id="auto-lock-hint" className="field-hint">
              {settings.autoLockMinutes === 0 ? t('settings.autoLockNeverHint') : t('settings.autoLockHint')}
            </p>
          </div>

          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span className="text-[0.88rem]">{t('settings.lockOnHide')}</span>
            <input
              type="checkbox"
              checked={settings.lockOnHide}
              onChange={(event) => void updateSettings({ lockOnHide: event.target.checked })}
            />
          </label>

          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span className="text-[0.88rem]">{t('settings.clipboard')}</span>
            <input
              type="checkbox"
              checked={settings.clearClipboard}
              onChange={(event) => void updateSettings({ clearClipboard: event.target.checked })}
            />
          </label>

          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span className="text-[0.88rem]">{t('settings.announce')}</span>
            <input
              type="checkbox"
              checked={settings.announceCodes}
              onChange={(event) => void updateSettings({ announceCodes: event.target.checked })}
            />
          </label>

          <div>
            <label className="field-label" htmlFor="clock-skew">
              {t('settings.clockSkew')}
            </label>
            <select
              id="clock-skew"
              value={settings.clockSkew}
              onChange={(event) => void updateSettings({ clockSkew: Number.parseInt(event.target.value, 10) })}
            >
              {[-2, -1, 0, 1, 2].map((value) => (
                <option key={value} value={value}>
                  {t('settings.skewValue', { value: value > 0 ? `+${value}` : String(value) })}
                </option>
              ))}
            </select>
            <p className="field-hint">{t('settings.clockSkewHint')}</p>
          </div>

          <hr className="rule" />
          <form onSubmit={(event) => void handleChangePassword(event)} className="flex flex-col gap-3">
            <p className="text-[0.88rem] font-medium">{t('settings.password')}</p>
            <div>
              <label className="field-label" htmlFor="current-password">
                {t('settings.password.current')}
              </label>
              <input
                id="current-password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="new-password">
                {t('settings.password.new')}
              </label>
              <input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </div>
            {passwordError !== null && <p className="field-error">{passwordError}</p>}
            <button
              type="submit"
              className="btn btn-secondary self-start"
              disabled={passwordBusy || currentPassword === '' || newPassword === ''}
            >
              {t('common.save')}
            </button>
          </form>
        </Section>

        <Section title={t('settings.display')}>
          <div>
            <span className="field-label">{t('settings.theme')}</span>
            <div className="flex gap-1.5">
              {(
                [
                  ['system', t('settings.theme.system')],
                  ['light', t('settings.theme.light')],
                  ['dark', t('settings.theme.dark')],
                ] as [ThemeMode, string][]
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  className={`btn flex-1 text-[0.8rem] ${settings.theme === mode ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => void updateSettings({ theme: mode })}
                  aria-pressed={settings.theme === mode}
                  data-testid={`theme-${mode}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="field-label" htmlFor="language">
              {t('settings.language')}
            </label>
            <select
              id="language"
              value={settings.language}
              onChange={(event) =>
                void updateSettings({ language: event.target.value as 'ja' | 'en' | 'auto' })
              }
            >
              <option value="auto">{t('settings.language.auto')}</option>
              <option value="ja">日本語</option>
              <option value="en">English</option>
            </select>
          </div>
        </Section>

        <Section title={t('settings.sync')}>
          {token === null ? (
            <div>
              <p className="text-[0.86rem]" style={{ color: 'var(--text-muted)' }}>
                {t('settings.sync.local')}
              </p>
              <button type="button" className="btn btn-secondary mt-3" onClick={() => navigate('/sync')}>
                {t('sync.submit')}
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[0.86rem]" style={{ color: 'var(--text-muted)' }}>
                  {t('settings.sync.status')}
                </span>
                <span
                  className={`badge ${syncState === 'synced' ? 'badge-accent' : syncState === 'error' ? 'badge-danger' : 'badge-clay'}`}
                  data-testid="sync-status"
                >
                  {t(`settings.sync.status.${syncState === 'local-only' ? 'local' : syncState}` as never)}
                </span>
              </div>
              <p className="text-[0.78rem]" style={{ color: 'var(--text-faint)' }}>
                {t('settings.sync.lastSynced', { time: formatTime(lastSyncedAt, language) })}
              </p>
              <div>
                <span className="field-label">{t('settings.sync.code')}</span>
                <div className="flex flex-wrap items-center gap-2">
                  <code
                    className="code-text flex-1 break-all rounded-md px-2.5 py-1.5 text-[0.78rem]"
                    style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border)' }}
                    data-testid="sync-code-value"
                  >
                    {revealToken ? formatSyncCode(token) : '•'.repeat(16)}
                  </code>
                  <button type="button" className="btn btn-ghost text-[0.78rem]" onClick={() => setRevealToken((v) => !v)}>
                    {revealToken ? t('settings.sync.hide') : t('settings.sync.reveal')}
                  </button>
                  <button type="button" className="btn btn-ghost text-[0.78rem]" onClick={() => void handleCopyToken()}>
                    {t('settings.sync.copy')}
                  </button>
                  <button type="button" className="btn btn-ghost text-[0.78rem]" onClick={() => setSyncQrOpen(true)}>
                    {t('settings.sync.qr')}
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn btn-secondary text-[0.82rem]" onClick={() => void syncNow()}>
                  {t('toast.synced')}
                </button>
                <button type="button" className="btn btn-danger text-[0.82rem]" onClick={() => setDisableOpen(true)}>
                  {t('settings.sync.disable')}
                </button>
              </div>
            </>
          )}
        </Section>

        <Section title={t('settings.export')}>
          <div className="flex flex-col gap-2">
            <button type="button" className="btn btn-secondary self-start" onClick={downloadBackup} disabled={envelope === null}>
              {t('settings.export.backup')}
            </button>
            <p className="field-hint -mt-1">{t('settings.export.backupHint')}</p>
          </div>
          <div className="flex flex-col gap-2">
            <button type="button" className="btn btn-secondary self-start" onClick={() => setCsvOpen(true)} disabled={accounts.length === 0}>
              {t('settings.export.csv')}
            </button>
            <p className="field-hint -mt-1" style={{ color: 'var(--clay)' }}>
              {t('settings.export.csvWarning')}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-secondary self-start"
            onClick={() => setMigrationOpen(true)}
            disabled={accounts.length === 0}
          >
            {t('settings.export.migrationQr')}
          </button>
        </Section>

        <Section title={t('settings.import')}>
          <div>
            <label className="field-label" htmlFor="backup-file-input">
              {t('settings.import.backup')}
            </label>
            <input
              ref={fileRef}
              id="backup-file-input"
              type="file"
              accept=".aegis,application/json"
              className="block w-full text-[0.82rem]"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file !== undefined) void handleBackupFile(file);
                event.target.value = '';
              }}
              data-testid="backup-file-input"
            />
            <p className="field-hint">{t('settings.export.backupHint')}</p>
          </div>
        </Section>

        <Section title={t('settings.about')}>
          <p className="text-[0.86rem] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {t('settings.about.lead')}
          </p>
          <p className="text-[0.76rem]" style={{ color: 'var(--text-faint)' }}>
            {t('settings.about.storage')}
          </p>
        </Section>

        <Section title={t('settings.danger')}>
          <button type="button" className="btn btn-danger self-start" onClick={() => setResetOpen(true)}>
            {t('settings.reset')}
          </button>
        </Section>
      </div>

      <Modal
        open={syncQrOpen}
        title={t('settings.sync.qr')}
        onClose={() => setSyncQrOpen(false)}
        width="sm"
      >
        <p className="mb-3 text-[0.8rem]" style={{ color: 'var(--clay)' }}>
          {t('detail.qr.warning')}
        </p>
        {syncQr.error ? (
          <p className="field-error" role="alert">
            {t('common.qrTooLarge')}
          </p>
        ) : syncQr.dataUrl !== null ? (
          <img
            src={syncQr.dataUrl}
            alt={t('settings.sync.qr')}
            className="mx-auto block w-full max-w-[240px] rounded-md"
          />
        ) : (
          <p className="text-[0.82rem]">{t('common.loading')}</p>
        )}
        <p className="code-text mt-3 break-all text-[0.74rem]">{token === null ? '' : formatSyncCode(token)}</p>
      </Modal>

      <Modal
        open={disableOpen}
        title={t('settings.sync.disable')}
        onClose={() => setDisableOpen(false)}
        width="sm"
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setDisableOpen(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                setDisableOpen(false);
                void disableSync();
              }}
            >
              {t('common.confirm')}
            </button>
          </>
        }
      >
        <p className="text-[0.88rem]">{t('settings.sync.disableConfirm')}</p>
      </Modal>

      <Modal
        open={csvOpen}
        title={t('settings.export.csv')}
        onClose={() => setCsvOpen(false)}
        width="sm"
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setCsvOpen(false)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn btn-primary" onClick={downloadCsv}>
              {t('common.download')}
            </button>
          </>
        }
      >
        <p className="text-[0.88rem]">{t('export.confirmCsv')}</p>
      </Modal>

      <Modal
        open={migrationOpen}
        title={t('settings.export.migrationQr')}
        onClose={() => setMigrationOpen(false)}
        width="sm"
        footer={
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void handleDownloadMigrationQr()}
            disabled={migrationQrText === null}
          >
            {t('common.download')}
          </button>
        }
      >
        <p className="mb-3 text-[0.8rem]" style={{ color: 'var(--clay)' }}>
          {t('export.migrationWarning')}
        </p>
        {migration.unsupported.length > 0 && (
          <p className="field-error mb-3" role="alert">
            {t('export.migrationPeriodUnsupported', { count: migration.unsupported.length })}
          </p>
        )}
        {migration.unsupported.length === 0 && migration.entries.length === 0 && (
          <p className="field-error mb-3" role="alert">
            {t('export.migrationNothingRepresentable')}
          </p>
        )}
        {migrationQr.error ? (
          <p className="field-error" role="alert">
            {t('common.qrTooLarge')}
          </p>
        ) : migrationQr.dataUrl !== null ? (
          <img
            src={migrationQr.dataUrl}
            alt={t('settings.export.migrationQr')}
            className="mx-auto block w-full max-w-[260px] rounded-md"
          />
        ) : (
          migrationQrText !== null && <p className="text-[0.82rem]">{t('common.loading')}</p>
        )}
      </Modal>

      <Modal
        open={resetOpen}
        title={t('settings.reset')}
        onClose={() => setResetOpen(false)}
        width="sm"
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setResetOpen(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                setResetOpen(false);
                void wipe();
              }}
            >
              {t('common.delete')}
            </button>
          </>
        }
      >
        <p className="text-[0.88rem]">{t('lock.resetConfirm')}</p>
      </Modal>

      <Modal
        open={pendingImport !== null}
        title={t('settings.import.backup')}
        onClose={() => {
          setPendingImport(null);
          setImportPassword('');
        }}
        width="sm"
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setPendingImport(null);
                setImportPassword('');
              }}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleConfirmImport()}
              disabled={importPassword === ''}
            >
              {t('common.confirm')}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div>
            <label className="field-label" htmlFor="import-password">
              {t('lock.password')}
            </label>
            <input
              id="import-password"
              type="password"
              autoComplete="current-password"
              value={importPassword}
              onChange={(event) => setImportPassword(event.target.value)}
            />
          </div>
          <fieldset>
            <legend className="field-label">{t('settings.import.backup')}</legend>
            <div className="flex gap-1.5">
              {(
                [
                  ['merge', t('settings.import.merge')],
                  ['replace', t('settings.import.replace')],
                ] as ['merge' | 'replace', string][]
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  className={`btn flex-1 text-[0.8rem] ${importMode === mode ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setImportMode(mode)}
                  aria-pressed={importMode === mode}
                >
                  {label}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
      </Modal>
    </main>
  );
}

/** 移行 URI を組み立てる。表現できない周期が混ざっている場合は null（呼び出し側で案内する）。 */
function safeEncodeMigration(partition: ReturnType<typeof partitionMigratableAccounts>): string | null {
  if (partition.unsupported.length > 0 || partition.entries.length === 0) return null;
  try {
    return encodeMigrationPayload(partition.entries);
  } catch {
    return null;
  }
}
