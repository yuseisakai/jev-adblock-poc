# 開発への参加

不具合報告には拡張のバージョン、Chrome/OS、再現手順、期待する動作を記載してください。APIキー、実際のページ本文、閲覧履歴、個人情報は貼らないでください。可能なら合成HTMLで再現してください。

Node.js 20以上を使用します。

```sh
npm ci
npx playwright install chromium
npm run format:check
npm run build
npm test
npm run test:e2e
```

PRは変更の理由、挙動、確認結果を記載してください。通信先・保存情報・権限を変える場合はREADMEとPRIVACY.mdも更新してください。実APIをCIから呼び出さないでください。

コードはMITライセンスです。第三者のコード・画像を追加する際は出典と許諾表示を含めてください。

書式は `npm run format` で揃えられます。
