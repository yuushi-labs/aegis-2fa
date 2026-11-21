# Aegis 2FA — 仕様書 v1.0

ゼロ知識 E2EE 同期対応の Web 2FA Authenticator（TOTP / HOTP）。
ブラウザだけで秘密鍵を復号し、サーバーには暗号文しか置かない。

- 対象: 個人〜小規模チーム。スマホ・PC の両方で使える PWA。
- UI 言語: 日本語（英語辞書も同梱し、`navigator.language` で自動切替）。
- ライセンス: MIT。

---

## 1. 技術スタック（固定）

| 層 | 採用 |
|---|---|
| フロント | Vite 6 + React 19 + TypeScript (strict) + Tailwind CSS 4 |
| ルーティング | React Router v7（HashRouter ではなく BrowserRouter、サーバーは SPA フォールバック） |
| 状態 | Zustand + TanStack Query（同期 API 用） |
| ローカル保存 | IndexedDB（`idb` ライブラリ）。平文の秘密鍵は「アンロック中のみメモリ」に置き、永続化するのは暗号文のみ |
| API | Hono 4（`@hono/node-server`） |
| DB | SQLite（`better-sqlite3`）+ Drizzle ORM（マイグレーション同梱） |
| QR | `jsqr`（読み取りフォールバック）+ `qrcode`（生成）。`BarcodeDetector` があれば優先 |
| テスト | Vitest（unit / integration）+ Playwright（E2E） |
| パッケージ | pnpm 10（`packageManager` フィールドで固定）、Node 22 |
| 配布 | マルチステージ Dockerfile + docker-compose.yml（単一コンテナで SPA と API を配信） |

リポジトリは pnpm workspace を使わない単一パッケージでよい。`src/` にクライアント、`server/` に API、`shared/` に両者共通の純粋関数（TOTP/HOTP/Base32/otpauth パーサ/暗号）を置く。

API の代替実装として、Node を使えない共用サーバー（Xserver など）向けに **PHP 8.1 以上 + SQLite + `.htaccess`** 版を `deploy/xserver/` に同梱する。エンドポイント・ステータスコード・JSON・制限値は本仕様の §2.8 と同一で、DB スキーマも Node 版と共通（`vaults` テーブル）。セットアップは [deploy/xserver/README.md](deploy/xserver/README.md)。

```
.
├── index.html
├── vite.config.ts
├── tailwind.config.ts（Tailwind 4 なら CSS 設定でも可）
├── tsconfig.json / tsconfig.node.json
├── package.json
├── Dockerfile
├── docker-compose.yml
├── drizzle.config.ts
├── drizzle/                     # SQL マイグレーション
├── shared/                      # 純粋ロジック（DOM 非依存・テスト容易）
│   ├── totp.ts  hotp.ts  base32.ts  otpauth.ts  migration.ts  crypto.ts  types.ts
├── server/
│   ├── index.ts                 # エントリ（PORT, DATABASE_PATH）
│   ├── app.ts                   # Hono アプリ（テストから inject 可能に）
│   ├── db/schema.ts  db/client.ts  migrate.ts
│   ├── routes/vault.ts  routes/health.ts
│   └── middleware/security.ts  middleware/rateLimit.ts  middleware/bodyLimit.ts
├── src/                         # React クライアント
├── tests/unit/  tests/integration/  tests/e2e/
└── .github/workflows/ci.yml
```

---

## 2. 機能要件

### 2.1 アカウント（TOTP/HOTP）モデル

```ts
type Account = {
  id: string;              // uuid v4
  type: 'totp' | 'hotp';
  issuer: string;          // サービス名（空可）
  label: string;           // アカウント名（メール等）
  secret: string;          // Base32（パディング無し・大文字正規化して保持）
  algorithm: 'SHA1' | 'SHA256' | 'SHA512';
  digits: 6 | 8;
  period: number;          // TOTP のみ。既定 30、1〜300
  counter: number;         // HOTP のみ。0 以上
  pinned: boolean;
  order: number;           // 並び替え用
  createdAt: string;       // ISO8601
  updatedAt: string;

  notes?: string;          // サービスごとのメモ（§2.9）
  recoveryCodes?: {        // 使い捨てバックアップコード（§2.9）
    id: string; code: string; used: boolean;
  }[];
  deletedAt?: string;      // ゴミ箱へ移した時刻（§2.10）。無ければ有効
  useCount?: number;       // コードを使った回数（§2.11）
  lastUsedAt?: string;     // 最後に使った時刻（§2.11）
};

type VaultData = {
  accounts: Account[];
  tombstones?: { id: string; deletedAt: string }[];
  devices?: { id: string; name: string; platform: string; lastSyncedAt: string }[]; // §2.14
};
```

暗号化ペイロード（`VaultData`）だけを広げ、**サーバー API と `vaults` テーブルの
スキーマは変更しない**。新しい項目はすべて暗号文の中に入る（サーバーは形も件数も知らない）。

### 2.2 OTP 生成（RFC 6238 / RFC 4226 完全準拠）

- `shared/hotp.ts`: HMAC（Web Crypto）→ dynamic truncation → 桁数で剰余。RFC 4226 のテストベクタ（secret `12345678901234567890`、カウンタ 0〜9）に一致すること。
- `shared/totp.ts`: `Math.floor(unixSeconds / period)` をカウンタに。RFC 6238 のテストベクタ（SHA-1/256/512、T=59, 1111111109, 1111111111, 1234567890, 2000000000）に一致すること。
  - SHA-256/512 は RFC のシードをそれぞれの長さに拡張したものを使う（テスト側で定義）。
