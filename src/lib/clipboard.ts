/**
 * クリップボード。navigator.clipboard 不可なら execCommand へフォールバック。
 * 30 秒後に同じ値なら自動クリア（設定で on/off）。
 */

const CLEAR_DELAY_MS = 30_000;
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

/** 一定時間後に、クリップボードがまだ同じ値なら空にする。 */
export function scheduleClipboardClear(copiedValue: string, enabled: boolean): void {
  if (!enabled) return;
  if (clearTimer !== null) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    clearTimer = null;
    void (async () => {
      try {
        const current = await navigator.clipboard?.readText();
        if (current === copiedValue) {
          await navigator.clipboard.writeText('');
        }
      } catch {
        // 読み取り権限が無い場合は何もしない（書き込みで上書きしない）。
      }
    })();
  }, CLEAR_DELAY_MS);
}

export function cancelClipboardClear(): void {
  if (clearTimer !== null) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
}

export const CLIPBOARD_CLEAR_DELAY_MS = CLEAR_DELAY_MS;
