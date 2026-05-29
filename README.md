# Binance Local Watcher (Electron mainline)

このリポジトリの運用対象は **Electron版** です。  
`app.py` の Streamlit 版は **legacy / 参照用** として残し、通常運用では起動しません。

<<<<<<< HEAD
## 安全方針
=======
突貫工事でやったので、荒っぽいところなどあるかと思いますが、Crypto初心者にやさしい設計になっていて、現在、Binanceeの公開データを利用して少額取引を考えるうえでヒントになるかもしれません。アカウントお餅の方は、APIで接続テストまで可能です。詳しくは起動してみてください。


## 重要
>>>>>>> 10ff1d2271889d87c2a7632ebca79bb15dd5d9dc

- 実注文はしません
- 自動売買はしません
- 出金機能はありません
- APIキー / Secret の保存処理は実装しません
- 価格取得は Binance 公開マーケットデータを利用します

## 起動（Electron）

前提:
- Node.js 20 以上（推奨 20 LTS）

```powershell
cd C:\Projects\binance_local_watcher
npm install
npm start
```

Windows:

```powershell
.\start_electron_local_engine.bat
```

## スモークチェック

```powershell
npm run smoke
```

`scripts/smoke_local_engine.js` が主要ルートを最小確認します。

## ビルド（Windows）

```powershell
npm run build
```

`electron-builder` を使って `dist/` に出力します。  
Node 14 ではビルドできないため、Node 20 以上で実行してください。

補足（Windows）:
- `winCodeSign` 展開時にシンボリックリンク作成権限が必要です
- 失敗する場合は「管理者PowerShellで実行」または「Windows開発者モードを有効化」してください

## 役割分担

- `index.html` / `renderer.js`: UI表示と入力
- `preload.js`: `window.blw.api` の公開
- `local_engine.js`: 公開API取得、CSV I/O、ルート処理
- `local_engine_calculations.js`: 計算ロジック（副作用なし）

## API境界

API契約は `API_CONTRACT.json` を参照してください。  
利用可能ルートは `getCapabilities` / `getContract` でも確認できます。

主なAPI:
- GET: `status`, `capabilities`, `summary`, `impact`, `alert-preview`, `alert-history`, `daily-goal-reports`, `chart`, `contract`, `api-readiness`
- POST: `fetch-prices`, `download-history`, `trade-preview`, `daily-goal`, `save-daily-goal-report`, `clear-alert-history`, `clear-daily-goal-reports`

補足:
- `alert-preview` は `simple / rolling / sustained` モード対応
- `trade-preview` は概算P/Lに加えて、`exchangeInfo` ベースの最小ルール診断（`rule_check`）を返します

禁止範囲:
- `real_order`
- `auto_trading`
- `withdrawal`
- `api_key_storage`
- `secret_storage`

## APIキー準備（保存しない）

APIキー/Secretはアプリ内保存しません。`環境変数` か `.env` の読み取りのみです。  
APIタブの「API準備度（最小）」で、公開API到達・署名API認証・手数料API取得（読み取り専用）を確認できます。

`.env` 例:

```env
BINANCE_API_KEY=your_key
BINANCE_API_SECRET=your_secret
```

## Legacy (Streamlit)

- `app.py` は legacy / 参照専用
- 現在のElectronポート作業では `app.py` を変更しません
- Python側の機能棚卸しは `ELECTRON_MIGRATION_BACKLOG.md` を参照

## 配布前チェック

- `RELEASE_CHECKLIST.md` を使用してください
