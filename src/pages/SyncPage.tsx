import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { deriveVaultId, formatSyncCode, normalizeSyncCode } from '../../shared/sync';
import { useI18n, useToast } from '../lib/hooks';
import { useVaultStore } from '../lib/vaultStore';
import { Modal } from '../components/Modal';
import { QrScanPanel } from '../components/QrScanPanel';
import { AppLoginButton } from '../components/AppLoginButton';
import { createSyncClient, SyncNotFoundError } from '../lib/syncClient';
import { extractSyncCode } from '../lib/syncCodeInput';

export function SyncPage() {
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const attachSync = useVaultStore((state) => state.attachSync);
  const hasVault = useVaultStore((state) => state.envelope !== null);
  const status = useVaultStore((state) => state.status);

  const [code, setCode] = useState(() => params.get('code') ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<'code' | 'network' | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  /** 画面を離れたら接続を完了させない（戻って別のボルトを作った場合の上書き防止）。 */
  const unmountedRef = useRef(false);
  const busyRef = useRef(false);

  useEffect(() => {
    // 同期コードはボルトの読み書き・削除権限を持つ。URL の ?code= に残すと
    // 履歴・アドレスバー・画面共有から漏れるため、読み取った直後に消す。
    if (params.get('code') === null) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('code');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, [params]);

  useEffect(() => {
    // StrictMode の再実行でも有効に戻す（cleanup 後に true のままにしない）。
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  async function connect(tokenOverride?: string): Promise<void> {
    const token = normalizeSyncCode(tokenOverride ?? code);
    if (token === '' || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setErrorKind(null);
    try {
      // 先に存在確認してからボルトを置き換える（失敗時に壊さない）。
      const client = createSyncClient();
      const vaultId = await deriveVaultId(token);
      await client.getMeta(vaultId, token);
      if (unmountedRef.current) return;
      // attachSync 側でも、取得中にボルトが変わっていないことを確認してから保存する。
      await attachSync(token);
      if (unmountedRef.current) return;
      toast(t('sync.connected'), 'success');
      navigate('/');
    } catch (connectError) {
      if (unmountedRef.current) return;
      if (connectError instanceof SyncNotFoundError) {
        setError(t('sync.notFound'));
        setErrorKind('code');
      } else {
        setError(t('toast.syncFailed'));
        setErrorKind('network');
      }
    } finally {
      busyRef.current = false;
      if (!unmountedRef.current) setBusy(false);
    }
  }

  /**
   * 入力欄への入力。同期 URL や 4 文字区切りのコードが貼られたら、
   * 同期コード（トークン）だけにしてから入れる。
   */
  function handleCodeChange(value: string): void {
    const extracted = extractSyncCode(value);
    if (extracted !== null && extracted !== normalizeSyncCode(value)) {
      setCode(extracted);
      return;
    }
    setCode(value);
  }

  /** QR の読み取り結果。同期コードを抽出して入力欄に入れ、必要ならそのまま接続する。 */
  function handleScanned(value: string): boolean {
    const token = extractSyncCode(value);
    if (token === null) return false;
    setCode(token);
    toast(t('sync.scanned'), 'success');
    // まだボルトが無い端末なら、読み取ったコードでそのまま接続する（余計なタップを省く）。
    if (!hasVault) void connect(token);
    return true;
  }

  return (
    <main className="mx-auto max-w-sm px-5 pt-8 pb-10">
      <h1 className="text-[1.35rem]">{t('sync.title')}</h1>
      <p className="mt-1.5 text-[0.86rem] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        {t('sync.lead')}
      </p>

      <form
        className="card mt-5 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (hasVault) setConfirmOpen(true);
          else void connect();
        }}
      >
        <label className="field-label" htmlFor="sync-code-input">
          {t('sync.code')}
        </label>
        <input
          id="sync-code-input"
          type="text"
          value={code}
          onChange={(event) => handleCodeChange(event.target.value)}
          placeholder="abcd efgh ijkl …"
          className="code-text text-[0.86rem]"
          spellCheck={false}
          autoComplete="off"
          autoFocus
          aria-invalid={errorKind === 'code' || undefined}
          aria-describedby={errorKind === 'code' ? 'sync-error' : undefined}
          data-testid="sync-code-input"
        />
        {code.trim() !== '' && (
          <p className="field-hint code-text break-all">{formatSyncCode(normalizeSyncCode(code))}</p>
        )}
        {error !== null && (
          <p id="sync-error" className="field-error mt-2" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="btn btn-primary mt-4 w-full"
          disabled={busy || code.trim() === ''}
          data-testid="sync-connect"
        >
          {busy ? t('common.loading') : t('sync.submit')}
        </button>
      </form>

      {status === 'unlocked' && (
        <section className="card mt-4 p-5" data-testid="app-login-card">
          <p className="text-[0.9rem] font-medium">{t('app.login.title')}</p>
          <div className="mt-3">
            <AppLoginButton />
          </div>
        </section>
      )}

      <div className="card mt-4 px-4 py-3">
        <button
          type="button"
          className="btn btn-ghost w-full justify-between px-1 text-[0.86rem]"
          aria-expanded={scanOpen}
          onClick={() => setScanOpen((open) => !open)}
          data-testid="sync-scan-toggle"
        >
          <span>{t('sync.qr')}</span>
          <span aria-hidden="true">{scanOpen ? '▴' : '▾'}</span>
        </button>
        {scanOpen && (
          <div className="mt-3">
            <QrScanPanel
              mode="both"
              onValue={handleScanned}
              invalidMessage={t('sync.qrInvalid')}
              imageTestId="sync-qr-image-input"
              videoTestId="sync-qr-video"
            />
          </div>
        )}
      </div>

      <p className="mt-6 text-center text-[0.78rem]">
        <Link to="/privacy" className="link" data-testid="privacy-link">
          {t('privacy.open')}
        </Link>
      </p>

      <Modal
        open={confirmOpen}
        title={t('sync.haveVault')}
        onClose={() => setConfirmOpen(false)}
        width="sm"
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setConfirmOpen(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setConfirmOpen(false);
                void connect();
              }}
            >
              {t('common.confirm')}
            </button>
          </>
        }
      >
        <p className="text-[0.88rem]">{t('sync.haveVaultConfirm')}</p>
      </Modal>
    </main>
  );
}
