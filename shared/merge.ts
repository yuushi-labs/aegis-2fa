/**
 * 同期の競合解決: アカウント id 単位の union。
 * 同一 id は updatedAt が新しい方を採る。
 *
 * updatedAt が同じ場合は、内容を安定した順序で直列化して比較し、
 * 引数の順序（どちらが base か）によらず同じ結果になるようにする。
 *
 * 削除は tombstone（id + deletedAt）で表し、削除時刻がアカウントの updatedAt 以上なら
 * そのアカウントはマージ結果から取り除く（削除したアカウントが別端末から復活しない）。
 */

import { purgeExpiredTrash } from './trash';
import type { Account, PasskeyInfo, SyncDevice, Tombstone, VaultData } from './types';

export type MergeResult = {
  data: VaultData;
  /** マージで増えた件数 */
  added: number;
  /** 更新された件数 */
  updated: number;
  /** 失われた（ローカル側で上書きされた）件数 */
  overwritten: number;
  /** 削除記録によって取り除かれた件数 */
  deleted: number;
};

/** キー順を固定した JSON 文字列（内容比較用）。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** 内容の安定比較。同じ内容なら 0、辞書順で大きい方が正。 */
export function compareAccountContent(a: Account, b: Account): number {
  const left = stableStringify(a);
  const right = stableStringify(b);
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function isNewer(candidate: Account, current: Account): boolean {
  const a = Date.parse(candidate.updatedAt);
  const b = Date.parse(current.updatedAt);
  if (Number.isNaN(a) || Number.isNaN(b)) {
    if (candidate.updatedAt !== current.updatedAt) return candidate.updatedAt > current.updatedAt;
  } else if (a !== b) {
    return a > b;
  }
  // 同時刻（または比較不能）: 内容で決める（入力順に依存しない）。
  return compareAccountContent(candidate, current) > 0;
}

/** 2 つの時刻表現を比較する（不正な値は文字列比較にフォールバック）。 */
function compareTimestamps(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) {
    if (a === b) return 0;
    return a > b ? 1 : -1;
  }
  if (ta === tb) return 0;
  return ta > tb ? 1 : -1;
}

/** 削除記録を id 単位に統合する（同じ id は新しい deletedAt を残す）。 */
export function mergeTombstones(
  ...lists: readonly (readonly Tombstone[] | undefined)[]
): Tombstone[] {
  const byId = new Map<string, Tombstone>();
  for (const list of lists) {
    for (const tombstone of list ?? []) {
      const current = byId.get(tombstone.id);
      if (current === undefined || compareTimestamps(tombstone.deletedAt, current.deletedAt) > 0) {
        byId.set(tombstone.id, tombstone);
      }
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** そのアカウントが削除済みか（削除がアカウントの更新以降なら削除扱い）。 */
function isDeleted(account: Account, tombstones: Map<string, Tombstone>): boolean {
  const tombstone = tombstones.get(account.id);
  if (tombstone === undefined) return false;
  return compareTimestamps(tombstone.deletedAt, account.updatedAt) >= 0;
}

export function mergeVaultData(
  base: VaultData,
  incoming: VaultData,
  options: { now?: number } = {},
): MergeResult {
  const now = options.now ?? Date.now();
  // ゴミ箱に 30 日以上置かれたものは、マージの前に完全削除へ進める
  // （どちらの端末からも期限切れの平文が残らないように）。
  const purgedBase = purgeExpiredTrash(base.accounts, base.tombstones ?? [], now);
  const purgedIncoming = purgeExpiredTrash(incoming.accounts, incoming.tombstones ?? [], now);
  const tombstones = mergeTombstones(purgedBase.tombstones, purgedIncoming.tombstones);
  const tombstoneIndex = new Map(tombstones.map((tombstone) => [tombstone.id, tombstone]));

  // 削除済みは最初から対象外にする（件数にも数えない）。
  const baseAccounts = purgedBase.accounts.filter((account) => !isDeleted(account, tombstoneIndex));
  const incomingAccounts = purgedIncoming.accounts.filter(
    (account) => !isDeleted(account, tombstoneIndex),
  );

  // 削除記録で除外した「元のローカル id」も覚えておく（作り直しは追加ではなく更新として数える）。
  const baseIds = new Set(base.accounts.map((account) => account.id));
  const byId = new Map<string, Account>();
  for (const account of baseAccounts) {
    byId.set(account.id, account);
  }
  let added = 0;
  let updated = 0;
  let overwritten = 0;

  for (const candidate of incomingAccounts) {
    const current = byId.get(candidate.id);
    if (current === undefined) {
      byId.set(candidate.id, candidate);
      if (baseIds.has(candidate.id)) updated += 1;
      else added += 1;
    } else if (compareAccountContent(candidate, current) === 0) {
      // 完全に同一なら件数に数えない。
      continue;
    } else if (isNewer(candidate, current)) {
      byId.set(candidate.id, candidate);
      updated += 1;
    } else {
      overwritten += 1;
    }
  }

  // 削除記録で取り除かれた件数（base 側と、incoming で新規だったもの）。
  // ゴミ箱の期限切れで完全削除された件数もここに含める。
  const deleted =
    base.accounts.length -
    baseAccounts.length +
    purgedIncoming.accounts.filter((account) => isDeleted(account, tombstoneIndex) && !baseIds.has(account.id))
      .length;

  const accounts = [...byId.values()].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.order !== b.order) return a.order - b.order;
    return a.createdAt.localeCompare(b.createdAt);
  });

  const devices = mergeDevices(base.devices, incoming.devices);
  const passkeyInfos = mergePasskeyInfos(base.passkeyInfos, incoming.passkeyInfos);
  return {
    data: {
      accounts,
      tombstones,
      ...(devices.length === 0 ? {} : { devices }),
      ...(passkeyInfos.length === 0 ? {} : { passkeyInfos }),
    },
    added,
    updated,
    overwritten,
    deleted,
  };
}

