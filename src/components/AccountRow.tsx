import { useEffect, useMemo, useRef, useState } from 'react';
import type { Account } from '../../shared/types';
import { generateHOTP } from '../../shared/hotp';
import { generateTOTPPair } from '../../shared/totp';
import { decodeBase32 } from '../../shared/base32';
import { Avatar } from './Avatar';
import { Code, ProgressRing } from './Code';
import { Modal } from './Modal';
import { useI18n, useToast } from '../lib/hooks';
import { useVaultStore } from '../lib/vaultStore';
import { copyText, scheduleClipboardClear } from '../lib/clipboard';

export type AccountRowProps = {
  account: Account;
  now: number;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onCopyResult: (ok: boolean) => void;
  /** 自動クリアに失敗した（クリップボードにコードが残っている）ときの通知 */
  onClipboardClearFailed: () => void;
  onIncrementHotp: () => void;
  /** コードを使った（「よく使う順」の記録用） */
  onUsed?: () => void;
  draggable?: boolean;
  onDragStart?: () => void;
  onDragOver?: (event: React.DragEvent) => void;
  onDrop?: () => void;
  dragging?: boolean;
  dropTarget?: boolean;
};

export function AccountRow({
  account,
  now,
  selected,
  onSelect,
  onOpen,
  onCopyResult,
  onClipboardClearFailed,
  onIncrementHotp,
  onUsed,
  draggable = false,
  onDragStart,
  onDragOver,
  onDrop,
  dragging = false,
  dropTarget = false,
}: AccountRowProps) {
  const { t } = useI18n();
  const toast = useToast();
  const settings = useVaultStore((state) => state.settings);
  const upsertAccount = useVaultStore((state) => state.upsertAccount);
  const removeAccount = useVaultStore((state) => state.removeAccount);
  const [code, setCode] = useState<string>('—');
  const [nextCode, setNextCode] = useState<string>('');
  const [remaining, setRemaining] = useState<number>(account.period);
  const [copied, setCopied] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const step = useMemo(() => {
    if (account.type === 'totp') return Math.floor(now / account.period) + settings.clockSkew;
    return account.counter;
  }, [account.type, account.period, account.counter, now, settings.clockSkew]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (account.type === 'totp') {
          const pair = await generateTOTPPair(account.secret, now, {
            algorithm: account.algorithm,
            digits: account.digits,
            period: account.period,
            skew: settings.clockSkew,
          });
          if (!cancelled) {
            setCode(pair.current);
            setNextCode(pair.next);
            setRemaining(pair.remaining);
          }
        } else {
          const value = await generateHOTP(decodeBase32(account.secret), account.counter, {
            algorithm: account.algorithm,
            digits: account.digits,
          });
          if (!cancelled) {
            setCode(value);
            setNextCode('');
            setRemaining(0);
          }
        }
      } catch {
        if (!cancelled) setCode('—');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account.secret, account.algorithm, account.digits, account.period, account.type, account.counter, step, now, settings.clockSkew]);

  useEffect(() => () => {
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
  }, []);

  async function handleCopy(): Promise<void> {
    const ok = await copyText(code);
    onCopyResult(ok);
    if (ok) {
      onUsed?.();
      void scheduleClipboardClear(code, settings.clearClipboard).then((outcome) => {
        if (outcome === 'failed') onClipboardClearFailed();
      });
      setCopied(true);
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1600);
    }
  }

  async function togglePin(): Promise<void> {
    const nowIso = new Date().toISOString();
    await upsertAccount({ ...account, pinned: !account.pinned, updatedAt: nowIso });
  }

  async function handleDelete(): Promise<void> {
    setDeleteOpen(false);
    try {
      await removeAccount(account.id);
    } catch {
      toast(t('common.error'), 'error');
      return;
    }
    toast(t('detail.deleted'), 'success');
  }

  const progress = account.type === 'totp' ? remaining / account.period : 0;
  const hasNotes = (account.notes ?? '') !== '';
  const unusedCodes = (account.recoveryCodes ?? []).filter((entry) => !entry.used).length;
  const title = account.issuer !== '' ? account.issuer : account.label;
  const subtitle = account.issuer !== '' ? account.label : '';

  return (
    <li
      className={`group relative ${dragging ? 'opacity-40' : ''}`}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      data-account-id={account.id}
      data-testid="account-row"
      style={{ borderTop: dropTarget ? '2px solid var(--accent)' : '2px solid transparent', marginTop: '-2px' }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={`${title} ${subtitle} のコード ${code}`}
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect}
        onDoubleClick={onOpen}
        onKeyDown={(event) => {
          // 子ボタン上での Space/Enter はボタンの既定動作を保つ（行の操作は行自体だけ）。
          if (event.target !== event.currentTarget) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect();
          }
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            onOpen();
          }
        }}
        className="card flex w-full cursor-default flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-3 text-left transition-colors"
        style={{
          borderColor: selected ? 'var(--accent)' : 'var(--border)',
          background: selected ? 'var(--accent-soft)' : 'var(--surface-raised)',
        }}
      >
        <Avatar issuer={account.issuer} label={account.label} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-[0.92rem] font-medium" title={title}>
              {title}
            </p>
            {account.pinned && (
              <span className="text-[0.7rem]" style={{ color: 'var(--clay)' }} aria-label={t('list.pinned')}>
                <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" fill="currentColor">
                  <path d="M7.4 1L11 4.6l-1.6.4-1.9 1.9.4 2.4-1 1L4.2 8.1 1.4 10.9l-.9-.9L3.3 7.2.9 4.8l1-1 2.4.4 1.9-1.9L7.4 1z" />
                </svg>
              </span>
            )}
          </div>
          <p className="truncate text-[0.78rem]" style={{ color: 'var(--text-muted)' }}>
            {subtitle !== '' ? subtitle : account.type.toUpperCase()}
          </p>
          {(hasNotes || unusedCodes > 0) && (
            <p className="mt-0.5 flex items-center gap-1.5 text-[0.68rem]" style={{ color: 'var(--text-faint)' }} data-testid="row-badges">
              {hasNotes && (
                <span title={account.notes} data-testid="row-notes">
                  ✎ {t('list.notes')}
                </span>
              )}
              {unusedCodes > 0 && (
                <span title={t('codes.title')} data-testid="row-codes">
                  ⌗ {t('list.codes', { count: unusedCodes })}
                </span>
              )}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2.5">
          {account.type === 'totp' && (
            <div className="flex flex-col items-center gap-0.5">
              <ProgressRing progress={progress} />
              <span className="code-text text-[0.62rem]" style={{ color: 'var(--text-faint)' }}>
                {remaining}
              </span>
            </div>
          )}
          <div className="text-right">
            <Code code={code} size="md" />
            {settings.announceCodes && (
              <span className="sr-only" aria-live="polite" aria-atomic="true">
                {code}
              </span>
            )}
            {account.type === 'totp' && nextCode !== '' && (
              <p className="code-text mt-0.5 text-[0.66rem]" style={{ color: 'var(--text-faint)' }}>
                {t('list.next')} {nextCode}
              </p>
            )}
          </div>
        </div>

        {/*
          操作列はスマホでは行の下に回す（横幅 360px でもコードと重ならない）。
          sm 以上では今までどおり同じ行の右端に並ぶ。
        */}
        <div
          className="flex w-full flex-wrap items-center justify-end gap-1 border-t pt-1 sm:w-auto sm:border-t-0 sm:pt-0"
          style={{ borderColor: 'var(--border)' }}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {account.type === 'hotp' && (
            <button
              type="button"
              className="btn btn-ghost text-[0.72rem]"
              onClick={(event) => {
                event.stopPropagation();
                onIncrementHotp();
              }}
              aria-label={t('list.hotpIncrement')}
            >
              ↻
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost"
            onClick={(event) => {
              event.stopPropagation();
              void handleCopy();
            }}
            aria-label={`${t('list.copyCode')}: ${title}`}
            title={t('list.copyCode')}
          >
            {copied ? (
              <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" fill="none">
                <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" fill="none">
                <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                <path d="M10.5 5.5V4a1.5 1.5 0 00-1.5-1.5H4A1.5 1.5 0 002.5 4v5A1.5 1.5 0 004 10.5h1.5" stroke="currentColor" strokeWidth="1.3" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={(event) => {
              event.stopPropagation();
              void togglePin();
            }}
            aria-label={account.pinned ? t('list.unpin') : t('list.pin')}
            aria-pressed={account.pinned}
            title={account.pinned ? t('list.unpin') : t('list.pin')}
          >
            <svg width="14" height="14" viewBox="0 0 12 12" aria-hidden="true" fill={account.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.1">
              <path d="M7.4 1L11 4.6l-1.6.4-1.9 1.9.4 2.4-1 1L4.2 8.1 1.4 10.9l-.9-.9L3.3 7.2.9 4.8l1-1 2.4.4 1.9-1.9L7.4 1z" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            className="btn btn-ghost text-[0.76rem]"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
            aria-label={`${t('list.edit')}: ${title}`}
            title={t('list.edit')}
            data-testid="edit-account"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none">
              <path d="M11.2 2.4l2.4 2.4-7.6 7.6-2.8.4.4-2.8 7.6-7.6z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            </svg>
            {t('list.edit')}
          </button>
          <button
            type="button"
            className="btn btn-ghost text-[0.76rem]"
            onClick={(event) => {
              event.stopPropagation();
              setDeleteOpen(true);
            }}
            aria-label={`${t('list.delete')}: ${title}`}
            title={t('list.delete')}
            data-testid="delete-account"
            style={{ color: 'var(--danger)' }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none">
              <path d="M3 4.5h10M6.2 4.5V3.2h3.6v1.3M4.4 4.5l.6 8.2h6l.6-8.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {t('list.delete')}
          </button>
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
            <button type="button" className="btn btn-danger" onClick={() => void handleDelete()} data-testid="confirm-delete-account">
              {t('common.delete')}
            </button>
          </>
        }
      >
        <p className="text-[0.88rem]">{t('list.deleteToTrashConfirm', { title })}</p>
        <p className="mt-2 text-[0.78rem]" style={{ color: 'var(--clay)' }}>
          {t('detail.deleteHint')}
        </p>
      </Modal>
    </li>
  );
}
