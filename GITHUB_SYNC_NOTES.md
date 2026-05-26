# GitHub Sync Notes

This repository currently lives under `C:\Users\ringo`, so do not run `git add .` from the home directory.

Use explicit paths when staging this project, for example:

```powershell
git -C C:\Users\ringo add binance_local_watcher/.gitignore
git -C C:\Users\ringo add binance_local_watcher/.env.example
git -C C:\Users\ringo add binance_local_watcher/config.local.example.json
git -C C:\Users\ringo add binance_local_watcher/GITHUB_SYNC_NOTES.md
git -C C:\Users\ringo add binance_local_watcher/electron_python_ui_v0_2_price_chart
```

Do not commit these local files:

- `.env`
- `config.local.json`
- `settings.json`
- `price_history.csv`
- `downloaded_price_history.csv`
- `long_data/`
- `node_modules/`

API keys and secrets should be read from environment variables or a local ignored file only.
Do not store them in `settings.json`, source files, README examples, screenshots, or chat logs.
