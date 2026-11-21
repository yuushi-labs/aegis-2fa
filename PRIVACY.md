# Aegis 2FA プライバシーポリシー / Privacy Policy

最終更新: 2026-11-21 ・ Last updated: 2026-11-21

Aegis 2FA は、2 段階認証のコードを発行するアプリです。マスターパスワードと秘密鍵がサービス側へ渡らない「ゼロ知識」の設計で作られています。

公開版: <https://yuushi0911.xsrv.jp/aegis/privacy>（アプリ内の `/privacy`）

---

## 日本語

### 1. 扱う情報
本アプリが扱うのは、利用者が登録した 2 段階認証のアカウント情報と、そのアカウントを守るための鍵の情報です。

- アカウント情報: サービス名、アカウント名、TOTP / HOTP の秘密鍵、アルゴリズム、桁数、周期またはカウンタ、メモ、バックアップコード、最終使用時刻。
- マスターパスワード: 端末内で暗号鍵を導出するためだけに使い、保存も送信もしません。
- データ暗号化鍵（DEK）: 端末内で生成し、アンロック中だけメモリに置きます。
- パスキー / セキュリティキー（WebAuthn）: 認証器が作る credential ID、PRF の salt、DEK を包んだ情報、表示名。
- 端末の ID と端末名、パスキーの表示名の一覧（同期している端末を一覧するため）。

### 2. どこに保存されるか
端末とサーバーで保存するものを分けています。サーバーに置くのは、復号できない暗号文とその付随情報だけです。

- 端末内（ブラウザの IndexedDB。暗号化した状態で保存）: 上のアカウント情報、削除の記録、端末一覧、パスキーの表示名一覧、アプリの設定。
- 端末内のみで、同期しないもの: パスキー / セキュリティキーの登録情報（credential ID、PRF の salt、DEK を包んだ情報）。指紋・顔・認証器の秘密鍵は認証器の外へ出ません。
- サーバー（同期を有効にした場合のみ）: 暗号文、IV、鍵導出の salt と反復回数、verifier、リビジョン番号、更新日時。これらから秘密鍵やマスターパスワードを知ることはできません。
- ボルト ID: 同期コードの SHA-256 の先頭 32 桁。同期コードそのものは送りません。

### 3. 暗号化の方式
マスターパスワードから PBKDF2-HMAC-SHA-256（600,000 回）で鍵を導出し、AES-256-GCM でアカウント情報を暗号化します。復号は端末内でだけ行います。サーバーは鍵もパスワードも受け取らないため、暗号文を読む手段がありません。

マスターパスワードを忘れた場合、開発者を含む誰もデータを復元できません。

### 4. ローカル専用モードと同期モード
ボルトを作るときに「この端末だけで使う」を選ぶと、サーバーへの通信は一切発生しません（アプリ本体の読み込みを除く）。

同期を有効にすると、暗号化されたボルトと、そこから導出したボルト ID だけをサーバーに保存し、ほかの端末と同じ暗号文を共有します。鍵は端末（とパスキー）の中だけにあり、端末どうしが鍵をやり取りすることもありません。

### 5. パスキー / セキュリティキー
パスキーは端末（またはセキュリティキー）の中にある秘密鍵で解除する仕組みです。生体情報や秘密鍵が端末・認証器の外へ出ることはありません。

登録に必要な情報は端末ごとの IndexedDB にだけ保存し、ほかの端末とは共有しません。ほかの端末には「表示名・登録日時・端末名」だけが暗号化されたボルトの中で共有され、一覧に表示されます。別の端末で登録したパスキーは、その端末の外では解除に使えません。

### 6. サーバー側で行う処理とログ
サーバー（Node 版・Xserver の PHP 版）は、暗号文の保存・取得・削除と、不正アクセスや過負荷を防ぐためのレート制限だけを行います。

- リクエストの記録は、メソッド・パス・ステータス・処理時間だけです。Authorization ヘッダやリクエスト本文は記録しません。
- レート制限のため、接続元の IP アドレスを一定時間だけ数えます。カウントはメモリ上で行い、データベースには保存しません。
- ホスティング事業者（Xserver など）が取得するアクセスログは、その事業者のポリシーに従います。

### 7. 広告・解析・第三者提供
広告の表示、行動の追跡、アクセス解析 SDK（Google Analytics など）の組み込みは一切ありません。利用者のデータを第三者へ販売・共有することもありません。

アプリ本体は外部の CDN やフォント配信を使わず、すべて同じ配信元から読み込みます。

### 8. Android アプリの権限
- カメラ: QR コードを読み取るときだけ使います。
- 生体認証: 端末内のロック解除だけに使います。
- ネットワーク: 同期と、設定された配布元（GitHub Releases）の更新確認だけに使います。

### 9. 端末に残るその他のもの
- 設定（テーマ・言語・自動ロック）: IndexedDB。
- 端末の ID と端末名: localStorage。端末を一覧で見分けるためだけに使います。
- 自動ロック「なし」を選んだときのセッション鍵: sessionStorage。同じタブの再読み込みで解除状態を保つためだけで、タブを閉じる・手動でロックする・設定を変えると消えます。
- オフラインで開くためのアプリ本体のキャッシュ（Service Worker）。アカウント情報は含みません。
- Cookie は使用しません。

