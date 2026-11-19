import { describe, expect, it } from 'vitest';
import {
  CryptoError,
  WrongPasswordError,
  createVaultEnvelope,
  generateDek,
  isVaultEnvelopeShape,
  reencryptVaultData,
  rewrapEnvelope,
  unlockVaultEnvelope,
  updateEnvelopeData,
  verifyPassword,
} from '../../shared/crypto';
import { deriveTokenHash, deriveVaultId, formatSyncCode, generateSyncToken, isValidSyncToken, isValidVaultId, normalizeSyncCode } from '../../shared/sync';
import type { VaultEnvelope } from '../../shared/types';

const PASSWORD = 'correct horse battery staple';
const PLAINTEXT = JSON.stringify({ accounts: [{ id: 'x', secret: 'JBSWY3DPEHPK3PXP' }] });

describe('ボルト暗号（PBKDF2 + AES-256-GCM）', () => {
  it('作成→解錠の往復で平文が戻る', async () => {
    const envelope = await createVaultEnvelope({ password: PASSWORD, plaintext: PLAINTEXT });
    const unlocked = await unlockVaultEnvelope(envelope, PASSWORD);
    expect(unlocked.plaintext).toBe(PLAINTEXT);
    expect(unlocked.revision).toBe(1);
    expect(unlocked.dek).toHaveLength(32);
  });

  it('封筒の構造が仕様どおり', async () => {
    const envelope = await createVaultEnvelope({ password: PASSWORD, plaintext: PLAINTEXT });
    expect(envelope.format).toBe('aegis-vault');
    expect(envelope.version).toBe(1);
    expect(envelope.kdf.name).toBe('PBKDF2-SHA256');
    expect(envelope.kdf.iterations).toBe(600_000);
    // salt 16 bytes → base64 24 文字
    expect(atob(envelope.kdf.salt)).toHaveLength(16);
    // IV 12 bytes
    expect(atob(envelope.wrappedKey.iv)).toHaveLength(12);
    expect(atob(envelope.data.iv)).toHaveLength(12);
    // verifier 16 bytes
    expect(atob(envelope.verifier)).toHaveLength(16);
    expect(isVaultEnvelopeShape(envelope)).toBe(true);
  });

  it('誤パスワードでは復号できない', async () => {
    const envelope = await createVaultEnvelope({ password: PASSWORD, plaintext: PLAINTEXT });
    await expect(unlockVaultEnvelope(envelope, 'wrong password here')).rejects.toBeInstanceOf(WrongPasswordError);
    await expect(verifyPassword(envelope, 'wrong password here')).resolves.toBe(false);
    await expect(verifyPassword(envelope, PASSWORD)).resolves.toBe(true);
  });

  it('暗号文を 1 バイト改変すると復号に失敗する', async () => {
    const envelope = await createVaultEnvelope({ password: PASSWORD, plaintext: PLAINTEXT });
    const bytes = Uint8Array.from(atob(envelope.data.ciphertext), (c) => c.charCodeAt(0));
    bytes[0] = (bytes[0] as number) ^ 0x01;
    const tampered: VaultEnvelope = {
      ...envelope,
      data: { ...envelope.data, ciphertext: btoa(String.fromCharCode(...bytes)) },
    };
    await expect(unlockVaultEnvelope(tampered, PASSWORD)).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('verifier を改変すると復号に失敗する', async () => {
    const envelope = await createVaultEnvelope({ password: PASSWORD, plaintext: PLAINTEXT });
    const tampered: VaultEnvelope = { ...envelope, verifier: btoa('0'.repeat(16)) };
    await expect(unlockVaultEnvelope(tampered, PASSWORD)).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('IV と salt は毎回異なる', async () => {
    const a = await createVaultEnvelope({ password: PASSWORD, plaintext: PLAINTEXT });
    const b = await createVaultEnvelope({ password: PASSWORD, plaintext: PLAINTEXT });
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.data.iv).not.toBe(b.data.iv);
    expect(a.wrappedKey.iv).not.toBe(b.wrappedKey.iv);
    expect(a.data.ciphertext).not.toBe(b.data.ciphertext);
  });

  it('AAD に revision を含むため、revision を改変すると復号に失敗する', async () => {
    const envelope = await createVaultEnvelope({ password: PASSWORD, plaintext: PLAINTEXT, revision: 3 });
    await expect(unlockVaultEnvelope({ ...envelope, revision: 4 }, PASSWORD)).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
  });

  it('revision を進めてデータを再暗号化できる', async () => {
    const envelope = await createVaultEnvelope({ password: PASSWORD, plaintext: PLAINTEXT });
    const { dek } = await unlockVaultEnvelope(envelope, PASSWORD);
    const next = await updateEnvelopeData(envelope, dek, '{"accounts":[]}', 2, '2024-05-05T00:00:00.000Z');
    expect(next.revision).toBe(2);
    expect(next.data.iv).not.toBe(envelope.data.iv);
    const unlocked = await unlockVaultEnvelope(next, PASSWORD);
    expect(unlocked.plaintext).toBe('{"accounts":[]}');
    expect(unlocked.revision).toBe(2);
  });

  it('reencryptVaultData は data と verifier だけを差し替える', async () => {
    const envelope = await createVaultEnvelope({ password: PASSWORD, plaintext: PLAINTEXT });
    const { dek } = await unlockVaultEnvelope(envelope, PASSWORD);
    const patch = await reencryptVaultData({
      password: PASSWORD,
      dek,
      salt: Uint8Array.from(atob(envelope.kdf.salt), (c) => c.charCodeAt(0)),
      iterations: envelope.kdf.iterations,
      plaintext: '{"accounts":[1]}',
      revision: 5,
    });
    const merged: VaultEnvelope = { ...envelope, ...patch, revision: 5 };
    await expect(unlockVaultEnvelope(merged, PASSWORD)).resolves.toMatchObject({
      plaintext: '{"accounts":[1]}',
      revision: 5,
    });
  });

  it('パスワード変更後は新パスワードでのみ解錠できる', async () => {
    const envelope = await createVaultEnvelope({ password: PASSWORD, plaintext: PLAINTEXT });
    const { dek } = await unlockVaultEnvelope(envelope, PASSWORD);
    const rewrapped = await rewrapEnvelope(envelope, dek, 'a-brand-new-passphrase');
    await expect(unlockVaultEnvelope(rewrapped, 'a-brand-new-passphrase')).resolves.toMatchObject({
      plaintext: PLAINTEXT,
    });
    await expect(unlockVaultEnvelope(rewrapped, PASSWORD)).rejects.toBeInstanceOf(WrongPasswordError);
    expect(rewrapped.kdf.salt).not.toBe(envelope.kdf.salt);
    expect(rewrapped.data.ciphertext).toBe(envelope.data.ciphertext);
  });

  it('平文秘密鍵は封筒のどこにも現れない', async () => {
    const envelope = await createVaultEnvelope({ password: PASSWORD, plaintext: PLAINTEXT });
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain('JBSWY3DPEHPK3PXP');
    expect(serialized).not.toContain(PASSWORD);
  });

  it('弱すぎる反復回数・空パスワードは拒否する', async () => {
    await expect(createVaultEnvelope({ password: '', plaintext: PLAINTEXT })).rejects.toBeInstanceOf(CryptoError);
    await expect(
      createVaultEnvelope({ password: PASSWORD, plaintext: PLAINTEXT, iterations: 1000 }),
    ).rejects.toBeInstanceOf(CryptoError);
  });

  it('generateDek は 32 バイトのランダム値', async () => {
    const a = await generateDek();
    const b = await generateDek();
    expect(a).toHaveLength(32);
    expect([...a]).not.toEqual([...b]);
  });

  it('isVaultEnvelopeShape は壊れた封筒を弾く', () => {
    expect(isVaultEnvelopeShape(null)).toBe(false);
    expect(isVaultEnvelopeShape({ format: 'nope' })).toBe(false);
    expect(isVaultEnvelopeShape({ format: 'aegis-vault', version: 2 })).toBe(false);
  });
});

describe('同期トークン', () => {
  it('トークンは 32 バイトの base64url', () => {
    const token = generateSyncToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isValidSyncToken(token)).toBe(true);
    expect(generateSyncToken()).not.toBe(token);
  });

  it('vaultId は SHA-256 の先頭 32 hex', async () => {
    const token = generateSyncToken();
    const id = await deriveVaultId(token);
    const hash = await deriveTokenHash(token);
    expect(id).toHaveLength(32);
    expect(id).toBe(hash.slice(0, 32));
    expect(isValidVaultId(id)).toBe(true);
    expect(isValidVaultId('ABCDEF')).toBe(false);
  });

  it('同じトークンから同じ vaultId が出る（別端末で一致）', async () => {
    const token = generateSyncToken();
    expect(await deriveVaultId(token)).toBe(await deriveVaultId(token));
  });

  it('同期コードの整形と正規化', () => {
    const token = generateSyncToken();
    expect(normalizeSyncCode(formatSyncCode(token))).toBe(token);
    expect(formatSyncCode('abcdefghijkl')).toBe('abcd efgh ijkl');
  });

  it('不正なトークンは弾く', () => {
    expect(isValidSyncToken('')).toBe(false);
    expect(isValidSyncToken('short')).toBe(false);
    expect(isValidSyncToken('!'.repeat(43))).toBe(false);
  });
});
