import { useEffect, useState } from 'react';
import type { OtpAlgorithm } from '../../shared/types';
import { MAX_NOTES_LENGTH, MAX_PERIOD, MIN_PERIOD } from '../../shared/types';
import { decodeBase32, isValidBase32 } from '../../shared/base32';
import { generateHOTP } from '../../shared/hotp';
import { generateTOTP } from '../../shared/totp';
import { useI18n, useToast } from '../lib/hooks';
import { type AccountDraft } from '../lib/accountDraft';
import { avatarTone } from '../lib/format';
import { ISSUER_SUGGESTIONS, matchedIssuerSuggestion } from '../lib/issuerSuggestions';
import { detectSecretUri, draftFromOtpauthUri, type DetectedSecretUri } from '../lib/secretUri';
import { Avatar } from './Avatar';
import { Code } from './Code';
import { RecoveryCodeEditor } from './RecoveryCodeEditor';

export type AccountFormProps = {
  value: AccountDraft;
  onChange: (draft: AccountDraft) => void;
  /** 詳細設定を最初から開く */
  showAdvancedByDefault?: boolean;
  idPrefix?: string;
  /**
   * 秘密鍵欄に `otpauth://` / `otpauth-migration://` が貼られたときの処理。
   * true を返すと URI を消費した（フォームへ反映済み、または移行タブへ案内済み）とみなし、
   * 秘密鍵欄は書き換えない。false を返すと貼られた文字列をそのまま秘密鍵欄に入れる。
   * 省略時は otpauth URI をこの場で分解して反映し、移行 URI は案内だけ出す。
   */
  onUriPaste?: (uri: string) => boolean;
};

