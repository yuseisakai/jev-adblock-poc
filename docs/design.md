# UIの方針

2026-09-30にデジタル庁デザインシステムv2.18.0の以下を参照した。

- https://design.digital.go.jp/dads/foundations/color/
- https://design.digital.go.jp/dads/components/button/
- https://design.digital.go.jp/dads/components/button/accessibility/
- https://design.digital.go.jp/dads/components/input-text/usage/
- https://design.digital.go.jp/dads/components/input-text/accessibility/

公式の指針を参考に、ラベルと入力条件を常時表示、保存時の具体的エラー、色に依存しない状態表示、44px以上の操作領域、見えるキーボードフォーカスを採用。

独自判断：白地、濃い本文、青の主要操作（#0031d8）、480px幅のポップアップ、OS標準書体。本文16px、補足14px、見出し24〜28px。チェックボックスは自動判定を即時変更し、数値欄は保存ボタンで確定する。外部フォント・計測通信を追加しない。

公式のコードやブランドを複製せず、HTML/CSSを独自実装した。採用だけでWCAG/JIS適合を宣言しない。キーボード・画面幅・主要配色を検査するが、スクリーンリーダーや規格全項目の適合試験は別途必要。

通常のポップアップは削除・復元・自動判定を中心にし、閾値と実行モードは「詳細設定」に折りたたむ。ルート要素にも幅を指定して、拡張ポップアップの初期表示で幅が縮むことを防ぐ。設定画面は広い画面で2列、狭い画面で1列とする。