- 表示: 現在コード、残り秒数（円形プログレス）、**次期コード**（次のステップのコードを薄く表示）。
- クロックスキュー補正: 設定で `-2〜+2` ステップ（既定 0）。表示・コピーは補正後のコード。
- コピー: クリップボードへ。`navigator.clipboard` 不可なら `document.execCommand` フォールバック。**30 秒後にクリップボードが同じ値なら自動クリア**（設定で on/off）。
- HOTP: コード表示＋「次のコードへ」ボタン（確認ダイアログ → counter++ → 保存 → コード再生成）。サーバーとクライアントの両方で使う値は常に暗号化ストア側に保存。

### 2.3 インポート / エクスポート

1. **otpauth URI**: `otpauth://totp/Issuer:account?secret=...&issuer=...&algorithm=SHA1&digits=6&period=30` と `otpauth://hotp/...&counter=N` のパースと生成（往復で意味が変わらない）。
   - `secret` は Base32（大文字小文字・空白・`=` パディング許容）。不正なら明示エラー。
   - issuer は label の `Issuer:account` とクエリの `issuer` の両対応（クエリ優先、無ければ label から）。
   - 追加手段は「手入力（フォーム）」「QR 読み取り」「画像から」「一括移行」の 4 つだけにし、
     `otpauth://` URI の手入力欄は置かない（secret 欄に URI を貼っても Base32 エラーとして扱う）。
     URI を受け取るのは QR 読み取りだけで、読み取った otpauth URI は同じパーサでフォーム全体
     （issuer / label / secret / type / algorithm / digits / period / counter）に入れて手入力タブへ移る。
     `otpauth-migration://` の QR は一括移行タブへ切り替えて読み込む。
2. **QR 読み取り**: カメラ（`getUserMedia`、背面優先）で連続スキャン。`BarcodeDetector` 未対応ブラウザは `jsqr` にフォールバック。画像ファイルアップロードからのデコードも可。読み取り結果が otpauth URI ならアカウント追加、`otpauth-migration://` なら一括インポート画面へ。
3. **QR エクスポート**: 個別アカウントの otpauth URI を QR 表示（ダウンロード PNG 可）。全アカウントの一括 QR（Google Authenticator 移行形式）も生成（下記）。
4. **Google Authenticator 移行形式**（`otpauth-migration://offline?data=<base64url>`）:
   - Protobuf を自前デコード（依存追加不要、`shared/migration.ts`）。
     - `MigrationPayload { repeated OtpParameters otp_parameters = 1; int32 version = 2; int32 batch_size = 3; int32 batch_index = 4; int32 batch_id = 5; }`
     - `OtpParameters { bytes secret = 1; string name = 2; string issuer = 3; Algorithm algorithm = 4; DigitCount digits = 5; OtpType type = 6; int64 counter = 7; }`
     - enum: Algorithm { ALGORITHM_UNSPECIFIED=0, SHA1=1, SHA256=2, SHA512=3, MD5=4 } / DigitCount { DIGIT_COUNT_UNSPECIFIED=0, SIX=1, EIGHT=2 } / OtpType { OTP_TYPE_UNSPECIFIED=0, HOTP=1, TOTP=2 }
   - MD5 と不明 enum はスキップし、**スキップ件数を UI に表示**。
   - `data` は base64url（`-`/`_`、パディング有無どちらも）。壊れた入力は「この QR は読み取れませんでした」と明示。
   - 一括インポート時は重複（issuer+label+secret）を検出し、追加/スキップを選べる。
   - エクスポート側: 1 つの URI にまとめるため `batch_size = 1` を書く。移行形式は TOTP の周期を持たないので、
     **30 秒以外の TOTP は含めず**、個別の `otpauth` URI での書き出しへ案内する（周期を黙って 30 に変換しない）。
   - デコード時: `int32` のフィールドは符号付きとして解釈する（`batch_id = -1` 等の負値でも取り込み全体を失敗させない）。
     HOTP の `counter`（`int64`）は 0 以上の安全整数に限り、外れた 1 件だけスキップする。
5. **暗号化バックアップ**（`.aegis` ファイル）: E2EE ボルトの暗号文をそのまま書き出す（下記 2.4 の形式）。インポートはパスフレーズ入力 → 復号 → 置換 or マージ選択。
6. **CSV エクスポート（警告付き）**: 平文 CSV（issuer,label,secret,type,algorithm,digits,period,counter）。実行前に「平文で保存されます」旨の確認。既定では出さない。

### 2.4 暗号化とゼロ知識同期

**方針: サーバーは暗号文・ID・バージョン・時刻以外を持たない。パスワードも同期トークンも保存しない（トークンは SHA-256 ハッシュのみ）。**

- KDF: PBKDF2-HMAC-SHA-256、`iterations = 600_000`、salt 16 bytes ランダム。Web Crypto (`crypto.subtle.deriveKey`)。
  受け入れる反復回数は 100,000〜1,000,000 に制限する（外部の封筒が巨大な値を主張して端末を長時間占有するのを防ぐ）。
