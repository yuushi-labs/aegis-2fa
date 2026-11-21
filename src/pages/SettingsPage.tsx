import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MIN_PASSWORD_LENGTH } from '../../shared/types';
import type { VaultEnvelope, PasskeyRecord } from '../../shared/types';
import { encodeMigrationPayload, partitionMigratableAccounts } from '../../shared/migration';
import { CryptoError, WrongPasswordError } from '../../shared/crypto';
import { formatSyncCode } from '../../shared/sync';
import { AppLoginButton } from '../components/AppLoginButton';
import { AUTO_LOCK_OPTIONS, type AutoLockMinutes, type ThemeMode } from '../lib/settings';
import { useI18n, useToast } from '../lib/hooks';
import { useVaultStore, VaultChangedError, VaultLockedError } from '../lib/vaultStore';
import { isPasskeyAvailable } from '../lib/passkeys';
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
  const passkeys = useVaultStore((state) => state.passkeys);
  const profiles = useVaultStore((state) => state.profiles);
  const activeProfileId = useVaultStore((state) => state.activeProfileId);
  const createProfile = useVaultStore((state) => state.createProfile);
  const switchProfile = useVaultStore((state) => state.switchProfile);
  const renameProfile = useVaultStore((state) => state.renameProfile);
  const deleteProfile = useVaultStore((state) => state.deleteProfile);
  const devices = useVaultStore((state) => state.devices);
  const deviceId = useVaultStore((state) => state.deviceId);
  const deviceName = useVaultStore((state) => state.deviceName);
  const renameDevice = useVaultStore((state) => state.renameDevice);
  const forgetDevice = useVaultStore((state) => state.forgetDevice);
  const registerPasskey = useVaultStore((state) => state.registerPasskey);
  const removePasskey = useVaultStore((state) => state.removePasskey);

  const [revealToken, setRevealToken] = useState(false);
  const [syncQrOpen, setSyncQrOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [profileToDelete, setProfileToDelete] = useState<{ id: string; name: string } | null>(null);
  const [profileToRename, setProfileToRename] = useState<{ id: string; name: string } | null>(null);
  const [profileRenameValue, setProfileRenameValue] = useState('');
  const [deviceRenameOpen, setDeviceRenameOpen] = useState(false);
  const [deviceRenameValue, setDeviceRenameValue] = useState('');
  const [deviceToRemove, setDeviceToRemove] = useState<{ id: string; name: string } | null>(null);

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

  const [passkeyName, setPasskeyName] = useState('');
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [passkeyToDelete, setPasskeyToDelete] = useState<PasskeyRecord | null>(null);
  const passkeysAvailable = isPasskeyAvailable();

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

  async function handleCreateProfile(): Promise<void> {
    await createProfile(newProfileName);
    setNewProfileName('');
    toast(t('profiles.added'), 'success');
  }

  async function handleRenameProfile(): Promise<void> {
    if (profileToRename === null) return;
    await renameProfile(profileToRename.id, profileRenameValue);
    setProfileToRename(null);
    toast(t('profiles.renamed'), 'success');
  }

  async function handleDeleteProfile(): Promise<void> {
    if (profileToDelete === null) return;
    const target = profileToDelete;
    setProfileToDelete(null);
    await deleteProfile(target.id);
    toast(t('profiles.removed'), 'success');
  }

  async function handleRenameDevice(): Promise<void> {
    await renameDevice(deviceRenameValue);
    setDeviceRenameOpen(false);
    toast(t('settings.devices.renamed'), 'success');
  }

  async function handleRemoveDevice(): Promise<void> {
    if (deviceToRemove === null) return;
    const target = deviceToRemove;
    setDeviceToRemove(null);
    await forgetDevice(target.id);
    toast(t('settings.devices.removed'), 'success');
  }

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

  async function handleRegisterPasskey(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (passkeyBusy) return;
    setPasskeyBusy(true);
    setPasskeyError(null);
    try {
      const result = await registerPasskey(passkeyName.trim() === '' ? t('settings.passkeys.defaultName') : passkeyName);
      if (result.ok) {
        toast(t('settings.passkeys.registered'), 'success');
        setPasskeyName('');
        return;
      }
      // キャンセルは利用者の操作なのでエラー色にしない。
      if (result.reason === 'cancelled') {
        toast(t('settings.passkeys.cancelled'), 'warning');
        return;
      }
      setPasskeyError(
        result.reason === 'prf_unsupported'
          ? t('settings.passkeys.prfUnsupported')
          : result.reason === 'unavailable'
            ? t('settings.passkeys.unavailable')
            : t('settings.passkeys.failed'),
      );
    } finally {
      setPasskeyBusy(false);
    }
  }

  async function handleDeletePasskey(): Promise<void> {
    if (passkeyToDelete === null) return;
    await removePasskey(passkeyToDelete.id);
    setPasskeyToDelete(null);
    toast(t('settings.passkeys.removed'), 'success');
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
        <Section title={t('profiles.title')}>
          <p className="field-hint">{t('profiles.lead')}</p>
          <ul className="flex flex-col" data-testid="profile-list">
            {profiles.map((profile) => {
              const isActive = profile.id === activeProfileId;
              return (
                <li
                  key={profile.id}
                  className="flex flex-wrap items-center gap-2 border-t py-2 first:border-t-0"
                  style={{ borderColor: 'var(--border)' }}
                  data-testid="profile-item"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[0.9rem]">
                      {profile.name}
                      {isActive && (
                        <span className="badge badge-accent ml-2 text-[0.64rem]" data-testid="profile-current">
                          {t('profiles.current')}
                        </span>
                      )}
                    </p>
                    <p className="text-[0.72rem]" style={{ color: 'var(--text-faint)' }}>
                      {formatTime(profile.createdAt, language)}
                    </p>
                  </div>
                  {!isActive && (
                    <button
                      type="button"
                      className="btn btn-secondary shrink-0 text-[0.76rem]"
                      onClick={() => void switchProfile(profile.id)}
                      data-testid="profile-use"
                    >
                      {t('profiles.switch')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost shrink-0 text-[0.76rem]"
                    onClick={() => {
                      setProfileToRename({ id: profile.id, name: profile.name });
                      setProfileRenameValue(profile.name);
                    }}
                    data-testid="profile-rename"
                  >
                    {t('profiles.rename')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost shrink-0 text-[0.76rem]"
                    style={{ color: 'var(--danger)' }}
                    disabled={profiles.length <= 1}
                    title={profiles.length <= 1 ? t('profiles.deleteLast') : t('profiles.delete')}
                    onClick={() => setProfileToDelete({ id: profile.id, name: profile.name })}
                    data-testid="profile-delete"
                  >
                    {t('profiles.delete')}
                  </button>
                </li>
              );
            })}
          </ul>
          <div>
            <label className="field-label" htmlFor="new-profile-name">
              {t('profiles.create')}
            </label>
            <div className="flex gap-2">
              <input
                id="new-profile-name"
                type="text"
                maxLength={32}
                value={newProfileName}
                onChange={(event) => setNewProfileName(event.target.value)}
                placeholder={t('profiles.namePlaceholder')}
                autoComplete="off"
                data-testid="new-profile-name"
              />
              <button
                type="button"
                className="btn btn-secondary shrink-0 text-[0.8rem]"
                onClick={() => void handleCreateProfile()}
                data-testid="profile-create"
              >
                {t('common.add')}
              </button>
            </div>
            <p className="field-hint">{t('profiles.deleteLast')}</p>
          </div>
        </Section>

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

        <Section title={t('settings.passkeys')}>
          <p className="field-hint">{t('settings.passkeys.lead')}</p>
          {passkeys.length === 0 ? (
            <p className="text-[0.86rem]" style={{ color: 'var(--text-muted)' }} data-testid="passkeys-empty">
              {t('settings.passkeys.empty')}
            </p>
          ) : (
            <>
              <p className="text-[0.78rem]" style={{ color: 'var(--text-faint)' }} data-testid="passkey-count">
                {t('settings.passkeys.count', { count: passkeys.length })}
              </p>
              <ul className="flex flex-col" data-testid="passkey-list">
                {passkeys.map((record) => (
                  <li
                    key={record.id}
                    className="flex items-center justify-between gap-3 border-t py-2 first:border-t-0"
                    style={{ borderColor: 'var(--border)' }}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[0.9rem]" data-testid="passkey-name">
                        {record.name}
                      </p>
                      <p className="text-[0.74rem]" style={{ color: 'var(--text-faint)' }}>
                        {t('settings.passkeys.registeredAt')}: {formatTime(record.createdAt, language)}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost shrink-0 text-[0.78rem]"
                      onClick={() => setPasskeyToDelete(record)}
                      data-testid="passkey-delete"
                    >
                      {t('settings.passkeys.delete')}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {passkeysAvailable ? (
            <form onSubmit={(event) => void handleRegisterPasskey(event)} className="flex flex-col gap-3">
              <div>
                <label className="field-label" htmlFor="passkey-name">
                  {t('settings.passkeys.name')}
                </label>
                <input
                  id="passkey-name"
                  type="text"
                  maxLength={64}
                  autoComplete="off"
                  placeholder={t('settings.passkeys.namePlaceholder')}
                  value={passkeyName}
                  onChange={(event) => setPasskeyName(event.target.value)}
                  data-testid="passkey-name-input"
                />
              </div>
              {passkeyError !== null && (
                <p className="field-error" role="alert" data-testid="passkey-register-error">
                  {passkeyError}
                </p>
              )}
              <button
                type="submit"
                className="btn btn-secondary self-start"
                disabled={passkeyBusy}
                data-testid="passkey-register"
              >
                {passkeyBusy ? t('settings.passkeys.registering') : t('settings.passkeys.register')}
              </button>
            </form>
          ) : (
            <p className="field-hint" data-testid="passkey-unavailable">
              {t('settings.passkeys.unavailable')}
            </p>
          )}
          <p className="field-hint" style={{ color: 'var(--clay)' }}>
            {t('settings.passkeys.warning')}
          </p>
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
                  <button
                    type="button"
                    className="btn btn-ghost text-[0.78rem]"
                    onClick={() => setSyncQrOpen(true)}
                    data-testid="sync-qr-open"
                  >
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

              <hr className="rule" />
              <div>
                <p className="text-[0.88rem] font-medium">{t('settings.devices')}</p>
                <p className="field-hint mt-1">{t('settings.devices.lead')}</p>
                <ul className="mt-2 flex flex-col" data-testid="device-list">
                  {devices.length === 0 && (
                    <li className="py-1 text-[0.82rem]" style={{ color: 'var(--text-faint)' }}>
                      {t('settings.devices.empty')}
                    </li>
                  )}
                  {devices.map((device) => {
                    const isSelf = device.id === deviceId;
                    const name = isSelf ? deviceName : device.name;
                    return (
                      <li
                        key={device.id}
                        className="flex flex-wrap items-center gap-2 border-t py-2 first:border-t-0"
                        style={{ borderColor: 'var(--border)' }}
                        data-testid="device-item"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[0.88rem]">
                            {name}
                            {isSelf && (
                              <span className="badge badge-accent ml-2 text-[0.62rem]" data-testid="device-self">
                                {t('settings.devices.thisDevice')}
                              </span>
                            )}
                          </p>
                          <p className="text-[0.72rem]" style={{ color: 'var(--text-faint)' }}>
                            {device.platform !== '' ? `${device.platform} · ` : ''}
                            {t('settings.devices.lastSynced', { time: formatTime(device.lastSyncedAt, language) })}
                          </p>
                        </div>
                        {isSelf ? (
                          <button
                            type="button"
                            className="btn btn-ghost shrink-0 text-[0.74rem]"
                            onClick={() => {
                              setDeviceRenameValue(deviceName);
                              setDeviceRenameOpen(true);
                            }}
                            data-testid="device-rename"
                          >
                            {t('settings.devices.rename')}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-ghost shrink-0 text-[0.74rem]"
                            style={{ color: 'var(--danger)' }}
                            onClick={() => setDeviceToRemove({ id: device.id, name })}
                            data-testid="device-remove"
                          >
                            {t('settings.devices.remove')}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </>
          )}

          <hr className="rule" />
          <div data-testid="app-login-section">
            <p className="text-[0.88rem] font-medium">{t('app.login.title')}</p>
            <div className="mt-2">
              <AppLoginButton />
            </div>
          </div>
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
          <hr className="rule" />
          <div className="flex flex-col gap-2">
            <p className="text-[0.88rem] font-medium">{t('settings.print.title')}</p>
            <p className="field-hint -mt-1">{t('settings.print.lead')}</p>
            <button
              type="button"
              className="btn btn-secondary self-start"
              onClick={() => setPrintOpen(true)}
              disabled={accounts.length === 0}
              data-testid="open-print-sheet"
            >
              {t('settings.print.open')}
            </button>
            <p className="field-hint -mt-1" style={{ color: 'var(--clay)' }}>
              {t('settings.print.warning')}
            </p>
          </div>
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
            data-testid="sync-qr-image"
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
        open={passkeyToDelete !== null}
        title={t('settings.passkeys.delete')}
        onClose={() => setPasskeyToDelete(null)}
        width="sm"
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setPasskeyToDelete(null)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void handleDeletePasskey()}>
              {t('common.delete')}
            </button>
          </>
        }
      >
        <p className="text-[0.88rem] leading-relaxed">{t('settings.passkeys.deleteConfirm')}</p>
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
        open={printOpen}
        title={t('settings.print.title')}
        onClose={() => setPrintOpen(false)}
        width="sm"
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setPrintOpen(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setPrintOpen(false);
                navigate('/print');
              }}
              data-testid="confirm-print-sheet"
            >
              {t('settings.print.confirm')}
            </button>
          </>
        }
      >
        <p className="text-[0.88rem] leading-relaxed" style={{ color: 'var(--clay)' }}>
          {t('settings.print.warning')}
        </p>
        <p className="mt-2 text-[0.82rem]" style={{ color: 'var(--text-muted)' }}>
          {t('print.accounts', { count: accounts.filter((account) => account.deletedAt === undefined).length })}
        </p>
      </Modal>

      <Modal
        open={profileToRename !== null}
        title={t('profiles.rename')}
        onClose={() => setProfileToRename(null)}
        width="sm"
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setProfileToRename(null)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void handleRenameProfile()} data-testid="profile-rename-save">
              {t('common.save')}
            </button>
          </>
        }
      >
        <label className="field-label" htmlFor="profile-rename-input">
          {t('profiles.nameLabel')}
        </label>
        <input
          id="profile-rename-input"
          type="text"
          maxLength={32}
          value={profileRenameValue}
          onChange={(event) => setProfileRenameValue(event.target.value)}
          data-testid="profile-rename-input"
        />
      </Modal>

      <Modal
        open={profileToDelete !== null}
        title={t('profiles.delete')}
        onClose={() => setProfileToDelete(null)}
        width="sm"
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setProfileToDelete(null)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void handleDeleteProfile()} data-testid="profile-delete-confirm">
              {t('common.delete')}
            </button>
          </>
        }
      >
        <p className="text-[0.88rem] leading-relaxed">
          {t('profiles.deleteConfirm', { name: profileToDelete?.name ?? '' })}
        </p>
      </Modal>

      <Modal
        open={deviceRenameOpen}
        title={t('settings.devices.rename')}
        onClose={() => setDeviceRenameOpen(false)}
        width="sm"
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setDeviceRenameOpen(false)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void handleRenameDevice()} data-testid="device-rename-save">
              {t('common.save')}
            </button>
          </>
        }
      >
        <label className="field-label" htmlFor="device-rename-input">
          {t('settings.devices.renamePrompt')}
        </label>
        <input
          id="device-rename-input"
          type="text"
          maxLength={64}
          value={deviceRenameValue}
          onChange={(event) => setDeviceRenameValue(event.target.value)}
          data-testid="device-rename-input"
        />
      </Modal>

      <Modal
        open={deviceToRemove !== null}
        title={t('settings.devices.remove')}
        onClose={() => setDeviceToRemove(null)}
        width="sm"
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setDeviceToRemove(null)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void handleRemoveDevice()} data-testid="device-remove-confirm">
              {t('common.delete')}
            </button>
          </>
        }
      >
        <p className="text-[0.88rem] leading-relaxed">
          {t('settings.devices.removeConfirm', { name: deviceToRemove?.name ?? '' })}
        </p>
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
