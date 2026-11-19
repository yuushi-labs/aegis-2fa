import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Account } from '../../shared/types';
import { isMigrationUri, isOtpauthUri, parseOtpauthUri, toAccountDraft } from '../../shared/otpauth';
import { MigrationError, migrationEntryToAccount, parseMigrationUri } from '../../shared/migration';
import { findDuplicates } from '../../shared/merge';
import { AccountForm } from '../components/AccountForm';
import { EMPTY_DRAFT, draftToAccount, type AccountDraft } from '../lib/accountDraft';
import { useI18n, useToast } from '../lib/hooks';
import { makeAccountId, useVaultStore } from '../lib/vaultStore';
import { startCameraScanner, decodeImageFile, hasBarcodeDetector, type ScannerHandle } from '../lib/qr';

type Tab = 'manual' | 'qr' | 'image' | 'migration';

type MigrationPreview = {
  entries: ReturnType<typeof parseMigrationUri>['entries'];
  skipped: number;
  skipReasons: string[];
  duplicates: number;
};

export function AddPage() {
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const upsertAccount = useVaultStore((state) => state.upsertAccount);
  const accounts = useVaultStore((state) => state.accounts);

  const [tab, setTab] = useState<Tab>('manual');
  const [draft, setDraft] = useState<AccountDraft>({ ...EMPTY_DRAFT });
  const [uriInput, setUriInput] = useState('');
  const [saving, setSaving] = useState(false);

  function applyUri(uri: string): boolean {
    try {
      if (isMigrationUri(uri)) {
        setTab('migration');
        setMigrationUri(uri);
        return true;
      }
      if (!isOtpauthUri(uri)) return false;
      const params = parseOtpauthUri(uri);
      const accountDraft = toAccountDraft(params);
      setDraft({
        type: accountDraft.type,
        issuer: accountDraft.issuer,
        label: accountDraft.label,
        secret: accountDraft.secret,
        algorithm: accountDraft.algorithm,
        digits: accountDraft.digits,
        period: accountDraft.period,
        counter: accountDraft.counter,
      });
      setTab('manual');
      toast(t('add.parse'), 'success');
      return true;
    } catch {
      return false;
    }
  }

  const [migrationUri, setMigrationUri] = useState('');

  async function handleSave(): Promise<void> {
    if (saving) return;
    const nowIso = new Date().toISOString();
    const account = draftToAccount(draft, null, makeAccountId(), nowIso);
    if (account.secret === '' || (account.issuer === '' && account.label === '')) return;
    const duplicates = findDuplicates(accounts, [account]);
    if (duplicates.size > 0 && !window.confirm(t('add.duplicate.confirm'))) return;
    setSaving(true);
    try {
      await upsertAccount(account);
      toast(t('add.saved'), 'success');
      navigate('/');
    } finally {
      setSaving(false);
    }
  }

  const canSave =
    draft.secret.trim() !== '' &&
    (draft.issuer.trim() !== '' || draft.label.trim() !== '') &&
    !saving;

  return (
    <main className="mx-auto max-w-2xl px-4 pt-5 pb-6">
      <h1 className="text-[1.35rem]">{t('add.title')}</h1>

      <div role="tablist" aria-label={t('add.title')} className="mt-4 flex gap-1 overflow-x-auto pb-1">
        {(
          [
            ['manual', t('add.tab.manual')],
            ['qr', t('add.tab.qr')],
            ['image', t('add.tab.image')],
            ['migration', t('add.tab.migration')],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            type="button"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`btn shrink-0 text-[0.8rem] ${tab === key ? 'btn-secondary' : 'btn-ghost'}`}
            style={tab === key ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
            data-testid={`tab-${key}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="card mt-3 p-5">
        {tab === 'manual' && (
          <>
            <div className="mb-4">
              <label className="field-label" htmlFor="uri-input">
                {t('add.uri')}
              </label>
              <div className="flex gap-2">
                <input
                  id="uri-input"
                  type="text"
                  value={uriInput}
                  onChange={(event) => setUriInput(event.target.value)}
                  placeholder="otpauth://totp/..."
                  spellCheck={false}
                  className="code-text text-[0.8rem]"
                />
                <button
                  type="button"
                  className="btn btn-secondary shrink-0 text-[0.8rem]"
                  onClick={() => {
                    if (!applyUri(uriInput)) toast(t('add.invalidUri'), 'error');
                  }}
                  disabled={uriInput.trim() === ''}
                >
                  {t('add.parse')}
                </button>
              </div>
              <p className="field-hint">{t('add.uriHint')}</p>
            </div>
            <hr className="rule mb-4" />
            <AccountForm value={draft} onChange={setDraft} idPrefix="add" />
            <div className="mt-5 flex items-center justify-end gap-2">
              <button type="button" className="btn btn-secondary" onClick={() => navigate('/')}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void handleSave()}
                disabled={!canSave}
                data-testid="save-account"
              >
                {t('common.add')}
              </button>
            </div>
          </>
        )}

        {tab === 'qr' && <QrScannerPanel onScan={applyUri} />}
        {tab === 'image' && <QrImagePanel onScan={applyUri} />}
        {tab === 'migration' && (
          <MigrationPanel initialUri={migrationUri} onDone={() => navigate('/')} />
        )}
      </div>
    </main>
  );
}

function QrScannerPanel({ onScan }: { onScan: (value: string) => boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const handleRef = useRef<ScannerHandle | null>(null);
  const startingRef = useRef(false);
  const cancelledRef = useRef(false);
  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia !== undefined;

  const stop = useCallback(() => {
    handleRef.current?.stop();
    handleRef.current = null;
    setActive(false);
  }, []);

  useEffect(() => {
    // StrictMode の再実行でも有効に戻す（cleanup で false のままにしない）。
    cancelledRef.current = false;
    return () => {
      // 画面を離れたら、開始待ちで後から返ってくる handle も即座に止める。
      cancelledRef.current = true;
      stop();
    };
  }, [stop]);

  async function start(): Promise<void> {
    const video = videoRef.current;
    if (video === null || startingRef.current || active) return;
    startingRef.current = true;
    setStarting(true);
    setError(null);
    try {
      const handle = await startCameraScanner(
        video,
        (value) => {
          stop();
          if (!onScan(value)) {
            setError(t('add.invalidUri'));
            toast(t('add.invalidUri'), 'error');
          }
        },
        (scannerError) => {
          setError(scannerError.message);
          stop();
        },
      );
      if (cancelledRef.current) {
        // 開始待ちの間にタブを離れた等。返ってきた handle は即停止する。
        handle.stop();
        return;
      }
      handleRef.current?.stop();
      handleRef.current = handle;
      setActive(true);
    } catch (scannerError) {
      const name = scannerError instanceof Error ? scannerError.message : 'camera_error';
      setError(name === 'camera_unsupported' ? t('qr.unsupported') : t('qr.denied'));
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }

  return (
    <div>
      <p className="text-[0.86rem] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        {t('qr.lead')}
      </p>
      {!supported ? (
        <p className="field-error mt-3">{t('qr.unsupported')}</p>
      ) : (
        <>
          <div
            className="mt-3 overflow-hidden rounded-lg"
            style={{ background: '#0d0f10', aspectRatio: '4 / 3', border: '1px solid var(--border)' }}
          >
            <video
              ref={videoRef}
              className="h-full w-full object-cover"
              aria-label={t('qr.lead')}
              data-testid="qr-video"
            />
          </div>
          {error !== null && <p className="field-error mt-2">{error}</p>}
          <div className="mt-3 flex items-center gap-2">
            {active ? (
              <button type="button" className="btn btn-secondary" onClick={stop}>
                {t('qr.stop')}
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={() => void start()} disabled={starting}>
                {starting ? t('common.loading') : t('qr.start')}
              </button>
            )}
            <span className="text-[0.72rem]" style={{ color: 'var(--text-faint)' }}>
              {hasBarcodeDetector() ? 'BarcodeDetector' : 'jsQR'}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function QrImagePanel({ onScan }: { onScan: (value: string) => boolean }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    // StrictMode の再実行でも有効に戻す。
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function handleFile(file: File): Promise<void> {
    const requestId = (requestRef.current += 1);
    const isLatest = (): boolean => requestRef.current === requestId && mountedRef.current;
    setBusy(true);
    setError(null);
    try {
      const value = await decodeImageFile(file);
      // 画像 A の解析中に画像 B が選ばれた場合、古い結果は適用しない。
      if (!isLatest()) return;
      if (value === null) {
        setError(t('migration.invalid'));
        return;
      }
      if (!onScan(value)) setError(t('add.invalidUri'));
    } catch {
      if (!isLatest()) return;
      setError(t('migration.invalid'));
    } finally {
      if (isLatest()) setBusy(false);
    }
  }

  return (
    <div>
      <p className="text-[0.86rem] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        {t('qr.imageLead')}
      </p>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="mt-3 block w-full text-[0.82rem]"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file !== undefined) void handleFile(file);
        }}
        data-testid="qr-image-input"
      />
      {busy && (
        <p className="mt-2 flex items-center gap-2 text-[0.8rem]" style={{ color: 'var(--text-muted)' }}>
          <span className="spinner" /> {t('qr.scanning')}
        </p>
      )}
      {error !== null && <p className="field-error mt-2">{error}</p>}
    </div>
  );
}

type ParseOutcome =
  | { kind: 'empty' }
  | { kind: 'ok'; preview: MigrationPreview }
  | { kind: 'error'; message: string };

/** 同期的に移行 URI を解析する（effect での setState を避けるため純関数にする）。 */
function parseMigration(
  value: string,
  accounts: readonly Account[],
  invalidMessage: string,
): ParseOutcome {
  const trimmed = value.trim();
  if (trimmed === '') return { kind: 'empty' };
  try {
    const decoded = parseMigrationUri(
      isMigrationUri(trimmed) ? trimmed : `otpauth-migration://offline?data=${encodeURIComponent(trimmed)}`,
    );
    const drafts = decoded.entries.map((entry) => migrationEntryToAccount(entry, '', '', 0));
    return {
      kind: 'ok',
      preview: {
        entries: decoded.entries,
        skipped: decoded.skipped,
        skipReasons: decoded.skipReasons,
        duplicates: findDuplicates(accounts, drafts).size,
      },
    };
  } catch (parseError) {
    return {
      kind: 'error',
      message: parseError instanceof MigrationError ? parseError.message : invalidMessage,
    };
  }
}

function MigrationPanel({ initialUri, onDone }: { initialUri: string; onDone: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const accounts = useVaultStore((state) => state.accounts);
  const saveAccounts = useVaultStore((state) => state.saveAccounts);
  const [uri, setUri] = useState(initialUri);
  const [submitted, setSubmitted] = useState(initialUri);
  const [includeDuplicates, setIncludeDuplicates] = useState(false);
  const [busy, setBusy] = useState(false);

  const outcome = useMemo(
    () => parseMigration(submitted, accounts, t('migration.invalid')),
    [submitted, accounts, t],
  );
  const preview = outcome.kind === 'ok' ? outcome.preview : null;
  const error = outcome.kind === 'error' ? outcome.message : null;

  async function handleImport(): Promise<void> {
    if (preview === null) return;
    setBusy(true);
    try {
      const nowIso = new Date().toISOString();
      const drafts = preview.entries.map((entry) => migrationEntryToAccount(entry, '', '', 0));
      const duplicateIndexes = findDuplicates(accounts, drafts);
      const created: Account[] = [];
      drafts.forEach((entryDraft, index) => {
        if (!includeDuplicates && duplicateIndexes.has(index)) return;
        const account = draftToAccount(
          {
            type: entryDraft.type,
            issuer: entryDraft.issuer,
            label: entryDraft.label,
            secret: entryDraft.secret,
            algorithm: entryDraft.algorithm,
            digits: entryDraft.digits,
            period: entryDraft.period,
            counter: entryDraft.counter,
          },
          null,
          makeAccountId(),
          nowIso,
        );
        created.push({ ...account, order: accounts.length + created.length });
      });
      await saveAccounts([...accounts, ...created]);
      toast(t('migration.done', { count: created.length }), 'success');
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="text-[0.86rem] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        {t('migration.lead')}
      </p>
      <div className="mt-3">
        <label className="field-label" htmlFor="migration-uri">
          {t('migration.paste')}
        </label>
        <textarea
          id="migration-uri"
          rows={3}
          value={uri}
          onChange={(event) => setUri(event.target.value)}
          placeholder="otpauth-migration://offline?data=..."
          className="code-text text-[0.76rem]"
          spellCheck={false}
          data-testid="migration-input"
        />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button type="button" className="btn btn-secondary" onClick={() => setSubmitted(uri)} disabled={uri.trim() === ''}>
          {t('migration.parse')}
        </button>
      </div>

      {error !== null && (
        <p className="field-error mt-3" role="alert">
          {error}
        </p>
      )}

      {preview !== null && (
        <div className="mt-4">
          <hr className="rule mb-3" />
          <p className="text-[0.88rem] font-medium">{t('migration.found', { count: preview.entries.length })}</p>
          {preview.skipped > 0 && (
            <div className="mt-2 rounded-lg px-3 py-2 text-[0.78rem]" style={{ background: 'var(--clay-soft)', color: 'var(--clay)' }}>
              <p>{t('migration.skipped', { count: preview.skipped })}</p>
              <ul className="mt-1 list-inside list-disc">
                {preview.skipReasons.map((reason, index) => (
                  <li key={index}>{reason}</li>
                ))}
              </ul>
            </div>
          )}
          {preview.duplicates > 0 && (
            <div className="mt-2 rounded-lg px-3 py-2 text-[0.78rem]" style={{ background: 'var(--surface-sunken)' }}>
              <p>{t('migration.duplicates', { count: preview.duplicates })}</p>
              <label className="mt-1.5 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={includeDuplicates}
                  onChange={(event) => setIncludeDuplicates(event.target.checked)}
                />
                <span>{t('migration.duplicatesAdd')}</span>
              </label>
            </div>
          )}
          <ul className="mt-3 flex max-h-56 flex-col gap-1.5 overflow-y-auto">
            {preview.entries.map((entry, index) => (
              <li
                key={`${entry.name}-${index}`}
                className="flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-[0.8rem]"
                style={{ background: 'var(--surface-sunken)' }}
              >
                <span className="truncate">
                  {entry.issuer !== '' ? `${entry.issuer} · ` : ''}
                  {entry.name !== '' ? entry.name : '—'}
                </span>
                <span className="code-text shrink-0 text-[0.7rem]" style={{ color: 'var(--text-faint)' }}>
                  {entry.type.toUpperCase()} {entry.digits}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="btn btn-primary" onClick={() => void handleImport()} disabled={busy || preview.entries.length === 0}>
              {t('migration.import')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
