# リリース手順（メンテナー向け）

この手順は配布の準備です。ビルド・パッケージコマンドだけではGitHubへのpush、Release作成、リポジトリ公開は行いません。

## 1. 検証と配布物の作成

Node.js 20以上とPython 3を用意します。

```sh
npm ci
npm run format:check
npm test
npx playwright install chromium
npm run build
npm run test:e2e
npm run package
```

`releases/Jev-Ad-blocker-<version>.zip` と `.zip.sha256` が生成されます。package.json・package-lock.json・manifest.jsonのバージョンを揃えてから実行してください。

ZIPは `Jev-Ad-blocker/` 以下に、manifest・実行用src・ライセンス・プライバシー・導入説明のみを含みます。許可リスト外のファイルがdistにあれば作成を停止します。依存ライブラリ、.git、APIキー、テスト結果は同梱しません。ZIPとチェックサムはGit追跡対象外です。

ZIPを新しいフォルダへ展開し、manifest.jsonがある階層を読み込めることを確認します。利用者のキーを配布物へ埋め込まないでください。スクリーンショットは合成データだけを使います。

## 2. GitHubへ反映・公開

1. 全履歴を含む秘密情報の検査と差分レビューを済ませます。
2. READMEと公開するコードをcommit・pushします。
3. リポジトリのVisibilityをPublicに変更します。これは配布ZIP作成とは別の操作です。
4. 対象コミットにバージョンタグを付け、GitHubのReleaseを作成します。
5. ZIPとSHA-256ファイルをReleaseのAssetsへ添付します。Source code (zip)とは別の配布物です。
6. 別のブラウザ／ログアウト状態で、READMEとZIPにアクセスできることを確認します。

Code → Download ZIPでもビルドなしで導入できます。配布ZIPは余分な開発ファイルを省き、導入用フォルダ名を固定するための選択肢です。

`package.json`の`private: true`はnpmへの誤公開を防ぐ設定です。GitHubでの公開・MITライセンスでの利用を制限するものではありません。

リポジトリ名を変更した場合は、README・INSTALL.mdのURLとclone先、関連文書のリンクも更新してください。GitHubの非公開脆弱性報告・利用可能な秘密情報保護機能も確認します。
