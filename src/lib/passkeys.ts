/**
 * WebAuthn（`navigator.credentials`）まわり。ブラウザ専用。
 *
 * 鍵導出・DEK のラップは `shared/passkey.ts`、保存は `src/lib/storage.ts`。
 * ここは「認証器と話して PRF 出力を受け取る」ことだけを担当する。
 *
 * - PRF 拡張に対応していない認証器では登録を中断する（`PasskeyPrfUnsupportedError`）。
 * - ユーザーがダイアログを閉じた／拒否した場合は `PasskeyCancelledError`。
 * - http の IP アドレスなど、WebAuthn を使えない環境は `PasskeyUnavailableError`。
 * - チャレンジはサーバーで検証しない（サーバーに認証テーブルを持たない設計のため）。
 *   ここでのチャレンジはリプレイ防止ではなく、WebAuthn の API 要件を満たすためのもの。
 *   実際の防御は「PRF 出力から導出した鍵でしか DEK を開けない」ことにある。
 */

import { base64ToBytes, bytesToBase64 } from '../../shared/encoding';

const TIMEOUT_MS = 60_000;
const CHALLENGE_LENGTH = 32;
const RP_NAME = 'Zekey 2FA';
/**
 * 認証器に保存する利用者名（表示用の表示名は別に渡す）。
 *
 * 認証器の一覧に表示されるだけの値で、鍵の導出には使わない。すでに登録済みの
 * パスキーは旧名（`aegis-vault`）のまま認証器に残るが、そのまま使える。
 */
const USER_NAME = 'zekey-vault';

/** 登録に使う既存レコードの最小情報。 */
export type PasskeyCandidate = {
  /** credentialId（base64） */
  id: string;
  /** PRF の eval 用 salt（base64） */
  prfSalt: string;
  transports?: string[];
};

export type CreatedPasskey = {
  credentialId: string;
  prfOutput: Uint8Array;
  transports: string[];
};

export type PasskeyAssertion = {
  credentialId: string;
  prfOutput: Uint8Array;
};

export class PasskeyCancelledError extends Error {
  constructor() {
    super('パスキーの操作がキャンセルされました');
    this.name = 'PasskeyCancelledError';
  }
}

export class PasskeyPrfUnsupportedError extends Error {
  constructor() {
    super('この認証器は PRF 拡張に対応していません');
    this.name = 'PasskeyPrfUnsupportedError';
  }
}

