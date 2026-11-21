import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Account } from '../../shared/types';
import { isMigrationUri, isOtpauthUri, parseOtpauthUri, toAccountDraft } from '../../shared/otpauth';
import { MigrationError, migrationEntryToAccount, parseMigrationUri } from '../../shared/migration';
import { findDuplicates } from '../../shared/merge';
import { findAccountDuplicates, type DuplicateMatch } from '../../shared/duplicates';
import { Modal } from '../components/Modal';
import { AccountForm } from '../components/AccountForm';
import { EMPTY_DRAFT, draftToAccount, type AccountDraft } from '../lib/accountDraft';
import { useI18n, useToast } from '../lib/hooks';
import { makeAccountId, useVaultStore } from '../lib/vaultStore';
import { QrScanPanel } from '../components/QrScanPanel';

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
  const [saving, setSaving] = useState(false);

  /** QR（カメラ・画像）の読み取り結果をフォームへ反映する。 */
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
      setDraft((current) => ({
        ...current,
        type: accountDraft.type,
        issuer: accountDraft.issuer,
        label: accountDraft.label,
        secret: accountDraft.secret,
        algorithm: accountDraft.algorithm,
        digits: accountDraft.digits,
        period: accountDraft.period,
        counter: accountDraft.counter,
      }));
      setTab('manual');
      toast(t('add.scanned'), 'success');
      return true;
    } catch {
      return false;
    }
  }

  const [migrationUri, setMigrationUri] = useState('');
  /** 重複が見つかったときに出す確認（どのアカウントと重なっているかを見せる）。 */
  const [duplicateMatches, setDuplicateMatches] = useState<DuplicateMatch[] | null>(null);

  /** 実際に保存する（重複確認のあとにも呼ぶ）。 */
  async function commitSave(account: Account): Promise<void> {
    setSaving(true);
    try {
      await upsertAccount(account);
      toast(t('add.saved'), 'success');
      navigate('/');
    } finally {
      setSaving(false);
    }
  }

  async function handleSave(): Promise<void> {
    if (saving) return;
    const nowIso = new Date().toISOString();
    const account = draftToAccount(draft, null, makeAccountId(), nowIso);
    if (account.secret === '' || (account.issuer === '' && account.label === '')) return;
    const matches = findAccountDuplicates(accounts, account);
    if (matches.length > 0) {
      setDuplicateMatches(matches);
      return;
    }
    await commitSave(account);
  }

  function titleOf(match: DuplicateMatch): string {
    const { issuer, label } = match.account;
    return issuer !== '' ? (label !== '' ? `${issuer} · ${label}` : issuer) : label;
  }

  const canSave =
    draft.secret.trim() !== '' &&
    (draft.issuer.trim() !== '' || draft.label.trim() !== '') &&
    !saving;

  return (
    <main className="mx-auto max-w-2xl px-4 pt-5 pb-6">
      <h1 className="text-[1.35rem]">{t('add.title')}</h1>

      <div role="tablist" aria-label={t('add.title')} className="mt-4 grid grid-cols-2 gap-1 sm:flex sm:gap-1">
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
            className={`btn w-full text-[0.8rem] sm:w-auto ${tab === key ? 'btn-secondary' : 'btn-ghost'}`}
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

        {tab === 'qr' && (
          <QrScanPanel
            mode="camera"
            onValue={applyUri}
            invalidMessage={t('add.invalidUri')}
            videoTestId="qr-video"
          />
        )}
        {tab === 'image' && (
          <QrScanPanel
            mode="image"
            onValue={applyUri}
            invalidMessage={t('add.invalidUri')}
            imageTestId="qr-image-input"
          />
        )}
        {tab === 'migration' && (
          <MigrationPanel initialUri={migrationUri} onDone={() => navigate('/')} />
        )}
      </div>

      <Modal
        open={duplicateMatches !== null}
        title={t('add.duplicate.title')}
        onClose={() => setDuplicateMatches(null)}
        width="sm"
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setDuplicateMatches(null)}>
              {t('add.duplicate.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="duplicate-continue"
              onClick={() => {
                const nowIso = new Date().toISOString();
                const account = draftToAccount(draft, null, makeAccountId(), nowIso);
                setDuplicateMatches(null);
                void commitSave(account);
              }}
            >
              {t('add.duplicate.continue')}
            </button>
          </>
        }
      >
        <p className="text-[0.88rem] leading-relaxed">{t('add.duplicate.lead')}</p>
        <ul className="mt-3 flex flex-col gap-1.5" data-testid="duplicate-list">
          {(duplicateMatches ?? []).slice(0, 5).map((match) => (
            <li
              key={match.account.id}
              className="rounded-md px-2.5 py-1.5 text-[0.8rem]"
              style={{ background: 'var(--surface-sunken)' }}
            >
              <span className="block truncate">{titleOf(match)}</span>
              <span className="text-[0.72rem]" style={{ color: 'var(--text-faint)' }}>
                {match.reasons.map((reason) => t(`add.duplicate.${reason}` as never)).join(' / ')}
              </span>
            </li>
          ))}
        </ul>
        {(duplicateMatches?.length ?? 0) > 5 && (
          <p className="mt-2 text-[0.74rem]" style={{ color: 'var(--text-faint)' }}>
            {t('add.duplicate.more', { count: (duplicateMatches?.length ?? 0) - 5 })}
          </p>
        )}
      </Modal>
    </main>
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
            ...EMPTY_DRAFT,
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
