/**
 * クリップボード。navigator.clipboard 不可なら execCommand へフォールバック。
 * 30 秒後に同じ値なら自動クリア（設定で on/off）。
 */

const CLEAR_DELAY_MS = 30_000;
const MAX_FOCUS_RETRIES = 1;

let clearTimer: ReturnType<typeof setTimeout> | null = null;

async function writeViaClipboardApi(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 権限拒否などはフォールバックへ。
  }
  return false;
}

function writeViaExecCommand(text: string): boolean {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export async function copyText(text: string): Promise<boolean> {
  const ok = (await writeViaClipboardApi(text)) || writeViaExecCommand(text);
  return ok;
}

export type ClipboardClearOutcome =
  /** 消去した、またはまだ残っている（未実行） */
  | 'pending'
  | 'cleared'
  | 'skipped'
  /** 読み取れず、消去できなかった（クリップボードには値が残っている） */
  | 'failed';

let lastOutcome: ClipboardClearOutcome = 'pending';

/** 直近の自動クリア結果（成功可否を呼び出し側が参照できる）。 */
export function getLastClipboardClearOutcome(): ClipboardClearOutcome {
  return lastOutcome;
}

/**
 * クリップボードがまだ同じ値なら空にする。
 * 戻り値の Promise は消去を試みた結果で解決する（失敗しても reject しない）。
 * フォーカス不足が原因の失敗は、ウィンドウがフォーカスを得た時点で 1 回だけ再試行する。
 */
export function scheduleClipboardClear(copiedValue: string, enabled: boolean): Promise<ClipboardClearOutcome> {
  if (!enabled) {
    lastOutcome = 'skipped';
    return Promise.resolve('skipped');
  }
  if (clearTimer !== null) clearTimeout(clearTimer);
  return new Promise((resolve) => {
    clearTimer = setTimeout(() => {
      clearTimer = null;
      void attemptClear(copiedValue, MAX_FOCUS_RETRIES).then(resolve);
    }, CLEAR_DELAY_MS);
  });
}

async function attemptClear(copiedValue: string, retriesLeft: number): Promise<ClipboardClearOutcome> {
  try {
    const current = await navigator.clipboard?.readText();
    if (current !== copiedValue) {
      lastOutcome = 'skipped';
      return 'skipped';
    }
    await (navigator.clipboard as Clipboard).writeText('');
    lastOutcome = 'cleared';
    return 'cleared';
  } catch {
    // 読み取り権限が無い場合は書き込みで上書きしない（現在の方針を維持）。
    if (retriesLeft > 0 && typeof document !== 'undefined' && !document.hasFocus()) {
      await new Promise<void>((resolve) => {
        const onFocus = (): void => {
          window.removeEventListener('focus', onFocus);
          resolve();
        };
        window.addEventListener('focus', onFocus);
        // 何かの拍子にフォーカスが戻らない場合に備えて、少しで打ち切る。
        setTimeout(() => {
          window.removeEventListener('focus', onFocus);
          resolve();
        }, CLEAR_DELAY_MS);
      });
      return attemptClear(copiedValue, retriesLeft - 1);
    }
    lastOutcome = 'failed';
    return 'failed';
  }
}

export function cancelClipboardClear(): void {
  if (clearTimer !== null) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
}

export const CLIPBOARD_CLEAR_DELAY_MS = CLEAR_DELAY_MS;