/** 端末一覧を id 単位に統合する（同じ端末は lastSyncedAt が新しい方を採る）。 */
export function mergeDevices(
  ...lists: readonly (readonly SyncDevice[] | undefined)[]
): SyncDevice[] {
  const byId = new Map<string, SyncDevice>();
  for (const list of lists) {
    for (const device of list ?? []) {
      if (typeof device?.id !== 'string' || device.id === '') continue;
      const current = byId.get(device.id);
      if (current === undefined || compareTimestamps(device.lastSyncedAt, current.lastSyncedAt) > 0) {
        byId.set(device.id, {
          id: device.id,
          name: typeof device.name === 'string' && device.name !== '' ? device.name : 'Device',
          platform: typeof device.platform === 'string' ? device.platform : '',
          lastSyncedAt: typeof device.lastSyncedAt === 'string' ? device.lastSyncedAt : '',
        });
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 同じ登録 id の 2 件から採る方を決める。
 *
 * 登録日時が違えば新しい方（表示名の付け替え）。同じなら端末名で決める
 * ——端末名の変更は登録日時を変えないため、入力順に任せると端末ごとに
 * 違う名前が残り、同期のたびに書き戻されて収束しない。
 */
function newerPasskeyInfo(a: PasskeyInfo, b: PasskeyInfo): PasskeyInfo {
  const byCreatedAt = compareTimestamps(a.createdAt, b.createdAt);
  if (byCreatedAt !== 0) return byCreatedAt > 0 ? a : b;
  const left = `${a.deviceName ?? ''}\u0000${a.name}`;
  const right = `${b.deviceName ?? ''}\u0000${b.name}`;
  return right > left ? b : a;
}

/**
 * パスキー登録のメタ情報を id 単位に統合する。
 *
 * - 同じ id は createdAt が新しい方を採る（名前の付け替えを反映する）。
 * - 削除（deletedAt）は取り消さない（古い端末が持っている「生きている」情報で
 *   消したはずの登録を復活させない）。
 * - 秘密は含まないので、件数の上限は設けず削除済みの記録も残す（削除の伝播のため）。
 */
export function mergePasskeyInfos(
  ...lists: readonly (readonly PasskeyInfo[] | undefined)[]
): PasskeyInfo[] {
  const byId = new Map<string, PasskeyInfo>();
  for (const list of lists) {
    for (const info of list ?? []) {
      if (typeof info?.id !== 'string' || info.id === '') continue;
      const normalized: PasskeyInfo = {
        id: info.id,
        name: typeof info.name === 'string' && info.name !== '' ? info.name : 'Passkey',
        createdAt: typeof info.createdAt === 'string' ? info.createdAt : '',
        ...(typeof info.deviceId === 'string' && info.deviceId !== '' ? { deviceId: info.deviceId } : {}),
        ...(typeof info.deviceName === 'string' && info.deviceName !== ''
          ? { deviceName: info.deviceName }
          : {}),
        ...(typeof info.deletedAt === 'string' && info.deletedAt !== '' ? { deletedAt: info.deletedAt } : {}),
      };
      const current = byId.get(info.id);
      if (current === undefined) {
        byId.set(info.id, normalized);
        continue;
      }
      const newer = newerPasskeyInfo(normalized, current);
      const deletedAt =
        current.deletedAt === undefined
          ? normalized.deletedAt
          : normalized.deletedAt === undefined
            ? current.deletedAt
            : compareTimestamps(normalized.deletedAt, current.deletedAt) > 0
              ? normalized.deletedAt
              : current.deletedAt;
      byId.set(info.id, {
        id: newer.id,
        name: newer.name,
        createdAt: newer.createdAt,
        ...(newer.deviceId === undefined ? {} : { deviceId: newer.deviceId }),
        ...(newer.deviceName === undefined ? {} : { deviceName: newer.deviceName }),
        ...(deletedAt === undefined ? {} : { deletedAt }),
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** 重複判定キー: issuer + label + secret。 */
export function accountFingerprint(account: Pick<Account, 'issuer' | 'label' | 'secret'>): string {
  return `${account.issuer.toLowerCase()}\u0000${account.label.toLowerCase()}\u0000${account.secret}`;
}

export function findDuplicates(
  existing: readonly Account[],
  candidates: readonly Pick<Account, 'issuer' | 'label' | 'secret'>[],
): Set<number> {
  const seen = new Set(existing.map(accountFingerprint));
  const duplicates = new Set<number>();
  candidates.forEach((candidate, index) => {
    const key = accountFingerprint(candidate);
    if (seen.has(key)) {
      duplicates.add(index);
    } else {
      seen.add(key);
    }
  });
  return duplicates;
}
