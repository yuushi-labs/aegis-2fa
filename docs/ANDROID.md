# Android アプリ（`android/`）

Web 版・PHP 版と同じボルトを開ける、ゼロ知識（E2EE）の Android アプリです。
Kotlin + Jetpack Compose（Material 3）で書き、`minSdk = 26` / `targetSdk = 35` / `compileSdk = 35`。
secret もマスターパスワードも端末の外へ出ません。同期で送るのは暗号文の封筒だけです。

```
android/
├── app/src/main/java/com/yuushilabs/aegis/
│   ├── core/        Web 版 shared/ と 1:1 の純粋ロジック（JVM でテスト）
│   │   ├── Bytes.kt / Base32.kt       base64・base64url・hex・Base32
│   │   ├── Crypto.kt                  PBKDF2 / AES-GCM / verifier / 封筒
│   │   ├── Hotp.kt / Totp.kt           RFC 4226 / 6238
│   │   ├── Otpauth.kt / Migration.kt   otpauth:// と otpauth-migration://
│   │   ├── Model.kt / Merge.kt         ボルトの型・JSON・競合マージ
│   │   ├── Trash.kt / Duplicates.kt    ゴミ箱（30日）・重複チェック
│   │   ├── SyncCode.kt / AppLogin.kt   同期コード・aegis://login
│   │   └── IsoTime.kt                  Web の toISOString と同じ形式
│   ├── data/
│   │   ├── SecureStore.kt              Keystore の AES-256-GCM でファイルを暗号化
│   │   ├── SettingsStore.kt            自動ロック・並び順・端末名など
│   │   ├── SyncApi.kt                  GET/PUT/DELETE /api/vault/{id}（Bearer）
│   │   └── VaultRepository.kt          状態・保存・同期・競合・プロファイル
│   └── ui/                             Compose の画面（一覧・追加・詳細・設定…）
├── app/src/test/java/…                 88 件の Unit テスト
└── keystore/                           配布用の固定署名鍵（公開情報）
```

## 機能

- **TOTP / HOTP**: SHA-1/256/512、6/8 桁、任意の period / counter、残り時間リング、3+3 表示、
  ワンタップコピー（30 秒で自動クリア）、次期コードの先出し、時計ずれ補正（±2）
- **追加手段は 3 つだけ**: 手入力（よく使うサービス候補つき）・QR スキャン（カメラ／画像）・
  Google Authenticator 移行（`otpauth-migration://`）。`otpauth://` の手入力欄はありません
- **ゼロ知識同期**: 接続先は `https://yuushi0911.xsrv.jp/aegis` に固定（変更 UI なし）。
  PBKDF2-HMAC-SHA-256 600,000 回、AES-256-GCM、AAD `aegis-vault-v1` / `aegis-data-v1:<revision>`、
  verifier `HMAC-SHA256(DEK, "aegis-verify-v1")[0:16]`、`vaultId = hex(SHA-256(token))[0:32]`
- **同期コード / QR**: 4 文字区切り表示・QR 表示・カメラや画像からの取り込み・手動同期・端末一覧
- **競合**: 409 で再取得し、サーバー側と同じ封筒なら成功扱い。違えば
  「マージ / この端末を残す / サーバーを残す」を選ぶ（マージは tombstones ごと）
- **サイトからの自動ログイン**: `aegis://login#code=…&dek=…&name=…` を受け取り、
  同期コードで最新の封筒を取得 → DEK で復号（verifier 検証）→ Keystore で保護して保存 →
  そのままアンロック済み一覧へ。処理後は Intent のデータを消す
- **ロック**: マスターパスワード（12 文字以上）・指紋/顔（BiometricPrompt + Keystore の
  認証必須鍵で DEK をラップ。`CryptoObject` を使うため BIOMETRIC_STRONG のみ）・
  自動ロック（なし/1/5/15/30 分）・アプリを離れたら即ロック
- **ゴミ箱**: 削除 → 30 日間は復元可 → 完全削除で tombstone。メモと復旧コード、複数ボルト、
  重複チェック、よく使う順 / 名前順 / 手動順、ピン留め
- **保存**: 端末内のファイルは Android Keystore の AES-256-GCM で暗号化。バックアップ
  （`android:allowBackup="false"`）にも出しません

## 権限

`INTERNET`（同期）・`CAMERA`（QR）・`USE_BIOMETRIC`（指紋/顔）・`USE_FINGERPRINT`
（API 26–27 の指紋は `USE_BIOMETRIC` では代替できない）だけです。解析 SDK、
位置情報、連絡先、外部ストレージは取りません。

## ビルドとテスト

```bash
cd android
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleRelease
```

- JDK 17（Temurin）と Android SDK platform 35 / build-tools 34.0.0 が必要です。
- Unit テストは JVM で動きます（Android 実機・エミュレータ不要）。
- `CryptoCompatTest` は **Web 版で作った封筒**（`app/src/test/resources/web-envelope.json`）を
  このアプリで復号し、verifier まで一致することを確かめます。フィクスチャは
  `shared/crypto.ts` の `createVaultEnvelope` で生成したものです。

## 署名と配布

- `assembleRelease` は `keystore/aegis-debug.keystore`（alias `androiddebugkey`）で署名します。
  これは **配布 ID として公開している鍵** で、秘密情報ではありません（理由と差し替え手順は
  `android/keystore/README.md` と [SECURITY.md](SECURITY.md)）。
- GitHub の Secrets に `ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` /
  `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` がある場合は、そちらを優先します。
- `v*` タグを push すると `.github/workflows/release.yml` が PHP ZIP と APK の両方を作り、
  GitHub Release に添付します（リポジトリへ書き込む GitHub App に Workflows 権限が無いあいだは、
  定義を `docs/ci/release.yml` に置いています。有効化は `docs/ci/README.md`）。
