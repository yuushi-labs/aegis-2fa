import { useEffect, useRef } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AppFooter, AppHeader } from './components/AppHeader';
import { Modal } from './components/Modal';
import { Toaster } from './components/Toaster';
import { useI18n, useTheme, useToast, clearToasts } from './lib/hooks';
import { useVaultStore } from './lib/vaultStore';
import { canonicalUrlFor, documentTitleFor } from './lib/seo';
import { formatSyncCode } from '../shared/sync';
import { AccountsPage } from './pages/AccountsPage';
import { AccountDetailPage } from './pages/AccountDetailPage';
import { AddPage } from './pages/AddPage';
import { LockPage } from './pages/LockPage';
import { SettingsPage } from './pages/SettingsPage';
import { TrashPage } from './pages/TrashPage';
import { PrintSheetPage } from './pages/PrintSheetPage';
import { SetupPage } from './pages/SetupPage';
import { SyncPage } from './pages/SyncPage';
import { PrivacyPage } from './pages/PrivacyPage';

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'visibilitychange', 'wheel', 'touchstart'] as const;

export function App() {
  useTheme();
  const status = useVaultStore((state) => state.status);
  const initialize = useVaultStore((state) => state.initialize);
  const lock = useVaultStore((state) => state.lock);
  const settings = useVaultStore((state) => state.settings);
  const conflict = useVaultStore((state) => state.conflict);
  const resolveConflict = useVaultStore((state) => state.resolveConflict);
  const syncState = useVaultStore((state) => state.syncState);
  const pendingSyncToken = useVaultStore((state) => state.pendingSyncToken);
  const acknowledgeSyncToken = useVaultStore((state) => state.acknowledgeSyncToken);
  const flushSync = useVaultStore((state) => state.flushSync);
  const toast = useToast();
  const { t, language } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const lastActivity = useRef<number | null>(null);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  // 画面遷移に合わせてタブのタイトルを変える（/privacy などをブックマーク・共有しても区別できる）。
  useEffect(() => {
    const title = documentTitleFor(location.pathname, status, language);
    if (title !== null) document.title = title;
  }, [location.pathname, status, language]);

  // canonical もルートに合わせる。初期 HTML はホームを指しているので、このままだと
  // /privacy がホームの重複ページとみなされ、索引されない。
  useEffect(() => {
    const href = canonicalUrlFor(window.location.origin, import.meta.env.BASE_URL, location.pathname);
    let link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (link === null) {
      link = document.createElement('link');
      link.rel = 'canonical';
      document.head.append(link);
    }
    if (link.href !== href) link.href = href;
  }, [location.pathname]);

  // ロックしたら、OTP を含みうる通知も残さない。
  useEffect(() => {
    if (status === 'locked' || status === 'uninitialized') clearToasts();
  }, [status]);

  // 自動ロック: 無操作 + タブ非表示の両方を見る。
  useEffect(() => {
    if (status !== 'unlocked') return;
    lastActivity.current = Date.now();
    const minutes = settings.autoLockMinutes;
    const onActivity = (): void => {
      lastActivity.current = Date.now();
    };
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, onActivity, { passive: true });
    }
    const interval = minutes > 0 ? setInterval(() => {
      if (lastActivity.current !== null && Date.now() - lastActivity.current >= minutes * 60_000) {
        lock();
      }
    }, 5_000) : null;

    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden' && settings.lockOnHide) lock();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, onActivity);
      if (interval !== null) clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [status, settings.autoLockMinutes, settings.lockOnHide, lock]);

  /** 競合解決ボタンの共通ハンドラ（失敗を握りつぶさず、失敗時は成功トーストを出さない）。 */
  async function handleResolve(mode: 'overwrite' | 'discard' | 'merge'): Promise<void> {
    try {
      const result = await resolveConflict(mode);
      if (mode === 'merge') {
        if (result.resolved === false) {
          toast(t('conflict.mergeFailed'), 'error');
          return;
        }
        toast(t('conflict.merged', { added: result.added, updated: result.updated }), 'success');
      }
    } catch {
      toast(t('conflict.failed'), 'error');
    }
  }

  // 同期状態の変化を通知する。
  const previousSync = useRef(syncState);
  useEffect(() => {
    if (previousSync.current !== syncState) {
      if (syncState === 'synced' && previousSync.current === 'pending') toast(t('toast.synced'), 'success');
      if (syncState === 'error') toast(t('toast.syncFailed'), 'error');
      if (syncState === 'conflict') toast(t('toast.conflict'), 'warning');
      previousSync.current = syncState;
    }
  }, [syncState, toast, t]);

  // アンマウント時（タブを閉じる）にロックする。
  // ただし自動ロック「なし」のときは、再読み込みでアンロックを維持するためにロックしない
  // （セッション継続用の鍵はタブを閉じると消えるので、開きっぱなしにはならない）。
  useEffect(() => {
    const onPageHide = (): void => {
      const state = useVaultStore.getState();
      if (state.status !== 'unlocked') return;
      state.flushSync();
      if (state.settings.autoLockMinutes !== 0) lock();
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [lock, flushSync]);

  if (status === 'loading') {
    return (
      <div className="grid min-h-dvh place-items-center">
        <p className="flex items-center gap-2 text-[0.86rem]" style={{ color: 'var(--text-muted)' }}>
          <span className="spinner" /> {t('common.loading')}
        </p>
      </div>
    );
  }

  if (status === 'uninitialized') {
    return (
      <>
        <Routes>
          <Route path="/sync" element={<SyncPage />} />
          {/* プライバシーポリシーは、ボルトを作る前でも読めるようにする。 */}
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="*" element={<SetupPage />} />
        </Routes>
        <Toaster />
      </>
    );
  }

  if (status === 'locked') {
    return (
      <>
        <Routes>
          <Route path="/sync" element={<SyncPage />} />
          {/* ロック中でも、解錠せずにプライバシーポリシーを開ける。 */}
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="*" element={<LockPage />} />
        </Routes>
        <Toaster />
      </>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader onLock={lock} />
      <div className="flex-1">
        <Routes>
          <Route path="/" element={<AccountsPage />} />
          <Route path="/add" element={<AddPage />} />
          <Route path="/account/:id" element={<AccountDetailPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/trash" element={<TrashPage />} />
          <Route path="/print" element={<PrintSheetPage />} />
          <Route path="/sync" element={<SyncPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
      <AppFooter />
      <Toaster />

      <Modal
        open={pendingSyncToken !== null}
        title={t('setup.done.title')}
        onClose={acknowledgeSyncToken}
        width="sm"
        footer={
          <button type="button" className="btn btn-primary" onClick={acknowledgeSyncToken} data-testid="ack-sync-code">
            {t('setup.done.ack')}
          </button>
        }
      >
        <p className="text-[0.86rem] leading-relaxed">{t('setup.done.lead')}</p>
        <p
          className="code-text mt-3 break-all rounded-lg px-3 py-3 text-[0.9rem] leading-relaxed"
          style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border)' }}
          data-testid="sync-code"
        >
          {pendingSyncToken === null ? '' : formatSyncCode(pendingSyncToken)}
        </p>
      </Modal>

      <Modal
        open={conflict !== null}
        title={t('conflict.title')}
        onClose={() => navigate(location.pathname)}
        width="sm"
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                void handleResolve('discard');
              }}
            >
              {t('conflict.discard')}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                void handleResolve('overwrite');
              }}
            >
              {t('conflict.overwrite')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                void handleResolve('merge');
              }}
            >
              {t('conflict.merge')}
            </button>
          </>
        }
      >
        <p className="text-[0.88rem] leading-relaxed">
          {t('conflict.lead', { remote: conflict?.remoteRevision ?? 0 })}
        </p>
      </Modal>
    </div>
  );
}
