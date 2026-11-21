import { useEffect, useRef, useState } from 'react';
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
  /** 初回同期の待機中に画面を離れたら、アプリへの遷移はしない。 */
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function handleClick(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { token, dek, vaultName } = await prepareAppLogin();
      // 待機中に別のページへ移っていたら、いまの操作を中断させない（画面も変えない）。
      if (!mounted.current) return;
      // カスタムスキームへ遷移する。未インストールの端末ではブラウザが何もしないので、
      // 下の案内（GitHub Releases）を必ず出す。
      window.location.href = buildAppLoginUrl({ token, dek, vaultName });
      setNotice(t('app.login.opening'));
    } catch (loginError) {
      if (!mounted.current) return;
      if (loginError instanceof AppLoginSyncError) setError(t('app.login.syncFailed'));
      else if (loginError instanceof VaultLockedError) setError(t('app.login.locked'));
      else setError(t('app.login.failed'));
    } finally {
      if (mounted.current) setBusy(false);
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
