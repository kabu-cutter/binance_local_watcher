# Binance Local Watcher (Electron mainline)

Binance Local Watcher は、Binance の公開マーケットデータを使って、BTC/JPY・ETH/JPY などの価格監視、チャート表示、アラート確認、損益プレビュー、日次目標の条件診断を行うローカルアプリです。

このリポジトリの運用対象は **Electron 版** です。
`app.py` の Streamlit 版は **legacy / 参照用** として残し、通常運用では起動しません。

## 重要・安全方針

このアプリは、手動取引前の確認・記録・条件診断を支援するためのものです。
売買シグナル、投資助言、自動売買ツールではありません。

- 実注文はしません
- 自動売買はしません
- 出金機能はありません
- APIキー / Secret の保存処理は実装しません
- 価格取得は Binance 公開マーケットデータを利用します
- APIキーを使う場合も、まずは読み取り専用・接続確認用途に限定します
- アラートや日次目標診断は、売買指示ではなく確認材料です

## 主な機能

- 現在価格の表示
- BTCJPY / ETHJPY の監視
- チャート表示
- アラート判定・履歴表示
- 値動き影響の確認
- 損益プレビュー
- 日次目標の条件診断
- API準備度の最小チェック
- ローカルデータによる履歴・診断の補助

## 起動（Electron）

前提:

- Node.js 20 以上
- Windows でのローカル実行を主対象

初回セットアップ:

```powershell
cd C:\Projects\binance_local_watcher
npm install
```

起動:

```powershell
npm start
```

Windows 用の起動バッチを使う場合:

```powershell
.\start_electron_local_engine.bat
```

## Electron 起動トラブルメモ

環境によって、`npm install` や Electron のインストールスクリプトが成功したように見えても、Electron が正しく起動しないことがあります。
特に Windows 環境では、`node_modules/electron/dist/electron.exe` が欠けている、壊れている、または `path.txt` の内容と合わず、`npm start` で失敗するケースがあります。

確認ポイント:

```powershell
Test-Path .\node_modules\electron\dist\electron.exe
Test-Path .\node_modules\electron\path.txt
Get-Content .\node_modules\electron\path.txt
```

確認する内容:

- `node_modules/electron/dist/electron.exe` が存在する
- `node_modules/electron/path.txt` が存在する
- `path.txt` の中身が `electron.exe` だけになっている
- `path.txt` の末尾に余計な改行や空白がない

### electron.exe の手動更新で直るケース

`npm install` が成功表示でも、`electron.exe` の実体が正しく入っていない場合があります。
この場合は、Electron パッケージを入れ直すか、Electron のバイナリを手動で更新・復元してから起動確認してください。

目安:

```powershell
npm install
Test-Path .\node_modules\electron\dist\electron.exe
npm start
```

それでも `electron.exe` が見つからない、または `spawn ... electron.exe ENOENT` が出る場合は、`node_modules/electron` 配下の Electron 本体を手動更新します。

```Powershell
$electronVersion = node -p "require('./node_modules/electron/package.json').version"
$zipUrl = "https://github.com/electron/electron/releases/download/v$electronVersion/electron-v$electronVersion-win32-x64.zip"
$zipPath = "$env:TEMP\electron-v$electronVersion-win32-x64.zip"

Write-Host "Electron version: $electronVersion"
Write-Host "Download: $zipUrl"

Remove-Item -Recurse -Force .\node_modules\electron\dist -ErrorAction SilentlyContinue
Remove-Item -Force .\node_modules\electron\path.txt -ErrorAction SilentlyContinue

Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath

New-Item -ItemType Directory -Force .\node_modules\electron\dist | Out-Null
Expand-Archive -Path $zipPath -DestinationPath .\node_modules\electron\dist -Force


手動更新後は、次の `path.txt` 修正もあわせて確認してください。

### path.txt 修正

`path.txt` の中身が不正、または末尾改行が原因で起動に失敗することがあります。
このファイルは `electron.exe` だけを ASCII で、末尾改行なしで保存します。

修正例:

```powershell
[System.IO.File]::WriteAllText(
  "C:\Projects\binance_local_watcher\node_modules\electron\path.txt",
  "electron.exe",
  [System.Text.Encoding]::ASCII
)
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

補足（Windows）:

- `winCodeSign` 展開時にシンボリックリンク作成権限が必要です
- 失敗する場合は「管理者PowerShellで実行」または「Windows開発者モードを有効化」してください

## 役割分担

- `index.html` / `renderer.js`: UI表示と入力
- `style.css`: UIスタイル
- `preload.js`: `window.blw.api` の公開
- `local_engine.js`: 公開API取得、ローカルI/O、ルート処理
- `local_engine_calculations.js`: 計算ロジック（副作用なし）
- `local_engine_alerts.js`: アラート判定ロジック
- `API_CONTRACT.json`: API契約

## API境界

API契約は `API_CONTRACT.json` を参照してください。
利用可能ルートは `getCapabilities` / `getContract` でも確認できます。

主なAPI:

- GET: `status`, `capabilities`, `summary`, `impact`, `alert-preview`, `alert-history`, `daily-goal-reports`, `chart`, `contract`, `api-readiness`
- POST: `fetch-prices`, `download-history`, `trade-preview`, `daily-goal`, `save-daily-goal-report`, `clear-alert-history`, `clear-daily-goal-reports`

補足:

- `alert-preview` は `simple / rolling / sustained` モード対応
- `trade-preview` は概算P/Lに加えて、`exchangeInfo` ベースの最小ルール診断（`rule_check`）を返します
- アラートは売買サインではなく、手動取引前の注意・確認用です

禁止範囲:

- `real_order`
- `auto_trading`
- `withdrawal`
- `api_key_storage`
- `secret_storage`

## APIキー準備（保存しない）

APIキー / Secret はアプリ内保存しません。
利用する場合は `環境変数` または `.env` の読み取りのみです。

APIタブの「API準備度（最小）」で、公開API到達・署名API認証・手数料API取得（読み取り専用）を確認できます。

`.env` 例:

```env
BINANCE_API_KEY=your_key
BINANCE_API_SECRET=your_secret
```

## ローカルデータ

このアプリはローカルで履歴・診断用データを扱います。
CSV / JSON / SQLite などの実行時データは、必要最小限の保存・参照にとどめます。

代表例:

- `price_history.csv`
- `alert_history.json`
- `data/blw.sqlite`

注意:

- ローカル実行時データは GitHub に上げない方針です
- `data/blw.sqlite` は `.gitignore` 対象にしてください
- APIキーや Secret をリポジトリに含めないでください

## Legacy (Streamlit)

- `app.py` は legacy / 参照専用
- 現在の Electron 版では `app.py` を通常運用しません
- Python側の機能棚卸しは `ELECTRON_MIGRATION_BACKLOG.md` を参照

## 配布前チェック

配布前は `RELEASE_CHECKLIST.md` を確認してください。

最低限の確認:

```powershell
npm run smoke
npm start
```
