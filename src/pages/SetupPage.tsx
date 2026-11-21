import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MIN_PASSWORD_LENGTH } from '../../shared/types';
import { useI18n } from '../lib/hooks';
import { useVaultStore } from '../lib/vaultStore';
import { passwordStrength } from '../lib/format';


export function SetupPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const createVault = useVaultStore((state) => state.createVault);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [sync, setSync] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const strength = passwordStrength(password);
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = password.length >= MIN_PASSWORD_LENGTH && confirm === password && !busy;

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      // 同期コードは App がモーダルで表示する（store.pendingSyncToken）。
      await createVault(password, { sync });
      setPassword('');
      setConfirm('');
      // 2 つ目以降のボルトは設定画面から作るため、作成後は一覧へ移る。
      navigate('/');
    } catch {
      setError(t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-10">
      <div className="rise-in">
        <p className="badge badge-accent mb-3">{t('app.name')}</p>
        <h1 className="text-[1.6rem]">{t('setup.title')}</h1>
        <p className="mt-2 text-[0.88rem] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          {t('setup.lead')}
        </p>
      </div>

      <form onSubmit={(event) => void handleSubmit(event)} className="card mt-6 p-5" noValidate>
        <div>
          <label className="field-label" htmlFor="setup-password">
            {t('setup.password')}
          </label>
          <input
            id="setup-password"
            type="password"
            autoComplete="new-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={tooShort || undefined}
            aria-describedby="setup-password-hint"
          />
          <p id="setup-password-hint" className="field-hint">
            {t('setup.hint')}
          </p>
          {tooShort && <p className="field-error">{t('setup.tooShort')}</p>}
          <div className="mt-2 flex items-center gap-2">
            <div className="flex flex-1 gap-1" aria-hidden="true">
              {[0, 1, 2, 3].map((index) => (
                <span
                  key={index}
                  className="h-1 flex-1 rounded-full transition-colors"
                  style={{
                    background:
                      index < strength
                        ? strength <= 1
                          ? 'var(--danger)'
                          : strength === 2
                            ? 'var(--clay)'
                            : 'var(--accent)'
                        : 'var(--ring-track)',
                  }}
                />
              ))}
            </div>
            <span className="text-[0.7rem]" style={{ color: 'var(--text-faint)' }} aria-live="polite">
              {t('setup.strength')}:{' '}
              {strength <= 1 ? t('setup.strength.weak') : strength === 2 ? t('setup.strength.fair') : t('setup.strength.strong')}
            </span>
          </div>
        </div>

        <div className="mt-4">
          <label className="field-label" htmlFor="setup-confirm">
            {t('setup.passwordConfirm')}
          </label>
          <input
            id="setup-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            aria-invalid={mismatch || undefined}
            aria-describedby={mismatch ? 'setup-confirm-error' : undefined}
          />
          {mismatch && (
            <p id="setup-confirm-error" className="field-error" role="alert">
              {t('setup.mismatch')}
            </p>
          )}
        </div>

        <fieldset className="mt-5">
          <legend className="field-label">{t('setup.sync.title')}</legend>
          <p className="field-hint mb-2">{t('setup.sync.lead')}</p>
          <div className="flex flex-col gap-1.5">
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5" style={{ borderColor: sync ? 'var(--accent)' : 'var(--border)' }}>
              <input type="radio" name="sync" checked={sync} onChange={() => setSync(true)} className="mt-1" />
              <span className="text-[0.86rem]">{t('setup.sync.on')}</span>
            </label>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5" style={{ borderColor: !sync ? 'var(--accent)' : 'var(--border)' }}>
              <input type="radio" name="sync" checked={!sync} onChange={() => setSync(false)} className="mt-1" />
              <span className="text-[0.86rem]">{t('setup.sync.off')}</span>
            </label>
          </div>
        </fieldset>

        <p className="mt-4 rounded-lg px-3 py-2 text-[0.76rem] leading-relaxed" style={{ background: 'var(--clay-soft)', color: 'var(--clay)' }}>
          {t('setup.warning')}
        </p>

        {error !== null && <p className="field-error mt-3">{error}</p>}

        <button type="submit" className="btn btn-primary mt-5 w-full" disabled={!canSubmit}>
          {busy ? t('setup.creating') : t('setup.submit')}
        </button>
      </form>

      <p className="mt-5 text-center text-[0.82rem]" style={{ color: 'var(--text-muted)' }}>
        {t('setup.haveSync')}{' '}
        <Link to="/sync" className="underline" style={{ color: 'var(--accent)' }}>
          {t('sync.submit')}
        </Link>
      </p>

      <p className="mt-3 text-center text-[0.78rem]">
        <Link to="/privacy" className="link" data-testid="privacy-link">
          {t('privacy.open')}
        </Link>
      </p>
    </main>
  );
}