- ボルト鍵: ランダム 32 bytes の DEK。DEK を KEK で AES-256-GCM ラップ（12 bytes IV、AAD = `aegis-vault-v1`）。
- データ暗号化: DEK で AES-256-GCM。IV 12 bytes ランダム（毎回新規）。AAD = UTF-8 `aegis-data-v1:<vaultVersion>`。
- ボルト封筒（ローカル IndexedDB とサーバーの両方に置く形式）:

```json
{
  "format": "aegis-vault",
  "version": 1,
  "kdf": { "name": "PBKDF2-SHA256", "iterations": 600000, "salt": "b64" },
  "wrappedKey": { "iv": "b64", "ciphertext": "b64" },
  "data": { "iv": "b64", "ciphertext": "b64" },
  "verifier": "b64",          // HMAC-SHA256(DEK, "aegis-verify-v1") の先頭16バイト。誤パスワード判定用
  "revision": 7,               // クライアントが持つ論理リビジョン
  "updatedAt": "ISO8601"
}
```

- 誤パスワード: GCM 認証失敗または verifier 不一致で「パスワードが違います」。5 回失敗で 30 秒のクールダウン（クライアント側）。
- 同期トークン: 初回作成時に 32 bytes ランダム → base64url。`vaultId = hex(SHA-256(token))[0:32]`。トークンはクライアントの IndexedDB に保存し、別端末へは「同期コード」として手入力/QR で渡す。サーバーは `vaultId` と `tokenHash`（SHA-256 hex 全長）だけ保存。
- 同期 API は `Authorization: Bearer <token>`。サーバーはハッシュ一致で認可（タイミング安全比較）。
- 楽観ロック: 更新時に `revision` を送り、サーバーの現 revision と一致しなければ `409 { currentRevision }`。
  基準にするのは「最後にサーバーと一致した revision」（`syncedRevision`）で、`envelope.revision - 1` ではない
  （デバウンス窓内に複数回編集しても偽の競合にならないようにする）。クライアントは「上書き / 破棄 / マージ」を選ぶ。
  マージはアカウント id 単位の union（同一 id は `updatedAt` が新しい方。同時刻なら内容の安定比較で決め、入力順に依存しない）。
- 削除の扱い: 削除したアカウントは `tombstones`（`{ id, deletedAt }` の配列、暗号文の中に保存）として記録し、
  マージでは id ごとに新しい `deletedAt` を残す。`deletedAt >= updatedAt` のアカウントは結果から取り除き、
  削除が別端末のマージで復活しないようにする。削除後に同じ id で作り直した場合（`updatedAt` が新しい）は残す。
- 自動同期: アンロック中、保存のたびにデバウンス 2 秒で PUT。オフライン時は IndexedDB に貯めてオンライン復帰時に再送。失敗は UI に小さく表示（トースト＋バッジ）。
  保存は 1 本のキューで直列化し、並行保存で先の変更が失われないようにする。ロック時は保留中の同期を破棄せず即時実行する。
- ローカル完結モード: 同期トークンを作らない選択肢を設け、その場合は一切サーバーへ送らない。
- 同期コードの受け取り（`src/lib/syncCodeInput.ts`）: 手入力・貼り付け・QR のいずれでも、
  同期コードそのもの（4 文字区切りの空白可）、`?code=` / `?sync=` / `#sync=` 付きの URL、
  `/sync/<token>` のようなパス形式、`aegis://sync?code=…` のディープリンクからトークンだけを取り出す。
  同期画面（`SyncPage`）ではカメラの連続スキャンと QR 画像ファイルの読み取りができ（追加画面と同じ
  `QrScanPanel`）、読み取ったコードは入力欄に入る。この端末にまだボルトが無い場合はそのまま接続まで進む。
  同期コードを含まない QR は入力欄を変えずにエラーを出す。
- Android アプリへの引き渡し（「📱 アプリでログイン」、設定の同期セクションと同期画面）:
  - 押すと、同期コードが未発行ならその場で発行（`generateSyncToken`）し、**サーバーへ初回同期してから**
    アプリを開く（アプリはコードでサーバーのボルトを取りに行くため、先に置いておく必要がある）。
    同期に失敗したときはアプリを開かず、エラーを出す。
  - 開く URL（`src/lib/appLogin.ts`）:
    `aegis://login#code=<base64url(syncToken)>&dek=<base64url(DEK)>&name=<URL エンコードしたボルト名>`
    - すべてフラグメント（`#`）に置く。フラグメントはサーバーへ送られないので、トークンも DEK も
      アクセスログ・リファラに残らない。
    - `code` は同期トークン（それ自体が base64url の 32 バイト）を UTF-8 のまま base64url 化したもの。
      アプリ側は base64url デコード → 同期トークン文字列として使う。
    - `dek` はアンロック中の DEK（32 バイト）の base64url。`name` は表示用のボルト名。
  - 押したあとは「Aegis Android アプリを開いています。インストールされていない場合は GitHub Releases から
    インストールしてください」と画面に出す（未インストールの端末ではブラウザが何もしないため）。

### 2.5 ロック / セッション

- 初回起動: ウェルカム → マスターパスワード設定（12 文字以上、強度メーター、確認入力）→ ボルト作成。パスワードは保存しない。忘れた場合の復旧は不可である旨を明示。
- アンロック: パスワード入力、`Enter` で解錠、オートフォーカス。登録済みのパスキー / セキュリティキーがあれば
  「パスキー / セキュリティキーで解除」ボタンも出す（§2.6）。
