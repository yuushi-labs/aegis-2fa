import { test, expect, createVault, addManualAccount, RFC_SECRET } from './helpers';

test.describe('モバイル 375px', () => {
  test('横スクロールが発生せず、主要操作が画面内に収まる', async ({ page }) => {
    await createVault(page, { sync: false });
    await addManualAccount(page, { issuer: 'とても長いサービス名のテスト', label: 'a-very-long-account-name@example.com', secret: RFC_SECRET });

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);

    await expect(page.getByTestId('otp-code').first()).toBeVisible();
    await expect(page.getByRole('link', { name: '追加', exact: true })).toBeInViewport();

    // コード表示・コピー・ピン留めの各ボタンがタップ可能な大きさで画面内にあること。
    const row = page.getByTestId('account-row').first();
    for (const button of await row.getByRole('button').all()) {
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      if (box === null) continue;
      expect(box.width).toBeGreaterThanOrEqual(24);
      expect(box.height).toBeGreaterThanOrEqual(24);
      expect(box.x + box.width).toBeLessThanOrEqual(375);
    }

    await page.getByRole('link', { name: '設定', exact: true }).click();
    const settingsOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(settingsOverflow).toBeLessThanOrEqual(1);
  });

  test('ダークテーマでも文字色が下地と十分にコントラストを持つ', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await createVault(page, { sync: false });
    const contrast = await page.evaluate(() => {
      const parse = (value: string): [number, number, number] => {
        const match = /(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/.exec(value);
        return match === null ? [0, 0, 0] : [Number(match[1]), Number(match[2]), Number(match[3])];
      };
      const luminance = ([r, g, b]: [number, number, number]): number => {
        const channel = (value: number): number => {
          const scaled = value / 255;
          return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      };
      const heading = document.querySelector('h1');
      if (heading === null) return 0;
      const style = getComputedStyle(heading);
      const fg = parse(style.color);
      let node: HTMLElement | null = heading;
      let bg: [number, number, number] = [255, 255, 255];
      while (node !== null) {
        const value = getComputedStyle(node).backgroundColor;
        if (value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent') {
          bg = parse(value);
          break;
        }
        node = node.parentElement;
      }
      const a = luminance(fg) + 0.05;
      const b = luminance(bg) + 0.05;
      return a > b ? a / b : b / a;
    });
    expect(contrast).toBeGreaterThan(4.5);
  });
});

test.describe('モバイル 375px（削除導線とセッション）', () => {
  test('行から削除でき、自動ロック「なし」はリロードでも解錠が続く', async ({ page }) => {
    await createVault(page, { sync: false });
    await addManualAccount(page, { issuer: 'MobileCo', label: 'mobile@example.com', secret: RFC_SECRET });

    // なし にすると、リロードしてもロック画面に戻らない。
    await page.getByRole('link', { name: '設定', exact: true }).click();
    await page.getByTestId('auto-lock-select').selectOption('0');
    await page.reload();
    await page.getByRole('link', { name: 'Zekey' }).click();
    await expect(page.getByTestId('otp-code').first()).toBeVisible();

    // 行の「削除」は 1 タップで確認ダイアログを開く。
    await page.getByTestId('account-row').first().getByTestId('delete-account').click();
    await expect(page.getByRole('dialog', { name: 'アカウントを削除' })).toBeVisible();
    await page.getByTestId('confirm-delete-account').click();
    await expect(page.getByTestId('account-row')).toHaveCount(0);
  });
});
