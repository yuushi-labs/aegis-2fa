import { useState } from 'react';
import type { RecoveryCode } from '../../shared/types';
import { MAX_RECOVERY_CODES, MAX_RECOVERY_CODE_LENGTH } from '../../shared/types';
import { useI18n, useToast } from '../lib/hooks';
import { copyText } from '../lib/clipboard';

export type RecoveryCodeEditorProps = {
  codes: RecoveryCode[];
  onChange: (codes: RecoveryCode[]) => void;
  idPrefix?: string;
};

/** ランダムな ID（コードごとに 1 つ）。 */
function codeId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `rc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * バックアップコードの保管欄。
 * 貼り付けたテキストを改行・カンマ・空白で区切って一括追加でき、
 * 使用済みの印・コピー・削除を 1 件ずつ行える。
 */
export function RecoveryCodeEditor({ codes, onChange, idPrefix = 'codes' }: RecoveryCodeEditorProps) {
  const { t } = useI18n();
  const toast = useToast();
  const [bulk, setBulk] = useState('');

  const unused = codes.filter((entry) => !entry.used).length;

  function addBulk(): void {
    const parts = bulk
      .split(/[\s,;]+/)
      .map((part) => part.trim())
      .filter((part) => part !== '');
    if (parts.length === 0) return;
    const tooLong = parts.some((part) => part.length > MAX_RECOVERY_CODE_LENGTH);
    if (tooLong) {
      toast(t('codes.tooLong'), 'error');
      return;
    }
    const existing = new Set(codes.map((entry) => entry.code.toLowerCase()));
    const added: RecoveryCode[] = [];
    for (const part of parts) {
      if (existing.has(part.toLowerCase())) continue;
      existing.add(part.toLowerCase());
      added.push({ id: codeId(), code: part, used: false });
      if (codes.length + added.length >= MAX_RECOVERY_CODES) break;
    }
    if (added.length === 0) return;
    const next = [...codes, ...added];
    onChange(next);
    setBulk('');
    toast(
      next.length < codes.length + added.length
        ? t('codes.tooMany', { max: MAX_RECOVERY_CODES })
        : t('codes.added', { count: added.length }),
      'success',
    );
  }

  function toggleUsed(id: string): void {
    onChange(codes.map((entry) => (entry.id === id ? { ...entry, used: !entry.used } : entry)));
  }

  function remove(id: string): void {
    onChange(codes.filter((entry) => entry.id !== id));
  }

  async function copy(code: string): Promise<void> {
    const ok = await copyText(code);
    toast(ok ? t('common.copied') : t('common.copyFailed'), ok ? 'success' : 'error');
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[0.88rem] font-medium">{t('codes.title')}</p>
        <p className="code-text text-[0.7rem]" style={{ color: 'var(--text-faint)' }} data-testid={`${idPrefix}-remaining`}>
          {t('codes.remaining', { count: unused, total: codes.length })}
        </p>
      </div>
      <p className="field-hint -mt-1">{t('codes.lead')}</p>

      {codes.length > 0 && (
        <ul className="flex flex-col" data-testid={`${idPrefix}-list`}>
          {codes.map((entry) => (
            <li
              key={entry.id}
              className="flex items-center gap-2 border-t py-1.5 first:border-t-0"
              style={{ borderColor: 'var(--border)' }}
            >
              <button
                type="button"
                className="btn btn-ghost shrink-0 text-[0.7rem]"
                onClick={() => toggleUsed(entry.id)}
                aria-pressed={entry.used}
                aria-label={entry.used ? t('codes.markUnused') : t('codes.markUsed')}
                title={entry.used ? t('codes.markUnused') : t('codes.markUsed')}
                data-testid={`${idPrefix}-toggle`}
              >
                <span aria-hidden="true">{entry.used ? '☑' : '☐'}</span>
              </button>
              <code
                className="code-text min-w-0 flex-1 truncate text-[0.8rem]"
                style={{
                  color: entry.used ? 'var(--text-faint)' : 'var(--text)',
                  textDecoration: entry.used ? 'line-through' : 'none',
                }}
              >
                {entry.code}
              </code>
              {entry.used && (
                <span className="badge shrink-0 text-[0.64rem]" data-testid={`${idPrefix}-used`}>
                  {t('codes.used')}
                </span>
              )}
              <button
                type="button"
                className="btn btn-ghost shrink-0"
                onClick={() => void copy(entry.code)}
                aria-label={t('codes.copy')}
                title={t('codes.copy')}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" fill="none">
                  <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                  <path
                    d="M10.5 5.5V4a1.5 1.5 0 00-1.5-1.5H4A1.5 1.5 0 002.5 4v5A1.5 1.5 0 004 10.5h1.5"
                    stroke="currentColor"
                    strokeWidth="1.3"
                  />
                </svg>
              </button>
              <button
                type="button"
                className="btn btn-ghost shrink-0 text-[0.7rem]"
                onClick={() => remove(entry.id)}
                aria-label={t('codes.remove')}
                title={t('codes.remove')}
                style={{ color: 'var(--danger)' }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div>
        <label className="field-label" htmlFor={`${idPrefix}-bulk`}>
          {t('codes.bulkLabel')}
        </label>
        <textarea
          id={`${idPrefix}-bulk`}
          rows={2}
          value={bulk}
          onChange={(event) => setBulk(event.target.value)}
          placeholder={t('codes.bulkPlaceholder')}
          className="code-text text-[0.78rem]"
          spellCheck={false}
          data-testid={`${idPrefix}-bulk`}
        />
        <button
          type="button"
          className="btn btn-secondary mt-2 self-start text-[0.8rem]"
          onClick={addBulk}
          disabled={bulk.trim() === '' || codes.length >= MAX_RECOVERY_CODES}
          data-testid={`${idPrefix}-add`}
        >
          {t('codes.add')}
        </button>
      </div>
    </div>
  );
}