- 自動ロック: 無操作 5 分（1/5/15/30 分/なし）。`visibilitychange` で「タブを離れたら即ロック」オプション。
- **自動ロック「なし」のセッション継続**: 「なし」を選んでいる間は、同じタブの再読み込みでアンロック状態を復帰する。
  復帰に使うのは DEK（データ鍵）だけで、**マスターパスワードは決して保存しない**。
  DEK は `sessionStorage`（既定プロファイルは `aegis.session.dek.v1`、その他のプロファイルは
  `aegis.session.dek.v1.<profileId>`）に、封筒の指紋（`kdf` の塩・反復回数と
  `wrappedKey` の iv・暗号文）と一緒に置く（`src/lib/sessionKey.ts`）。指紋が一致しない封筒
  （パスワード変更・別ボルト）では使わず破棄する。預け場所はプロファイル ID ごとに分かれ、
  別プロファイルの DEK を拾って解錠することはない（§2.13）。
  次の場合は即座に消して確実にロックする: 手動ロック、`lockOnHide` によるロック、自動ロックを 0 以外へ変更、
  ボルトの作成・置換・同期接続・削除（リセット）。タブを閉じれば `sessionStorage` ごと消えるため、
  開きっぱなしのタブ以外では復帰しない。
- ロック時は秘密鍵・コードをメモリから破棄（参照を null にし、タイマー停止）。
- 画面キャプチャ抑止は不可なので、スクショ注意の一文をロック画面に出す。

### 2.6 パスキー / セキュリティキーによる解除（WebAuthn PRF）

マスターパスワードに加えて、**パスキー / セキュリティキー（WebAuthn PRF 拡張）** で解錠できる。
ゼロ知識の設計は変えない（サーバーに認証用テーブルもチャレンジ検証も持たない）。

```
認証器の PRF 出力 (32B) ──HKDF-SHA-256(salt = PRF salt, info="aegis-passkey-kek-v1")──► パスキー KEK
パスキー KEK ── AES-256-GCM wrap (AAD "aegis-passkey-v1") ──► wrappedDek（端末の IndexedDB に保存）
```

- **登録**（アンロック中のみ）: `navigator.credentials.create` に
  `extensions: { prf: { eval: { first: salt } } }` を渡す（`salt` は 32B ランダム、`rp.id` は省略＝配信元の実効ドメイン）。
  返る `getClientExtensionResults().prf.enabled` が `true` でなければ登録を中断する（PRF 非対応の認証器）。
  PRF 出力が `create` で返らない実装では、同じ認証器へ `eval` 付きの `get` を 1 回行って取得する。
- 取得した PRF 出力から KEK を導出し、**既存の DEK をラップ**して `wrappedDek` とする。DEK は作り直さない
  （データの再暗号化が不要で、マスターパスワードも引き続き使える）。
- 同じボルトのパスキーは **PRF salt を共有する**（1 回の `get` で複数の認証器をまとめて提示し、
  利用者がどれを選んでも同じ KEK になるようにする）。
- 登録情報は端末の IndexedDB（`passkeys` ストア、DB v2）だけに保存する。サーバーには送らない・同期しない。

```ts
type PasskeyRecord = {
  v: 1;
  id: string;            // credentialId（base64）
  name: string;          // 表示名（未入力なら既定名）
  createdAt: string;     // ISO 8601
  prfSalt: string;       // base64、32B
  wrappedDek: { iv: string; ciphertext: string };  // AAD は aegis-passkey-v1
  vaultFingerprint: string;  // 登録時の封筒の指紋（パスワード変更で変わる）
  verifier: string;          // 登録時の封筒の verifier（DEK の同一性）
  transports?: string[];     // 認証器の申告値（allowCredentials のヒント）
};
```

- **解除**（ロック画面）: 今の封筒の `verifier` と一致する登録が 1 件以上あるときだけ
  「パスキー / セキュリティキーで解除」ボタンを出す。`navigator.credentials.get` の
  `allowCredentials` に全登録を渡し、選ばれた認証器の PRF 出力から KEK → DEK を得て、
  封筒の `verifier` と AAD（`aegis-data-v1:<revision>`）を確かめながらデータを復号する。
  成功時はパスワード解錠と同じ経路でアンロックし、`autoLockMinutes === 0` なら DEK を
  `sessionStorage` に預ける（§2.5）。キャンセル・失敗時はメッセージを出し、
  マスターパスワードでの解錠はそのまま使える。
- **整合性**: 封筒の `verifier` が一致しない登録は、初期化・解錠・ボルト置換・同期接続・
  別ボルトのバックアップ取り込みのたびに削除する（旧ボルトの登録で誤動作させない）。
  パスワード変更は DEK を変えないので、登録はそのまま使え、保存している封筒の指紋だけを付け替える。
  `wipe`（ボルト削除）では登録もすべて消す。
- **制約**:
  - PRF 拡張に対応した認証器とブラウザが必要（非対応なら登録時に日本語・英語で明示して中断）。
  - WebAuthn はセキュアコンテキストが前提。HTTPS（と localhost）で使う。IP アドレスのオリジンでは
    `rpId` が無効になり `SecurityError` になるため、登録・解除できない旨を表示する。
  - マスターパスワードの代替復旧手段ではない。認証器を失ってもパスワードで解錠できる。
  - 登録情報は端末ごと。別端末では（同じパスキーを同期していても）その端末で登録し直す必要がある。

