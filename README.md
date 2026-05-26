# Binance Local Watcher Electron UI v0.4 local engine

Electron rendererをUI、Electron main processのNodeエンジンを計算・公開価格取得・履歴保存・チャート用データ生成に使う版です。

## 重要

- 実注文はしません。
- 自動売買はしません。
- 出金機能はありません。
- APIキーやSecretは入力・保存しません。
- 価格取得は Binance の公開マーケットデータだけを使います。

## v0.3で変えたこと

- Python HTTP backend の自動起動をやめ、Electron main process の `local_engine.js` へ移行
- renderer から `preload.js` 経由で IPC 呼び出し
- Nodeエンジンが `BTCJPY` / `ETHJPY` の価格を公開APIから取得
- `price_history.csv` へ追記保存
- ローカル履歴、DL済み過去データ、統合表示、公開klineからSVGチャートを表示
- Python backend と同じ返却形を保ち、比較しやすくする
- Binance公開klineを1時間チャンクで `long_data/` へ保存する履歴DLを追加

## v0.4で変えたこと

- 計算式を `local_engine_calculations.js` に分離
- `local_engine.js` はCSV、公開API取得、IPCルートの窓口に整理
- summary、impact、chart集計、損益プレビュー、日次目標を副作用のない関数として扱う
- Electron main process がI/Oを持ち、rendererは `window.blw.api` だけを呼ぶ形を維持

## 現在地

- ルート直下のElectron版は `npm start` で起動確認済み
- 通常起動ではPython backendを起動しない
- GitHub `main` は初回同期済み
- `price_history.csv`、`.env`、`node_modules/`、ローカル状態ファイルはGit除外済み
- 計算まわりは `local_engine_calculations.js` を中心に拡張する

## 起動

```powershell
cd C:\Projects\binance_local_watcher
npm install
npm start
```

Windowsなら以下でもOKです。

```powershell
.\start_electron_local_engine.bat
```

## 既存のプロジェクトフォルダを使う

既存の `price_history.csv` を使いたい場合は、`BLW_PROJECT_DIR` を指定します。
新しく価格取得して保存する場合も、このフォルダの `price_history.csv` に追記します。

```powershell
$env:BLW_PROJECT_DIR="C:\Projects\binance_local_watcher"
npm start
```

## 役割分担

- Electron renderer: 表示、入力、画面遷移、SVGグラフ描画
- preload: rendererへ安全な `window.blw.api` だけを公開
- Electron main / `local_engine.js`: 公開価格取得、履歴CSV保存、履歴読み込み、IPCルート
- `local_engine_calculations.js`: summary、impact、chart集計、損益プレビュー、日次目標の計算

## API境界

rendererはHTTPサーバーではなく、`window.blw.api` から IPC で Electron main process のローカルエンジンを呼びます。

- `getStatus`: 接続状態、履歴CSV、API境界、安全範囲
- `getCapabilities`: 利用可能ルートと禁止機能
- `getSummary`: 最新価格サマリー
- `getImpact`: 金額ごとの値動き影響
- `getChart`: チャート用データ
- `fetchPrices`: 公開APIから現在価格を取得してCSVへ追記
- `downloadHistory`: 指定日のklineを1時間チャンクで取得し、統合CSVを作成
- `tradePreview`: 実注文なしの損益概算
- `dailyGoal`: 日次目標の条件整理

禁止範囲はローカルエンジンの `getStatus` と `getCapabilities` でも返します。
`real_order`, `auto_trading`, `withdrawal`, `api_key_storage`, `secret_storage` は実装しません。

## 日次目標の考え方

日次目標は利益額だけを見る場所ではなく、今日の条件がどれくらい重いかを見る準備ボードです。

- 目標利益、投入額、機会回数、往復コスト、損切り幅、未約定率から条件を分解する
- 今日の重さ、損切り1回の重さ、未約定時の悪化をカードで見る
- 準備コメントは売買指示ではなく、条件の厳しさと確認点を示す
- 実注文、自動売買、出金、APIキー保存は扱わない

## 履歴データDL

チャートタブの履歴データDLは、指定日・通貨・間隔・開始時・終了時を受け取り、内部では1時間単位に分割してBinance公開klineを取得します。

- 時刻指定はJST
- Binance APIへはJSTをUTCミリ秒へ変換して送る
- 保存先はGit除外済みの `long_data/`
- チャンクCSVとmerged CSVのファイル名には `_JST` を付ける
- 取得済みチャンクはスキップ可能
- チャートの「DL済み過去データ」「ローカル+DL済み」は、この日付・時間帯を使って `long_data/` と `price_history.csv` を表示する
- 後で仮想未約定率を計算するための元データとして使う

## 次の候補

- Streamlit版 candidate の計算ルール・実commission・BNBチェックを `local_engine_calculations.js` へ移植
- チャートをサマリーへ小さく表示
- Electron UIをさらに運用画面寄りに整理
- 読み取り専用APIキーを使う場合の保存先を `.env` から始め、将来はOS資格情報ストアへ寄せる
- 実注文・注文テストはまだ入れない
