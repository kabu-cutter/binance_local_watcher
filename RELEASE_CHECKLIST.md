# Release Checklist (Windows / Electron)

## 1) Safety
- `real_order` / `auto_trading` / `withdrawal` / `api_key_storage` / `secret_storage` が未実装であること
- `API_CONTRACT.json` の禁止範囲と `local_engine.js` の `API_BOUNDARY.forbidden` が一致していること

## 2) Ignore / Local files
- `.env`, `price_history.csv`, `long_data/`, `alert_history.json`, `daily_goal_reports.csv`, `node_modules/` がGit追跡対象外であること
- `git status --ignored` でローカルデータが除外されていること

## 3) Startup check
- Node.js 20 以上を使用していること
- `npm install` 済み
- `npm start` でElectron起動
- サマリー表示、価格取得、チャート、日次目標、簡易アラートが動くこと

## 4) API boundary check
- `status`, `capabilities`, `contract`, `api-readiness` が取得できること
- `alert-preview`, `chart`, `impact`, `daily-goal`, `trade-preview`, `download-history` がエラーなく返ること
- `npm run smoke` が成功すること（主要ルートの最小スモーク）
- GitHub Actions `Smoke Check` が成功していること（PR / main push）

## 5) Read-only API readiness
- `api-readiness` で `public_api_ok` が確認できること
- APIキー/Secretを使う場合は環境変数 or `.env` 読み取りのみで、保存処理がないこと

## 6) Packaging prep
- 生成物出力先(`dist/`, `out/`, `build/`, `release/`)がGit追跡対象外であること
- 起動バッチ(`start_electron_local_engine.bat`)で起動確認できること
- `npm run build` が成功すること（Node 20+）
- `npm run build` 失敗時に、管理者実行またはWindows開発者モードでシンボリックリンク権限を確認すること

## 7) Final policy check
- 実注文・自動売買・出金・秘密情報保存を追加していないことを再確認
