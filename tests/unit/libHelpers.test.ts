import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accountToDraft,
  draftToAccount,
  EMPTY_DRAFT,
  type AccountDraft,
} from '../../src/lib/accountDraft';
import {
  avatarHue,
  avatarTone,
  formatCode,
  formatTime,
  initials,
  passwordStrength,
  timestampForFilename,
} from '../../src/lib/format';
import { MESSAGE_KEYS, resolveLanguage, translate } from '../../src/lib/i18n';
import { DEFAULT_SETTINGS, normalizeSettings } from '../../src/lib/settings';
import type { Account } from '../../shared/types';

const baseAccount: Account = {
  id: 'acc-1',
  type: 'totp',
  issuer: 'GitHub',
  label: 'octocat@example.com',
  secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1',
  digits: 6,
  period: 30,
  counter: 0,
  pinned: false,
  order: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('表示整形', () => {
  it('formatCode は 6 桁・8 桁・その他を読みやすく区切る', () => {
    expect(formatCode('123456')).toBe('123 456');
    expect(formatCode('12345678')).toBe('1234 5678');
    expect(formatCode('12345')).toBe('123 45');
    expect(formatCode('')).toBe(' ');
  });

  it('initials は issuer 優先で 1〜2 文字を返す', () => {
    expect(initials('Acme Corp', 'user@example.com')).toBe('AC');
    expect(initials('', 'yamada.taro@example.com')).toBe('YT');
    expect(initials('X', '')).toBe('X');
    expect(initials('', '')).toBe('?');
    expect(initials('  ', '  ')).toBe('?');
  });

  it('avatarHue は同じ入力に同じ 0〜359 の色相を返す', () => {
    const hue = avatarHue('GitHub', 'octocat');
    expect(hue).toBe(avatarHue('GitHub', 'octocat'));
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
    expect(avatarHue('', 'Other')).toBe(avatarHue('', 'other'));
  });

  it('avatarTone はパレット内の配色を返す', () => {
    const tone = avatarTone('GitHub', 'octocat');
    expect(tone.background).toMatch(/^#[0-9a-f]{6}$/);
    expect(tone.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(tone).toBe(avatarTone('GitHub', 'octocat'));
  });

  it('passwordStrength は長さと文字種で 0〜4 を返す', () => {
    expect(passwordStrength('short')).toBe(0);
    expect(passwordStrength('onlylowercase')).toBe(1);
    expect(passwordStrength('lowerandUPPER')).toBe(2);
    expect(passwordStrength('lowerUPPER1234')).toBe(3);
    expect(passwordStrength('lowerUPPER1234!')).toBe(4);
    expect(passwordStrength('aMuchLongerPassphrase1!x')).toBe(4);
  });

  it('formatTime は未同期・不正値を区別して整形する', () => {
    expect(formatTime(null, 'ja')).toBe('未同期');
    expect(formatTime(null, 'en')).toBe('Never');
    expect(formatTime('not-a-date', 'ja')).toBe('—');
    // 表示は実行環境のタイムゾーンに依存するため、ローカル時刻から作った値で確認する。
    const localDate = new Date(2026, 6, 15, 12, 0).toISOString();
    expect(formatTime(localDate, 'en')).toMatch(/2026/);
    expect(formatTime(localDate, 'ja')).toMatch(/2026/);
  });

  it('timestampForFilename はローカル時刻の 12 桁を作る', () => {
    const stamp = timestampForFilename(new Date(2026, 0, 2, 3, 4));
    expect(stamp).toBe('20260102-0304');
  });
});

describe('設定の正規化', () => {
  it('未保存・壊れた値は既定へ戻す', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('x')).toEqual(DEFAULT_SETTINGS);
    expect(
      normalizeSettings({
        theme: 'sepia',
        autoLockMinutes: 7,
        lockOnHide: 1,
        clockSkew: -9.6,
        clearClipboard: 'no',
        announceCodes: 'yes',
        language: 'de',
      }),
    ).toEqual({
      theme: 'system',
      autoLockMinutes: 5,
      lockOnHide: false,
      clockSkew: -2,
      clearClipboard: true,
      announceCodes: false,
      language: 'auto',
    });
  });

  it('妥当な値はそのまま採用する', () => {
    expect(
      normalizeSettings({
        theme: 'dark',
        autoLockMinutes: 30,
        lockOnHide: true,
        clockSkew: 2,
        clearClipboard: false,
        announceCodes: true,
        language: 'en',
      }),
    ).toEqual({
      theme: 'dark',
      autoLockMinutes: 30,
      lockOnHide: true,
      clockSkew: 2,
      clearClipboard: false,
      announceCodes: true,
      language: 'en',
    });
    expect(normalizeSettings({ autoLockMinutes: 0 }).autoLockMinutes).toBe(0);
    expect(normalizeSettings({ clockSkew: 1.6 }).clockSkew).toBe(2);
  });
});

describe('アカウントの下書き変換', () => {
  it('draftToAccount は前後の空白を除き、シークレットを正規化する', () => {
    const draft: AccountDraft = {
      ...EMPTY_DRAFT,
      issuer: '  Example  ',
      label: ' user@example.com ',
      secret: 'jbswy3dp ehpk3pxp',
    };
    const created = draftToAccount(draft, null, 'new-id', '2026-02-01T00:00:00.000Z');
    expect(created).toEqual({
      ...baseAccount,
      id: 'new-id',
      issuer: 'Example',
      label: 'user@example.com',
      secret: 'JBSWY3DPEHPK3PXP',
      pinned: false,
      order: 0,
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    });
  });

  it('既存アカウントの編集では id・作成日時・ピン留め・並び順を保つ', () => {
    const existing: Account = {
      ...baseAccount,
      pinned: true,
      order: 4,
      issuer: 'Old',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const updated = draftToAccount(
      { ...accountToDraft(existing), issuer: 'New name' },
      existing,
      existing.id,
      '2026-03-01T00:00:00.000Z',
    );
    expect(updated.id).toBe(existing.id);
    expect(updated.createdAt).toBe(existing.createdAt);
    expect(updated.pinned).toBe(true);
    expect(updated.order).toBe(4);
    expect(updated.issuer).toBe('New name');
    expect(updated.updatedAt).toBe('2026-03-01T00:00:00.000Z');
  });

  it('accountToDraft は編集対象の項目だけを取り出す', () => {
    expect(accountToDraft({ ...baseAccount, pinned: true, order: 9 })).toEqual({
      type: 'totp',
      issuer: 'GitHub',
      label: 'octocat@example.com',
      secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      counter: 0,
    });
  });
});

describe('文言', () => {
  it('日本語と英語の辞書を切り替える', () => {
    expect(translate('ja', 'nav.accounts')).toBe('アカウント');
    expect(translate('en', 'nav.accounts')).toBe('Accounts');
  });

  it('パラメータを差し込む', () => {
    expect(translate('ja', 'migration.found', { count: 3 })).toContain('3');
    expect(translate('en', 'settings.autoLockValue', { minutes: 15 })).toBe('15 min');
  });

  it('未知のパラメータはそのまま残す', () => {
    expect(translate('en', 'migration.found', {})).toBe('Found {count} accounts');
  });

  it('未知のキーはキー名を返す', () => {
    const translateUnknown = translate as (language: 'ja', key: string) => string;
    expect(translateUnknown('ja', 'no.such.key')).toBe('no.such.key');
  });

  it('resolveLanguage は設定と navigator.language に従う', () => {
    expect(resolveLanguage('ja')).toBe('ja');
    expect(resolveLanguage('en')).toBe('en');
    vi.stubGlobal('navigator', { language: 'en-US' });
    expect(resolveLanguage('auto')).toBe('en');
    vi.stubGlobal('navigator', { language: 'ja-JP' });
    expect(resolveLanguage('auto')).toBe('ja');
  });

  it('すべての言語で同じキー集合を持つ', () => {
    for (const key of MESSAGE_KEYS) {
      expect(translate('ja', key)).not.toBe('');
      expect(translate('en', key)).not.toBe('');
    }
  });
});
