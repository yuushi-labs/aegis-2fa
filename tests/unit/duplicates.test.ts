import { describe, expect, it } from 'vitest';
import { findAccountDuplicates } from '../../shared/duplicates';
import type { Account } from '../../shared/types';

function account(overrides: Partial<Account> & { id: string }): Account {
  return {
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
    ...overrides,
  };
}

describe('追加前の重複チェック', () => {
  it('正規化した秘密鍵が同じなら重複', () => {
    const existing = [account({ id: 'a', secret: 'jbsw y3dp ehpk 3pxp' })];
    const matches = findAccountDuplicates(existing, {
      issuer: 'GitHub',
      label: 'other@example.com',
      secret: 'JBSWY3DPEHPK3PXP',
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.reasons).toEqual(['secret']);
  });

  it('サービス名 + アカウント名が同じなら重複（大文字小文字と前後空白を無視）', () => {
    const existing = [account({ id: 'a' })];
    const matches = findAccountDuplicates(existing, {
      issuer: '  github ',
      label: 'Octocat@Example.com',
      secret: 'AAAAAAAAAAAAAAAA',
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.reasons).toEqual(['label']);
  });

  it('両方当てはまれば理由を 2 つ返す', () => {
    const existing = [account({ id: 'a' })];
    const matches = findAccountDuplicates(existing, {
      issuer: 'GitHub',
      label: 'octocat@example.com',
      secret: 'JBSWY3DPEHPK3PXP',
    });
    expect(matches[0]?.reasons).toEqual(['secret', 'label']);
  });

  it('ゴミ箱のアカウントは重複として数えない', () => {
    const existing = [
      account({ id: 'a', deletedAt: '2026-02-01T00:00:00.000Z' }),
      account({ id: 'b', issuer: 'GitLab', label: 'other', secret: 'GEZDGNBVGY3TQOJQ' }),
    ];
    const matches = findAccountDuplicates(existing, {
      issuer: 'GitHub',
      label: 'octocat@example.com',
      secret: 'JBSWY3DPEHPK3PXP',
    });
    expect(matches).toEqual([]);
  });

  it('別のサービス・別の鍵なら重複しない', () => {
    const existing = [account({ id: 'a' })];
    expect(
      findAccountDuplicates(existing, {
        issuer: 'GitLab',
        label: 'other@example.com',
        secret: 'GEZDGNBVGY3TQOJQ',
      }),
    ).toEqual([]);
  });
});
