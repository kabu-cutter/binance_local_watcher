# Electron Migration Backlog (app.pyは変更しない)

## 方針
- Python `app.py` は参照のみ。改修しない。
- Electron (`index.html` / `renderer.js` / `preload.js` / `local_engine.js`) を主系にする。
- 実注文・自動売買・出金・APIキー保存は実装しない。

## 現在の実装済み（Electron）
- サマリー表示（公開価格取得 + `price_history.csv` 反映）
- 値動き影響（amountベース）
- チャート表示
  - ローカル履歴
  - 公開kline
  - DL済み過去データ
  - ローカル + DL済み統合
- 履歴データDL（1時間チャンク、JST、`long_data/` 保存、merged作成）
- 損益プレビュー（ローカル概算）
- 日次目標
  - 約定率/勝率/値動き中心
  - 仮想約定率の履歴ベース自動推定
  - 条件テンプレート（4種）

## Python側に残っている主要機能（未移管）
- 高度アラート群
  - 急騰検知、ローリング、持続上昇、イベント検知、固定時刻アラート
  - 通貨別しきい値、アラート表示整形
- 取引シミュレータの高度機能
  - Binanceルール適合チェック（`exchangeInfo`）
  - 板ベース約定シミュレーション（`depth`）
  - 手数料プロファイルの詳細分解
- API準備度タブの詳細
  - 読み取り専用API接続テスト
  - 資産/commission取得表示
  - fee反映補助表示
- チャート高度設定
  - 軸固定/自動幅の詳細制御
  - intervalごとの時間軸表示最適化
- Ollama連携タブ
  - 背景ジョブ、保存コメント、接続テスト

## 優先移管順（推奨）
1. アラート最小セット移管
   - まず「急騰検知」だけを Electron 化
   - 入力: しきい値、監視窓、通貨別ON/OFF
   - 出力: 一覧 + 上位通知
2. 日次目標の履歴活用強化
   - 仮想約定率推定を「日次別キャッシュ」化
   - 推定根拠（対象本数/条件）を短く表示
3. 取引シミュレーションの精度段階化
   - Phase A: 現状の概算を維持
   - Phase B: ルールチェックのみ追加（板は後回し）
4. API準備度の最小実装
   - 接続可否 + 手数料取得可否だけ先に表示
   - APIキー保存はしない（環境変数のみ）
5. Ollama/高度UIは最後

## API境界（維持）
- Renderer: 入力と表示のみ
- Main(Local Engine): 公開データ取得、CSV I/O、計算、判定
- 禁止:
  - `real_order`
  - `auto_trading`
  - `withdrawal`
  - `api_key_storage`
  - `secret_storage`

## 次アクション（着手候補）
- `local_engine.js` に `alert-preview` ルートを追加
- `renderer.js` / `index.html` にアラート最小UIを追加
- まずは「直近N分でX%以上上昇」のみ実装