### 2.7 UI / UX

- デザイン: **温かみのある、人間が作ったような落ち着いた UI**。AI テンプレート風の紫グラデ・絵文字多用・過剰なグラスモーフィズムは禁止。
  - 基調: アイボリー/生成り（ライト）とチャコール（ダーク）。アクセントは深いティール＋差し色のテラコッタ。
  - タイポ: 見出しはセリフ系（`"Fraunces"` 相当を `@fontsource` で同梱、無理なら system セリフ）、本文はサンセリフ（`Inter` 相当）。外部 CDN からのフォント読み込みは禁止（CSP とプライバシーのため）→ `@fontsource` を npm 依存として同梱。
  - カードは 1px の境界線＋ごく弱い影。角丸 12px。コード表示は等幅（`JetBrains Mono` 相当 or system mono）、数字は `tabular-nums`、6 桁を 3+3 で区切る。
  - ダーク/ライトは `prefers-color-scheme` 追従＋手動切替（設定に保存）。
  - モーション: 150–200ms の控えめなトランジション。`prefers-reduced-motion` 尊重。
- 主要画面: ロック / 初回設定 / アカウント一覧（検索・ピン留め・ドラッグ並び替え） / アカウント追加（手入力・QR・画像・一括移行） / アカウント詳細編集 / 設定（セキュリティ・同期・表示・エクスポート） / 同期コード入力。
- アカウント詳細の削除は、保存・QR・URI コピーの列に混ぜず、説明文（元に戻せない・同期中は他の端末からも消える）と
  一緒に一段下に置く。スマホでは横幅いっぱいの danger ボタンにして、押す場所を迷わせない。
- レスポンシブ: 360〜390px 幅で横スクロールを出さない（ヘッダー・一覧・追加・詳細・設定・同期・オンボーディング）。
  文字切れ・ボタンのはみ出し・QR やモーダルのはみ出しを避け、タップ領域は 36px 以上にする。
  追加画面のタブはスマホでは 2×2 のグリッドにする。
- 一覧の行: アイコン（issuer から決定的な色のイニシャルアバター。外部 favicon 取得はしない＝アカウント情報の外部漏洩防止）、issuer、label、コード、残り時間リング、コピーボタン、ピン。
- 一覧の行には上の項目に加えて「詳細・編集」と「削除」のボタンを置く。行のダブルクリック／`ArrowRight` の編集導線と
  キーボード操作は維持しつつ、スマホでも 1 タップで編集・削除へ届くようにする。削除は確認ダイアログを挟み、
  実行すると一覧から消える（同期中なら削除記録として他の端末にも伝わる）。
  行の操作列はスマホでは行の下（横並び・右寄せ）に回し、幅 640px 以上では同じ行の右端に並べる。
- アカウント追加／編集のサービス名欄には、よく使うサービス（Google / GitHub / Discord / X / Amazon / Microsoft / Apple / Steam / Cloudflare / Notion）のクイック候補を並べ、ワンタップで入力できる。候補は端末内の固定リストで、外部から取得しない。
- キーボード: `/` で検索フォーカス、`Esc` でモーダル閉、`L` でロック、`C` で選択中コードをコピー。フォーカスリング常時表示。
- アクセシビリティ: すべての操作要素に見出し/ラベル、`aria-live` でコード更新を読み上げ（既定 off）、コントラスト比 4.5:1 以上。
- PWA: `manifest.webmanifest`（name/short_name/theme_color/icons 192/512 maskable）、Service Worker でアプリシェルのみキャッシュ（API は network-first、`/api/*` をキャッシュしない）。オフラインでもアンロック済みならコード生成可。

### 2.8 サーバー API

| Method | Path | 説明 |
|---|---|---|
| GET | `/api/health` | `{ status: "ok", uptime, version }`（認証不要、DB 到達確認込み） |
| PUT | `/api/vault/:id` | ボルト作成/更新。body `{ envelope, revision }`。成功 `{ revision }`、競合 `409 { currentRevision }` |
| GET | `/api/vault/:id` | 現在の封筒 `{ envelope, revision }`、無ければ 404 |
| DELETE | `/api/vault/:id` | 削除（Bearer 必須）。204 |
| GET | `/api/vault/:id/meta` | `{ revision, updatedAt }` のみ（同期判定用・軽量） |

