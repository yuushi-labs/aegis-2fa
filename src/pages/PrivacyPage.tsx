import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useI18n } from '../lib/hooks';
import {
  PRIVACY_INTRO,
  PRIVACY_ISSUES,
  PRIVACY_REPO,
  PRIVACY_SECTIONS,
  PRIVACY_TITLE,
  PRIVACY_UPDATED,
  PRIVACY_UPDATED_LABEL,
  type PrivacyLanguage,
} from './privacyContent';

/**
 * プライバシーポリシーのページ（`/privacy`）。
 *
 * ボルトの状態（未作成・ロック中・解錠中）に関わらず読めるように、ルーティングの
 * 3 つの分岐すべてに置いている。本文は日本語・英語の両方を同梱し、画面の言語に
 * 追従しつつ手動で切り替えられる（公開文書なので、UI の言語設定に縛られない）。
 */
export function PrivacyPage() {
  const { t, language } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  // アプリ内のリンクから来たか（初回表示は key が 'default'）。
  const cameFromApp = location.key !== 'default';
  const [override, setOverride] = useState<PrivacyLanguage | null>(null);
  const docLanguage: PrivacyLanguage = override ?? language;
  const sections = PRIVACY_SECTIONS[docLanguage];

  return (
    <main className="mx-auto max-w-2xl px-5 py-10" data-testid="privacy-page">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-[1.5rem]">{PRIVACY_TITLE[docLanguage]}</h1>
        <div className="flex gap-1" role="group" aria-label={t('privacy.title')}>
          {(
            [
              ['ja', t('privacy.japanese')],
              ['en', t('privacy.english')],
            ] as [PrivacyLanguage, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`btn text-[0.76rem] ${docLanguage === value ? 'btn-secondary' : 'btn-ghost'}`}
              aria-pressed={docLanguage === value}
              onClick={() => setOverride(value)}
              data-testid={`privacy-language-${value}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <p className="mt-1.5 text-[0.86rem] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        {PRIVACY_INTRO[docLanguage]}
      </p>
      <p className="mt-2 text-[0.74rem]" style={{ color: 'var(--text-faint)' }}>
        {PRIVACY_UPDATED_LABEL[docLanguage]}: {PRIVACY_UPDATED}
      </p>

      <div className="mt-6 flex flex-col gap-5">
        {sections.map((section) => (
          <section key={section.title}>
            <h2 className="text-[1rem]">{section.title}</h2>
            <div className="mt-1.5 flex flex-col gap-2">
              {section.blocks.map((block, index) =>
                block.kind === 'p' ? (
                  <p
                    key={index}
                    className="text-[0.86rem] leading-relaxed"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {block.text}
                  </p>
                ) : (
                  <ul
                    key={index}
                    className="flex list-disc flex-col gap-1 pl-5 text-[0.86rem] leading-relaxed"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {block.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ),
              )}
            </div>
          </section>
        ))}
      </div>

      <hr className="rule my-6" />

      <div className="flex flex-col gap-2 text-[0.8rem]">
        <a className="link" href={PRIVACY_ISSUES} target="_blank" rel="noreferrer noopener">
          GitHub Issues
        </a>
        <a className="link" href={`${PRIVACY_REPO}/blob/main/PRIVACY.md`} target="_blank" rel="noreferrer noopener">
          {t('privacy.markdown')}
        </a>
      </div>

      <p className="mt-8">
        {/* 来た場所（ロック画面・設定など）へ戻る。直リンクで開いたときは先頭へ。 */}
        <button
          type="button"
          className="link text-[0.84rem]"
          data-testid="privacy-back"
          onClick={() => {
            if (cameFromApp) navigate(-1);
            else navigate('/');
          }}
        >
          {t('privacy.back')}
        </button>
      </p>
    </main>
  );
}
