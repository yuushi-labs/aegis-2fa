import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../lib/hooks';
import { useVaultStore } from '../lib/vaultStore';
import { Modal } from '../components/Modal';

export function LockPage() {
  const { t } = useI18n();
  const unlock = useVaultStore((state) => state.unlock);
  const wipe = useVaultStore((state) => state.wipe);
  const token = useVaultStore((state) => state.token);

  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [resetOpen, setResetOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy || cooldown > 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await unlock(password);
      if (!result.ok) {
        setError(t('lock.wrong'));
        if (result.cooldownSeconds !== undefined) setCooldown(result.cooldownSeconds);
        setPassword('');
        inputRef.current?.focus();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-5 py-10">
      <div className="rise-in">
        <h1 className="text-[1.5rem]">{t('lock.title')}</h1>
        <p className="mt-1.5 text-[0.88rem]" style={{ color: 'var(--text-muted)' }}>
          {t('lock.lead')}
        </p>
      </div>

      <form onSubmit={(event) => void handleSubmit(event)} className="card mt-6 p-5" noValidate>
        <label className="field-label" htmlFor="lock-password">
          {t('lock.password')}
        </label>
        <input
          ref={inputRef}
          id="lock-password"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={error !== null || undefined}
          aria-describedby={error !== null ? 'lock-error' : 'lock-hint'}
          disabled={cooldown > 0}
        />
        <p id="lock-hint" className="field-hint">
          {t('lock.unlockHint')}
        </p>
        {error !== null && (
          <p id="lock-error" className="field-error" role="alert">
            {cooldown > 0 ? t('lock.cooldown', { seconds: cooldown }) : error}
          </p>
        )}

        <button type="submit" className="btn btn-primary mt-4 w-full" disabled={busy || cooldown > 0 || password === ''}>
          {busy ? t('lock.unlocking') : t('lock.unlock')}
        </button>
      </form>

      <p className="mt-4 text-center text-[0.74rem] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
        {t('lock.screenshot')}
      </p>

      <div className="mt-8 flex flex-col items-center gap-2">
        {token === null && (
          <a href="#/sync" className="link text-[0.8rem]">
            {t('sync.title')}
          </a>
        )}
        <button
          type="button"
          className="btn btn-ghost text-[0.76rem]"
          onClick={() => setResetOpen(true)}
          style={{ color: 'var(--text-faint)' }}
        >
          {t('lock.reset')}
        </button>
      </div>

      <Modal
        open={resetOpen}
        title={t('lock.reset')}
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
        <p className="text-[0.86rem] leading-relaxed">{t('lock.resetConfirm')}</p>
      </Modal>
    </main>
  );
}
