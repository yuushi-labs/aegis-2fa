import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Account } from '../../shared/types';
import { generateHOTP } from '../../shared/hotp';
import { generateTOTPPair } from '../../shared/totp';
import { decodeBase32 } from '../../shared/base32';
import { AccountRow } from '../components/AccountRow';
import { copyText, scheduleClipboardClear } from '../lib/clipboard';
import { useDebounced, useI18n, useNow, useToast } from '../lib/hooks';
import { sortAccounts, useVaultStore } from '../lib/vaultStore';

export function AccountsPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const accounts = useVaultStore((state) => state.accounts);
  const upsertAccount = useVaultStore((state) => state.upsertAccount);
  const reorderAccounts = useVaultStore((state) => state.reorderAccounts);
  const lock = useVaultStore((state) => state.lock);
  const settings = useVaultStore((state) => state.settings);
  const now = useNow(1000);

  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query, 120);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  /** HOTP 更新中のアカウント（同じ更新の重複実行を防ぐ） */
  const [hotpBusyId, setHotpBusyId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const sorted = useMemo(() => sortAccounts(accounts), [accounts]);
  const filtered = useMemo(() => {
    const needle = debouncedQuery.trim().toLowerCase();
    if (needle === '') return sorted;
    return sorted.filter(
      (account) =>
        account.issuer.toLowerCase().includes(needle) || account.label.toLowerCase().includes(needle),
    );
  }, [sorted, debouncedQuery]);

  /** 行表示と同じ規則（種別・クロックスキュー）で現在のコードを求める。 */
  const currentCodeFor = useCallback(async (account: Account): Promise<string | null> => {
    try {
      if (account.type === 'hotp') {
        return await generateHOTP(decodeBase32(account.secret), account.counter, {
          algorithm: account.algorithm,
          digits: account.digits,
        });
      }
      const pair = await generateTOTPPair(account.secret, Math.floor(Date.now() / 1000), {
        algorithm: account.algorithm,
        digits: account.digits,
        period: account.period,
        skew: settings.clockSkew,
      });
      return pair.current;
    } catch {
      return null;
    }
  }, [settings.clockSkew]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target !== null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      if (event.key === '/' && !isTyping) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (event.key === 'l' && !isTyping && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        lock();
        return;
      }
      if (event.key === 'c' && !isTyping && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const target = filtered.find((account) => account.id === selectedId);
        if (target === undefined) return;
        event.preventDefault();
        void (async () => {
          const code = await currentCodeFor(target);
          if (code === null) return;
          const ok = await copyText(code);
          if (ok) {
            void scheduleClipboardClear(code, settings.clearClipboard).then((outcome) => {
              if (outcome === 'failed') toast(t('common.clipboardClearFailed'), 'warning');
            });
          }
          toast(ok ? t('common.copied') : t('common.copyFailed'), ok ? 'success' : 'error');
        })();
        return;
      }
      if (event.key === 'n' && !isTyping && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        navigate('/add');
        return;
      }
      if (event.key === 'Escape' && document.activeElement === searchRef.current) {
        setQuery('');
        searchRef.current?.blur();
        return;
      }
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && filtered.length > 0) {
        if (isTyping && document.activeElement !== searchRef.current) return;
        event.preventDefault();
        const index = filtered.findIndex((account) => account.id === selectedId);
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        const nextIndex = index === -1 ? 0 : Math.max(0, Math.min(filtered.length - 1, index + delta));
        setSelectedId(filtered[nextIndex]?.id ?? null);
        return;
      }
      if (event.key === 'Enter' && selectedId !== null && !isTyping) {
        // フォーカス中のボタン・リンクの既定動作（Enter で押す）を取り消さない。
        if (target !== null && (target.closest('button') !== null || target.closest('a') !== null || target === searchRef.current)) {
          return;
        }
        event.preventDefault();
        navigate(`/account/${selectedId}`);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [filtered, selectedId, navigate, lock, settings.clearClipboard, t, toast, currentCodeFor]);

  async function handleCopyResult(ok: boolean): Promise<void> {
    toast(ok ? t('common.copied') : t('common.copyFailed'), ok ? 'success' : 'error');
  }

  async function incrementHotp(account: Account): Promise<void> {
    if (hotpBusyId !== null) return;
    setHotpBusyId(account.id);
    try {
      // 実行時点の最新 counter から進める（連打で同じ値を二重に保存しない）。
      const latest = useVaultStore.getState().accounts.find((item) => item.id === account.id) ?? account;
      const nextCounter = latest.counter + 1;
      const nextCode = await generateHOTP(decodeBase32(latest.secret), nextCounter, {
        algorithm: latest.algorithm,
        digits: latest.digits,
      });
      // 生成中にロックされたら、保存も通知も行わない（ロック画面にコードを出さない）。
      if (useVaultStore.getState().dek === null) return;
      await upsertAccount({
        ...latest,
        counter: nextCounter,
        updatedAt: new Date().toISOString(),
      });
      if (useVaultStore.getState().dek === null) return;
      toast(`${t('list.hotpIncrement')}: ${nextCode}`, 'info');
    } finally {
      setHotpBusyId(null);
    }
  }

  function handleDrop(targetId: string): void {
    const sourceId = dragId;
    setDragId(null);
    setDragOverId(null);
    if (sourceId === null || sourceId === targetId) return;
    const ids = sorted.map((account) => account.id);
    const from = ids.indexOf(sourceId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    void reorderAccounts(ids);
  }

  return (
    <main className="mx-auto max-w-2xl px-4 pt-5 pb-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-[1.35rem]">{t('list.title')}</h1>
          <p className="text-[0.76rem]" style={{ color: 'var(--text-faint)' }}>
            {t('list.count', { count: accounts.length })}
          </p>
        </div>
        <Link to="/add" className="btn btn-primary text-[0.84rem]">
          {t('nav.add')}
        </Link>
      </div>

      <div className="relative mt-4">
        <svg
          width="15"
          height="15"
          viewBox="0 0 16 16"
          aria-hidden="true"
          fill="none"
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
          style={{ color: 'var(--text-faint)' }}
        >
          <circle cx="7" cy="7" r="4.3" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10.3 10.3L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('list.searchPlaceholder')}
          aria-label={t('common.search')}
          className="pl-9"
          data-testid="search-input"
        />
      </div>

      {accounts.length === 0 ? (
        <div className="card mt-6 px-5 py-10 text-center">
          <p className="font-serif text-[1.05rem]">{t('list.empty.title')}</p>
          <p className="mx-auto mt-1.5 max-w-xs text-[0.84rem] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {t('list.empty.lead')}
          </p>
          <Link to="/add" className="btn btn-primary mt-5">
            {t('list.empty.cta')}
          </Link>
        </div>
      ) : filtered.length === 0 ? (
        <p className="mt-10 text-center text-[0.86rem]" style={{ color: 'var(--text-muted)' }}>
          {t('list.noResults')}
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-2" data-testid="account-list">
          {filtered.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              now={now}
              selected={selectedId === account.id}
              onSelect={() => setSelectedId(account.id)}
              onOpen={() => navigate(`/account/${account.id}`)}
              onCopyResult={(ok) => void handleCopyResult(ok)}
              onClipboardClearFailed={() => toast(t('common.clipboardClearFailed'), 'warning')}
              onIncrementHotp={() => void incrementHotp(account)}
              draggable
              dragging={dragId === account.id}
              dropTarget={dragOverId === account.id && dragId !== account.id}
              onDragStart={() => setDragId(account.id)}
              onDragOver={(event) => {
                event.preventDefault();
                if (dragId !== null && dragId !== account.id) setDragOverId(account.id);
              }}
              onDrop={() => handleDrop(account.id)}
            />
          ))}
        </ul>
      )}
    </main>
  );
}