### 10. データの削除
- 「ボルトを削除」で、この端末の暗号文とサーバー上の暗号文を削除します（サーバーへの削除が失敗しても端末側は削除します）。
- 「同期を停止」で、サーバー上の暗号文を削除します。ほかの端末では解除できなくなります。
- パスキーの削除は、その端末の登録と、暗号化されたボルト内の表示名の一覧から行います。
- ブラウザのサイトデータを消すと端末内の暗号文も消えます。マスターパスワードが分かっていても、暗号文がなければ復号できません。

### 11. 変更とお問い合わせ
このポリシーを変更するときは、このページとリポジトリの PRIVACY.md の最終更新日を合わせて更新します。

質問・不具合の報告は GitHub の Issue へお願いします: <https://github.com/yuushi-labs/aegis-2fa/issues>

---

## English

Aegis 2FA generates two-factor authentication codes. It is built around a zero-knowledge design: your master password and secrets never reach the service.

### 1. What the app handles
Aegis 2FA handles the two-factor accounts you add and the key material that protects them.

- Account data: service name, account name, TOTP / HOTP secret, algorithm, digits, period or counter, notes, backup codes, last-used time.
- Master password: used only to derive the encryption key on your device. It is never stored or sent.
- Data encryption key (DEK): generated on your device and kept in memory only while the vault is unlocked.
- Passkeys / security keys (WebAuthn): the credential ID created by your authenticator, the PRF salt, the wrapped DEK, and a label.
- Device ID, device name, and the list of passkey labels (used to list the devices that share the vault).

### 2. Where it is stored
Storage is split between your device and the server. The server only ever holds ciphertext it cannot decrypt, plus the metadata needed to store it.

- On your device (the browser’s IndexedDB, encrypted): account data, deletion records, the device list, the passkey label list, and app settings.
- On your device only, never synced: passkey / security key registrations (credential ID, PRF salt, wrapped DEK). Fingerprints, faces and the authenticator’s private key never leave the authenticator.
- On the server (only when sync is enabled): ciphertext, IV, the key-derivation salt and iteration count, the verifier, the revision number and the update time. None of it reveals your secrets or master password.
- Vault ID: the first 32 hex characters of SHA-256(sync code). The sync code itself is never sent.

### 3. How it is encrypted
The master password is stretched with PBKDF2-HMAC-SHA-256 (600,000 iterations) and account data is encrypted with AES-256-GCM. Decryption happens only on your device. The server never receives the key or the password, so it has no way to read the ciphertext.

If you forget your master password, nobody — including the developer — can recover the data.

### 4. Local-only mode and sync mode
If you choose “this device only” when creating a vault, the app makes no network requests at all (apart from loading the app itself).

With sync enabled, only the encrypted vault and the vault ID derived from it are stored on the server, and the same ciphertext is shared between your devices. The keys stay on the devices (and authenticators); devices never exchange keys with each other.

### 5. Passkeys / security keys
A passkey unlocks the vault with a private key that stays inside your device or security key. Biometric data and private keys never leave the device or authenticator.

What is needed for unlocking is stored only in that device’s IndexedDB and is not shared with other devices. Only the label, registration time and device name travel inside the encrypted vault, so other devices can list the registration. A passkey registered on one device cannot be used to unlock on another.

### 6. Server-side processing and logs
The server (Node or the PHP build for Xserver) only stores, returns and deletes ciphertext, and applies rate limits to stop abuse and overload.

- Request records contain the method, path, status and duration only. The Authorization header and request bodies are never logged.
- For rate limiting, the client IP address is counted for a short time in memory; it is not written to the database.
- Access logs kept by the hosting provider (such as Xserver) follow that provider’s own policy.

### 7. Ads, analytics and third parties
There are no ads, no behavioural tracking and no analytics SDKs (such as Google Analytics). Your data is never sold or shared with third parties.

The app bundles its own fonts and assets, so it does not load files from third-party CDNs.

### 8. Android permissions
- Camera: used only to scan QR codes.
- Biometrics: used only to unlock the vault on the device.
- Network: used only for sync and for checking updates from the configured source (GitHub Releases).

### 9. Other data kept on your device
- Settings (theme, language, auto-lock): IndexedDB.
- Device ID and device name: localStorage, used only to tell your devices apart.
- When auto-lock is set to “never”, a session key in sessionStorage so a reload in the same tab keeps the vault unlocked. It disappears when the tab closes, when you lock manually, or when you change the setting.
- A cache of the app shell for offline use (Service Worker). It does not contain account data.
- No cookies are used.

### 10. Deleting your data
- “Delete vault” removes the ciphertext on this device and on the server (the local copy is removed even if the server request fails).
- “Stop syncing” removes the ciphertext on the server; other devices will no longer be able to unlock.
- Deleting a passkey removes the registration on that device and the label from the encrypted vault.
- Clearing your browser’s site data also removes the ciphertext on the device. Even with the master password, data without its ciphertext cannot be decrypted.

### 11. Changes and contact
When this policy changes, the “last updated” date here and on the in-app page (`/privacy`) is updated together.

Questions and bug reports are welcome on the GitHub issue tracker: <https://github.com/yuushi-labs/aegis-2fa/issues>