export function AccountForm({
  value,
  onChange,
  showAdvancedByDefault = false,
  idPrefix = 'acct',
  onUriPaste,
}: AccountFormProps) {
  const { t } = useI18n();
  const toast = useToast();
  const [advanced, setAdvanced] = useState(showAdvancedByDefault);
  const [preview, setPreview] = useState<string>('');
  const [previewError, setPreviewError] = useState(false);
  const secretValid = value.secret.trim() === '' ? true : isValidBase32(value.secret);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (value.secret.trim() === '' || !isValidBase32(value.secret)) {
        if (!cancelled) {
          setPreview('');
          setPreviewError(value.secret.trim() !== '');
        }
        return;
      }
      try {
        const code =
          value.type === 'totp'
            ? await generateTOTP(value.secret, Math.floor(Date.now() / 1000), {
                algorithm: value.algorithm,
                digits: value.digits,
                period: value.period,
              })
            : await generateHOTP(decodeBase32(value.secret), value.counter, {
                algorithm: value.algorithm,
                digits: value.digits,
              });
        if (!cancelled) {
          setPreview(code);
          setPreviewError(false);
        }
      } catch {
        if (!cancelled) {
          setPreview('');
          setPreviewError(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [value.secret, value.type, value.algorithm, value.digits, value.period, value.counter]);

  function patch(next: Partial<AccountDraft>): void {
    onChange({ ...value, ...next });
  }

  /**
   * 検出した URI を呼び出し側へ渡す（または URI をこの場で分解する）。
   * 引き受けた（true）ときは秘密鍵欄へ URI の文字列を残さない。
   */
  function consumeUri(detected: DetectedSecretUri): boolean {
    if (onUriPaste !== undefined) return onUriPaste(detected.uri);
    if (detected.kind === 'migration') {
      toast(t('add.pasteMigration'), 'warning');
      return true;
    }
    try {
      onChange(draftFromOtpauthUri(detected.uri, value));
      toast(t('add.pasteApplied'), 'success');
      return true;
    } catch {
      // 解釈できない URI は秘密鍵として扱い、Base32 エラーを出す。
      return false;
    }
  }

  /**
   * 貼り付けは入力途中と区別する。欄に前の（壊れた）URI が残っていても、
   * 貼り付けた URI はそのまま解析する。引き受けたら既定の貼り付けを止める。
   */
  function handleSecretPaste(event: React.ClipboardEvent<HTMLInputElement>): void {
    const detected = detectSecretUri(event.clipboardData.getData('text'));
    if (detected === null) return;
    if (consumeUri(detected)) event.preventDefault();
  }

  /**
   * 秘密鍵欄への入力。URI が貼られた場合は Base32 として扱わず、フォーム全体へ展開する。
   * 編集画面で黙って他の項目を上書きしないよう、呼び出し側の `onUriPaste` を優先する。
   * URI を手で打っている途中（otpauth:// → otpauth://t …）で毎回反応しないよう、
   * 直前の値がすでに URI だったときは何もしない（貼り直しは onPaste が扱う）。
   */
  function handleSecretInput(raw: string): void {
    const detected = detectSecretUri(raw);
    const alreadyUri = detectSecretUri(value.secret) !== null;
    if (detected !== null && !alreadyUri && consumeUri(detected)) return;
    patch({ secret: raw });
  }

  return (
    <div className="flex flex-col gap-4">
      <fieldset>
        <legend className="field-label">{t('add.type')}</legend>
        <div className="flex gap-1.5">
          {(['totp', 'hotp'] as const).map((type) => (
            <button
              key={type}
              type="button"
              className={`btn flex-1 text-[0.82rem] ${value.type === type ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => patch({ type })}
              aria-pressed={value.type === type}
            >
              {t(type === 'totp' ? 'add.type.totp' : 'add.type.hotp')}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="field-label" htmlFor={`${idPrefix}-issuer`}>
            {t('add.issuer')}
          </label>
          <div className="flex items-center gap-2">
            <Avatar issuer={value.issuer} label={value.label} size={36} />
            <input
              id={`${idPrefix}-issuer`}
              type="text"
              value={value.issuer}
              onChange={(event) => patch({ issuer: event.target.value })}
              placeholder="GitHub"
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1"
            />
          </div>
          <div
            className="mt-2 flex flex-wrap items-center gap-1.5"
            role="group"
            aria-label={t('add.issuerSuggestions')}
            data-testid={`${idPrefix}-issuer-suggestions`}
          >
            {ISSUER_SUGGESTIONS.map((name) => (
              <button
                key={name}
                type="button"
                className="chip"
                aria-pressed={matchedIssuerSuggestion(value.issuer) === name}
                onClick={() => patch({ issuer: name })}
              >
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: avatarTone(name, '').color }}
                />
                {name}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="field-label" htmlFor={`${idPrefix}-label`}>
            {t('add.label')}
          </label>
          <input
            id={`${idPrefix}-label`}
            type="text"
            value={value.label}
            onChange={(event) => patch({ label: event.target.value })}
            placeholder="you@example.com"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      </div>

      <div>
        <label className="field-label" htmlFor={`${idPrefix}-secret`}>
          {t('add.secret')}
        </label>
        <input
          id={`${idPrefix}-secret`}
          type="text"
          value={value.secret}
          onChange={(event) => handleSecretInput(event.target.value)}
          onPaste={handleSecretPaste}
          placeholder="JBSWY3DPEHPK3PXP"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="code-text"
          aria-invalid={!secretValid || undefined}
          aria-describedby={`${idPrefix}-secret-hint`}
          data-testid="secret-input"
        />
        <p id={`${idPrefix}-secret-hint`} className="field-hint">
          {t('add.secretHint')}
        </p>
        {!secretValid && (
          <p className="field-error" role="alert">
            {t('add.invalidSecret')}
          </p>
        )}
      </div>

      <div
        className="flex items-center justify-between gap-3 rounded-lg px-3 py-2.5"
        style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border)' }}
      >
        <div>
          <p className="text-[0.72rem] font-medium" style={{ color: 'var(--text-muted)' }}>
            {t('add.preview')}
          </p>
          {preview !== '' ? (
            <Code code={preview} size="md" />
          ) : (
            <p className="text-[0.76rem]" style={{ color: 'var(--text-faint)' }}>
              {previewError ? t('add.invalidSecret') : t('add.previewEmpty')}
            </p>
          )}
        </div>
      </div>

      <button
        type="button"
        className="btn btn-ghost self-start text-[0.8rem]"
        onClick={() => setAdvanced((open) => !open)}
        aria-expanded={advanced}
      >
        {t('detail.advanced')} {advanced ? '▴' : '▾'}
      </button>

      {advanced && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className="field-label" htmlFor={`${idPrefix}-algorithm`}>
              {t('add.algorithm')}
            </label>
            <select
              id={`${idPrefix}-algorithm`}
              value={value.algorithm}
              onChange={(event) => patch({ algorithm: event.target.value as OtpAlgorithm })}
            >
              <option value="SHA1">SHA-1</option>
              <option value="SHA256">SHA-256</option>
              <option value="SHA512">SHA-512</option>
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor={`${idPrefix}-digits`}>
              {t('add.digits')}
            </label>
            <select
              id={`${idPrefix}-digits`}
              value={value.digits}
              onChange={(event) => patch({ digits: Number.parseInt(event.target.value, 10) === 8 ? 8 : 6 })}
            >
              <option value={6}>6</option>
              <option value={8}>8</option>
            </select>
          </div>
          {value.type === 'totp' ? (
            <div>
              <label className="field-label" htmlFor={`${idPrefix}-period`}>
                {t('add.period')}
              </label>
              <input
                id={`${idPrefix}-period`}
                type="number"
                min={MIN_PERIOD}
                max={MAX_PERIOD}
                value={value.period}
                onChange={(event) => {
                  const parsed = Number.parseInt(event.target.value, 10);
                  if (Number.isFinite(parsed)) {
                    patch({ period: Math.max(MIN_PERIOD, Math.min(MAX_PERIOD, parsed)) });
                  }
                }}
              />
            </div>
          ) : (
            <div>
              <label className="field-label" htmlFor={`${idPrefix}-counter`}>
                {t('add.counter')}
              </label>
              <input
                id={`${idPrefix}-counter`}
                type="number"
                min={0}
                value={value.counter}
                onChange={(event) => {
                  const parsed = Number.parseInt(event.target.value, 10);
                  if (Number.isFinite(parsed) && parsed >= 0) patch({ counter: parsed });
                }}
              />
            </div>
          )}
        </div>
      )}

      <div>
        <label className="field-label" htmlFor={`${idPrefix}-notes`}>
          {t('notes.label')}
        </label>
        <textarea
          id={`${idPrefix}-notes`}
          rows={3}
          maxLength={MAX_NOTES_LENGTH}
          value={value.notes}
          onChange={(event) => patch({ notes: event.target.value })}
          placeholder={t('notes.placeholder')}
          data-testid="notes-input"
        />
        <p className="field-hint">{t('notes.hint')}</p>
      </div>

      <RecoveryCodeEditor
        codes={value.recoveryCodes}
        onChange={(codes) => patch({ recoveryCodes: codes })}
        idPrefix={`${idPrefix}-codes`}
      />
    </div>
  );
}
