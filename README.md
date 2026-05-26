# Binance Local Watcher Electron UI v0.3 local engine

Electron rendererをUI、Electron main processのNodeエンジンを計算・公開価格取得・履歴保存・チャート用データ生成に使う版です。

突貫工事でやったので、荒っぽいところなどあるかと思いますが、Crypto初心者にやさしい設計になっていて、現在、Binanceeの公開データを利用して少額取引を考えるうえでヒントになるかもしれません。アカウントお餅の方は、APIで接続テストまで可能です。詳しくは起動してみてください。


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
- ローカル履歴または公開klineからSVGチャートを表示
- Python backend と同じ返却形を保ち、比較しやすくする

## 起動

```powershell
cd C:\Projects\binance_local_watcher
npm install
npm start
```

Windowsなら以下でもOKです。

```powershell
.\start_electron_python_ui.bat
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
- Electron main / `local_engine.js`: 公開価格取得、履歴CSV保存、履歴読み込み、チャート用データ生成、概算計算

## API境界

rendererはHTTPサーバーではなく、`window.blw.api` から IPC で Electron main process のローカルエンジンを呼びます。

- `getStatus`: 接続状態、履歴CSV、API境界、安全範囲
- `getCapabilities`: 利用可能ルートと禁止機能
- `getSummary`: 最新価格サマリー
- `getImpact`: 金額ごとの値動き影響
- `getChart`: チャート用データ
- `fetchPrices`: 公開APIから現在価格を取得してCSVへ追記
- `tradePreview`: 実注文なしの損益概算
- `dailyGoal`: 日次目標の条件整理

禁止範囲はローカルエンジンの `getStatus` と `getCapabilities` でも返します。
`real_order`, `auto_trading`, `withdrawal`, `api_key_storage`, `secret_storage` は実装しません。

## 次の候補

- Streamlit版 candidate の計算ルール・実commission・BNBチェックを `local_engine.js` へ移植
- チャートをサマリーへ小さく表示
- Electron UIをさらに運用画面寄りに整理
- 実注文・注文テストはまだ入れない