- 認可: `Authorization: Bearer <token>`。`vaultId` とトークンハッシュの両方が一致したときのみ。不一致は 404（存在を漏らさない）。
- 制限: body 上限 256 KiB（超過 413）、`envelope` の必須フィールド検証（zod）、`revision` は非負整数、`id` は 32 桁 hex。
- レート制限: IP 単位で `/api/vault/*` は 60 req/min、`PUT` は 20 req/min。超過 429 + `Retry-After`。`better-sqlite3` のメモリテーブルでも可（プロセス内 Map + 定期掃除で可）。
- ログ: リクエストメソッド/パス/ステータス/所要時間のみ。**Authorization ヘッダ・body・クエリは絶対にログしない**。`NODE_ENV=production` でスタックトレースを返さない。
- 静的配信: `dist/` を配信し、`/api/*` 以外の未知パスは `index.html`（SPA フォールバック）。`dist/assets/*` は `immutable` キャッシュ、`index.html` は `no-store`。
- ヘッダ（全レスポンス）:
  - `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
    `Permissions-Policy: camera=(self), microphone=(), geolocation=(), interest-cohort=()`,
    `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`,
    `Strict-Transport-Security: max-age=31536000; includeSubDomains`（HTTPS のときのみ）
  - `Cache-Control: no-store` for `/api/*`
- 環境変数: `PORT`（既定 3000）、`DATABASE_PATH`（既定 `./data/aegis.db`）、`TRUST_PROXY`（既定 false）、`CORS_ORIGIN`（既定 未設定＝同一オリジンのみ）。
- graceful shutdown（SIGTERM で server.close → DB close）。

---

### 2.9 サービスごとのメモとバックアップコード

- アカウントごとに自由記述の**メモ**（最大 2,000 文字）と、サービスが発行した
  **使い捨てバックアップコード**（最大 50 件）を保管できる。どちらも暗号化ペイロードの中だけに置き、
  画面以外（localStorage・ログ・サーバー）へは出さない。
- 追加・編集・詳細画面（`AccountForm` / `AccountDetailPage`）で、メモの編集と、
  コードの一括追加（改行・カンマ・空白区切り）・1 件ずつの使用済み切替・ワンタップコピー・削除ができる。
  空にした項目は保存時にキーごと落とす（消したメモが残らない）。
- 一覧の行には、メモがあること・未使用コードの件数を控えめなバッジで示す。
- 同期マージでは他の項目と同じく `updatedAt` の新しい方を採る（`shared/merge.ts` は変更不要）。

### 2.10 ゴミ箱（30 日復元）

- 通常の削除は**ゴミ箱へ移す**（`deletedAt` に現在時刻を入れ、`updatedAt` も更新する）。
  tombstone はまだ作らないため、他の端末にも「ゴミ箱行き」がそのまま同期される。
- 通常の一覧（`AccountsPage`）・検索・OTP 生成の対象は `deletedAt` の無いアカウントだけ。
- 一覧上部の「ゴミ箱（件数）」からゴミ箱ビュー（`/trash`）を開ける。削除日時と
  「あと N 日で完全削除」を表示し、1 件ずつの**復元**と**完全に削除**、**ゴミ箱を空にする**ができる。
- **完全に削除**ではアカウントを取り除き、tombstone に記録する（他端末からの復活を防ぐ）。
  初期化・読み込み・保存・同期マージのたびに、`deletedAt` から 30 日以上経過したものは
  完全削除して tombstone に記録する（`shared/trash.ts`）。
- 期限の判定に使う日時が壊れている場合は「期限切れ」とみなさない（勝手に消さない）。
- ゴミ箱にあるアカウントの詳細画面は、編集フォームではなく復元・完全削除だけを出す
  （編集して保存すると意図せず復活するため）。

### 2.11 重複チェックと「よく使う順」ソート

- **重複チェック**: 新規追加（手入力・QR・一括移行）の保存時に、有効なアカウントの中に
  同じ正規化 `secret`、または同じ `issuer` + `label`（大文字小文字と前後の空白を無視）があれば、
  どのアカウントと・どの理由で重なっているかをダイアログに並べる（`shared/duplicates.ts`）。
  「やめる」で追加画面に残り、「それでも追加する」で登録を続行できる。ゴミ箱のアカウントは数えない。
- **使用回数**: コードをコピーしたときに `useCount` を 1 増やし `lastUsedAt` を更新する。
  同期を騒がせないよう `updatedAt` は変えない（他端末の新しい編集を巻き戻さないため）。
- **並べ替え**: 一覧に「手動順（ピン留め優先）」「よく使う順」「名前順」の切替を置き、
  選択は設定（`sortMode`）として端末に保存する。手動順以外ではドラッグ並べ替えを無効にする。
  名前順でもピン留めは先頭に置く。

### 2.12 緊急バックアップ印刷シート

- 設定画面のバックアップセクションから「緊急バックアップ印刷シート」を開ける。開く前に
  **平文の秘密鍵と復旧コードが出る旨の警告**をモーダルで確認させる。
- 印刷用ビュー（`/print`、`@media print` 対応）に、印刷日時・ボルト名・保管上の注意書きと、
  有効な全アカウント（サービス名・アカウント名・種別・アルゴリズム/桁数・Base32 秘密鍵・メモ・
  未使用のバックアップコード・`otpauth://` の QR）を並べる。アカウントごとに改ページで分断しない。
- 操作ボタン・アプリのヘッダー/フッター・通知は印刷しない。印刷はブラウザの `window.print()`。

### 2.13 複数ボルト（プロファイル）

- 1 つのブラウザ（IndexedDB）に複数の独立したボルトを持てる。各プロファイルは
  ID・表示名・作成日時だけを持ち、**封筒（マスターパスワード）・パスキー・同期コード・ロック状態は
  プロファイルごとに独立**する。
- IndexedDB は `DB_VERSION` 2 → 3。`profiles`（一覧）と `appState`（選択中）ストアを追加し、
  `vault` / `secrets` / `passkeys` の各記録をプロファイル ID で区切る。既存の単一ボルト
  （封筒・同期コード・パスキー・設定）は既定プロファイル `main`（表示名「メイン」）へ
  自動で引き継ぐ。設定（テーマ・言語・自動ロック・並べ替え）は端末共通として共有する。
- 作成・切替・名前変更・削除ができ、ヘッダー（切替セレクト）・ロック画面・設定画面から操作できる。
  切替時は未送信の同期を確定させ、世代を進めてから読み込む（前のボルトの平文を残さない）。
  最後の 1 つは削除できない（中身を消すときは初期化を使う）。
- 「自動ロック：なし」の `sessionStorage` DEK はプロファイル ID ごとに分離する（§2.5）。

### 2.14 同期している端末の可視化

- 端末（ブラウザ）ごとに ID（UUID）をローカル生成して保持し、名前（初期値は UA から
  「Android (Chrome)」「Desktop」等を推定）を編集できる。保存先は `localStorage`
  （キー `aegis.device.v1`、プロファイルを切り替えても同じ端末）。
- 暗号化ペイロードに `devices: { id, name, platform, lastSyncedAt }[]` を持ち、保存（push）のたびに
  自端末の `lastSyncedAt` を更新する。`mergeVaultData` は端末 ID ごとに新しい日時を採る。
  platform は UA から推定した粗い分類だけで、UA 全文・IP・端末の識別子は送らない。
- 設定画面の同期セクションに「同期されたデバイス」を表示し、自端末の名前変更と、
  不要になった古い端末エントリの一覧からの削除ができる（端末側のボルトは消さない）。

## 3. テスト要件

### 3.1 単体（Vitest, `shared/`）
- RFC 4226 の 10 ベクタすべて一致（6 桁）。
- RFC 6238 の SHA-1/256/512 各ベクタ一致、8 桁指定も一致。
- Base32: エンコード/デコード往復、小文字・空白・パディング許容、不正文字で例外。
- otpauth: パース→シリアライズの往復、issuer/label 分離、HOTP counter、欠損パラメータの既定値、不正 URI で例外。
- migration: 手組みの Protobuf バイト列（TOTP 2 件 + HOTP 1 件 + 未知 enum 1 件）をデコードし、件数・フィールド・スキップが正しいこと。base64url パディング無しでも通ること。
- crypto: PBKDF2 派生→暗号化→復号の往復、誤パスワードで失敗、暗号文 1 バイト改変で失敗、IV が毎回異なる、verifier 判定。
- マージ: id 単位 union で `updatedAt` 優先。端末一覧は id 単位で新しい `lastSyncedAt` を採る。
- ゴミ箱: 30 日の境界（29 日は残る・30 日で期限切れ）、残り日数の切り上げ、壊れた日時は消さない、
  期限切れの完全削除が tombstone を残すこと。
- 重複判定: 正規化した秘密鍵・issuer+label（大文字小文字無視）・両方一致・ゴミ箱は除外。
- ストレージ: プロファイルごとの封筒/同期コード/パスキーの分離、v2 → v3 の引き継ぎ
  （旧キーの記録が残らないこと）、プロファイルの追加・改名・削除。
- ストア: ゴミ箱への移動・復元・完全削除・空にする、期限切れの解錠時削除、使用回数の記録
  （`updatedAt` を変えない）、端末名の変更と一覧からの削除。
- passkey: PRF 出力→HKDF→KEK の導出が決定的であること、salt 不一致・暗号文改ざんで `PasskeyMismatchError`、
  レコードの形の検査、封筒の verifier による紐づけ（別ボルトの登録を落とす）、指紋の付け替え。

### 3.2 統合（Vitest + Hono `app.request`）
- PUT→GET→meta→DELETE の一連、revision 不一致で 409、トークン不一致 404、body 過大 413、`id` 形式不正 400、レート制限 429、ヘッダ（CSP 等）付与、`/api/health` 200。
- **ゼロ知識テスト**: PUT された封筒に秘密鍵（Base32）もマスターパスワードも平文で含まれないこと、サーバー DB ファイルに平文 secret が現れないこと（`fs.readFileSync(dbPath)` に secret 文字列が含まれない）。

### 3.3 E2E（Playwright, 本番ビルドに対して）
1. 初回設定 → ボルト作成 → 一覧が空。
2. 手入力で追加（RFC テスト秘密鍵）→ コードが `page.clock` 固定時刻の期待値と一致 → コピー → トースト表示。
3. リロード → ロック画面 → 誤パスワードでエラー → 正しいパスワードで解錠 → アカウント残存。
4. 検索・ピン留め・削除（確認ダイアログ）。
5. 暗号化バックアップ書き出し → ボルト削除 → インポート → 復元。
6. 同期: 2 つ目のブラウザコンテキストで同期コード入力 → 同じアカウントが見える。
7. レスポンシブ（375x812）でレイアウト崩れなし、コンソールエラーなし。
8. アクセシビリティ: 主要操作がキーボードのみで完了できる。
9. 行の「削除」→ 確認ダイアログ → 削除（360px でも 1 タップで到達できる）。
10. 自動ロック「なし」: リロードしても解錠が続き、手動ロック・0 以外への変更・ボルト削除で戻る。
11. 同期 QR: 設定画面の同期 QR 画像／`?sync=` の URL の QR を読み取り、別コンテキストから接続して同じアカウントを開ける。
12. 360px / 390px 幅で一覧・追加・詳細・設定・同期が横にはみ出さず、行のボタンが画面内に収まる。
13. パスキー / セキュリティキー（CDP の仮想オーセンティケータ、`hasPrf: true`）を登録 → リロード →
    ロック画面の解除ボタンで解錠 → 設定画面で削除 → 解除ボタンが消えてパスワードで解錠、まで通る。
    WebAuthn の `rpId` はドメインである必要があるため、この検証だけ `http://localhost:<port>` で実行する。
14. PRF 非対応の認証器（`hasPrf: false`）では登録を中断し、理由を画面に出す（一覧にも解除ボタンにも残らない）。

15. メモとバックアップコード: 追加画面でメモと 3 件のコードを一括登録 → 一覧の行に
    「メモあり」「未使用 3」→ 詳細で 1 件を使用済み → 「未使用 2」に変わる。メモが localStorage に残らない。
16. ゴミ箱: 行から削除 → 一覧から消える → ゴミ箱に「あと 30 日で完全削除」→ 復元 → 一覧に戻る →
    再度ゴミ箱へ → 完全に削除 → ゴミ箱が空。
17. 重複チェック: 同じ秘密鍵で追加しようとするとダイアログに既存アカウントと理由が出る →
    「やめる」で追加されない → 「それでも追加する」で 2 件になる。
18. 並べ替え: 名前順・手動順・よく使う順（コピーした行が先頭）が切り替わり、選択が残る。
19. 印刷シート: 設定 → 警告モーダル → `/print` に秘密鍵と QR が並び、印刷ボタンがある。
20. 複数ボルト: 2 つ目のボルトを作成（別パスワード）→ 中身が空 → ヘッダーでメインへ戻ると
    ロックされ、2 つ目のパスワードでは開かず、メインのパスワードで元のアカウントが戻る。
21. 同期端末: 同期ボルトの設定に自端末（「この端末」）が出て、名前を変えると再読み込み後も残る。
22. 追加画面には `otpauth://` の手入力欄が無く、秘密鍵欄に URI を貼っても分解せず Base32 エラーになる。
23. アプリでログイン: 未同期のボルトで押すと同期コードが自動発行され「同期済み」になり、案内が出る
    （既に同期済みならコードを作り直さない）。設定と同期画面の両方から押せる。

E2E は `pnpm build && pnpm start`（一時 DB）に対して `playwright.config.ts` の `webServer` で実行。
既存サーバーは再利用しない（`reuseExistingServer: false`。今回のビルドとテスト用の設定を必ず効かせる）。
全テストが同じ IP（127.0.0.1）から短時間に作る・更新するため、E2E のサーバーだけ `AEGIS_DISABLE_RATE_LIMIT=true` で
レート制限を外す（20 PUT/分に当たると無関係なテストが落ちる）。制限そのものは integration と PHP 版テストで検証する。

---

## 4. CI（GitHub Actions）

`.github/workflows/ci.yml`、`on: [push, pull_request]`、Node 22 + pnpm（corepack）、ジョブ分割:

1. `quality`: `pnpm lint`（ESLint）＋ `pnpm typecheck`（`tsc --noEmit` を client/server/shared で）
2. `test`: `pnpm test -- --coverage`（unit + integration）
3. `e2e`: `pnpm exec playwright install --with-deps chromium` → `pnpm build` → `pnpm test:e2e`（成果物: レポート）
4. `docker`: `docker/build-push-action` でビルドのみ（push なし）、`cache-from/to: gha`

- concurrency で同一ブランチの古い実行をキャンセル。`permissions: contents: read`。
- すべて緑でなければマージ不可（ブランチ保護は main に要求）。

---

## 5. ドキュメント

- `README.md`: スクリーンショット、特徴、クイックスタート（pnpm / Docker）、環境変数、デプロイ例、セキュリティモデルの要約、ライセンス。
- `docs/SECURITY.md`: 脅威モデル（サーバー侵害・DB 漏洩・XSS・クリップボード・端末紛失）、保証すること/しないこと、既知の制約（ブラウザ拡張、メモリダンプ）、鍵導出パラメータの根拠。
- `docs/DEPLOY.md`: Docker Compose / Fly.io / Render / VPS + Caddy の手順、バックアップ、TLS 前提。
- `docs/ARCHITECTURE.md`: データフロー図（Mermaid）、モジュール責務、同期の競合解決。

---

## 6. 受け入れ基準（すべて満たすこと）

- [ ] `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm build` / `pnpm test:e2e` がローカルで全て成功
- [ ] RFC 4226・6238 の全テストベクタ一致
- [ ] Google Authenticator 移行 URI の一括インポートが動作（E2E か統合テストで担保）
- [ ] サーバー DB・API ペイロード・ログに平文の secret / パスワードが存在しない（テストで証明）
- [ ] CSP ほかセキュリティヘッダが全レスポンスに付与される（テストで担保）
- [ ] Docker イメージがビルドでき、起動して `/api/health` が 200、SPA が表示される
- [ ] パスキー / セキュリティキー（PRF）で解除でき、登録情報は端末内だけに保存される（E2E で担保）
- [ ] メモ・バックアップコード・ゴミ箱・使用回数・端末一覧・複数プロファイルが、サーバー API と
      `vaults` スキーマを変えずに暗号化ペイロード内だけで動く（統合テストと単体テストで担保）
- [ ] 削除したアカウントは 30 日間ゴミ箱から復元でき、期限後は tombstone 付きで完全削除される
- [ ] 印刷シートは警告の確認後にだけ開き、印刷時に操作系を出さない
- [ ] ライト/ダーク、375px 幅で破綻しない
- [ ] README / SECURITY / DEPLOY / ARCHITECTURE が揃っている
- [ ] `main` への PR で CI が全緑、CodeRabbit の指摘が解消済み
