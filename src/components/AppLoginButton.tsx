import { useState } from 'react';
import { buildAppLoginUrl } from '../lib/appLogin';
import { useI18n } from '../lib/hooks';
import { AppLoginSyncError, VaultLockedError, useVaultStore } from '../lib/vaultStore';

/**
 * 「📱 アプリでログイン」ボタン。
 *
 * 押すと、同期コードが未発行なら自動で発行して初回同期し、そのあと
 * `aegis://login#...` を開いて Android アプリへボルト（同期コードと DEK）を渡す。
 * 鍵は URL のフラグメントに置くので、サーバーやログには残らない。
 */
export function AppLoginButton() {
  const { t } = useI18n();
  const prepareAppLogin = useVaultStore((state) => state.prepareAppLogin);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleClick(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { token, dek, vaultName } = await prepareAppLogin();
      // カスタムスキームへ遷移する。未インストールの端末ではブラウザが何もしないので、
      // 下の案内（GitHub Releases）を必ず出す。
      window.location.href = buildAppLoginUrl({ token, dek, vaultName });
      setNotice(t('app.login.opening'));
    } catch (loginError) {
      if (loginError instanceof AppLoginSyncError) setError(t('app.login.syncFailed'));
      else if (loginError instanceof VaultLockedError) setError(t('app.login.locked'));
      else setError(t('app.login.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        className="btn btn-secondary w-full text-[0.86rem]"
        onClick={() => void handleClick()}
        disabled={busy}
        data-testid="app-login"
      >
        {busy ? t('common.loading') : t('app.login.button')}
      </button>
      <p className="field-hint mt-1.5">{t('app.login.lead')}</p>
      {notice !== null && (
        <p className="mt-2 text-[0.8rem] leading-relaxed" role="status" data-testid="app-login-notice">
          {notice}
        </p>
      )}
      {error !== null && (
        <p className="field-error mt-2" role="alert" data-testid="app-login-error">
          {error}
        </p>
      )}
    </div>
  );
}
