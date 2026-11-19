import { useEffect, useState } from 'react';
import type { OtpAlgorithm } from '../../shared/types';
import { MAX_PERIOD, MIN_PERIOD } from '../../shared/types';
import { decodeBase32, isValidBase32 } from '../../shared/base32';
import { generateHOTP } from '../../shared/hotp';
import { generateTOTP } from '../../shared/totp';
import { useI18n } from '../lib/hooks';
import { type AccountDraft } from '../lib/accountDraft';
import { Code } from './Code';

export type AccountFormProps = {
  value: AccountDraft;
  onChange: (draft: AccountDraft) => void;
  /** 詳細設定を最初から開く */
  showAdvancedByDefault?: boolean;
  idPrefix?: string;
};

export function AccountForm({ value, onChange, showAdvancedByDefault = false, idPrefix = 'acct' }: AccountFormProps) {
  const { t } = useI18n();
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
          <input
            id={`${idPrefix}-issuer`}
            type="text"
            value={value.issuer}
            onChange={(event) => patch({ issuer: event.target.value })}
            placeholder="GitHub"
            autoComplete="off"
            spellCheck={false}
          />
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
          onChange={(event) => patch({ secret: event.target.value })}
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
    </div>
  );
}
