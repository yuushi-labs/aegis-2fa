import { NavLink } from 'react-router-dom';
import { useI18n } from '../lib/hooks';
import { useVaultStore } from '../lib/vaultStore';

function ShieldMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" fill="none">
      <path
        d="M10 2.2l6 2.2v5.1c0 3.6-2.4 6.9-6 8.3-3.6-1.4-6-4.7-6-8.3V4.4l6-2.2z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M7.3 9.8l1.9 1.9 3.5-3.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function AppHeader({ onLock }: { onLock: () => void }) {
  const { t } = useI18n();
  const syncState = useVaultStore((state) => state.syncState);

  return (
    <header className="sticky top-0 z-30 border-b" style={{ background: 'var(--surface)' }}>
      <div className="mx-auto flex h-14 max-w-2xl items-center gap-3 px-4">
        <NavLink to="/" className="flex items-center gap-2 no-underline" style={{ color: 'var(--text)' }}>
          <span style={{ color: 'var(--accent)' }}>
            <ShieldMark />
          </span>
          <span className="font-serif text-[1.02rem] tracking-tight">Aegis</span>
        </NavLink>
        {syncState === 'conflict' && (
          <span className="badge badge-clay" title={t('toast.conflict')}>
            {t('toast.conflict')}
          </span>
        )}
        {syncState === 'error' && (
          <span className="badge badge-danger" title={t('toast.syncFailed')}>
            {t('toast.syncFailed')}
          </span>
        )}
        {syncState === 'pending' && <span className="badge">{t('settings.sync.status.pending')}</span>}
        <nav className="ml-auto flex items-center gap-0.5" aria-label="主要">
          <NavLink
            to="/settings"
            className={({ isActive }) => `btn btn-ghost text-[0.82rem] ${isActive ? 'underline' : ''}`}
          >
            {t('nav.settings')}
          </NavLink>
          <button type="button" className="btn btn-ghost text-[0.82rem]" onClick={onLock}>
            {t('nav.lock')}
          </button>
        </nav>
      </div>
    </header>
  );
}

export function AppFooter() {
  const { t } = useI18n();
  return (
    <footer className="mx-auto max-w-2xl px-4 pt-6 pb-10">
      <p className="text-[0.72rem] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
        {t('app.tagline')}
      </p>
    </footer>
  );
}
