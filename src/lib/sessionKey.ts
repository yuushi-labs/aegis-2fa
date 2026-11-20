/**
 * 「自動ロック：なし」のときだけ使う、同じタブ内でのセッション継続。
 *
 * マスターパスワードは決して保存しない。復帰に使うのは DEK（データ鍵）だけで、
 * 置き場所は sessionStorage にする（同じタブの再読み込みでは残り、タブを閉じると消える）。
 * 封筒の指紋を一緒に持ち、パスワード変更やボルトの入れ替えで指紋が変わったら使わない。
 *
 * 消すタイミング（呼び出し側の責務）:
 * - 手動ロック / lockOnHide によるロック
 * - 自動ロックを 0 以外へ変更
 * - ボルトの作成・置換・接続・削除（リセット）
 */

import { base64ToBytes, bytesToBase64 } from '../../shared/encoding';
import type { VaultEnvelope } from '../../shared/types';

export const SESSION_DEK_KEY = 'aegis.session.dek.v1';

/** DEK の長さ（AES-256）。 */
const DEK_BYTES = 32;

type StoredSession = {
  v: 1;
  /** どの封筒用の DEK か（パスワード変更などで変わる） */
  fingerprint: string;
  /** DEK を base64 で保持する */
  dek: string;
};

function getStorage(): Storage | null {
  try {
    // プライベートモードや設定で禁止されている環境では例外になる。
    const storage = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

/**
 * 封筒の同一性を表す文字列。KDF の塩・反復回数とラップ鍵の暗号文から作る。
 * パスワード変更（再ラップ）で変わるので、古いセッションを誤って復号に使わない。
 */
export function envelopeFingerprint(envelope: VaultEnvelope): string {
  return [
    envelope.format,
    envelope.kdf.name,
    String(envelope.kdf.iterations),
    envelope.kdf.salt,
    envelope.wrappedKey.iv,
    envelope.wrappedKey.ciphertext,
  ].join('|');
}

/** セッション継続用に DEK を預ける。保存できたら true。 */
export function saveSessionDek(envelope: VaultEnvelope, dek: Uint8Array): boolean {
  const storage = getStorage();
  if (storage === null) return false;
  if (dek.length !== DEK_BYTES) return false;
  const value: StoredSession = {
    v: 1,
    fingerprint: envelopeFingerprint(envelope),
    dek: bytesToBase64(dek),
  };
  try {
    storage.setItem(SESSION_DEK_KEY, JSON.stringify(value));
    return true;
  } catch {
    // 容量超過などで保存できなくても、アンロック自体は続けられる。
    return false;
  }
}

/** 封筒に合う DEK が預けてあれば取り出す。合わない・壊れていれば null（その場合は消す）。 */
export function readSessionDek(envelope: VaultEnvelope): Uint8Array | null {
  const storage = getStorage();
  if (storage === null) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(SESSION_DEK_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (parsed.v !== 1 || typeof parsed.dek !== 'string' || typeof parsed.fingerprint !== 'string') {
      clearSessionDek();
      return null;
    }
    if (parsed.fingerprint !== envelopeFingerprint(envelope)) {
      clearSessionDek();
      return null;
    }
    const dek = base64ToBytes(parsed.dek);
    if (dek.length !== DEK_BYTES) {
      clearSessionDek();
      return null;
    }
    return dek;
  } catch {
    clearSessionDek();
    return null;
  }
}

/** 預けた DEK を消す（手動ロック・設定変更・ボルトの作り直しなど）。 */
export function clearSessionDek(): void {
  const storage = getStorage();
  if (storage === null) return;
  try {
    storage.removeItem(SESSION_DEK_KEY);
  } catch {
    // 消せなくても致命的ではない（次回の解錠で上書きされる）。
  }
}

/** セッション継続用の DEK が預けてあるか（テスト・診断用）。 */
export function hasSessionDek(envelope: VaultEnvelope): boolean {
  return readSessionDek(envelope) !== null;
}
