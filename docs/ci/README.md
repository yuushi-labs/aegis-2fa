# CI / Release ワークフロー（一時置き場）

ここにある 2 ファイルは、そのまま `.github/workflows/` に置いて使う GitHub Actions の定義です。

- `android.yml`: Android の Unit テスト（88 件）・Lint・debug/release APK ビルド。
  `ci.yml` の `android` ジョブ（`uses: ./.github/workflows/android.yml`）から呼びます。
- `release.yml`: `v*` タグで PHP（Xserver 用）ZIP と Android APK を作り、GitHub Release に添付します。

## なぜここにあるか

このリポジトリへ書き込む GitHub App に **Workflows 権限** が無く、`.github/workflows/` 配下の
変更を push できませんでした（`refusing to allow a GitHub App to create or update workflow`）。
権限を付与したあと、次のどちらかで有効化してください。

```bash
# 1) ファイルを置く
git mv docs/ci/android.yml .github/workflows/android.yml
git mv docs/ci/release.yml .github/workflows/release.yml

# 2) ci.yml の docker ジョブの前に android ジョブを足して、両方ステージする
#      android:
#        name: android unit test / lint / apk
#        uses: ./.github/workflows/android.yml
#        secrets: inherit

git add .github/workflows
git commit -m "ci: Android と Release のワークフローを有効化" && git push
```

権限は https://github.com/apps/pickle → Permissions → Repository permissions → **Workflows: Read and write**
で付与できます（組織 `yuushi-labs` の場合は組織の承認も必要）。

権限が無いあいだも、Release はローカルでビルドした同じ成果物を `gh release create` で
公開できます（APK は `android/app/build/outputs/apk/release/app-release.apk`、
ZIP は `pnpm build:xserver` の `deploy/xserver/build/zekey/`）。