export class PasskeyUnavailableError extends Error {
  constructor(message = 'この環境ではパスキーを使えません') {
    super(message);
    this.name = 'PasskeyUnavailableError';
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function randomChallenge(): Uint8Array {
  const bytes = new Uint8Array(CHALLENGE_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** WebAuthn を使える環境か（HTTPS か localhost、かつ PublicKeyCredential がある）。 */
export function isPasskeyAvailable(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (typeof window.PublicKeyCredential === 'undefined') return false;
  if (window.isSecureContext !== true) return false;
  const credentials = navigator.credentials as CredentialsContainer | undefined;
  return typeof credentials?.create === 'function' && typeof credentials.get === 'function';
}

/** WebAuthn の例外を、画面に出せる型へ振り分ける。 */
function translateError(error: unknown): Error {
  const name = (error as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'AbortError') return new PasskeyCancelledError();
  if (name === 'NotSupportedError' || name === 'SecurityError' || name === 'InvalidStateError') {
    return new PasskeyUnavailableError();
  }
  return error instanceof Error ? error : new Error(String(error));
}

type PrfExtension = {
  enabled?: boolean;
  results?: { first?: ArrayBuffer };
};

/**
 * PRF 拡張の応答を読む。
 *
 * - `create` では認証器が PRF に対応していれば `prf.enabled === true` が返る
 *   （登録の可否はこれで判断する）。
 * - `get` では `enabled` は返らず、`prf.results.first`（32B）だけが返る。
 *   そのため認証時の判定は `results.first` の有無で行う。
 */
function readPrf(credential: PublicKeyCredential): { enabled?: boolean; first: Uint8Array | null } {
  const extensions = credential.getClientExtensionResults() as { prf?: PrfExtension } | undefined;
  const prf = extensions?.prf;
  const first = prf?.results?.first;
  return {
    ...(prf?.enabled === undefined ? {} : { enabled: prf.enabled }),
    first: first === undefined ? null : new Uint8Array(first),
  };
}

/**
 * 新しいパスキー / セキュリティキーを登録し、PRF 出力を受け取る。
 *
 * `prfSalt` はボルトで共通の値を使う（同じボルトの複数のパスキーを 1 回の
 * `get` でまとめて提示できるようにするため）。
 */
export async function createPasskeyCredential(options: {
  userId: Uint8Array;
  prfSalt: Uint8Array;
  /** 認証器に表示される名前（利用者が付けた表示名） */
  displayName: string;
}): Promise<CreatedPasskey> {
  if (!isPasskeyAvailable()) throw new PasskeyUnavailableError();
  const credentials = navigator.credentials;
  let credential: Credential | null;
  try {
    credential = await credentials.create({
      publicKey: {
        challenge: toArrayBuffer(randomChallenge()),
        // rp.id は省略する（このオリジンの実効ドメインが入る）。
        rp: { name: RP_NAME },
        user: {
          id: toArrayBuffer(options.userId),
          name: USER_NAME,
          displayName: options.displayName,
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          userVerification: 'required',
          residentKey: 'preferred',
          requireResidentKey: false,
        },
        timeout: TIMEOUT_MS,
        attestation: 'none',
        extensions: { prf: { eval: { first: toArrayBuffer(options.prfSalt) } } },
      },
    });
  } catch (error) {
    throw translateError(error);
  }
  if (credential === null) throw new PasskeyCancelledError();
  const publicKey = credential as PublicKeyCredential;
  const credentialId = bytesToBase64(new Uint8Array(publicKey.rawId));

  const prf = readPrf(publicKey);
  // PRF 非対応なら登録を中断する。`enabled` を返さない実装もあるので、
  // 実際に PRF 出力が返っていれば対応しているとみなす。
  if (prf.enabled !== true && prf.first === null) throw new PasskeyPrfUnsupportedError();
  let prfOutput = prf.first;
  if (prfOutput === null) {
    // create では PRF の結果を返さない実装があるので、同じ認証器に eval 付きで get する。
    const assertion = await getPasskeyAssertion([
      { id: credentialId, prfSalt: bytesToBase64(options.prfSalt) },
    ]);
    prfOutput = assertion.prfOutput;
  }

  const response = publicKey.response as AuthenticatorAttestationResponse;
  const transports =
    typeof response.getTransports === 'function' ? response.getTransports() : ([] as string[]);
  return { credentialId, prfOutput, transports };
}

/**
 * 登録済みのパスキーのどれかで認証し、PRF 出力を受け取る。
 * `allowCredentials` に全候補を渡すので、複数登録していれば利用者が選べる。
 */
export async function getPasskeyAssertion(candidates: readonly PasskeyCandidate[]): Promise<PasskeyAssertion> {
  if (!isPasskeyAvailable()) throw new PasskeyUnavailableError();
  const first = candidates[0];
  if (first === undefined) throw new PasskeyUnavailableError('登録済みのパスキーがありません');
  // 1 回の get では 1 つの salt しか評価できない。salt が食い違う古い登録が
  // 混ざっている場合に備え、先頭と同じ salt の組だけを提示する。
  const group = candidates.filter((candidate) => candidate.prfSalt === first.prfSalt);
  const salt = base64ToBytes(first.prfSalt);
  const credentials = navigator.credentials;
  let credential: Credential | null;
  try {
    credential = await credentials.get({
      publicKey: {
        challenge: toArrayBuffer(randomChallenge()),
        allowCredentials: group.map((candidate) => ({
          type: 'public-key' as const,
          id: toArrayBuffer(base64ToBytes(candidate.id)),
          ...(candidate.transports === undefined
            ? {}
            : { transports: candidate.transports as AuthenticatorTransport[] }),
        })),
        userVerification: 'required',
        timeout: TIMEOUT_MS,
        extensions: { prf: { eval: { first: toArrayBuffer(salt) } } },
      },
    });
  } catch (error) {
    throw translateError(error);
  }
  if (credential === null) throw new PasskeyCancelledError();
  const publicKey = credential as PublicKeyCredential;
  const prf = readPrf(publicKey);
  // 認証時は enabled が返らないので、PRF 出力そのものの有無で判断する。
  if (prf.first === null) throw new PasskeyPrfUnsupportedError();
  return {
    credentialId: bytesToBase64(new Uint8Array(publicKey.rawId)),
    prfOutput: prf.first,
  };
}
