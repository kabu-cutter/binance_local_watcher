from __future__ import annotations

import html
import json
import re
import os
import hmac
import hashlib
import threading
import time
from pathlib import Path
from datetime import datetime
from urllib.parse import urlencode
from decimal import Decimal, ROUND_DOWN, InvalidOperation
from zoneinfo import ZoneInfo

import pandas as pd
import requests
import streamlit as st
import streamlit.components.v1 as components

try:
    import matplotlib.pyplot as plt
    import matplotlib.dates as mdates
    from matplotlib.ticker import FuncFormatter
    MATPLOTLIB_AVAILABLE = True
except Exception:
    MATPLOTLIB_AVAILABLE = False


# =========================
# 基本設定
# =========================

APP_VERSION = "v0.5-candidate-18"

APP_DIR = Path(__file__).resolve().parent


def detect_project_data_dir(app_dir: Path) -> Path:
    """
    履歴CSVやsettings.jsonを読む基準フォルダを決める。

    app.pyをダウンロードフォルダなどから直接実行した場合でも、
    PowerShellの現在位置に既存の price_history.csv / settings.json / long_data があれば、
    そちらをプロジェクトのデータフォルダとして使う。
    
    通常どおり C:/Users/ringo/binance_local_watcher に app.py を置いて実行する場合は、
    app.py と同じフォルダを使う。
    """
    app_dir = Path(app_dir).resolve()
    cwd = Path.cwd().resolve()

    marker_names = ["price_history.csv", "settings.json", "long_data"]

    if any((app_dir / name).exists() for name in marker_names):
        return app_dir

    if cwd != app_dir and any((cwd / name).exists() for name in marker_names):
        return cwd

    return app_dir


PROJECT_DIR = detect_project_data_dir(APP_DIR)
HISTORY_FILE = PROJECT_DIR / "price_history.csv"
SETTINGS_FILE = PROJECT_DIR / "settings.json"
OLLAMA_COMMENT_FILE = PROJECT_DIR / "ollama_comment.json"
OLLAMA_JOB_FILE = PROJECT_DIR / "ollama_job.json"
COLLECTOR_STATUS_FILE = PROJECT_DIR / "price_collector_status.json"
LONG_DATA_DIR = PROJECT_DIR / "long_data"
ENV_FILE = PROJECT_DIR / ".env"
GITIGNORE_FILE = PROJECT_DIR / ".gitignore"

SYMBOLS = ["BTCJPY", "ETHJPY"]
HISTORY_COLUMNS = ["timestamp", "symbol", "price_jpy"]
HISTORY_IO_LOCK = threading.RLock()

JST = ZoneInfo("Asia/Tokyo")

DEFAULT_OLLAMA_URL = "http://192.168.3.50:11434"
DEFAULT_OLLAMA_MODEL = "qwen3:8b"


# =========================
# 設定
# =========================

def load_settings() -> dict:
    defaults = {
        "auto_save": True,
        "save_interval_sec": 60,
        "monitor_paused": False,
        "long_data_skip_existing": True,
        "long_data_range_start": "12:00",
        "long_data_range_end": "13:00",

        "trend_points": 10,
        "flat_threshold_pct": 0.05,
        "small_threshold_pct": 0.10,
        "medium_threshold_pct": 0.50,
        "large_threshold_pct": 1.00,

        "amount_text": "1000,10000,100000",
        "focus_amount": 10000,
        "impact_amount_preset": "比較",


        # v0.5 取引シミュレーター設定
        # 実注文ではなく、数量・手数料・成行コスト・損益を確認するための計算用。
        "trade_sim_amount_jpy": 10000,
        "trade_sim_taker_fee_pct": 0.10,
        "trade_sim_use_live_taker_fee": False,
        "trade_sim_spread_pct": 0.05,
        "trade_sim_slippage_pct": 0.02,
        "trade_sim_fee_mode": "Binance寄せ: 買いはコイン控除 / 売りはJPY控除",
        "trade_sim_use_binance_rules": True,
        "trade_sim_use_order_book": False,
        "trade_sim_depth_limit": 20,
        "trade_sim_exit_mode": "変動率で指定",
        "trade_sim_exit_change_pct": 1.00,
        "trade_sim_exit_prices": {
            "BTCJPY": 0,
            "ETHJPY": 0,
        },

        # v0.5-candidate-14 日次目標シミュレーター設定
        # 目標達成側だけでなく、指値未約定キャンセルと約定後損切りを分けて見る。
        # 売買判断ではなく準備用。実注文は行わない。
        "daily_goal_profit_jpy": 100,
        "daily_goal_amounts_text": "1000,10000,100000",
        "daily_goal_trade_counts_text": "1,3,5,10",
        "daily_goal_stop_loss_change_pct": 1.00,
        "daily_goal_loss_change_pct": 1.00,  # 旧設定互換。画面では「約定後の損切り逆行率」として扱う。
        "daily_goal_unfilled_cancel_rate_pct": 0.0,
        "daily_goal_unfilled_scenarios_text": "10,30,50,70",
        "daily_goal_limit_wait_minutes": 5,
        "daily_goal_limit_cancel_move_pct": 0.30,
        "daily_goal_plan_amount_jpy": 2000,
        "daily_goal_plan_min_count": 5,
        "daily_goal_plan_max_count": 10,
        "daily_goal_show_suggestions": True,

        # v0.5 candidate-4: 読み取り専用API確認。
        # APIキーとSecretはsettings.jsonへ保存せず、環境変数だけから読む。
        "binance_api_recv_window": 5000,

        # 急騰検出アラート設定
        "alert_enabled": True,

        # 通常監視用: 直近何分間で急騰を検出するか。
        # 23:30のような固定時刻に依存しない。
        "rolling_alert_enabled": True,
        "rolling_alert_window_minutes": 10,

        # 15分・20分・30分など、少し長く上昇が続く動きを見る。
        # 「急騰」とは分けて、継続上昇として表示する。
        "sustained_rise_enabled": True,
        "sustained_rise_windows_text": "15,20,30",
        "sustained_rise_max_pullback_pct": 0.05,
        "sustained_rise_close_near_high_pct": 0.03,

        # 過去数時間の中で、急騰イベントが起きた区間を探す。
        # 例: 23:30〜23:40ごろの直線的な上昇を、現在時刻が進んだあとでも拾う。
        "event_alert_enabled": True,
        "event_lookback_hours": 6,
        "event_window_minutes": 15,
        "event_use_peak_price": True,
        "event_candidate_mode": True,

        # 固定時刻から見る確認用。例: 23:30から今まで。
        "fixed_time_alert_enabled": False,
        "alert_start_time": "23:30",

        "alert_threshold_pct": 0.02,
        "alert_rising_ratio": 60.0,
        "alert_r2_threshold": 0.45,
        "alert_symbol_settings": {
            "BTCJPY": {"enabled": True, "threshold_yen": 1000},
            "ETHJPY": {"enabled": True, "threshold_yen": 150},
        },

        "price_axis_padding_pct": 1.0,
        "min_price_axis_width": 0,
        "chart_interval": "そのまま",
        "chart_data_source": "DLデータ＋ローカル補完",

        # 通貨別の通常表示用Y軸最低幅。
        # ETHJPYは実レンジに密着しすぎると上下に暴れやすいので、
        # デフォルトで少し余裕を持たせる。
        "symbol_min_axis_widths": {
            "BTCJPY": 0,
            "ETHJPY": 3000,
        },

        # 全通貨共通の手動レンジ。必要な場合だけONにする。
        "manual_price_axis_enabled": False,
        "manual_price_axis_min": 8000,
        "manual_price_axis_max": 13000,

        # 通貨別の手動レンジ。共通より優先する。
        "symbol_axis_ranges": {
            "BTCJPY": {"enabled": False, "min": 8000, "max": 13000},
            "ETHJPY": {"enabled": False, "min": 8000, "max": 13000},
        },

        "use_ollama": True,
        "ollama_url": DEFAULT_OLLAMA_URL,
        "ollama_model": DEFAULT_OLLAMA_MODEL,

        # v0.5-candidate-10: Ollama高速化・安定化設定
        # 高速: Python判定サマリー中心 / 短い出力
        # 通常: 少し詳しめ / 詳細: 旧来に近い情報量
        "ollama_response_mode": "高速",
    }

    if SETTINGS_FILE.exists():
        try:
            with SETTINGS_FILE.open("r", encoding="utf-8") as f:
                loaded = json.load(f)

            if isinstance(loaded, dict):
                defaults.update(loaded)
        except Exception:
            pass

    # 古いsettings.jsonから来た場合に備えて補完
    if "symbol_axis_ranges" not in defaults or not isinstance(defaults["symbol_axis_ranges"], dict):
        defaults["symbol_axis_ranges"] = {}
    for symbol in SYMBOLS:
        defaults["symbol_axis_ranges"].setdefault(
            symbol,
            {"enabled": False, "min": 8000, "max": 13000},
        )

    if "symbol_min_axis_widths" not in defaults or not isinstance(defaults["symbol_min_axis_widths"], dict):
        defaults["symbol_min_axis_widths"] = {}
    defaults["symbol_min_axis_widths"].setdefault("BTCJPY", 0)
    defaults["symbol_min_axis_widths"].setdefault("ETHJPY", 3000)

    if "alert_symbol_settings" not in defaults or not isinstance(defaults["alert_symbol_settings"], dict):
        defaults["alert_symbol_settings"] = {}
    defaults["alert_symbol_settings"].setdefault("BTCJPY", {"enabled": True, "threshold_yen": 2000})
    defaults["alert_symbol_settings"].setdefault("ETHJPY", {"enabled": True, "threshold_yen": 300})

    if "trade_sim_exit_prices" not in defaults or not isinstance(defaults["trade_sim_exit_prices"], dict):
        defaults["trade_sim_exit_prices"] = {}
    for symbol in SYMBOLS:
        defaults["trade_sim_exit_prices"].setdefault(symbol, 0)

    return defaults


def save_settings(settings: dict):
    try:
        with SETTINGS_FILE.open("w", encoding="utf-8") as f:
            json.dump(settings, f, ensure_ascii=False, indent=2)
    except Exception as e:
        st.warning(f"設定ファイルの保存に失敗しました: {e}")


def update_setting_if_changed(settings: dict, key: str, value):
    if settings.get(key) != value:
        settings[key] = value
        save_settings(settings)


def update_symbol_axis_setting(settings: dict, symbol: str, subkey: str, value):
    if "symbol_axis_ranges" not in settings or not isinstance(settings["symbol_axis_ranges"], dict):
        settings["symbol_axis_ranges"] = {}

    if symbol not in settings["symbol_axis_ranges"]:
        settings["symbol_axis_ranges"][symbol] = {"enabled": False, "min": 8000, "max": 13000}

    if settings["symbol_axis_ranges"][symbol].get(subkey) != value:
        settings["symbol_axis_ranges"][symbol][subkey] = value
        save_settings(settings)


def get_symbol_min_axis_width(settings: dict, symbol: str, fallback: int = 0) -> int:
    """
    通貨別のグラフ最低表示幅を取得する。
    """
    widths = settings.get("symbol_min_axis_widths", {})
    if not isinstance(widths, dict):
        return int(fallback)

    try:
        return int(widths.get(symbol, fallback))
    except Exception:
        return int(fallback)


def update_symbol_min_axis_width(settings: dict, symbol: str, value: int):
    """
    通貨別のグラフ最低表示幅を保存する。
    """
    if "symbol_min_axis_widths" not in settings or not isinstance(settings["symbol_min_axis_widths"], dict):
        settings["symbol_min_axis_widths"] = {}

    value = int(value)

    if settings["symbol_min_axis_widths"].get(symbol) != value:
        settings["symbol_min_axis_widths"][symbol] = value
        save_settings(settings)


def get_alert_symbol_setting(settings: dict, symbol: str) -> dict:
    """
    通貨別アラート設定を取得する。
    """
    alert_settings = settings.get("alert_symbol_settings", {})
    if not isinstance(alert_settings, dict):
        alert_settings = {}

    default_threshold = 2000 if symbol == "BTCJPY" else 300
    item = alert_settings.get(symbol, {})

    if not isinstance(item, dict):
        item = {}

    return {
        "enabled": bool(item.get("enabled", True)),
        "threshold_yen": int(item.get("threshold_yen", default_threshold)),
    }


def update_alert_symbol_setting(settings: dict, symbol: str, subkey: str, value):
    """
    通貨別アラート設定を保存する。
    """
    if "alert_symbol_settings" not in settings or not isinstance(settings["alert_symbol_settings"], dict):
        settings["alert_symbol_settings"] = {}

    if symbol not in settings["alert_symbol_settings"] or not isinstance(settings["alert_symbol_settings"][symbol], dict):
        default_threshold = 2000 if symbol == "BTCJPY" else 300
        settings["alert_symbol_settings"][symbol] = {"enabled": True, "threshold_yen": default_threshold}

    if settings["alert_symbol_settings"][symbol].get(subkey) != value:
        settings["alert_symbol_settings"][symbol][subkey] = value
        save_settings(settings)


def update_trade_exit_price_setting(settings: dict, symbol: str, value):
    """
    v0.5 取引シミュレーター用の通貨別売却想定価格を保存する。
    将来 trade_calculator.py / Electron UI に分けても使いやすいよう、
    設定は symbol -> price の単純な辞書で持つ。
    """
    if "trade_sim_exit_prices" not in settings or not isinstance(settings["trade_sim_exit_prices"], dict):
        settings["trade_sim_exit_prices"] = {}

    value = float(value)

    if settings["trade_sim_exit_prices"].get(symbol) != value:
        settings["trade_sim_exit_prices"][symbol] = value
        save_settings(settings)


# =========================
# 価格取得
# =========================

def fetch_binance_price(symbol: str) -> float:
    """
    Binance公開APIから価格を取得する。
    APIキー・認証・実注文は使わない。
    """
    url = "https://api.binance.com/api/v3/ticker/price"
    response = requests.get(url, params={"symbol": symbol}, timeout=10)
    response.raise_for_status()
    return float(response.json()["price"])


def fetch_all_prices(symbols):
    now = datetime.now(JST)
    now_utc = pd.Timestamp(now).tz_convert("UTC")

    rows = []
    errors = []

    for symbol in symbols:
        try:
            price = fetch_binance_price(symbol)
            rows.append({
                "timestamp": now.isoformat(timespec="seconds"),
                "timestamp_dt": now_utc,
                "symbol": symbol,
                "price_jpy": price,
            })
        except Exception as e:
            errors.append(f"{symbol}: {e}")

    return pd.DataFrame(rows), errors



def fetch_binance_klines(symbol: str, interval: str, start_jst: pd.Timestamp, end_jst: pd.Timestamp) -> pd.DataFrame:
    """
    Binance公開APIからローソク足を取得する。
    APIキー・認証・実注文は使わない。

    v0.4.2.2:
    - 429が返った場合は Retry-After を見て待つ
    - 通常の呼び出し間隔は短めに空ける
    - 1回のlimitは1000に固定する
    """
    url = "https://api.binance.com/api/v3/klines"

    start_utc = pd.Timestamp(start_jst).tz_convert("UTC")
    end_utc = pd.Timestamp(end_jst).tz_convert("UTC")

    params = {
        "symbol": symbol,
        "interval": interval,
        "startTime": int(start_utc.timestamp() * 1000),
        "endTime": int(end_utc.timestamp() * 1000),
        "limit": 1000,
    }

    last_error = None

    for attempt in range(3):
        try:
            response = requests.get(url, params=params, timeout=20)

            if response.status_code == 429:
                retry_after = response.headers.get("Retry-After")
                wait_sec = 5.0
                if retry_after:
                    try:
                        wait_sec = max(1.0, float(retry_after))
                    except Exception:
                        wait_sec = 5.0
                time.sleep(wait_sec)
                continue

            response.raise_for_status()
            data = response.json()
            break
        except Exception as e:
            last_error = e
            if attempt < 2:
                time.sleep(1.0 + attempt)
            else:
                raise last_error
    else:
        data = []

    rows = []

    for item in data:
        open_time_ms = int(item[0])
        close_time_ms = int(item[6])

        open_time_utc = pd.to_datetime(open_time_ms, unit="ms", utc=True)
        close_time_utc = pd.to_datetime(close_time_ms, unit="ms", utc=True)

        rows.append({
            "timestamp": open_time_utc.tz_convert(JST).isoformat(),
            "timestamp_dt": open_time_utc,
            "symbol": symbol,
            "interval": interval,
            "open": float(item[1]),
            "high": float(item[2]),
            "low": float(item[3]),
            "close": float(item[4]),
            "volume": float(item[5]),
            "close_time": close_time_utc.tz_convert(JST).isoformat(),
            "quote_asset_volume": float(item[7]),
            "number_of_trades": int(item[8]),
            "taker_buy_base_volume": float(item[9]),
            "taker_buy_quote_volume": float(item[10]),
        })

    return pd.DataFrame(rows)


def fetch_binance_klines_range_chunked(
    symbol: str,
    interval: str,
    start_jst: pd.Timestamp,
    end_jst: pd.Timestamp,
    pause_sec: float = 0.30,
) -> pd.DataFrame:
    """
    長い時間範囲を分割して取得する。

    1分足の丸一日（1440本）はlimit=1000を超えるため、
    12時間ずつに分けて取得する。
    """
    start_jst = pd.Timestamp(start_jst)
    end_jst = pd.Timestamp(end_jst)

    if start_jst.tzinfo is None:
        start_jst = start_jst.tz_localize(JST)
    else:
        start_jst = start_jst.tz_convert(JST)

    if end_jst.tzinfo is None:
        end_jst = end_jst.tz_localize(JST)
    else:
        end_jst = end_jst.tz_convert(JST)

    if end_jst <= start_jst:
        return pd.DataFrame()

    # 1分足なら12時間=720本。limit=1000に余裕を持たせる。
    chunk_hours = 12 if interval == "1m" else 24
    chunk_delta = pd.Timedelta(hours=chunk_hours)

    frames = []
    cursor = start_jst

    while cursor < end_jst:
        chunk_end = min(cursor + chunk_delta, end_jst)
        df = fetch_binance_klines(symbol=symbol, interval=interval, start_jst=cursor, end_jst=chunk_end)
        if df is not None and not df.empty:
            frames.append(df)
        cursor = chunk_end
        if cursor < end_jst:
            time.sleep(float(pause_sec))

    if not frames:
        return pd.DataFrame()

    return normalize_long_data_dataframe(pd.concat(frames, ignore_index=True))


def parse_time_text_for_date(download_date, time_text: str) -> pd.Timestamp:
    """
    日付 + HH:MM をJSTのTimestampへ変換する。
    24:00は翌日0:00として扱う。
    """
    text = str(time_text).strip().replace("：", ":")
    if ":" not in text:
        raise ValueError("時刻は HH:MM 形式で入力してください。例: 12:00")

    hour_text, minute_text = text.split(":", 1)
    hour = int(hour_text)
    minute = int(minute_text)

    if hour == 24 and minute == 0:
        base = pd.Timestamp(download_date).tz_localize(JST) + pd.Timedelta(days=1)
        return base

    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError("時刻は 00:00〜24:00 の範囲で入力してください。")

    base = pd.Timestamp(download_date).tz_localize(JST)
    return base.replace(hour=hour, minute=minute, second=0, microsecond=0)


def get_long_data_daily_file(download_date, interval: str = "1m") -> Path:
    """
    v0.4.2.2以降の長期分析用CSV。
    日付ごとに1ファイルへ追記・統合する。
    """
    start_jst = pd.Timestamp(download_date).tz_localize(JST)
    date_label = start_jst.strftime("%Y%m%d")
    return LONG_DATA_DIR / f"binance_{interval}_{date_label}_JST.csv"


def get_long_data_legacy_noon_file(download_date, interval: str = "1m") -> Path:
    """
    v0.4.2以前の 0:00〜12:00 固定ファイル名。
    互換読み込み用。
    """
    start_jst = pd.Timestamp(download_date).tz_localize(JST)
    date_label = start_jst.strftime("%Y%m%d")
    return LONG_DATA_DIR / f"binance_{interval}_{date_label}_0000_1200_JST.csv"


def get_long_data_output_file(download_date, interval: str = "1m") -> Path:
    """
    互換用。新規保存先は日付単位CSVへ統一する。
    """
    return get_long_data_daily_file(download_date, interval)


def get_legacy_long_data_files_for_date(download_date, interval: str = "1m") -> list:
    """
    同じ日付の旧形式CSVを探す。
    例: binance_1m_20260525_0000_1200_JST.csv
    """
    if not LONG_DATA_DIR.exists():
        return []

    start_jst = pd.Timestamp(download_date).tz_localize(JST)
    date_label = start_jst.strftime("%Y%m%d")
    daily_file = get_long_data_daily_file(download_date, interval)

    files = []
    for path in LONG_DATA_DIR.glob(f"binance_{interval}_{date_label}_*_JST.csv"):
        if path.name != daily_file.name:
            files.append(path)

    # 古い固定名がglobから漏れた場合の保険
    legacy_noon = get_long_data_legacy_noon_file(download_date, interval)
    if legacy_noon.exists() and legacy_noon not in files:
        files.append(legacy_noon)

    return sorted(files, key=lambda p: p.name)


def read_existing_long_data_for_date(download_date, interval: str = "1m", include_legacy: bool = True) -> pd.DataFrame:
    """
    日付単位CSVと、同日の旧形式CSVをまとめて読む。
    """
    frames = []
    daily_file = get_long_data_daily_file(download_date, interval)

    if daily_file.exists():
        df = read_long_data_csv(daily_file)
        if not df.empty:
            frames.append(df)

    if include_legacy:
        for path in get_legacy_long_data_files_for_date(download_date, interval):
            df = read_long_data_csv(path)
            if not df.empty:
                frames.append(df)

    if not frames:
        return pd.DataFrame()

    return normalize_long_data_dataframe(pd.concat(frames, ignore_index=True))

def normalize_long_data_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    """
    長期分析用CSVを読み直したときに、型と列を整える。
    """
    if df is None or df.empty:
        return pd.DataFrame()

    df = df.copy()
    df.columns = [str(c).strip().replace("\ufeff", "") for c in df.columns]

    required = {"timestamp", "timestamp_dt", "symbol", "interval", "open", "high", "low", "close"}
    if not required.issubset(set(df.columns)):
        return pd.DataFrame()

    df["timestamp_dt"] = pd.to_datetime(df["timestamp_dt"], errors="coerce", utc=True)
    df["timestamp"] = df["timestamp"].astype(str)
    df["symbol"] = df["symbol"].astype(str)
    df["interval"] = df["interval"].astype(str)

    numeric_cols = [
        "open",
        "high",
        "low",
        "close",
        "volume",
        "quote_asset_volume",
        "number_of_trades",
        "taker_buy_base_volume",
        "taker_buy_quote_volume",
    ]

    for col in numeric_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")

    df = df.dropna(subset=["timestamp_dt", "symbol", "interval", "close"])
    df = df[df["symbol"].isin(SYMBOLS)]

    if df.empty:
        return pd.DataFrame()

    # 重複防止の本体:
    # 同じ symbol / interval / timestamp_dt は1行にまとめる。
    df = df.sort_values(["symbol", "interval", "timestamp_dt"])
    df = df.drop_duplicates(subset=["symbol", "interval", "timestamp_dt"], keep="last")

    return df


def read_long_data_csv(path: Path) -> pd.DataFrame:
    """
    既存の長期分析CSVを読む。
    """
    if path is None or not Path(path).exists():
        return pd.DataFrame()

    for enc in ["utf-8-sig", "utf-8"]:
        try:
            return normalize_long_data_dataframe(pd.read_csv(path, encoding=enc))
        except Exception:
            pass

    return pd.DataFrame()


def write_long_data_csv(df: pd.DataFrame, path: Path):
    """
    長期分析CSVを重複削除して保存する。
    """
    normalized = normalize_long_data_dataframe(df)

    if normalized.empty:
        return

    save_df = normalized.copy()
    save_df["timestamp_dt"] = save_df["timestamp_dt"].astype(str)
    save_df.to_csv(path, index=False, encoding="utf-8")

def list_long_data_files() -> list:
    """
    long_dataフォルダ内のCSVを新しい順に返す。
    """
    if not LONG_DATA_DIR.exists():
        return []

    return sorted(LONG_DATA_DIR.glob("*.csv"), key=lambda p: p.stat().st_mtime, reverse=True)


def latest_long_data_file():
    """
    最新の長期分析CSVを返す。
    """
    files = list_long_data_files()
    return files[0] if files else None


def format_jst_timestamp(value) -> str:
    """
    保存状態表示用に、時刻をJST表記へ統一する。
    """
    if value is None:
        return "なし"

    try:
        if pd.isna(value):
            return "なし"
    except Exception:
        pass

    try:
        ts = pd.Timestamp(value)

        if ts.tzinfo is None:
            ts = ts.tz_localize("UTC")

        return ts.tz_convert(JST).strftime("%Y-%m-%d %H:%M:%S JST")
    except Exception:
        return str(value)


def format_time_range_jst(start_value, end_value) -> str:
    """
    JSTの期間表示。
    """
    return f"{format_jst_timestamp(start_value)} 〜 {format_jst_timestamp(end_value)}"


def long_data_to_price_history(long_df: pd.DataFrame) -> pd.DataFrame:
    """
    長期分析用ローソク足CSVを、グラフ用の価格履歴形式に変換する。
    close を price_jpy として使う。
    """
    long_df = normalize_long_data_dataframe(long_df)

    if long_df.empty:
        return empty_history_df()

    result = pd.DataFrame({
        "timestamp": long_df["timestamp"].astype(str),
        "timestamp_dt": long_df["timestamp_dt"],
        "symbol": long_df["symbol"].astype(str),
        "price_jpy": pd.to_numeric(long_df["close"], errors="coerce"),
    })

    return normalize_history_dataframe(result)


def build_chart_history_dataframe(
    local_history_df: pd.DataFrame,
    current_snapshot_df: pd.DataFrame,
    chart_source: str,
    selected_long_file,
):
    """
    グラフ表示用の履歴を作る。

    - ローカル保存のみ
    - DLデータのみ
    - DLデータ＋ローカル補完

    DLデータ＋ローカル補完では、
    DLデータの最終時刻より後のローカル保存データだけを追加する。
    """
    local_df = normalize_history_dataframe(local_history_df)

    if current_snapshot_df is not None and not current_snapshot_df.empty:
        local_df = pd.concat([local_df, current_snapshot_df], ignore_index=True)
        local_df = normalize_history_dataframe(local_df)

    chart_source = str(chart_source)

    # DLデータを使う設定なのにCSVが未選択の場合は、最新CSVを自動採用する。
    # これにより、DLボタンを押した直後の同じ画面更新でも反映されやすくする。
    if selected_long_file is None and chart_source != "ローカル保存のみ":
        selected_long_file = latest_long_data_file()

    long_price_df = empty_history_df()

    if selected_long_file is not None and Path(selected_long_file).exists():
        long_raw_df = read_long_data_csv(Path(selected_long_file))
        long_price_df = long_data_to_price_history(long_raw_df)

    source_info = {
        "chart_source": chart_source,
        "long_file": str(selected_long_file) if selected_long_file is not None else "",
        "long_rows": int(len(long_price_df)) if long_price_df is not None else 0,
        "local_rows": int(len(local_df)) if local_df is not None else 0,
        "combined_rows": 0,
        "long_range": "",
        "local補完_range": "",
        "message": "",
    }

    if chart_source == "ローカル保存のみ":
        combined = local_df
        source_info["message"] = "グラフはローカル保存データのみで表示しています。"

    elif chart_source == "DLデータのみ":
        combined = long_price_df
        source_info["message"] = "グラフはDL済みCSVのみで表示しています。"

    else:
        # DLデータ＋ローカル補完
        if long_price_df.empty:
            combined = local_df
            source_info["message"] = "DLデータがないため、ローカル保存データのみで表示しています。"
        elif local_df.empty:
            combined = long_price_df
            source_info["message"] = "ローカル保存データがないため、DLデータのみで表示しています。"
        else:
            parts = [long_price_df]
            local_patch_parts = []

            for symbol in SYMBOLS:
                long_symbol = long_price_df[long_price_df["symbol"] == symbol].copy()
                local_symbol = local_df[local_df["symbol"] == symbol].copy()

                if local_symbol.empty:
                    continue

                if long_symbol.empty:
                    local_patch_parts.append(local_symbol)
                    continue

                latest_long_ts = long_symbol["timestamp_dt"].max()
                local_after = local_symbol[local_symbol["timestamp_dt"] > latest_long_ts].copy()

                if not local_after.empty:
                    local_patch_parts.append(local_after)

            if local_patch_parts:
                parts.extend(local_patch_parts)

            combined = pd.concat(parts, ignore_index=True)
            source_info["message"] = "グラフはDLデータに、DL最終時刻より後のローカル保存データを補完して表示しています。"

    combined = normalize_history_dataframe(combined)
    combined = combined.sort_values("timestamp_dt")

    source_info["combined_rows"] = int(len(combined))

    if not long_price_df.empty:
        source_info["long_range"] = format_time_range_jst(long_price_df["timestamp_dt"].min(), long_price_df["timestamp_dt"].max())

    if not local_df.empty:
        if chart_source == "DLデータ＋ローカル補完" and not long_price_df.empty:
            patch_check_parts = []

            for symbol in SYMBOLS:
                long_symbol = long_price_df[long_price_df["symbol"] == symbol]
                local_symbol = local_df[local_df["symbol"] == symbol]

                if local_symbol.empty:
                    continue

                if long_symbol.empty:
                    patch_check_parts.append(local_symbol)
                else:
                    patch_part = local_symbol[local_symbol["timestamp_dt"] > long_symbol["timestamp_dt"].max()]
                    if not patch_part.empty:
                        patch_check_parts.append(patch_part)

            if patch_check_parts:
                patch_df = pd.concat(patch_check_parts, ignore_index=True)
                source_info["local補完_range"] = format_time_range_jst(patch_df["timestamp_dt"].min(), patch_df["timestamp_dt"].max())
            else:
                source_info["local補完_range"] = "補完なし"
        else:
            source_info["local補完_range"] = format_time_range_jst(local_df["timestamp_dt"].min(), local_df["timestamp_dt"].max())

    return combined, source_info



def merge_and_write_long_data_daily(
    download_date,
    new_df: pd.DataFrame,
    interval: str = "1m",
    include_legacy: bool = True,
):
    """
    既存の日付単位CSV・旧形式CSV・新規取得分を結合し、重複なしで保存する。
    """
    LONG_DATA_DIR.mkdir(parents=True, exist_ok=True)
    output_file = get_long_data_daily_file(download_date, interval)

    frames = []
    existing_df = read_existing_long_data_for_date(download_date, interval, include_legacy=include_legacy)
    if not existing_df.empty:
        frames.append(existing_df)

    normalized_new = normalize_long_data_dataframe(new_df)
    if not normalized_new.empty:
        frames.append(normalized_new)

    if frames:
        combined = normalize_long_data_dataframe(pd.concat(frames, ignore_index=True))
        combined = combined.sort_values(["symbol", "timestamp_dt"])
        write_long_data_csv(combined, output_file)
        combined = read_long_data_csv(output_file)
    else:
        combined = pd.DataFrame()

    return combined, output_file


def count_existing_rows_in_range(existing_df: pd.DataFrame, symbol: str, interval: str, start_jst: pd.Timestamp, end_jst: pd.Timestamp) -> int:
    existing_df = normalize_long_data_dataframe(existing_df)
    if existing_df.empty:
        return 0

    start_utc = pd.Timestamp(start_jst).tz_convert("UTC")
    end_utc = pd.Timestamp(end_jst).tz_convert("UTC")

    subset = existing_df[
        (existing_df["symbol"] == symbol)
        & (existing_df["interval"] == interval)
        & (existing_df["timestamp_dt"] >= start_utc)
        & (existing_df["timestamp_dt"] < end_utc)
    ]
    return int(len(subset))


def expected_1m_rows(start_jst: pd.Timestamp, end_jst: pd.Timestamp) -> int:
    if end_jst <= start_jst:
        return 0
    return int((end_jst - start_jst).total_seconds() // 60)


def download_klines_range_to_daily_csv(
    download_date,
    start_time_text: str,
    end_time_text: str,
    symbols,
    interval: str = "1m",
    skip_existing: bool = True,
):
    """
    指定した日付・時間帯のローソク足を取得して、日付単位CSVへ追加保存する。

    例:
    - 2026-05-25 / 12:00〜13:00
    - 2026-05-24 / 00:00〜24:00
    """
    LONG_DATA_DIR.mkdir(parents=True, exist_ok=True)

    start_jst = parse_time_text_for_date(download_date, start_time_text)
    end_jst = parse_time_text_for_date(download_date, end_time_text)

    if end_jst <= start_jst:
        # 23:00〜01:00 のような日またぎにも対応する。
        end_jst = end_jst + pd.Timedelta(days=1)

    output_file = get_long_data_daily_file(download_date, interval)
    existing_df = read_existing_long_data_for_date(download_date, interval, include_legacy=True)

    frames = []
    errors = []
    skipped_symbols = []
    downloaded_symbols = []

    expected_rows = expected_1m_rows(start_jst, end_jst) if interval == "1m" else 0
    min_required = max(1, int(expected_rows * 0.95)) if expected_rows > 0 else 1

    for symbol in symbols:
        if skip_existing and not existing_df.empty:
            existing_count = count_existing_rows_in_range(existing_df, symbol, interval, start_jst, end_jst)
            if expected_rows > 0 and existing_count >= min_required:
                skipped_symbols.append(symbol)
                continue

        try:
            df = fetch_binance_klines_range_chunked(
                symbol=symbol,
                interval=interval,
                start_jst=start_jst,
                end_jst=end_jst,
            )
            if df is not None and not df.empty:
                frames.append(df)
                downloaded_symbols.append(symbol)
        except Exception as e:
            errors.append(f"{symbol}: {e}")

        # 公開APIに優しくするため、通貨ごとに少し間を空ける。
        time.sleep(0.30)

    if frames:
        new_df = normalize_long_data_dataframe(pd.concat(frames, ignore_index=True))
    else:
        new_df = pd.DataFrame()

    combined, output_file = merge_and_write_long_data_daily(
        download_date=download_date,
        new_df=new_df,
        interval=interval,
        include_legacy=True,
    )

    status = {
        "mode": "range",
        "requested_range": f"{start_jst.strftime('%Y-%m-%d %H:%M')}〜{end_jst.strftime('%Y-%m-%d %H:%M')} JST",
        "expected_rows_per_symbol": expected_rows,
        "min_required_rows_per_symbol": min_required,
        "skipped_symbols": skipped_symbols,
        "downloaded_symbols": downloaded_symbols,
        "existing_file": output_file.exists(),
        "skip_existing": bool(skip_existing),
        "output_file_type": "daily",
        "legacy_files_merged": [p.name for p in get_legacy_long_data_files_for_date(download_date, interval)],
    }

    return combined, output_file, errors, start_jst, end_jst, status


def download_klines_full_day_to_daily_csv(
    download_date,
    symbols,
    interval: str = "1m",
    skip_existing: bool = True,
):
    """
    指定日の丸一日分、0:00〜24:00（JST）を取得する。
    """
    return download_klines_range_to_daily_csv(
        download_date=download_date,
        start_time_text="00:00",
        end_time_text="24:00",
        symbols=symbols,
        interval=interval,
        skip_existing=skip_existing,
    )


def download_klines_until_noon(
    download_date,
    symbols,
    interval: str = "1m",
    skip_existing: bool = True,
):
    """
    互換用: 指定日の0:00〜12:00（JST）までを、日付単位CSVへ追加保存する。
    """
    return download_klines_range_to_daily_csv(
        download_date=download_date,
        start_time_text="00:00",
        end_time_text="12:00",
        symbols=symbols,
        interval=interval,
        skip_existing=skip_existing,
    )


# =========================
# 履歴
# =========================

def empty_history_df() -> pd.DataFrame:
    return pd.DataFrame(columns=["timestamp", "timestamp_dt", "symbol", "price_jpy"])


def read_raw_history_csv() -> pd.DataFrame:
    with HISTORY_IO_LOCK:
        if not HISTORY_FILE.exists():
            return pd.DataFrame()

        for enc in ["utf-8-sig", "utf-8"]:
            try:
                return pd.read_csv(HISTORY_FILE, dtype=str, encoding=enc)
            except Exception:
                pass

    return pd.DataFrame()


def normalize_history_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    """
    履歴CSVを timestamp, timestamp_dt, symbol, price_jpy の形に寄せる。

    対応:
    - 新形式: timestamp,symbol,price_jpy
    - 旧形式: timestamp,BTCJPY,ETHJPY
    """
    if df is None or df.empty:
        return empty_history_df()

    df = df.copy()
    df.columns = [str(c).strip().replace("\ufeff", "") for c in df.columns]

    if "timestamp" not in df.columns and "timestamp_dt" in df.columns:
        df["timestamp"] = df["timestamp_dt"].astype(str)

    if "price_jpy" not in df.columns:
        for candidate in ["price", "価格", "current_price", "last_price"]:
            if candidate in df.columns:
                df["price_jpy"] = df[candidate]
                break

    if "symbol" not in df.columns or "price_jpy" not in df.columns:
        if "timestamp" in df.columns:
            value_cols = [c for c in df.columns if c in SYMBOLS]
            if value_cols:
                df = df.melt(
                    id_vars=["timestamp"],
                    value_vars=value_cols,
                    var_name="symbol",
                    value_name="price_jpy",
                )
            else:
                return empty_history_df()
        else:
            return empty_history_df()

    required = {"timestamp", "symbol", "price_jpy"}
    if not required.issubset(set(df.columns)):
        return empty_history_df()

    df = df[["timestamp", "symbol", "price_jpy"]].copy()
    df["timestamp"] = df["timestamp"].astype(str).str.strip()
    df["symbol"] = df["symbol"].astype(str).str.strip()
    df["price_jpy"] = pd.to_numeric(df["price_jpy"], errors="coerce")
    df["timestamp_dt"] = pd.to_datetime(df["timestamp"], errors="coerce", utc=True)

    df = df.dropna(subset=["timestamp_dt", "symbol", "price_jpy"])
    df = df[df["symbol"].isin(SYMBOLS)]
    df = df[df["price_jpy"] > 0]

    if df.empty:
        return empty_history_df()

    df = df.sort_values("timestamp_dt")
    df = df.drop_duplicates(subset=["timestamp", "symbol"], keep="last")

    return df[["timestamp", "timestamp_dt", "symbol", "price_jpy"]]


def load_history() -> pd.DataFrame:
    return normalize_history_dataframe(read_raw_history_csv())


def write_history(history_df: pd.DataFrame):
    normalized = normalize_history_dataframe(history_df)
    with HISTORY_IO_LOCK:
        HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
        temp_file = HISTORY_FILE.with_suffix(".tmp")
        normalized[HISTORY_COLUMNS].to_csv(
            temp_file,
            mode="w",
            header=True,
            index=False,
            encoding="utf-8",
        )
        temp_file.replace(HISTORY_FILE)


def append_history(snapshot_df: pd.DataFrame):
    if snapshot_df is None or snapshot_df.empty:
        return False, "現在価格データが空です。", 0, 0

    try:
        with HISTORY_IO_LOCK:
            existing = load_history()
            before_count = len(existing)

            snap = snapshot_df[["timestamp", "symbol", "price_jpy"]].copy()
            snap["timestamp_dt"] = pd.to_datetime(snap["timestamp"], errors="coerce", utc=True)

            combined = pd.concat([existing, snap], ignore_index=True)
            combined = normalize_history_dataframe(combined)

            write_history(combined)

            after_count = len(load_history())

        return True, None, before_count, after_count

    except Exception as e:
        return False, str(e), 0, 0


def latest_snapshot_from_history(history_df: pd.DataFrame) -> pd.DataFrame:
    """
    最後に保存された価格を現在表示用として使う。
    v0.4.2.3-candidate-8 では、画面自動リロードをやめるため、
    表示側は基本的にCSVの最新保存値を読む。
    """
    history_df = normalize_history_dataframe(history_df)

    if history_df.empty:
        return pd.DataFrame(columns=["timestamp", "timestamp_dt", "symbol", "price_jpy"])

    rows = []

    for symbol in SYMBOLS:
        symbol_df = history_df[history_df["symbol"] == symbol].copy()
        symbol_df = symbol_df.sort_values("timestamp_dt")

        if symbol_df.empty:
            continue

        last = symbol_df.iloc[-1]
        rows.append({
            "timestamp": last["timestamp"],
            "timestamp_dt": last["timestamp_dt"],
            "symbol": symbol,
            "price_jpy": float(last["price_jpy"]),
        })

    return pd.DataFrame(rows)


def history_without_current_snapshot(history_df: pd.DataFrame, current_df: pd.DataFrame) -> pd.DataFrame:
    """
    CSVの最新保存値を「現在価格」として表示する場合、
    その同じ行を履歴側に残したまま前回比を計算すると差分が0になりやすい。
    そのため、current_df と同じ timestamp/symbol の行だけ履歴側から外して、
    直前の保存値との差を見られるようにする。
    """
    history_df = normalize_history_dataframe(history_df)
    current_df = normalize_history_dataframe(current_df)

    if history_df.empty or current_df.empty:
        return history_df

    result = history_df.copy()

    for _, row in current_df.iterrows():
        symbol = str(row.get("symbol", ""))
        ts = row.get("timestamp_dt")
        if not symbol or pd.isna(ts):
            continue
        result = result[~((result["symbol"] == symbol) & (result["timestamp_dt"] == ts))]

    return normalize_history_dataframe(result)


# =========================
# バックグラウンド価格保存
# =========================

def load_price_collector_status() -> dict:
    default_data = {
        "status": "idle",
        "message": "価格保存係はまだ状態を記録していません。",
        "started_at": "",
        "updated_at": "",
        "last_saved_at": "",
        "last_error": "",
        "save_interval_sec": 0,
        "remaining_sec": 0,
        "history_rows": 0,
        "version": APP_VERSION,
    }

    if not COLLECTOR_STATUS_FILE.exists():
        return default_data

    try:
        with COLLECTOR_STATUS_FILE.open("r", encoding="utf-8") as f:
            loaded = json.load(f)
        if isinstance(loaded, dict):
            default_data.update(loaded)
    except Exception:
        pass

    return default_data


def save_price_collector_status(**kwargs):
    data = load_price_collector_status()
    data.update(kwargs)
    data["updated_at"] = datetime.now(JST).isoformat(timespec="seconds")
    data["version"] = APP_VERSION

    try:
        COLLECTOR_STATUS_FILE.parent.mkdir(parents=True, exist_ok=True)
        temp_file = COLLECTOR_STATUS_FILE.with_suffix(".tmp")
        with temp_file.open("w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        temp_file.replace(COLLECTOR_STATUS_FILE)
    except Exception:
        pass


def should_save_now(history_df: pd.DataFrame, save_interval_sec: int) -> tuple:
    history_df = normalize_history_dataframe(history_df)
    if history_df.empty:
        return True, 0, None

    last_saved_at = history_df["timestamp_dt"].max()
    now_utc = pd.Timestamp.now(tz="UTC")
    elapsed = (now_utc - last_saved_at).total_seconds()
    remaining = max(0, int(save_interval_sec - elapsed))
    return elapsed >= int(save_interval_sec), remaining, last_saved_at


def price_collector_loop(stop_event: threading.Event):
    """
    Streamlit画面をリロードせず、同じapp.pyプロセス内で価格取得とCSV保存を続ける。
    画面側は保存済みCSVを読むだけにする。
    """
    started_at = datetime.now(JST).isoformat(timespec="seconds")
    save_price_collector_status(
        status="starting",
        message="価格保存係を起動しています。",
        started_at=started_at,
        last_error="",
    )

    while not stop_event.is_set():
        wait_sec = 2

        try:
            settings = load_settings()
            auto_save_enabled = bool(settings.get("auto_save", True))
            monitor_paused_enabled = bool(settings.get("monitor_paused", False))
            save_interval = max(10, int(settings.get("save_interval_sec", 60)))

            if monitor_paused_enabled:
                save_price_collector_status(
                    status="paused",
                    message="短期監視が停止中のため、裏側保存も停止しています。",
                    save_interval_sec=save_interval,
                    remaining_sec=0,
                    last_error="",
                )
                wait_sec = 2
                stop_event.wait(wait_sec)
                continue

            if not auto_save_enabled:
                save_price_collector_status(
                    status="disabled",
                    message="自動保存がOFFのため、裏側保存は待機しています。",
                    save_interval_sec=save_interval,
                    remaining_sec=0,
                    last_error="",
                )
                wait_sec = 2
                stop_event.wait(wait_sec)
                continue

            history_df = load_history()
            due, remaining, last_saved_at = should_save_now(history_df, save_interval)

            if not due:
                save_price_collector_status(
                    status="waiting",
                    message="次の保存時刻を待っています。",
                    save_interval_sec=save_interval,
                    remaining_sec=remaining,
                    history_rows=int(len(history_df)),
                    last_saved_at=format_jst_timestamp(last_saved_at),
                    last_error="",
                )
                wait_sec = max(1, min(5, int(remaining) if remaining else 1))
                stop_event.wait(wait_sec)
                continue

            snapshot_df, errors = fetch_all_prices(SYMBOLS)

            if errors or snapshot_df is None or snapshot_df.empty:
                message = " / ".join(errors) if errors else "価格取得結果が空です。"
                save_price_collector_status(
                    status="error",
                    message="裏側保存で価格取得に失敗しました。",
                    save_interval_sec=save_interval,
                    remaining_sec=save_interval,
                    history_rows=int(len(history_df)),
                    last_saved_at=format_jst_timestamp(last_saved_at),
                    last_error=message,
                )
                wait_sec = min(15, save_interval)
                stop_event.wait(wait_sec)
                continue

            did_save, save_error, before_count, after_count = append_history(snapshot_df)

            if did_save:
                latest_ts = snapshot_df["timestamp_dt"].max() if "timestamp_dt" in snapshot_df.columns else None
                save_price_collector_status(
                    status="saved",
                    message=f"裏側で価格を保存しました。{before_count:,}行 → {after_count:,}行",
                    save_interval_sec=save_interval,
                    remaining_sec=save_interval,
                    history_rows=int(after_count),
                    last_saved_at=format_jst_timestamp(latest_ts),
                    last_error="",
                )
            else:
                save_price_collector_status(
                    status="error",
                    message="裏側保存に失敗しました。",
                    save_interval_sec=save_interval,
                    remaining_sec=save_interval,
                    history_rows=int(len(history_df)),
                    last_saved_at=format_jst_timestamp(last_saved_at),
                    last_error=str(save_error),
                )

            wait_sec = max(1, min(5, save_interval))

        except Exception as e:
            save_price_collector_status(
                status="error",
                message="価格保存係で予期しないエラーが起きました。",
                last_error=str(e),
            )
            wait_sec = 5

        stop_event.wait(wait_sec)


@st.cache_resource(show_spinner=False)
def get_background_price_collector():
    """
    Streamlitの再実行や複数タブで、保存係スレッドを重複起動しにくくする。
    """
    stop_event = threading.Event()
    thread = threading.Thread(
        target=price_collector_loop,
        args=(stop_event,),
        daemon=True,
        name="binance-local-watcher-price-collector",
    )
    thread.start()
    return {
        "thread": thread,
        "stop_event": stop_event,
        "started_at": datetime.now(JST).isoformat(timespec="seconds"),
    }


# =========================
# 判定
# =========================

def movement_size_label(abs_pct, small_threshold, medium_threshold, large_threshold) -> str:
    if pd.isna(abs_pct):
        return "履歴不足"
    if abs_pct < small_threshold:
        return "微小"
    if abs_pct < medium_threshold:
        return "小"
    if abs_pct < large_threshold:
        return "中"
    return "大"


def trend_label(pct, flat_threshold) -> str:
    if pd.isna(pct):
        return "履歴不足"
    if abs(pct) < flat_threshold:
        return "横ばい"
    if pct > 0:
        return "短期上昇"
    return "短期下落"


def impact_label(value_yen) -> str:
    if pd.isna(value_yen):
        return "履歴不足"

    abs_yen = abs(float(value_yen))

    if abs_yen < 10:
        return "ごく小さい"
    if abs_yen < 100:
        return "小さい"
    if abs_yen < 1000:
        return "中くらい"
    return "大きい"


def parse_amounts(text: str):
    normalized = (
        str(text)
        .replace("、", ",")
        .replace("，", ",")
        .replace("円", "")
        .replace(" ", "")
    )

    amounts = []

    for part in normalized.split(","):
        if not part:
            continue
        try:
            value = float(part)
            if value > 0:
                amounts.append(value)
        except ValueError:
            pass

    return amounts if amounts else [1000, 10000, 100000]


IMPACT_AMOUNT_PRESETS = {
    "少額": "1000,3000,5000",
    "標準": "10000,30000,50000",
    "比較": "1000,10000,100000",
    "大きめ": "50000,100000,300000",
    "カスタム": None,
}


def get_impact_amount_text(preset_label: str, custom_text: str) -> str:
    """
    数量別影響タブの金額設定を、プリセットまたはカスタムから決める。
    ここは計算前にも使うため、UI表示とは分けておく。
    """
    preset_label = str(preset_label or "比較")
    if preset_label not in IMPACT_AMOUNT_PRESETS:
        preset_label = "比較"

    preset_text = IMPACT_AMOUNT_PRESETS.get(preset_label)
    if preset_text is None:
        return str(custom_text or "1000,10000,100000")
    return str(preset_text)


def normalize_focus_amount(value, fallback: int = 10000) -> int:
    try:
        value = int(float(value))
    except Exception:
        value = int(fallback)
    return max(100, min(100000000, value))


def compute_metrics(
    history_df: pd.DataFrame,
    current_df: pd.DataFrame,
    trend_points: int,
    flat_threshold_pct: float,
    small_threshold_pct: float,
    medium_threshold_pct: float,
    large_threshold_pct: float,
):
    rows = []

    for _, current in current_df.iterrows():
        symbol = current["symbol"]
        current_price = float(current["price_jpy"])

        hist = history_df[history_df["symbol"] == symbol].sort_values("timestamp_dt")

        if hist.empty:
            prev_price = pd.NA
            prev_diff = pd.NA
            prev_pct = pd.NA
        else:
            prev_price = float(hist.iloc[-1]["price_jpy"])
            prev_diff = current_price - prev_price
            prev_pct = (prev_diff / prev_price) * 100 if prev_price else pd.NA

        combined = pd.concat([hist, pd.DataFrame([current])], ignore_index=True)
        combined = combined.sort_values("timestamp_dt")
        recent = combined.tail(int(trend_points))

        if len(recent) < 2:
            trend_base_price = pd.NA
            trend_diff = pd.NA
            trend_pct = pd.NA
        else:
            trend_base_price = float(recent.iloc[0]["price_jpy"])
            trend_diff = current_price - trend_base_price
            trend_pct = (trend_diff / trend_base_price) * 100 if trend_base_price else pd.NA

        prev_abs_pct = abs(prev_pct) if pd.notna(prev_pct) else pd.NA
        trend_abs_pct = abs(trend_pct) if pd.notna(trend_pct) else pd.NA

        rows.append({
            "通貨": symbol,
            "現在価格": current_price,
            "前回価格": prev_price,
            "前回比(円)": prev_diff,
            "前回比(%)": prev_pct,
            "前回比の大きさ": movement_size_label(prev_abs_pct, small_threshold_pct, medium_threshold_pct, large_threshold_pct),
            "短期基準価格": trend_base_price,
            "短期変化(円)": trend_diff,
            "短期変化(%)": trend_pct,
            "短期傾向": trend_label(trend_pct, flat_threshold_pct),
            "短期変化の大きさ": movement_size_label(trend_abs_pct, small_threshold_pct, medium_threshold_pct, large_threshold_pct),
        })

    return pd.DataFrame(rows)


def compute_impact_table(metrics_df: pd.DataFrame, amounts):
    rows = []

    for _, row in metrics_df.iterrows():
        symbol = row["通貨"]
        current_price = pd.to_numeric(row["現在価格"], errors="coerce")

        for amount in amounts:
            amount = float(amount)
            quantity = pd.NA if pd.isna(current_price) or current_price == 0 else amount / float(current_price)

            prev_diff = pd.to_numeric(row["前回比(円)"], errors="coerce")
            trend_diff = pd.to_numeric(row["短期変化(円)"], errors="coerce")

            prev_impact = pd.NA
            trend_impact = pd.NA

            if pd.notna(quantity) and pd.notna(prev_diff):
                prev_impact = float(quantity) * float(prev_diff)
            if pd.notna(quantity) and pd.notna(trend_diff):
                trend_impact = float(quantity) * float(trend_diff)

            rows.append({
                "通貨": symbol,
                "想定額(JPY)": amount,
                "現在価格": current_price,
                "概算数量": quantity,
                "前回比の影響額(円)": prev_impact,
                "前回比影響": impact_label(prev_impact),
                "短期変化の影響額(円)": trend_impact,
                "短期影響": impact_label(trend_impact),
            })

    return pd.DataFrame(rows)


# =========================
# v0.5 取引シミュレーター計算
# =========================

TRADE_EXIT_MODE_RATE = "変動率で指定"
TRADE_EXIT_MODE_PRICE = "売却価格で指定"

TRADE_FEE_MODE_QUOTE_PREPAID = "概算: JPYから手数料を先引き"
TRADE_FEE_MODE_BASE_DEDUCT = "Binance寄せ: 買いはコイン控除 / 売りはJPY控除"
TRADE_FEE_MODE_BNB = "BNB別払いとして概算"
TRADE_FEE_MODE_OPTIONS = [
    TRADE_FEE_MODE_BASE_DEDUCT,
    TRADE_FEE_MODE_QUOTE_PREPAID,
    TRADE_FEE_MODE_BNB,
]


def _to_float_or_na(value):
    num = pd.to_numeric(value, errors="coerce")
    if pd.isna(num):
        return pd.NA
    return float(num)


def clamp_rate_pct(value, minimum: float = 0.0, maximum: float = 100.0) -> float:
    """
    %入力を安全な範囲に丸める。
    手数料・スプレッド・スリッページは設定値であり、実取引APIには使わない。
    """
    num = _to_float_or_na(value)
    if pd.isna(num):
        return float(minimum)
    return max(float(minimum), min(float(maximum), float(num)))


def _rate_from_commission_dict(data: dict, section: str, keys: list) -> float:
    """
    account/commission の standardCommission / taxCommission / specialCommission から、
    taker+buyer や taker+seller のような合算rateを小数で返す。
    """
    if not isinstance(data, dict):
        return 0.0

    section_data = data.get(section, {}) or {}
    if not isinstance(section_data, dict):
        return 0.0

    total = 0.0
    for key in keys:
        value = _to_float_or_na(section_data.get(key, 0))
        if pd.notna(value):
            total += float(value)
    return max(0.0, total)


def _commission_discount_info(data: dict) -> dict:
    """
    BNB手数料割引の状態を読む。
    discount は standardCommission にだけ適用し、tax/special には適用しない前提で扱う。
    """
    discount = data.get("discount", {}) if isinstance(data, dict) else {}
    if not isinstance(discount, dict):
        discount = {}

    enabled_account = bool(discount.get("enabledForAccount", False))
    enabled_symbol = bool(discount.get("enabledForSymbol", False))
    discount_asset = str(discount.get("discountAsset", "") or "")
    discount_rate = _to_float_or_na(discount.get("discount", 0))
    if pd.isna(discount_rate):
        discount_rate = 0.0

    return {
        "enabled": bool(enabled_account and enabled_symbol),
        "enabled_for_account": enabled_account,
        "enabled_for_symbol": enabled_symbol,
        "asset": discount_asset,
        "rate": max(0.0, min(1.0, float(discount_rate))),
    }


def build_trade_commission_profile(
    commissions: dict,
    symbol: str,
    fallback_taker_fee_pct: float,
    fee_mode: str,
) -> dict:
    """
    取引シミュレーター用の手数料プロファイルを作る。

    実commissionがある場合:
    - BUY は taker + buyer を使う
    - SELL は taker + seller を使う
    - standard / tax / special を分けて合算する
    - BNB別払い時だけ standard にBNB割引を反映する

    実commissionがない場合:
    - 手入力の taker fee をBUY/SELL共通の概算rateとして使う
    """
    fallback_rate = clamp_rate_pct(fallback_taker_fee_pct, 0.0, 20.0) / 100.0
    empty = {
        "source": "手入力taker fee",
        "detailed": False,
        "discount_applied": False,
        "discount_asset": "",
        "discount_rate": 0.0,
        "buy_standard_rate": fallback_rate,
        "buy_tax_rate": 0.0,
        "buy_special_rate": 0.0,
        "buy_total_rate": fallback_rate,
        "sell_standard_rate": fallback_rate,
        "sell_tax_rate": 0.0,
        "sell_special_rate": 0.0,
        "sell_total_rate": fallback_rate,
        "memo": "実commission未使用。BUY/SELLとも手入力taker feeで概算しています。",
    }

    if not isinstance(commissions, dict):
        return empty

    data = commissions.get(symbol, {})
    if not isinstance(data, dict) or data.get("_error"):
        return empty

    discount = _commission_discount_info(data)
    apply_bnb_discount = bool(fee_mode == TRADE_FEE_MODE_BNB and discount["enabled"])
    standard_multiplier = 1.0 - discount["rate"] if apply_bnb_discount else 1.0

    buy_keys = ["taker", "buyer"]
    sell_keys = ["taker", "seller"]

    buy_standard = _rate_from_commission_dict(data, "standardCommission", buy_keys) * standard_multiplier
    buy_tax = _rate_from_commission_dict(data, "taxCommission", buy_keys)
    buy_special = _rate_from_commission_dict(data, "specialCommission", buy_keys)

    sell_standard = _rate_from_commission_dict(data, "standardCommission", sell_keys) * standard_multiplier
    sell_tax = _rate_from_commission_dict(data, "taxCommission", sell_keys)
    sell_special = _rate_from_commission_dict(data, "specialCommission", sell_keys)

    # まれにレスポンスの該当項目が全部0/欠落する場合は、手入力値へ逃がす。
    if (buy_standard + buy_tax + buy_special + sell_standard + sell_tax + sell_special) <= 0:
        return empty

    if apply_bnb_discount:
        memo = f"実commission使用。BNB払い想定のためstandard部分に {discount['rate'] * 100:.2f}% 割引を反映。tax/specialは割引なし。"
    else:
        memo = "実commission使用。BUY=taker+buyer、SELL=taker+sellerで計算。BNB割引は未適用。"

    return {
        "source": "account/commission",
        "detailed": True,
        "discount_applied": apply_bnb_discount,
        "discount_asset": discount["asset"],
        "discount_rate": discount["rate"],
        "buy_standard_rate": buy_standard,
        "buy_tax_rate": buy_tax,
        "buy_special_rate": buy_special,
        "buy_total_rate": buy_standard + buy_tax + buy_special,
        "sell_standard_rate": sell_standard,
        "sell_tax_rate": sell_tax,
        "sell_special_rate": sell_special,
        "sell_total_rate": sell_standard + sell_tax + sell_special,
        "memo": memo,
    }


def rate_decimal_to_pct(rate) -> float:
    value = _to_float_or_na(rate)
    if pd.isna(value):
        return pd.NA
    return float(value) * 100.0


def determine_trade_accuracy_label(commission_profile: dict, rule_status: str, use_order_book_buy: bool, board_filled_ratio) -> tuple:
    """
    NET P/Lの近似度をA〜Dで返す。
    Aでも実注文の約定を保証するものではなく、現在の入力条件に対する近似度。
    """
    detailed = bool((commission_profile or {}).get("detailed", False))
    rules_ok = str(rule_status) == "OK"
    board_ok = False
    if use_order_book_buy:
        ratio = _to_float_or_na(board_filled_ratio)
        board_ok = pd.notna(ratio) and float(ratio) >= 0.999

    if detailed and rules_ok and board_ok:
        return "A", "実commission・注文ルール・現在板を反映。売却側は未来板ではなく想定価格ベースです。"
    if detailed and rules_ok:
        return "B", "実commissionと注文ルールを反映。買い板または未来売り板は概算です。"
    if detailed:
        return "B-", "実commissionは反映。注文ルールまたは板情報は未確認/要確認です。"
    if rules_ok:
        return "C", "手入力手数料で概算。注文ルールは概算OKです。"
    return "D", "手入力手数料または注文ルール未確認の概算です。"


def _decimal_or_none(value):
    try:
        d = Decimal(str(value))
        if not d.is_finite():
            return None
        return d
    except (InvalidOperation, ValueError, TypeError):
        return None


def floor_to_step(value, step):
    """
    BinanceのstepSizeに合わせて数量を切り下げる。
    stepSizeが0または不明の場合は元の値を返す。
    """
    value_d = _decimal_or_none(value)
    step_d = _decimal_or_none(step)

    if value_d is None:
        return pd.NA
    if step_d is None or step_d <= 0:
        return float(value_d)

    units = (value_d / step_d).to_integral_value(rounding=ROUND_DOWN)
    rounded = units * step_d
    if rounded < 0:
        rounded = Decimal("0")
    return float(rounded)


def parse_binance_symbol_rules(symbol_info: dict) -> dict:
    """
    /api/v3/exchangeInfo のsymbol情報から、取引シミュレーター用の主要ルールを抜き出す。
    実注文には使わず、最小注文額・数量刻み・価格刻みの確認だけに使う。
    """
    result = {
        "status": "unknown",
        "base_asset": "",
        "quote_asset": "",
        "tick_size": pd.NA,
        "min_price": pd.NA,
        "max_price": pd.NA,
        "min_qty": pd.NA,
        "max_qty": pd.NA,
        "step_size": pd.NA,
        "market_min_qty": pd.NA,
        "market_max_qty": pd.NA,
        "market_step_size": pd.NA,
        "min_notional": pd.NA,
        "max_notional": pd.NA,
        "apply_min_to_market": pd.NA,
        "raw_error": "",
    }

    if not isinstance(symbol_info, dict):
        result["raw_error"] = "symbol情報を取得できませんでした。"
        return result

    result["status"] = str(symbol_info.get("status", "unknown"))
    result["base_asset"] = str(symbol_info.get("baseAsset", ""))
    result["quote_asset"] = str(symbol_info.get("quoteAsset", ""))

    filters = symbol_info.get("filters", [])
    if not isinstance(filters, list):
        return result

    by_type = {str(item.get("filterType", "")): item for item in filters if isinstance(item, dict)}

    price_filter = by_type.get("PRICE_FILTER", {})
    lot_filter = by_type.get("LOT_SIZE", {})
    market_lot_filter = by_type.get("MARKET_LOT_SIZE", {})
    min_notional_filter = by_type.get("MIN_NOTIONAL", {})
    notional_filter = by_type.get("NOTIONAL", {})

    for key, source_key in [("tick_size", "tickSize"), ("min_price", "minPrice"), ("max_price", "maxPrice")]:
        if source_key in price_filter:
            result[key] = _to_float_or_na(price_filter.get(source_key))

    for key, source_key in [("min_qty", "minQty"), ("max_qty", "maxQty"), ("step_size", "stepSize")]:
        if source_key in lot_filter:
            result[key] = _to_float_or_na(lot_filter.get(source_key))

    for key, source_key in [("market_min_qty", "minQty"), ("market_max_qty", "maxQty"), ("market_step_size", "stepSize")]:
        if source_key in market_lot_filter:
            result[key] = _to_float_or_na(market_lot_filter.get(source_key))

    if "minNotional" in min_notional_filter:
        result["min_notional"] = _to_float_or_na(min_notional_filter.get("minNotional"))
        result["apply_min_to_market"] = bool(min_notional_filter.get("applyToMarket", False))

    if "minNotional" in notional_filter:
        result["min_notional"] = _to_float_or_na(notional_filter.get("minNotional"))
        result["apply_min_to_market"] = bool(notional_filter.get("applyMinToMarket", False))
    if "maxNotional" in notional_filter:
        result["max_notional"] = _to_float_or_na(notional_filter.get("maxNotional"))

    return result


@st.cache_data(ttl=300, show_spinner=False)
def fetch_binance_symbol_info_cached(symbol: str) -> dict:
    """Binance公開APIから現在の取引ルールを取得する。APIキーは使わない。"""
    url = "https://api.binance.com/api/v3/exchangeInfo"
    response = requests.get(url, params={"symbol": symbol}, timeout=10)
    response.raise_for_status()
    data = response.json()
    symbol_items = data.get("symbols", [])
    if not symbol_items:
        raise ValueError(f"{symbol} のexchangeInfoが空です。")
    return symbol_items[0]


@st.cache_data(ttl=10, show_spinner=False)
def fetch_binance_order_book_cached(symbol: str, limit: int = 20) -> dict:
    """Binance公開APIから現在の板情報を取得する。APIキーは使わない。"""
    url = "https://api.binance.com/api/v3/depth"
    allowed_limits = [5, 10, 20, 50, 100, 500, 1000, 5000]
    try:
        limit = int(limit)
    except Exception:
        limit = 20
    if limit not in allowed_limits:
        limit = 20
    response = requests.get(url, params={"symbol": symbol, "limit": limit}, timeout=10)
    response.raise_for_status()
    return response.json()


@st.cache_data(ttl=30, show_spinner=False)
def fetch_optional_binance_price_cached(symbol: str):
    """
    補助用の公開価格取得。
    BNB手数料払いの残高チェックで BNBJPY が取れる場合だけ使う。
    APIキー・注文権限は使わない。
    """
    try:
        return float(fetch_binance_price(symbol)), ""
    except Exception as e:
        return pd.NA, str(e)


def simulate_market_buy_from_asks(asks, quote_amount_jpy) -> dict:
    """
    現在の板のasksを上から食べた場合の、成行買い平均価格を概算する。
    quoteOrderQtyに近い考え方で、投入JPYを板の売り注文に順番に当てる。
    """
    quote_d = _decimal_or_none(quote_amount_jpy)
    if quote_d is None or quote_d <= 0 or not isinstance(asks, list):
        return {
            "avg_price": pd.NA,
            "gross_base_qty": pd.NA,
            "quote_used": pd.NA,
            "levels_used": 0,
            "filled_ratio": pd.NA,
            "insufficient_depth": True,
        }

    remaining = quote_d
    base_qty = Decimal("0")
    quote_used = Decimal("0")
    levels_used = 0

    for level in asks:
        if remaining <= 0:
            break
        if not isinstance(level, (list, tuple)) or len(level) < 2:
            continue
        price = _decimal_or_none(level[0])
        qty = _decimal_or_none(level[1])
        if price is None or qty is None or price <= 0 or qty <= 0:
            continue

        level_quote = price * qty
        take_quote = min(remaining, level_quote)
        take_base = take_quote / price

        base_qty += take_base
        quote_used += take_quote
        remaining -= take_quote
        levels_used += 1

    avg_price = quote_used / base_qty if base_qty > 0 else None
    filled_ratio = quote_used / quote_d if quote_d > 0 else None

    return {
        "avg_price": float(avg_price) if avg_price is not None else pd.NA,
        "gross_base_qty": float(base_qty) if base_qty > 0 else pd.NA,
        "quote_used": float(quote_used),
        "levels_used": int(levels_used),
        "filled_ratio": float(filled_ratio) if filled_ratio is not None else pd.NA,
        "insufficient_depth": bool(remaining > Decimal("0")),
    }


def check_trade_against_binance_rules(quantity, notional_jpy, rules: dict) -> dict:
    """取引ルールに照らして、数量・注文額の概算チェックを返す。"""
    if not isinstance(rules, dict) or not rules:
        return {
            "rounded_quantity": pd.NA,
            "min_notional": pd.NA,
            "min_qty": pd.NA,
            "step_size": pd.NA,
            "rule_status": "未確認",
            "rule_message": "Binanceルール未取得",
        }

    step = rules.get("market_step_size", pd.NA)
    if pd.isna(step) or float(step or 0) <= 0:
        step = rules.get("step_size", pd.NA)

    min_qty = rules.get("market_min_qty", pd.NA)
    if pd.isna(min_qty) or float(min_qty or 0) <= 0:
        min_qty = rules.get("min_qty", pd.NA)

    rounded_quantity = floor_to_step(quantity, step) if pd.notna(quantity) else pd.NA
    min_notional = rules.get("min_notional", pd.NA)

    messages = []
    ok = True

    if str(rules.get("status", "")).upper() not in ["TRADING", "UNKNOWN", ""]:
        ok = False
        messages.append(f"取引状態: {rules.get('status')}")

    if pd.notna(min_qty) and pd.notna(rounded_quantity) and float(rounded_quantity) < float(min_qty):
        ok = False
        messages.append(f"数量が最小数量未満: minQty {min_qty}")

    if pd.notna(min_notional) and pd.notna(notional_jpy) and float(notional_jpy) < float(min_notional):
        ok = False
        messages.append(f"注文額が最小注文額未満: minNotional {min_notional}")

    if pd.isna(rounded_quantity) or float(rounded_quantity or 0) <= 0:
        ok = False
        messages.append("数量丸め後が0です")

    if not messages:
        messages.append("概算では主要ルール内")

    return {
        "rounded_quantity": rounded_quantity,
        "min_notional": min_notional,
        "min_qty": min_qty,
        "step_size": step,
        "rule_status": "OK" if ok else "要確認",
        "rule_message": " / ".join(messages),
    }


def calc_exit_price_from_mode(entry_price, exit_mode: str, exit_change_pct, direct_exit_price):
    """
    売却想定価格を決める。
    - 変動率で指定: 現在価格 × (1 + 変動率%)
    - 売却価格で指定: 直接入力した価格
    """
    entry_price = _to_float_or_na(entry_price)
    if pd.isna(entry_price) or entry_price <= 0:
        return pd.NA

    if exit_mode == TRADE_EXIT_MODE_PRICE:
        price = _to_float_or_na(direct_exit_price)
        if pd.isna(price) or price <= 0:
            return pd.NA
        return float(price)

    change_pct = _to_float_or_na(exit_change_pct)
    if pd.isna(change_pct):
        change_pct = 0.0

    return float(entry_price) * (1.0 + float(change_pct) / 100.0)


def calculate_market_order_simulation(
    symbol: str,
    entry_price,
    investment_jpy,
    exit_price,
    taker_fee_pct: float,
    spread_pct: float,
    slippage_pct: float,
    fee_mode: str = TRADE_FEE_MODE_BASE_DEDUCT,
    symbol_rules: dict = None,
    order_book: dict = None,
    use_order_book_buy: bool = False,
    commissions: dict = None,
) -> dict:
    """
    成行注文を想定した概算損益を計算する。

    v0.5-candidate-8:
    - 実commissionがある場合は、BUY=taker+buyer / SELL=taker+sellerで計算する。
    - standard / tax / special commissionを分け、BNB払い時はstandard部分だけ割引を反映する。
    - 買い後数量をstepSizeで売却可能数量に丸め、残りダストも評価する。
    - Net P/Lは「売却できる数量のJPY」と「残りダスト評価」を合わせた資産評価込みで見る。

    重要:
    - 実注文は行わない。
    - APIキーを使うのは、呼び出し元が取得済みcommissionを渡した場合だけ。
    - これは板スナップショット時点の概算であり、実際の約定とはズレる。
    """
    entry_price = _to_float_or_na(entry_price)
    investment_jpy = _to_float_or_na(investment_jpy)
    exit_price = _to_float_or_na(exit_price)

    taker_fee_pct = clamp_rate_pct(taker_fee_pct, 0.0, 20.0)
    spread_pct = clamp_rate_pct(spread_pct, 0.0, 20.0)
    slippage_pct = clamp_rate_pct(slippage_pct, 0.0, 20.0)
    if fee_mode not in TRADE_FEE_MODE_OPTIONS:
        fee_mode = TRADE_FEE_MODE_BASE_DEDUCT

    commission_profile = build_trade_commission_profile(
        commissions=commissions or {},
        symbol=symbol,
        fallback_taker_fee_pct=taker_fee_pct,
        fee_mode=fee_mode,
    )

    empty_result = {
        "通貨": symbol,
        "投入JPY": investment_jpy,
        "買い注文想定": "MARKET BUY / quoteOrderQty",
        "現在価格": entry_price,
        "想定売却価格": exit_price,
        "想定変動率(%)": pd.NA,
        "実質買い価格": pd.NA,
        "実質売り価格": pd.NA,
        "概算数量": pd.NA,
        "売却可能数量": pd.NA,
        "残りダスト数量": pd.NA,
        "残りダスト評価額": pd.NA,
        "板平均買い価格": pd.NA,
        "板使用段数": pd.NA,
        "板充足率": pd.NA,
        "Gross P/L": pd.NA,
        "Net P/L": pd.NA,
        "Net P/L(売却分のみ)": pd.NA,
        "買い手数料": pd.NA,
        "売り手数料": pd.NA,
        "買い手数料数量": pd.NA,
        "BNB手数料必要額(JPY)": pd.NA,
        "買い成行コスト": pd.NA,
        "売り成行コスト": pd.NA,
        "総コスト概算": pd.NA,
        "損益分岐価格": pd.NA,
        "損益分岐まで(%)": pd.NA,
        "BUY手数料率(%)": rate_decimal_to_pct(commission_profile.get("buy_total_rate", pd.NA)),
        "SELL手数料率(%)": rate_decimal_to_pct(commission_profile.get("sell_total_rate", pd.NA)),
        "BUY標準手数料率(%)": rate_decimal_to_pct(commission_profile.get("buy_standard_rate", pd.NA)),
        "BUY税手数料率(%)": rate_decimal_to_pct(commission_profile.get("buy_tax_rate", pd.NA)),
        "BUY特別手数料率(%)": rate_decimal_to_pct(commission_profile.get("buy_special_rate", pd.NA)),
        "SELL標準手数料率(%)": rate_decimal_to_pct(commission_profile.get("sell_standard_rate", pd.NA)),
        "SELL税手数料率(%)": rate_decimal_to_pct(commission_profile.get("sell_tax_rate", pd.NA)),
        "SELL特別手数料率(%)": rate_decimal_to_pct(commission_profile.get("sell_special_rate", pd.NA)),
        "手数料データ元": commission_profile.get("source", ""),
        "BNB割引反映": "あり" if commission_profile.get("discount_applied") else "なし",
        "精度ラベル": "D",
        "精度メモ": "計算不可",
        "ルール判定": "未確認",
        "ルールメッセージ": "",
        "丸め後数量": pd.NA,
        "最小注文額": pd.NA,
        "最小数量": pd.NA,
        "数量刻み": pd.NA,
        "手数料方式": fee_mode,
        "判定": "計算不可",
    }

    if (
        pd.isna(entry_price) or entry_price <= 0
        or pd.isna(investment_jpy) or investment_jpy <= 0
        or pd.isna(exit_price) or exit_price <= 0
    ):
        return empty_result

    buy_fee_rate = float(commission_profile.get("buy_total_rate", taker_fee_pct / 100.0))
    sell_fee_rate = float(commission_profile.get("sell_total_rate", taker_fee_pct / 100.0))
    market_cost_rate = (spread_pct + slippage_pct) / 100.0

    # 買い価格: 板情報がある場合はasksを実際に食べる概算。なければ従来のspread/slippage概算。
    buy_fill = None
    if use_order_book_buy and isinstance(order_book, dict) and isinstance(order_book.get("asks"), list):
        quote_for_book = float(investment_jpy)
        if fee_mode == TRADE_FEE_MODE_QUOTE_PREPAID:
            quote_for_book = max(0.0, float(investment_jpy) * (1.0 - buy_fee_rate))
        buy_fill = simulate_market_buy_from_asks(order_book.get("asks", []), quote_for_book)

    if buy_fill and pd.notna(buy_fill.get("avg_price", pd.NA)) and float(buy_fill.get("avg_price")) > 0:
        effective_buy_price = float(buy_fill["avg_price"])
        gross_base_qty = float(buy_fill["gross_base_qty"])
        board_avg_price = effective_buy_price
        board_levels_used = int(buy_fill.get("levels_used", 0))
        board_filled_ratio = buy_fill.get("filled_ratio", pd.NA)
        buy_market_cost = max(0.0, gross_base_qty * (effective_buy_price - float(entry_price)))
    else:
        effective_buy_price = float(entry_price) * (1.0 + market_cost_rate)
        quote_used_for_buy = float(investment_jpy)
        if fee_mode == TRADE_FEE_MODE_QUOTE_PREPAID:
            quote_used_for_buy = max(0.0, float(investment_jpy) * (1.0 - buy_fee_rate))
        gross_base_qty = quote_used_for_buy / effective_buy_price if effective_buy_price > 0 else pd.NA
        board_avg_price = pd.NA
        board_levels_used = pd.NA
        board_filled_ratio = pd.NA
        buy_market_cost = float(gross_base_qty) * (effective_buy_price - float(entry_price)) if pd.notna(gross_base_qty) else pd.NA

    buy_fee = 0.0
    buy_fee_base_qty = 0.0

    if fee_mode == TRADE_FEE_MODE_BASE_DEDUCT:
        # Binance寄せ: BUYの手数料は受け取るbase assetから差し引かれる想定。
        buy_fee_base_qty = float(gross_base_qty) * buy_fee_rate if pd.notna(gross_base_qty) else pd.NA
        quantity_after_buy_fee = max(0.0, float(gross_base_qty) - float(buy_fee_base_qty)) if pd.notna(gross_base_qty) else pd.NA
        buy_fee = float(buy_fee_base_qty) * effective_buy_price if pd.notna(buy_fee_base_qty) else pd.NA
    elif fee_mode == TRADE_FEE_MODE_BNB:
        # BNB別払い: BTC/ETH数量は減らさず、BNBで払う手数料をJPY換算で別計上。
        quantity_after_buy_fee = float(gross_base_qty) if pd.notna(gross_base_qty) else pd.NA
        buy_fee_base_qty = 0.0
        buy_fee = float(gross_base_qty) * buy_fee_rate * effective_buy_price if pd.notna(gross_base_qty) else pd.NA
    else:
        # 概算: JPYから手数料を先引き。数量は先引き後quoteで計算済み。
        buy_fee = float(investment_jpy) * buy_fee_rate
        quantity_after_buy_fee = float(gross_base_qty) if pd.notna(gross_base_qty) else pd.NA
        buy_fee_base_qty = 0.0

    # 注文ルールを使い、買い後数量を売却可能数量へ丸める。
    rule_check = check_trade_against_binance_rules(
        quantity=quantity_after_buy_fee,
        notional_jpy=float(investment_jpy),
        rules=symbol_rules or {},
    )

    rounded_quantity = rule_check.get("rounded_quantity", pd.NA)
    if pd.notna(rounded_quantity) and float(rounded_quantity) > 0:
        sellable_quantity = float(rounded_quantity)
    else:
        sellable_quantity = float(quantity_after_buy_fee) if pd.notna(quantity_after_buy_fee) else pd.NA

    dust_quantity = pd.NA
    if pd.notna(quantity_after_buy_fee) and pd.notna(sellable_quantity):
        dust_quantity = max(0.0, float(quantity_after_buy_fee) - float(sellable_quantity))

    # Gross P/Lは、手数料・板・成行コストなしの単純価格差。
    gross_quantity = float(investment_jpy) / float(entry_price)
    gross_pl = gross_quantity * (float(exit_price) - float(entry_price))

    # 売却側は未来の板が分からないため、売却想定価格からspread/slippageを不利方向へ差し引く。
    effective_sell_price = float(exit_price) * max(0.0, 1.0 - market_cost_rate)
    gross_sell_proceeds = float(sellable_quantity) * effective_sell_price if pd.notna(sellable_quantity) else pd.NA
    sell_fee = gross_sell_proceeds * sell_fee_rate if pd.notna(gross_sell_proceeds) else pd.NA

    if fee_mode == TRADE_FEE_MODE_BNB:
        net_sell_proceeds = gross_sell_proceeds
        external_fee_jpy = (float(buy_fee) if pd.notna(buy_fee) else 0.0) + (float(sell_fee) if pd.notna(sell_fee) else 0.0)
        sell_fee_deducted_from_quote = 0.0
    else:
        net_sell_proceeds = gross_sell_proceeds - sell_fee if pd.notna(gross_sell_proceeds) and pd.notna(sell_fee) else pd.NA
        external_fee_jpy = 0.0
        sell_fee_deducted_from_quote = sell_fee

    residual_dust_value = float(dust_quantity) * effective_sell_price if pd.notna(dust_quantity) else pd.NA

    net_pl_sell_only = pd.NA
    net_pl = pd.NA
    if pd.notna(net_sell_proceeds):
        net_pl_sell_only = float(net_sell_proceeds) - float(investment_jpy) - float(external_fee_jpy)
        if pd.notna(residual_dust_value):
            net_pl = float(net_sell_proceeds) + float(residual_dust_value) - float(investment_jpy) - float(external_fee_jpy)
        else:
            net_pl = net_pl_sell_only

    sell_market_cost = float(sellable_quantity) * (float(exit_price) - effective_sell_price) if pd.notna(sellable_quantity) else pd.NA

    total_cost = pd.NA
    if pd.notna(buy_fee) and pd.notna(sell_fee) and pd.notna(buy_market_cost) and pd.notna(sell_market_cost):
        total_cost = float(buy_fee) + float(sell_fee) + float(buy_market_cost) + float(sell_market_cost)

    bnb_fee_required_jpy = 0.0
    if fee_mode == TRADE_FEE_MODE_BNB:
        if pd.notna(buy_fee) and pd.notna(sell_fee):
            bnb_fee_required_jpy = float(buy_fee) + float(sell_fee)
        else:
            bnb_fee_required_jpy = pd.NA

    breakeven_price = pd.NA
    if pd.notna(sellable_quantity) and sellable_quantity > 0:
        # 丸め後数量を売れる前提の近似。残りダストがある場合は、その評価額を投資回収側に含める。
        sell_multiplier = max(0.0, 1.0 - market_cost_rate)
        if fee_mode != TRADE_FEE_MODE_BNB:
            sell_multiplier *= max(0.0, 1.0 - sell_fee_rate)
        else:
            sell_multiplier *= max(0.0, 1.0 - sell_fee_rate)
        denominator = float(sellable_quantity) * sell_multiplier
        if denominator > 0:
            breakeven_price = (float(investment_jpy) + (float(buy_fee) if fee_mode == TRADE_FEE_MODE_BNB and pd.notna(buy_fee) else 0.0)) / denominator

    breakeven_pct = pd.NA
    if pd.notna(breakeven_price):
        breakeven_pct = ((float(breakeven_price) - float(entry_price)) / float(entry_price)) * 100.0

    change_pct = ((float(exit_price) - float(entry_price)) / float(entry_price)) * 100.0

    if pd.isna(net_pl):
        judgement = "計算不可"
    elif rule_check.get("rule_status") == "要確認":
        judgement = "ルール要確認"
    elif net_pl > 0:
        judgement = "netプラス"
    elif net_pl < 0:
        judgement = "netマイナス"
    else:
        judgement = "損益ほぼゼロ"

    accuracy_label, accuracy_memo = determine_trade_accuracy_label(
        commission_profile=commission_profile,
        rule_status=rule_check.get("rule_status", "未確認"),
        use_order_book_buy=bool(use_order_book_buy),
        board_filled_ratio=board_filled_ratio,
    )

    return {
        "通貨": symbol,
        "投入JPY": float(investment_jpy),
        "買い注文想定": "MARKET BUY / quoteOrderQty",
        "現在価格": float(entry_price),
        "想定売却価格": float(exit_price),
        "想定変動率(%)": change_pct,
        "実質買い価格": effective_buy_price,
        "実質売り価格": effective_sell_price,
        "概算数量": quantity_after_buy_fee,
        "売却可能数量": sellable_quantity,
        "残りダスト数量": dust_quantity,
        "残りダスト評価額": residual_dust_value,
        "板平均買い価格": board_avg_price,
        "板使用段数": board_levels_used,
        "板充足率": board_filled_ratio,
        "Gross P/L": gross_pl,
        "Net P/L": net_pl,
        "Net P/L(売却分のみ)": net_pl_sell_only,
        "買い手数料": buy_fee,
        "売り手数料": sell_fee,
        "買い手数料数量": buy_fee_base_qty,
        "BNB手数料必要額(JPY)": bnb_fee_required_jpy,
        "買い成行コスト": buy_market_cost,
        "売り成行コスト": sell_market_cost,
        "総コスト概算": total_cost,
        "損益分岐価格": breakeven_price,
        "損益分岐まで(%)": breakeven_pct,
        "BUY手数料率(%)": rate_decimal_to_pct(commission_profile.get("buy_total_rate", pd.NA)),
        "SELL手数料率(%)": rate_decimal_to_pct(commission_profile.get("sell_total_rate", pd.NA)),
        "BUY標準手数料率(%)": rate_decimal_to_pct(commission_profile.get("buy_standard_rate", pd.NA)),
        "BUY税手数料率(%)": rate_decimal_to_pct(commission_profile.get("buy_tax_rate", pd.NA)),
        "BUY特別手数料率(%)": rate_decimal_to_pct(commission_profile.get("buy_special_rate", pd.NA)),
        "SELL標準手数料率(%)": rate_decimal_to_pct(commission_profile.get("sell_standard_rate", pd.NA)),
        "SELL税手数料率(%)": rate_decimal_to_pct(commission_profile.get("sell_tax_rate", pd.NA)),
        "SELL特別手数料率(%)": rate_decimal_to_pct(commission_profile.get("sell_special_rate", pd.NA)),
        "手数料データ元": commission_profile.get("source", ""),
        "BNB割引反映": "あり" if commission_profile.get("discount_applied") else "なし",
        "手数料メモ": commission_profile.get("memo", ""),
        "精度ラベル": accuracy_label,
        "精度メモ": accuracy_memo,
        "ルール判定": rule_check.get("rule_status", "未確認"),
        "ルールメッセージ": rule_check.get("rule_message", ""),
        "丸め後数量": rule_check.get("rounded_quantity", pd.NA),
        "最小注文額": rule_check.get("min_notional", pd.NA),
        "最小数量": rule_check.get("min_qty", pd.NA),
        "数量刻み": rule_check.get("step_size", pd.NA),
        "手数料方式": fee_mode,
        "判定": judgement,
    }


def compute_trade_simulation_table(
    current_df: pd.DataFrame,
    investment_jpy: float,
    exit_mode: str,
    exit_change_pct: float,
    exit_prices: dict,
    taker_fee_pct: float,
    spread_pct: float,
    slippage_pct: float,
    fee_mode: str = TRADE_FEE_MODE_BASE_DEDUCT,
    rules_by_symbol: dict = None,
    order_books_by_symbol: dict = None,
    use_order_book_buy: bool = False,
    commissions: dict = None,
) -> pd.DataFrame:
    """
    現在価格テーブルから、BTCJPY/ETHJPYの取引前シミュレーション表を作る。
    """
    current_df = normalize_history_dataframe(current_df)
    rows = []

    for symbol in SYMBOLS:
        symbol_df = current_df[current_df["symbol"] == symbol].sort_values("timestamp_dt")
        if symbol_df.empty:
            continue

        entry_price = float(symbol_df.iloc[-1]["price_jpy"])
        direct_exit_price = 0
        if isinstance(exit_prices, dict):
            direct_exit_price = exit_prices.get(symbol, 0)

        exit_price = calc_exit_price_from_mode(
            entry_price=entry_price,
            exit_mode=exit_mode,
            exit_change_pct=exit_change_pct,
            direct_exit_price=direct_exit_price,
        )

        rows.append(
            calculate_market_order_simulation(
                symbol=symbol,
                entry_price=entry_price,
                investment_jpy=investment_jpy,
                exit_price=exit_price,
                taker_fee_pct=taker_fee_pct,
                spread_pct=spread_pct,
                slippage_pct=slippage_pct,
                fee_mode=fee_mode,
                symbol_rules=(rules_by_symbol or {}).get(symbol, {}),
                order_book=(order_books_by_symbol or {}).get(symbol, {}),
                use_order_book_buy=bool(use_order_book_buy),
                commissions=commissions or {},
            )
        )

    return pd.DataFrame(rows)


# =========================
# v0.5-candidate-13 日次目標シミュレーター計算
# =========================

def parse_positive_number_list(text: str, defaults: list, min_value: float = 0.0, max_value: float = 1_000_000_000.0) -> list:
    """
    カンマ区切りの数値リストを読む。
    例: "1000,10000,100000" → [1000.0, 10000.0, 100000.0]
    """
    normalized = (
        str(text)
        .replace("、", ",")
        .replace("，", ",")
        .replace("円", "")
        .replace("回", "")
        .replace(" ", "")
    )
    values = []
    for part in normalized.split(","):
        if not part:
            continue
        value = _to_float_or_na(part)
        if pd.isna(value):
            continue
        value = float(value)
        if min_value < value <= max_value and value not in values:
            values.append(value)
    if values:
        return values
    return [float(v) for v in defaults]


def _clamp_float(value, low: float, high: float, default: float) -> float:
    num = _to_float_or_na(value)
    if pd.isna(num):
        return float(default)
    return max(float(low), min(float(high), float(num)))


def _ceil_int(value):
    num = _to_float_or_na(value)
    if pd.isna(num):
        return pd.NA
    return int(__import__("math").ceil(float(num)))


def daily_goal_difficulty_label(required_pct) -> str:
    """
    目標額に対する必要変動率の目安。
    売買判断ではなく、目標と投入額のバランスを見るためのラベル。
    """
    value = _to_float_or_na(required_pct)
    if pd.isna(value):
        return "到達困難/未計算"
    value = abs(float(value))
    if value < 0.20:
        return "低め"
    if value < 0.80:
        return "中"
    if value < 2.00:
        return "高め"
    return "かなり高い"


def daily_goal_risk_label(required_win_rate, required_pct, stop_loss_net_per_trade, filled_count) -> str:
    """
    日次目標に対するリスク感の簡易ラベル。
    これは売買推奨ではなく、準備不足や目標の厳しさに気づくための表示。
    """
    filled_count_num = _to_float_or_na(filled_count)
    if pd.isna(filled_count_num) or float(filled_count_num) <= 0:
        return "未約定多すぎ"

    win_rate = _to_float_or_na(required_win_rate)
    pct = _to_float_or_na(required_pct)
    loss_net = _to_float_or_na(stop_loss_net_per_trade)

    if pd.isna(win_rate) or pd.isna(pct):
        return "要確認"

    win_rate = float(win_rate)
    pct_abs = abs(float(pct))
    loss_abs = abs(float(loss_net)) if pd.notna(loss_net) else 0.0

    if win_rate > 90 or pct_abs >= 2.0:
        return "かなり厳しい"
    if win_rate > 70 or pct_abs >= 0.8 or loss_abs >= 1000:
        return "高め"
    if win_rate > 50 or pct_abs >= 0.3:
        return "中"
    return "低め"


def build_daily_goal_suggestion(
    symbol: str,
    amount: float,
    opportunity_count: int,
    filled_count: int,
    unfilled_count: int,
    daily_goal_profit: float,
    required_pct,
    required_win_rate,
    max_stop_losses,
    stop_loss_net,
    wait_minutes: float,
    cancel_move_pct: float,
    rule_status: str,
    accuracy: str,
) -> str:
    """
    日次目標シミュレーターの説明メモ。
    未約定キャンセルと約定後損切りを分けて、準備上の注意を短く返す。
    """
    pieces = []

    pieces.append(
        f"{symbol}で{fmt_yen(amount)}を{opportunity_count}回試す想定。"
        f"未約定キャンセルは{unfilled_count}回、実際に約定して損益が出る回数は{filled_count}回として見ます。"
    )

    if unfilled_count > 0:
        pieces.append(
            f"未約定キャンセルは損益0円として扱いますが、残り{filled_count}回で日次目標{fmt_yen(daily_goal_profit)}を狙うため、1回あたりの必要Netが上がります。"
        )

    if wait_minutes > 0:
        pieces.append(
            f"指値待ちは{wait_minutes:g}分、価格が{cancel_move_pct:.2f}%以上不利に離れたら未約定キャンセル候補として見る設定です。"
        )

    if pd.notna(required_pct):
        pieces.append(f"約定後に目標達成側で必要な変動率は{fmt_pct(required_pct, digits=4, signed=True)}です。")
    else:
        pieces.append("現在の条件では、目標達成に必要な変動率を計算できていません。投入額・回数・手数料設定を見直してください。")

    if pd.notna(stop_loss_net):
        pieces.append(f"約定後に損切り逆行率へ到達した場合、1回の例は{fmt_yen(stop_loss_net, digits=2, signed=True)}です。")

    if pd.notna(required_win_rate):
        if float(required_win_rate) > 100:
            pieces.append("この条件では、約定した取引が全勝でも日次目標に届かない可能性があります。")
        elif float(required_win_rate) >= 80:
            pieces.append("必要勝率がかなり高いので、目標額か投入額・回数の前提を慎重に確認してください。")
        elif float(required_win_rate) >= 60:
            pieces.append("必要勝率は高めです。未約定キャンセルが増えるとさらに厳しくなります。")
        else:
            pieces.append("必要勝率だけを見ると極端ではありませんが、板・手数料・損切り時の遅れを別途確認してください。")

    if pd.notna(max_stop_losses):
        try:
            max_losses_int = int(max_stop_losses)
            if max_losses_int < 0:
                pieces.append("損切りを1回も許容しにくい条件です。")
            else:
                pieces.append(f"日次目標に対して許容できる約定後損切りは最大{max_losses_int}回程度の目安です。")
        except Exception:
            pass

    if rule_status not in ["OK", "OK/概算", ""]:
        pieces.append(f"注文ルールは「{rule_status}」です。実注文前には必ず注文ルールを再確認してください。")

    if accuracy:
        pieces.append(f"精度ラベルは「{accuracy}」です。")

    return " ".join(pieces)


def simulate_single_symbol_for_change_pct(
    symbol: str,
    entry_price: float,
    investment_jpy: float,
    change_pct: float,
    taker_fee_pct: float,
    spread_pct: float,
    slippage_pct: float,
    fee_mode: str,
    rules_by_symbol: dict = None,
    order_books_by_symbol: dict = None,
    use_order_book_buy: bool = False,
    commissions: dict = None,
) -> dict:
    """
    1通貨・1投入額・1変動率で、既存の取引シミュレーター計算を呼ぶ。
    """
    exit_price = float(entry_price) * (1.0 + float(change_pct) / 100.0)
    return calculate_market_order_simulation(
        symbol=symbol,
        entry_price=float(entry_price),
        investment_jpy=float(investment_jpy),
        exit_price=float(exit_price),
        taker_fee_pct=float(taker_fee_pct),
        spread_pct=float(spread_pct),
        slippage_pct=float(slippage_pct),
        fee_mode=str(fee_mode),
        symbol_rules=(rules_by_symbol or {}).get(symbol, {}),
        order_book=(order_books_by_symbol or {}).get(symbol, {}),
        use_order_book_buy=bool(use_order_book_buy),
        commissions=commissions or {},
    )


def find_required_change_pct_for_net_target(
    symbol: str,
    entry_price: float,
    investment_jpy: float,
    target_net_pl: float,
    taker_fee_pct: float,
    spread_pct: float,
    slippage_pct: float,
    fee_mode: str,
    rules_by_symbol: dict = None,
    order_books_by_symbol: dict = None,
    use_order_book_buy: bool = False,
    commissions: dict = None,
    max_pct: float = 50.0,
) -> tuple:
    """
    1回あたりの目標Net P/Lを達成するために必要な変動率を二分探索で求める。
    戻り値: (required_pct, simulation_result)
    """
    entry_price = _to_float_or_na(entry_price)
    investment_jpy = _to_float_or_na(investment_jpy)
    target_net_pl = _to_float_or_na(target_net_pl)

    if pd.isna(entry_price) or entry_price <= 0 or pd.isna(investment_jpy) or investment_jpy <= 0 or pd.isna(target_net_pl):
        return pd.NA, {}

    if float(target_net_pl) <= 0:
        sim = simulate_single_symbol_for_change_pct(
            symbol, entry_price, investment_jpy, 0.0,
            taker_fee_pct, spread_pct, slippage_pct, fee_mode,
            rules_by_symbol, order_books_by_symbol, use_order_book_buy, commissions,
        )
        return 0.0, sim

    low = -20.0
    high = float(max_pct)

    high_sim = simulate_single_symbol_for_change_pct(
        symbol, entry_price, investment_jpy, high,
        taker_fee_pct, spread_pct, slippage_pct, fee_mode,
        rules_by_symbol, order_books_by_symbol, use_order_book_buy, commissions,
    )
    high_net = _to_float_or_na(high_sim.get("Net P/L", pd.NA))
    if pd.isna(high_net) or float(high_net) < float(target_net_pl):
        return pd.NA, high_sim

    best_sim = high_sim
    for _ in range(36):
        mid = (low + high) / 2.0
        sim = simulate_single_symbol_for_change_pct(
            symbol, entry_price, investment_jpy, mid,
            taker_fee_pct, spread_pct, slippage_pct, fee_mode,
            rules_by_symbol, order_books_by_symbol, use_order_book_buy, commissions,
        )
        net_pl = _to_float_or_na(sim.get("Net P/L", pd.NA))
        if pd.isna(net_pl):
            low = mid
            continue
        if float(net_pl) >= float(target_net_pl):
            high = mid
            best_sim = sim
        else:
            low = mid

    return float(high), best_sim


def compute_daily_goal_simulation_table(
    current_df: pd.DataFrame,
    daily_goal_profit_jpy: float,
    investment_amounts: list,
    trade_counts: list,
    stop_loss_change_pct: float,
    unfilled_cancel_rate_pct: float,
    limit_wait_minutes: float,
    limit_cancel_move_pct: float,
    taker_fee_pct: float,
    spread_pct: float,
    slippage_pct: float,
    fee_mode: str = TRADE_FEE_MODE_BASE_DEDUCT,
    rules_by_symbol: dict = None,
    order_books_by_symbol: dict = None,
    use_order_book_buy: bool = False,
    commissions: dict = None,
) -> pd.DataFrame:
    """
    一日の目標利益から、必要な1回あたりNet P/L・必要変動率を逆算する。

    v0.5-candidate-18:
    - 未約定キャンセル: 指値が刺さらない/待ちすぎで取り消す。損益は0円として扱い、機会回数だけ減る。
    - 約定後損切り: 約定後に逆行し、指定した逆行率で売って損失確定する想定。
    """
    current_df = normalize_history_dataframe(current_df)
    rows = []

    daily_goal_profit_jpy = float(max(0.0, _to_float_or_na(daily_goal_profit_jpy) if pd.notna(_to_float_or_na(daily_goal_profit_jpy)) else 0.0))
    stop_loss_change_pct = _clamp_float(stop_loss_change_pct, 0.0, 50.0, 1.0)
    unfilled_cancel_rate_pct = _clamp_float(unfilled_cancel_rate_pct, 0.0, 100.0, 0.0)
    limit_wait_minutes = _clamp_float(limit_wait_minutes, 0.0, 120.0, 5.0)
    limit_cancel_move_pct = _clamp_float(limit_cancel_move_pct, 0.0, 20.0, 0.30)

    for symbol in SYMBOLS:
        symbol_df = current_df[current_df["symbol"] == symbol].sort_values("timestamp_dt")
        if symbol_df.empty:
            continue
        entry_price = float(symbol_df.iloc[-1]["price_jpy"])

        for amount in investment_amounts:
            amount = float(amount)
            if amount <= 0:
                continue

            for count in trade_counts:
                opportunity_count = int(max(1, round(float(count))))

                unfilled_count = int(__import__("math").floor(opportunity_count * (unfilled_cancel_rate_pct / 100.0)))
                unfilled_count = max(0, min(unfilled_count, opportunity_count))
                filled_count = opportunity_count - unfilled_count

                if filled_count <= 0:
                    rows.append({
                        "通貨": symbol,
                        "投入額": amount,
                        "想定機会回数": opportunity_count,
                        "未約定キャンセル率(%)": unfilled_cancel_rate_pct,
                        "未約定キャンセル想定回数": unfilled_count,
                        "有効約定回数": filled_count,
                        "指値待ち時間(分)": limit_wait_minutes,
                        "未約定キャンセル乖離率(%)": limit_cancel_move_pct,
                        "日次目標利益": daily_goal_profit_jpy,
                        "1回必要Net": pd.NA,
                        "単純必要変動率(%)": pd.NA,
                        "必要変動率(%)": pd.NA,
                        "必要売却価格": pd.NA,
                        "目標達成難易度": "未約定多すぎ",
                        "全成功時日次Net": pd.NA,
                        "未約定1回Net": 0.0,
                        "約定後損切り逆行率(%)": -stop_loss_change_pct,
                        "損切り1回Net": pd.NA,
                        "損切り時日次Net": pd.NA,
                        "目標必要勝ち回数": pd.NA,
                        "損益分岐勝ち回数": pd.NA,
                        "目標必要勝率(%)": pd.NA,
                        "目標許容損切り回数": pd.NA,
                        "リスク感": "未約定多すぎ",
                        "ルール": "未計算",
                        "精度": "",
                        "サジェスト": "未約定キャンセル想定が多く、有効約定回数が0回です。目標達成計算はできません。",
                        "メモ": "未約定キャンセルは損益0円。ただし機会回数を減らします。",
                    })
                    continue

                per_trade_target = daily_goal_profit_jpy / filled_count if filled_count > 0 else daily_goal_profit_jpy

                required_pct, required_sim = find_required_change_pct_for_net_target(
                    symbol=symbol,
                    entry_price=entry_price,
                    investment_jpy=amount,
                    target_net_pl=per_trade_target,
                    taker_fee_pct=taker_fee_pct,
                    spread_pct=spread_pct,
                    slippage_pct=slippage_pct,
                    fee_mode=fee_mode,
                    rules_by_symbol=rules_by_symbol or {},
                    order_books_by_symbol=order_books_by_symbol or {},
                    use_order_book_buy=bool(use_order_book_buy),
                    commissions=commissions or {},
                )

                stop_loss_sim = simulate_single_symbol_for_change_pct(
                    symbol=symbol,
                    entry_price=entry_price,
                    investment_jpy=amount,
                    change_pct=-stop_loss_change_pct,
                    taker_fee_pct=taker_fee_pct,
                    spread_pct=spread_pct,
                    slippage_pct=slippage_pct,
                    fee_mode=fee_mode,
                    rules_by_symbol=rules_by_symbol or {},
                    order_books_by_symbol=order_books_by_symbol or {},
                    use_order_book_buy=bool(use_order_book_buy),
                    commissions=commissions or {},
                )

                required_exit_price = pd.NA
                all_win_daily_net = pd.NA
                rule_status = "未計算"
                accuracy = ""
                win_net = pd.NA
                if pd.notna(required_pct) and required_sim:
                    required_exit_price = required_sim.get("想定売却価格", pd.NA)
                    win_net = _to_float_or_na(required_sim.get("Net P/L", pd.NA))
                    if pd.notna(win_net):
                        all_win_daily_net = float(win_net) * filled_count
                    rule_status = required_sim.get("ルール判定", "未確認")
                    accuracy = required_sim.get("精度ラベル", "")

                stop_loss_net = _to_float_or_na(stop_loss_sim.get("Net P/L", pd.NA))
                stop_loss_daily_net = float(stop_loss_net) * filled_count if pd.notna(stop_loss_net) else pd.NA

                required_wins_for_goal = pd.NA
                break_even_wins = pd.NA
                required_win_rate = pd.NA
                max_stop_losses_for_goal = pd.NA

                if pd.notna(win_net) and pd.notna(stop_loss_net):
                    win_value = float(win_net)
                    lose_value = float(stop_loss_net)
                    denom = win_value - lose_value
                    if denom > 0:
                        raw_goal_wins = (daily_goal_profit_jpy - filled_count * lose_value) / denom
                        raw_break_even_wins = (0.0 - filled_count * lose_value) / denom
                        required_wins_for_goal = int(max(0, __import__("math").ceil(raw_goal_wins)))
                        break_even_wins = int(max(0, __import__("math").ceil(raw_break_even_wins)))
                        required_win_rate = (required_wins_for_goal / filled_count) * 100.0 if filled_count > 0 else pd.NA
                        max_stop_losses_for_goal = filled_count - required_wins_for_goal

                suggestion = build_daily_goal_suggestion(
                    symbol=symbol,
                    amount=amount,
                    opportunity_count=opportunity_count,
                    filled_count=filled_count,
                    unfilled_count=unfilled_count,
                    daily_goal_profit=daily_goal_profit_jpy,
                    required_pct=required_pct,
                    required_win_rate=required_win_rate,
                    max_stop_losses=max_stop_losses_for_goal,
                    stop_loss_net=stop_loss_net,
                    wait_minutes=limit_wait_minutes,
                    cancel_move_pct=limit_cancel_move_pct,
                    rule_status=rule_status,
                    accuracy=accuracy,
                )

                rows.append({
                    "通貨": symbol,
                    "投入額": amount,
                    "想定機会回数": opportunity_count,
                    "未約定キャンセル率(%)": unfilled_cancel_rate_pct,
                    "未約定キャンセル想定回数": unfilled_count,
                    "有効約定回数": filled_count,
                    "指値待ち時間(分)": limit_wait_minutes,
                    "未約定キャンセル乖離率(%)": limit_cancel_move_pct,
                    "日次目標利益": daily_goal_profit_jpy,
                    "1回必要Net": per_trade_target,
                    "単純必要変動率(%)": _daily_goal_plain_required_pct(daily_goal_profit_jpy, amount, filled_count),
                    "必要変動率(%)": required_pct,
                    "必要売却価格": required_exit_price,
                    "目標達成難易度": daily_goal_difficulty_label(required_pct),
                    "全成功時日次Net": all_win_daily_net,
                    "未約定1回Net": 0.0,
                    "約定後損切り逆行率(%)": -stop_loss_change_pct,
                    "損切り1回Net": stop_loss_net,
                    "損切り時日次Net": stop_loss_daily_net,
                    "目標必要勝ち回数": required_wins_for_goal,
                    "損益分岐勝ち回数": break_even_wins,
                    "目標必要勝率(%)": required_win_rate,
                    "目標許容損切り回数": max_stop_losses_for_goal,
                    "リスク感": daily_goal_risk_label(required_win_rate, required_pct, stop_loss_net, filled_count),
                    "ルール": rule_status,
                    "精度": accuracy,
                    "サジェスト": suggestion,
                    "メモ": "未約定キャンセルは損益0円、約定後損切りはNet P/Lに反映。",
                })

    return pd.DataFrame(rows)


# =========================
# 表示整形
# =========================

def numeric_value(value):
    return pd.to_numeric(value, errors="coerce")


def fmt_yen(value, digits=0, signed=False):
    value = numeric_value(value)
    if pd.isna(value):
        return "—"
    sign = "+" if signed and value > 0 else ""
    return f"{sign}{value:,.{digits}f}円"


def fmt_pct(value, digits=4, signed=False):
    value = numeric_value(value)
    if pd.isna(value):
        return "—"
    sign = "+" if signed and value > 0 else ""
    return f"{sign}{value:.{digits}f}%"


def fmt_qty(value, digits=8):
    value = numeric_value(value)
    if pd.isna(value):
        return "—"
    return f"{value:.{digits}f}"


def trend_badge_text(trend: str, size: str) -> str:
    if trend == "短期上昇":
        return f"↗ {trend} / {size}"
    if trend == "短期下落":
        return f"↘ {trend} / {size}"
    if trend == "横ばい":
        return f"→ {trend} / {size}"
    return f"{trend} / {size}"


def safe_round_columns(df: pd.DataFrame, round_map: dict) -> pd.DataFrame:
    result = df.copy()
    for col, digits in round_map.items():
        if col in result.columns:
            result[col] = pd.to_numeric(result[col], errors="coerce").round(digits)
    return result


def make_summary_display(metrics_df: pd.DataFrame, impact_df: pd.DataFrame, focus_amount: float) -> pd.DataFrame:
    rows = []

    for _, row in metrics_df.iterrows():
        symbol = row["通貨"]

        focus_rows = impact_df[impact_df["通貨"] == symbol].copy()
        if focus_rows.empty:
            focus_prev_impact = pd.NA
            focus_trend_impact = pd.NA
        else:
            focus_rows["amount_diff"] = (
                pd.to_numeric(focus_rows["想定額(JPY)"], errors="coerce") - float(focus_amount)
            ).abs()
            focus_row = focus_rows.sort_values("amount_diff").iloc[0]
            focus_prev_impact = focus_row["前回比の影響額(円)"]
            focus_trend_impact = focus_row["短期変化の影響額(円)"]

        rows.append({
            "通貨": symbol,
            "現在価格": fmt_yen(row["現在価格"]),
            "前回比": f'{fmt_yen(row["前回比(円)"], signed=True)} / {fmt_pct(row["前回比(%)"], signed=True)}',
            "前回比の大きさ": row["前回比の大きさ"],
            "短期傾向": row["短期傾向"],
            "短期変化": f'{fmt_yen(row["短期変化(円)"], signed=True)} / {fmt_pct(row["短期変化(%)"], signed=True)}',
            f"{int(focus_amount):,}円の前回比影響": fmt_yen(focus_prev_impact, digits=2, signed=True),
            f"{int(focus_amount):,}円の短期影響": fmt_yen(focus_trend_impact, digits=2, signed=True),
        })

    return pd.DataFrame(rows)


def make_impact_display(impact_df: pd.DataFrame) -> pd.DataFrame:
    rows = []

    for _, row in impact_df.iterrows():
        rows.append({
            "通貨": row["通貨"],
            "想定額": fmt_yen(row["想定額(JPY)"]),
            "概算数量": fmt_qty(row["概算数量"]),
            "前回比の影響額": fmt_yen(row["前回比の影響額(円)"], digits=2, signed=True),
            "前回比影響": row["前回比影響"],
            "短期変化の影響額": fmt_yen(row["短期変化の影響額(円)"], digits=2, signed=True),
            "短期影響": row["短期影響"],
        })

    return pd.DataFrame(rows)


def make_trade_simulation_display(trade_df: pd.DataFrame) -> pd.DataFrame:
    """
    取引シミュレーターのメイン表示用テーブル。
    NET P/Lは、売却可能数量を売ったJPYと残りダスト評価を合わせた資産評価込み。
    """
    if trade_df is None or trade_df.empty:
        return pd.DataFrame()

    rows = []
    for _, row in trade_df.iterrows():
        rows.append({
            "通貨": row.get("通貨", ""),
            "投入額": fmt_yen(row.get("投入JPY")),
            "買い想定": row.get("買い注文想定", ""),
            "現在価格": fmt_yen(row.get("現在価格")),
            "想定売却価格": fmt_yen(row.get("想定売却価格")),
            "想定変動率": fmt_pct(row.get("想定変動率(%)"), signed=True),
            "買い後数量": fmt_qty(row.get("概算数量")),
            "売却可能数量": fmt_qty(row.get("売却可能数量")),
            "Gross P/L": fmt_yen(row.get("Gross P/L"), digits=2, signed=True),
            "Net P/L": fmt_yen(row.get("Net P/L"), digits=2, signed=True),
            "精度": row.get("精度ラベル", ""),
            "判定": row.get("判定", ""),
        })

    return pd.DataFrame(rows)


def make_trade_fee_cost_display(trade_df: pd.DataFrame) -> pd.DataFrame:
    """
    取引シミュレーター下段1: 手数料・成行コスト。
    BUY/SELL手数料率と内訳を分けて確認する。
    """
    if trade_df is None or trade_df.empty:
        return pd.DataFrame()

    rows = []
    for _, row in trade_df.iterrows():
        rows.append({
            "通貨": row.get("通貨", ""),
            "手数料方式": row.get("手数料方式", ""),
            "データ元": row.get("手数料データ元", ""),
            "BUY率": fmt_pct(row.get("BUY手数料率(%)")),
            "SELL率": fmt_pct(row.get("SELL手数料率(%)")),
            "BNB割引": row.get("BNB割引反映", ""),
            "買い手数料": fmt_yen(row.get("買い手数料"), digits=2),
            "買い手数料数量": fmt_qty(row.get("買い手数料数量")),
            "売り手数料": fmt_yen(row.get("売り手数料"), digits=2),
            "BNB手数料概算": fmt_yen(row.get("BNB手数料必要額(JPY)"), digits=2),
            "買い成行コスト": fmt_yen(row.get("買い成行コスト"), digits=2),
            "売り成行コスト": fmt_yen(row.get("売り成行コスト"), digits=2),
            "総コスト概算": fmt_yen(row.get("総コスト概算"), digits=2),
            "損益分岐価格": fmt_yen(row.get("損益分岐価格")),
        })

    return pd.DataFrame(rows)


def make_trade_commission_breakdown_display(trade_df: pd.DataFrame) -> pd.DataFrame:
    """
    手数料率の分解表示。standard / tax / special を分ける。
    """
    if trade_df is None or trade_df.empty:
        return pd.DataFrame()

    rows = []
    for _, row in trade_df.iterrows():
        rows.append({
            "通貨": row.get("通貨", ""),
            "BUY標準": fmt_pct(row.get("BUY標準手数料率(%)")),
            "BUY税": fmt_pct(row.get("BUY税手数料率(%)")),
            "BUY特別": fmt_pct(row.get("BUY特別手数料率(%)")),
            "SELL標準": fmt_pct(row.get("SELL標準手数料率(%)")),
            "SELL税": fmt_pct(row.get("SELL税手数料率(%)")),
            "SELL特別": fmt_pct(row.get("SELL特別手数料率(%)")),
            "メモ": row.get("手数料メモ", ""),
        })
    return pd.DataFrame(rows)


def make_trade_rule_book_display(trade_df: pd.DataFrame) -> pd.DataFrame:
    """
    取引シミュレーター下段2: Binance注文ルール・板情報。
    注文できるか、数量刻みに合うか、板平均を使ったかを確認する。
    """
    if trade_df is None or trade_df.empty:
        return pd.DataFrame()

    rows = []
    for _, row in trade_df.iterrows():
        board_ratio = row.get("板充足率", pd.NA)
        board_ratio_pct = pd.NA
        if pd.notna(pd.to_numeric(board_ratio, errors="coerce")):
            board_ratio_pct = float(board_ratio) * 100.0

        rows.append({
            "通貨": row.get("通貨", ""),
            "ルール": row.get("ルール判定", ""),
            "買い後数量": fmt_qty(row.get("概算数量")),
            "売却可能数量": fmt_qty(row.get("売却可能数量")),
            "残りダスト": fmt_qty(row.get("残りダスト数量")),
            "ダスト評価": fmt_yen(row.get("残りダスト評価額"), digits=2),
            "最小注文額": fmt_yen(row.get("最小注文額")),
            "最小数量": fmt_qty(row.get("最小数量")),
            "数量刻み": fmt_qty(row.get("数量刻み")),
            "板平均買い": fmt_yen(row.get("板平均買い価格")),
            "板使用段数": "—" if pd.isna(row.get("板使用段数")) else f'{int(row.get("板使用段数"))}',
            "板充足率": fmt_pct(board_ratio_pct),
            "精度メモ": row.get("精度メモ", ""),
            "ルールメモ": row.get("ルールメッセージ", ""),
        })

    return pd.DataFrame(rows)



def make_daily_goal_display(goal_df: pd.DataFrame) -> pd.DataFrame:
    """
    日次目標シミュレーターの表示用テーブル。
    未約定キャンセルと約定後損切りを分けて表示する。
    """
    if goal_df is None or goal_df.empty:
        return pd.DataFrame()

    rows = []
    for _, row in goal_df.iterrows():
        max_losses = row.get("目標許容損切り回数", pd.NA)
        if pd.isna(max_losses):
            max_losses_text = "—"
        else:
            try:
                max_losses_int = int(max_losses)
                max_losses_text = "なし/未達" if max_losses_int < 0 else f"{max_losses_int}回"
            except Exception:
                max_losses_text = "—"

        rows.append({
            "通貨": row.get("通貨", ""),
            "投入額": fmt_yen(row.get("投入額")),
            "機会回数": f'{int(row.get("想定機会回数"))}回' if pd.notna(row.get("想定機会回数")) else "—",
            "未約定": f'{int(row.get("未約定キャンセル想定回数"))}回 / {fmt_pct(row.get("未約定キャンセル率(%)"), digits=1)}' if pd.notna(row.get("未約定キャンセル想定回数")) else "—",
            "有効約定": f'{int(row.get("有効約定回数"))}回' if pd.notna(row.get("有効約定回数")) else "—",
            "日次目標": fmt_yen(row.get("日次目標利益"), digits=0),
            "1回必要Net": fmt_yen(row.get("1回必要Net"), digits=2, signed=True),
            "必要変動率": fmt_pct(row.get("必要変動率(%)"), digits=4, signed=True),
            "必要売却価格": fmt_yen(row.get("必要売却価格")),
            "損切り1回": f'{fmt_pct(row.get("約定後損切り逆行率(%)"), digits=2, signed=True)} → {fmt_yen(row.get("損切り1回Net"), digits=2, signed=True)}',
            "必要勝ち": "—" if pd.isna(row.get("目標必要勝ち回数")) else f'{int(row.get("目標必要勝ち回数"))}回',
            "必要勝率": fmt_pct(row.get("目標必要勝率(%)"), digits=1),
            "許容損切り": max_losses_text,
            "リスク感": row.get("リスク感", ""),
            "ルール": row.get("ルール", ""),
            "精度": row.get("精度", ""),
            "メモ": row.get("メモ", ""),
        })
    return pd.DataFrame(rows)



def _short_plan_status(required_win_rate, required_pct, max_losses, filled_count) -> str:
    """
    今日の組み立て表用の短い判定。
    売買推奨ではなく、目標設定の厳しさを一目で見るためのラベル。
    """
    filled_num = _to_float_or_na(filled_count)
    if pd.isna(filled_num) or float(filled_num) <= 0:
        return "未約定多すぎ"

    win_rate = _to_float_or_na(required_win_rate)
    pct = _to_float_or_na(required_pct)
    losses = _to_float_or_na(max_losses)

    if pd.isna(win_rate) or pd.isna(pct):
        return "未計算"

    if float(win_rate) > 100:
        return "全勝でも不足"
    if float(win_rate) >= 90:
        return "かなり厳しい"
    if pd.notna(losses) and float(losses) < 0:
        return "損切り許容なし"
    if float(win_rate) >= 70 or abs(float(pct)) >= 1.0:
        return "厳しめ"
    if float(win_rate) >= 50 or abs(float(pct)) >= 0.4:
        return "要注意"
    return "検討しやすい"


def make_daily_goal_plan_display(goal_df: pd.DataFrame) -> pd.DataFrame:
    """
    日次目標タブ上段用。
    1つの投入額について、5〜10回などの機会回数ごとに「何回勝てばよいか」を短く見る。
    """
    if goal_df is None or goal_df.empty:
        return pd.DataFrame()

    rows = []
    for _, row in goal_df.iterrows():
        filled_count = row.get("有効約定回数", pd.NA)
        required_wins = row.get("目標必要勝ち回数", pd.NA)
        max_losses = row.get("目標許容損切り回数", pd.NA)

        try:
            filled_text = f'{int(filled_count)}回' if pd.notna(filled_count) else "—"
        except Exception:
            filled_text = "—"

        try:
            required_wins_text = "—" if pd.isna(required_wins) else f'{int(required_wins)}勝/{int(filled_count)}回'
        except Exception:
            required_wins_text = "—"

        if pd.isna(max_losses):
            max_losses_text = "—"
        else:
            try:
                max_losses_int = int(max_losses)
                max_losses_text = "0回未満" if max_losses_int < 0 else f"{max_losses_int}回まで"
            except Exception:
                max_losses_text = "—"

        rows.append({
            "通貨": row.get("通貨", ""),
            "投入額": fmt_yen(row.get("投入額")),
            "機会": f'{int(row.get("想定機会回数"))}回' if pd.notna(row.get("想定機会回数")) else "—",
            "未約定想定": f'{int(row.get("未約定キャンセル想定回数"))}回' if pd.notna(row.get("未約定キャンセル想定回数")) else "—",
            "有効約定": filled_text,
            "1回必要Net": fmt_yen(row.get("1回必要Net"), digits=2, signed=True),
            "必要変動率": fmt_pct(row.get("必要変動率(%)"), digits=4, signed=True),
            "必要勝ち": required_wins_text,
            "必要勝率": fmt_pct(row.get("目標必要勝率(%)"), digits=1),
            "損切り1回": fmt_yen(row.get("損切り1回Net"), digits=2, signed=True),
            "許容損切り": max_losses_text,
            "準備感": _short_plan_status(
                row.get("目標必要勝率(%)"),
                row.get("必要変動率(%)"),
                row.get("目標許容損切り回数"),
                row.get("有効約定回数"),
            ),
        })

    return pd.DataFrame(rows)


def pick_daily_goal_plan_candidate(goal_df: pd.DataFrame):
    """
    準備表から、比較的検討しやすい候補を1行選ぶ。
    売買推奨ではなく、表を読むための起点として使う。
    """
    if goal_df is None or goal_df.empty:
        return None

    df = goal_df.copy()
    df["_win_rate"] = pd.to_numeric(df.get("目標必要勝率(%)"), errors="coerce")
    df["_required_pct_abs"] = pd.to_numeric(df.get("必要変動率(%)"), errors="coerce").abs()
    df["_max_losses"] = pd.to_numeric(df.get("目標許容損切り回数"), errors="coerce")
    df["_filled"] = pd.to_numeric(df.get("有効約定回数"), errors="coerce")
    df = df.dropna(subset=["_win_rate", "_required_pct_abs", "_filled"])
    df = df[df["_filled"] > 0]
    if df.empty:
        return None

    # 必要勝率が100%を超えるものは後回し。許容損切りがあるものを少し優先。
    df["_over_100"] = (df["_win_rate"] > 100).astype(int)
    df["_loss_penalty"] = df["_max_losses"].fillna(-1).apply(lambda x: 0 if x >= 0 else 1)
    return df.sort_values(["_over_100", "_loss_penalty", "_win_rate", "_required_pct_abs"]).iloc[0]


def build_daily_goal_plan_note(plan_df: pd.DataFrame, daily_goal_profit_jpy: float, plan_amount: float, min_count: int, max_count: int) -> str:
    """
    今日の目標設計を読むための短い説明。
    """
    if plan_df is None or plan_df.empty:
        return "今日の組み立てを表示できるデータがありません。価格・投入額・回数設定を確認してください。"

    pick = pick_daily_goal_plan_candidate(plan_df)
    if pick is None:
        return "目標達成に必要な変動率や勝率を計算できていません。手数料・注文ルール・投入額の設定を確認してください。"

    symbol = pick.get("通貨", "")
    count = pick.get("想定機会回数", pd.NA)
    filled = pick.get("有効約定回数", pd.NA)
    required_wins = pick.get("目標必要勝ち回数", pd.NA)
    required_pct = pick.get("必要変動率(%)", pd.NA)
    required_win_rate = pick.get("目標必要勝率(%)", pd.NA)
    max_losses = pick.get("目標許容損切り回数", pd.NA)
    stop_loss_net = pick.get("損切り1回Net", pd.NA)

    count_text = "—" if pd.isna(count) else f"{int(count)}回"
    filled_text = "—" if pd.isna(filled) else f"{int(filled)}回"
    wins_text = "—" if pd.isna(required_wins) else f"{int(required_wins)}勝"
    losses_text = "—"
    if pd.notna(max_losses):
        try:
            losses_text = "許容しにくい" if int(max_losses) < 0 else f"最大{int(max_losses)}回程度"
        except Exception:
            losses_text = "—"

    pieces = [
        f"今日の組み立ては、{fmt_yen(plan_amount)}を1回投入額として、{min_count}〜{max_count}回の機会で日次目標{fmt_yen(daily_goal_profit_jpy)}を見る表です。",
        f"表の中では、{symbol}の{count_text}想定が読み始めやすい候補です。未約定を除いた有効約定は{filled_text}、目標には{wins_text}が目安です。",
        f"この候補では1回の必要変動率は{fmt_pct(required_pct, digits=4, signed=True)}、必要勝率は{fmt_pct(required_win_rate, digits=1)}です。",
        f"約定後に損切り逆行率へ到達した場合の1回例は{fmt_yen(stop_loss_net, digits=2, signed=True)}で、目標に対して損切り許容は{losses_text}です。",
        "これは売買提案ではなく、目標額・回数・損切り条件の厳しさを見るための準備メモです。",
    ]
    return " ".join(pieces)




def _daily_goal_readiness_label(required_pct, required_win_rate, max_losses, filled_count) -> str:
    """
    今日の目標に対して、その回数プランがどれくらい考えやすいかを短く返す。
    売買推奨ではなく、目標・資金・回数の厳しさを読むためのラベル。
    """
    filled = _to_float_or_na(filled_count)
    pct = _to_float_or_na(required_pct)
    win_rate = _to_float_or_na(required_win_rate)
    losses = _to_float_or_na(max_losses)

    if pd.isna(filled) or float(filled) <= 0:
        return "未約定多すぎ"
    if pd.isna(pct) or pd.isna(win_rate):
        return "未計算"
    if float(win_rate) > 100:
        return "全勝でも不足"
    if abs(float(pct)) >= 3.0 or float(win_rate) >= 90:
        return "かなり厳しい"
    if abs(float(pct)) >= 1.0 or float(win_rate) >= 70:
        return "厳しめ"
    if pd.notna(losses) and float(losses) < 0:
        return "損切り余地なし"
    if abs(float(pct)) >= 0.4 or float(win_rate) >= 50:
        return "要注意"
    return "比較的考えやすい"


def _daily_goal_plain_required_pct(goal_profit: float, amount: float, count: int) -> float:
    """
    手数料を除いた単純な必要変動率。
    画面で「まず頭で分かる目安」として使う。
    """
    goal = _to_float_or_na(goal_profit)
    amount_num = _to_float_or_na(amount)
    count_num = _to_float_or_na(count)
    if pd.isna(goal) or pd.isna(amount_num) or pd.isna(count_num):
        return pd.NA
    if float(amount_num) <= 0 or int(count_num) <= 0:
        return pd.NA
    return (float(goal) / (float(amount_num) * int(count_num))) * 100.0


def make_daily_goal_decision_display(focus_df: pd.DataFrame) -> pd.DataFrame:
    """
    日次目標タブの上段に出す、読む順番用のテーブル。
    1回・最小回数・最大回数などを並べて、まず何を考えればよいかを示す。
    """
    if focus_df is None or focus_df.empty:
        return pd.DataFrame()

    df = focus_df.copy()
    df["_count"] = pd.to_numeric(df.get("想定機会回数"), errors="coerce")
    df["_symbol_order"] = df.get("通貨", "").map({symbol: i for i, symbol in enumerate(SYMBOLS)}) if "通貨" in df.columns else 0
    df = df.sort_values(["_symbol_order", "_count"])

    rows = []
    for _, row in df.iterrows():
        count = row.get("想定機会回数", pd.NA)
        filled = row.get("有効約定回数", pd.NA)
        required_wins = row.get("目標必要勝ち回数", pd.NA)
        max_losses = row.get("目標許容損切り回数", pd.NA)

        if pd.isna(count):
            plan_name = "—"
        elif int(count) == 1:
            plan_name = "1回で達成"
        else:
            plan_name = f"{int(count)}回で分ける"

        try:
            win_text = "—" if pd.isna(required_wins) or pd.isna(filled) else f"{int(required_wins)}勝 / {int(filled)}約定"
        except Exception:
            win_text = "—"

        if pd.isna(max_losses):
            loss_text = "—"
        else:
            try:
                max_loss_int = int(max_losses)
                loss_text = "なし/不足" if max_loss_int < 0 else f"{max_loss_int}回まで"
            except Exception:
                loss_text = "—"

        rows.append({
            "通貨": row.get("通貨", ""),
            "考え方": plan_name,
            "資金/投入額": fmt_yen(row.get("投入額")),
            "未約定後の有効約定": "—" if pd.isna(filled) else f"{int(filled)}回",
            "1回必要Net": fmt_yen(row.get("1回必要Net"), digits=2, signed=True),
            "手数料抜き単純目安": fmt_pct(row.get("単純必要変動率(%)"), digits=4, signed=True),
            "コスト込み必要変動率": fmt_pct(row.get("必要変動率(%)"), digits=4, signed=True),
            "必要勝ち": win_text,
            "損切り許容": loss_text,
            "読み取り": _daily_goal_readiness_label(
                row.get("必要変動率(%)"),
                row.get("目標必要勝率(%)"),
                row.get("目標許容損切り回数"),
                row.get("有効約定回数"),
            ),
        })

    return pd.DataFrame(rows)


def pick_daily_goal_reading_candidate(focus_df: pd.DataFrame):
    """
    上段の候補の中から、文章で説明するための行を選ぶ。
    売買推奨ではなく、目標設定の読み取り起点。
    """
    if focus_df is None or focus_df.empty:
        return None

    df = focus_df.copy()
    df["_win_rate"] = pd.to_numeric(df.get("目標必要勝率(%)"), errors="coerce")
    df["_pct_abs"] = pd.to_numeric(df.get("必要変動率(%)"), errors="coerce").abs()
    df["_losses"] = pd.to_numeric(df.get("目標許容損切り回数"), errors="coerce")
    df["_filled"] = pd.to_numeric(df.get("有効約定回数"), errors="coerce")
    df = df.dropna(subset=["_win_rate", "_pct_abs", "_filled"])
    df = df[df["_filled"] > 0]
    if df.empty:
        return None

    df["_over100"] = (df["_win_rate"] > 100).astype(int)
    df["_loss_penalty"] = df["_losses"].fillna(-1).apply(lambda x: 0 if x >= 0 else 1)
    return df.sort_values(["_over100", "_loss_penalty", "_win_rate", "_pct_abs"]).iloc[0]


def build_daily_goal_decision_note(
    focus_df: pd.DataFrame,
    daily_goal_profit_jpy: float,
    capital_amount_jpy: float,
    min_count: int,
    max_count: int,
    stop_loss_change_pct: float,
    unfilled_cancel_rate_pct: float,
) -> str:
    """
    「100円稼ぎたい。資金2000円。じゃあどう見る？」に答えるための上段メモ。
    売買判断ではなく、必要条件・厳しさ・見る順番を整理する。
    """
    if focus_df is None or focus_df.empty:
        return "今日の目標を整理できるデータがありません。現在価格・資金・回数設定を確認してください。"

    capital = float(_to_float_or_na(capital_amount_jpy)) if pd.notna(_to_float_or_na(capital_amount_jpy)) else 0.0
    goal = float(_to_float_or_na(daily_goal_profit_jpy)) if pd.notna(_to_float_or_na(daily_goal_profit_jpy)) else 0.0
    one_shot_plain = _daily_goal_plain_required_pct(goal, capital, 1)
    min_plain = _daily_goal_plain_required_pct(goal, capital, int(min_count))
    max_plain = _daily_goal_plain_required_pct(goal, capital, int(max_count))

    pieces = []
    pieces.append(f"今日の条件は、目標{fmt_yen(goal)}・資金{fmt_yen(capital)}です。")
    if pd.notna(one_shot_plain):
        pieces.append(f"手数料を抜いた単純計算では、1回で達成するなら約{fmt_pct(one_shot_plain, digits=2, signed=True)}、{min_count}回に分けるなら1回あたり約{fmt_pct(min_plain, digits=2, signed=True)}、{max_count}回なら約{fmt_pct(max_plain, digits=2, signed=True)}のNet相当が必要です。")

    one_rows = focus_df[pd.to_numeric(focus_df.get("想定機会回数"), errors="coerce") == 1]
    if not one_rows.empty:
        one = one_rows.iloc[0]
        pieces.append(f"1回勝負のコスト込み必要変動率は{fmt_pct(one.get('必要変動率(%)'), digits=4, signed=True)}です。ここが大きい場合、1回で狙うより回数を分けて見る方が考えやすくなります。")

    pick = pick_daily_goal_reading_candidate(focus_df)
    if pick is not None:
        count = int(pick.get("想定機会回数")) if pd.notna(pick.get("想定機会回数")) else 0
        filled = int(pick.get("有効約定回数")) if pd.notna(pick.get("有効約定回数")) else 0
        wins = pick.get("目標必要勝ち回数", pd.NA)
        wins_text = "—" if pd.isna(wins) else f"{int(wins)}勝"
        losses = pick.get("目標許容損切り回数", pd.NA)
        if pd.isna(losses):
            losses_text = "—"
        else:
            losses_text = "損切り余地なし" if int(losses) < 0 else f"損切りは最大{int(losses)}回程度"
        pieces.append(f"読み始めるなら、{pick.get('通貨', '')}の{count}回プランです。未約定キャンセル率{float(unfilled_cancel_rate_pct):.1f}%を入れると有効約定は{filled}回、目標には{wins_text}が目安です。")
        pieces.append(f"この候補のコスト込み必要変動率は{fmt_pct(pick.get('必要変動率(%)'), digits=4, signed=True)}、約定後に{float(stop_loss_change_pct):.2f}%逆行して損切りする想定では1回{fmt_yen(pick.get('損切り1回Net'), digits=2, signed=True)}、{losses_text}です。")

    pieces.append("これは買い・売りの指示ではなく、今日の目標が資金と回数に対してどれくらい厳しいかを読むための準備メモです。")
    return " ".join(pieces)


def parse_percentage_scenarios(text: str, defaults: list = None) -> list:
    """
    未約定シナリオ用のパーセントリストを読む。
    例: "10,30,50,70" / "10%, 30%" → [10.0, 30.0, 50.0, 70.0]
    """
    if defaults is None:
        defaults = [10, 30, 50, 70]

    normalized = (
        str(text)
        .replace("、", ",")
        .replace("，", ",")
        .replace("％", "%")
        .replace("%", "")
        .replace(" ", "")
    )

    values = []
    for part in normalized.split(","):
        if not part:
            continue
        value = _to_float_or_na(part)
        if pd.isna(value):
            continue
        value = max(0.0, min(100.0, float(value)))
        if value not in values:
            values.append(value)

    if values:
        return values
    return [float(v) for v in defaults]


def compute_daily_goal_unfilled_scenario_table(
    scenario_rates,
    current_df: pd.DataFrame,
    daily_goal_profit_jpy: float,
    investment_amounts,
    trade_counts,
    stop_loss_change_pct: float,
    limit_wait_minutes: float,
    limit_cancel_move_pct: float,
    taker_fee_pct: float,
    spread_pct: float,
    slippage_pct: float,
    fee_mode: str,
    rules_by_symbol: dict,
    order_books_by_symbol: dict,
    use_order_book_buy: bool,
    commissions: dict,
) -> pd.DataFrame:
    """
    未約定率を複数シナリオで並べる。
    未約定率は当てに行く値ではなく、目標が崩れやすいかを見る感度分析として使う。
    """
    frames = []
    for rate in scenario_rates:
        scenario_df = compute_daily_goal_simulation_table(
            current_df=current_df,
            daily_goal_profit_jpy=float(daily_goal_profit_jpy),
            investment_amounts=investment_amounts,
            trade_counts=trade_counts,
            stop_loss_change_pct=float(stop_loss_change_pct),
            unfilled_cancel_rate_pct=float(rate),
            limit_wait_minutes=float(limit_wait_minutes),
            limit_cancel_move_pct=float(limit_cancel_move_pct),
            taker_fee_pct=float(taker_fee_pct),
            spread_pct=float(spread_pct),
            slippage_pct=float(slippage_pct),
            fee_mode=str(fee_mode),
            rules_by_symbol=rules_by_symbol,
            order_books_by_symbol=order_books_by_symbol,
            use_order_book_buy=bool(use_order_book_buy),
            commissions=commissions,
        )
        if scenario_df is not None and not scenario_df.empty:
            scenario_df = scenario_df.copy()
            scenario_df["未約定シナリオ率(%)"] = float(rate)
            frames.append(scenario_df)

    if not frames:
        return pd.DataFrame()
    return pd.concat(frames, ignore_index=True)


def make_daily_goal_unfilled_scenario_display(scenario_df: pd.DataFrame) -> pd.DataFrame:
    """
    未約定シナリオ比較の表示用。

    v0.5-candidate-18:
    未約定想定が0回の行は、表に並べても情報量が少ないため省略する。
    0回ケースは未約定なしの基準ケースとして、追記メモ側で説明する。
    """
    if scenario_df is None or scenario_df.empty:
        return pd.DataFrame()

    df = scenario_df.copy()
    df["_symbol_order"] = df["通貨"].map({symbol: i for i, symbol in enumerate(SYMBOLS)}) if "通貨" in df.columns else 0
    df["_rate"] = pd.to_numeric(df.get("未約定シナリオ率(%)"), errors="coerce")
    df["_count"] = pd.to_numeric(df.get("想定機会回数"), errors="coerce")
    df["_unfilled_count"] = pd.to_numeric(df.get("未約定キャンセル想定回数"), errors="coerce")

    # 未約定0回は、比較表ではなく追記で扱う。
    df = df[df["_unfilled_count"].fillna(0) > 0].copy()

    if df.empty:
        return pd.DataFrame()

    df = df.sort_values(["_symbol_order", "_count", "_rate"])

    rows = []
    for _, row in df.iterrows():
        max_losses = row.get("目標許容損切り回数", pd.NA)
        if pd.isna(max_losses):
            max_losses_text = "—"
        else:
            try:
                max_losses_int = int(max_losses)
                max_losses_text = "なし/不足" if max_losses_int < 0 else f"{max_losses_int}回まで"
            except Exception:
                max_losses_text = "—"

        required_wins = row.get("目標必要勝ち回数", pd.NA)
        filled = row.get("有効約定回数", pd.NA)
        try:
            wins_text = "—" if pd.isna(required_wins) or pd.isna(filled) else f"{int(required_wins)}勝/{int(filled)}約定"
        except Exception:
            wins_text = "—"

        rows.append({
            "通貨": row.get("通貨", ""),
            "機会": f'{int(row.get("想定機会回数"))}回' if pd.notna(row.get("想定機会回数")) else "—",
            "未約定率": fmt_pct(row.get("未約定シナリオ率(%)"), digits=1),
            "未約定想定": f'{int(row.get("未約定キャンセル想定回数"))}回' if pd.notna(row.get("未約定キャンセル想定回数")) else "—",
            "有効約定": f'{int(row.get("有効約定回数"))}回' if pd.notna(row.get("有効約定回数")) else "—",
            "1回必要Net": fmt_yen(row.get("1回必要Net"), digits=2, signed=True),
            "必要変動率": fmt_pct(row.get("必要変動率(%)"), digits=4, signed=True),
            "必要勝ち": wins_text,
            "必要勝率": fmt_pct(row.get("目標必要勝率(%)"), digits=1),
            "損切り許容": max_losses_text,
            "準備感": _short_plan_status(
                row.get("目標必要勝率(%)"),
                row.get("必要変動率(%)"),
                row.get("目標許容損切り回数"),
                row.get("有効約定回数"),
            ),
        })

    return pd.DataFrame(rows)


def build_zero_unfilled_scenario_appendix(scenario_df: pd.DataFrame) -> str:
    """
    未約定0回として省略した行についての追記文を作る。
    """
    if scenario_df is None or scenario_df.empty:
        return ""

    df = scenario_df.copy()
    df["_unfilled_count"] = pd.to_numeric(df.get("未約定キャンセル想定回数"), errors="coerce")
    zero_df = df[df["_unfilled_count"].fillna(-1) == 0].copy()

    if zero_df.empty:
        return ""

    rate_text = ""
    if "未約定シナリオ率(%)" in zero_df.columns:
        rates = sorted({float(v) for v in pd.to_numeric(zero_df["未約定シナリオ率(%)"], errors="coerce").dropna().unique()})
        if rates:
            shown = ", ".join(f"{rate:g}%" for rate in rates[:6])
            if len(rates) > 6:
                shown += " ほか"
            rate_text = f"該当シナリオ率: {shown}。"

    count_text = ""
    if "想定機会回数" in zero_df.columns:
        counts = sorted({int(v) for v in pd.to_numeric(zero_df["想定機会回数"], errors="coerce").dropna().unique()})
        if counts:
            shown = ", ".join(f"{count}回" for count in counts[:8])
            if len(counts) > 8:
                shown += " ほか"
            count_text = f"対象機会回数: {shown}。"

    return (
        "未約定想定が0回になる行は、比較表から省略しました。"
        "0回ケースは『未約定なしで全機会が有効約定になる基準ケース』として見ます。"
        f"{rate_text}{count_text}"
        "必要Netや必要変動率は、上の回数別プランや今日の組み立て表で確認してください。"
    )


def build_unfilled_scenario_note(scenario_df: pd.DataFrame, plan_amount: float, daily_goal_profit_jpy: float, min_count: int, max_count: int) -> str:
    """
    未約定率をどう読めばよいかを短く説明する。
    """
    if scenario_df is None or scenario_df.empty:
        return "未約定シナリオを表示できるデータがありません。価格・資金・回数設定を確認してください。"

    df = scenario_df.copy()
    df["_rate"] = pd.to_numeric(df.get("未約定シナリオ率(%)"), errors="coerce")
    df["_count"] = pd.to_numeric(df.get("想定機会回数"), errors="coerce")
    df["_filled"] = pd.to_numeric(df.get("有効約定回数"), errors="coerce")
    df["_per_trade"] = pd.to_numeric(df.get("1回必要Net"), errors="coerce")
    df["_required_pct"] = pd.to_numeric(df.get("必要変動率(%)"), errors="coerce")
    df = df.dropna(subset=["_rate", "_count", "_filled", "_per_trade"])

    if df.empty:
        return "未約定率別の必要Netを計算できていません。"

    # 最大回数側を見ると、未約定率の影響が分かりやすい。
    focus_count = int(max_count)
    focus_df = df[df["_count"] == focus_count].copy()
    if focus_df.empty:
        focus_count = int(df["_count"].max())
        focus_df = df[df["_count"] == focus_count].copy()

    # まず最初の通貨を代表にする。売買判断ではなく読み方の説明用。
    first_symbol = SYMBOLS[0] if SYMBOLS else ""
    if "通貨" in focus_df.columns and first_symbol:
        symbol_df = focus_df[focus_df["通貨"] == first_symbol].copy()
        if not symbol_df.empty:
            focus_df = symbol_df

    low = focus_df.sort_values("_rate").iloc[0]
    high = focus_df.sort_values("_rate").iloc[-1]

    return (
        f"未約定率は当てる数字ではなく、感度分析として見ます。"
        f"{fmt_yen(plan_amount)}で日次目標{fmt_yen(daily_goal_profit_jpy)}、{focus_count}回の機会を想定すると、"
        f"未約定率{float(low.get('_rate')):.1f}%では有効約定{int(low.get('_filled'))}回・1回必要Net{fmt_yen(low.get('_per_trade'), digits=2, signed=True)}、"
        f"未約定率{float(high.get('_rate')):.1f}%では有効約定{int(high.get('_filled'))}回・1回必要Net{fmt_yen(high.get('_per_trade'), digits=2, signed=True)}になります。"
        f"未約定が増えるほど、残った約定で取り返す必要があり、必要変動率と必要勝ち回数が重くなります。"
        f"これは指値を浅くする/深く待つ判断の準備であり、売買指示ではありません。"
    )



def _daily_goal_target_ratio_label(ratio_pct) -> str:
    ratio = _to_float_or_na(ratio_pct)
    if pd.isna(ratio):
        return "未計算"
    ratio = float(ratio)
    if ratio <= 1.0:
        return "軽め"
    if ratio <= 3.0:
        return "中くらい"
    if ratio <= 5.0:
        return "高め"
    return "かなり高い"


def _daily_goal_required_pct_label(required_pct) -> str:
    pct = _to_float_or_na(required_pct)
    if pd.isna(pct):
        return "未計算"
    pct = abs(float(pct))
    if pct <= 0.30:
        return "軽め"
    if pct <= 0.80:
        return "現実味あり"
    if pct <= 1.50:
        return "やや重い"
    if pct <= 3.00:
        return "重い"
    return "かなり重い"


def _pick_representative_symbol_df(df: pd.DataFrame) -> pd.DataFrame:
    """
    読み取りメモ用に、まずBTCJPYなど最初の通貨を代表として取り出す。
    売買判断ではなく、同じ計算ロジックの読み方を説明するための代表行。
    """
    if df is None or df.empty:
        return pd.DataFrame()
    result = df.copy()
    if "通貨" in result.columns:
        for symbol in SYMBOLS:
            symbol_df = result[result["通貨"] == symbol].copy()
            if not symbol_df.empty:
                return symbol_df
    return result


def _pick_count_row(df: pd.DataFrame, count: int):
    if df is None or df.empty:
        return None
    temp = df.copy()
    temp["_count"] = pd.to_numeric(temp.get("想定機会回数"), errors="coerce")
    temp = temp[temp["_count"] == int(count)]
    if temp.empty:
        return None
    temp = _pick_representative_symbol_df(temp)
    if temp.empty:
        return None
    return temp.iloc[0]


def _pick_unfilled_rate_row(scenario_df: pd.DataFrame, count: int, preferred_rate: float):
    if scenario_df is None or scenario_df.empty:
        return None
    df = scenario_df.copy()
    df["_count"] = pd.to_numeric(df.get("想定機会回数"), errors="coerce")
    df["_rate"] = pd.to_numeric(df.get("未約定シナリオ率(%)"), errors="coerce")
    df = df[df["_count"] == int(count)]
    df = df.dropna(subset=["_rate"])
    if df.empty:
        return None
    df = _pick_representative_symbol_df(df)
    if df.empty:
        return None
    df["_rate_diff"] = (df["_rate"] - float(preferred_rate)).abs()
    return df.sort_values("_rate_diff").iloc[0]


def make_daily_goal_preparation_display(
    focus_df: pd.DataFrame,
    scenario_df: pd.DataFrame,
    daily_goal_profit_jpy: float,
    capital_amount_jpy: float,
    min_count: int,
    max_count: int,
) -> pd.DataFrame:
    """
    「100円ほしい、資金2000円。じゃあ何を見る？」を表より前に整理する簡易カード用データ。
    """
    rows = []
    goal = _to_float_or_na(daily_goal_profit_jpy)
    capital = _to_float_or_na(capital_amount_jpy)
    goal_ratio = pd.NA
    if pd.notna(goal) and pd.notna(capital) and float(capital) > 0:
        goal_ratio = (float(goal) / float(capital)) * 100.0

    rows.append({
        "見るところ": "目標と資金の比率",
        "値": fmt_pct(goal_ratio, digits=2),
        "読み方": _daily_goal_target_ratio_label(goal_ratio),
        "メモ": "資金に対して目標利益が何%か。ここが高いほど、1回あたりの必要値動きや勝率が重くなります。",
    })

    for label, count in [
        ("1回で狙う場合", 1),
        (f"{int(min_count)}回で分ける場合", int(min_count)),
        (f"{int(max_count)}回で分ける場合", int(max_count)),
    ]:
        row = _pick_count_row(focus_df, int(count))
        if row is None:
            rows.append({"見るところ": label, "値": "—", "読み方": "未計算", "メモ": "この回数の計算行がありません。"})
            continue
        wins = row.get("目標必要勝ち回数", pd.NA)
        filled = row.get("有効約定回数", pd.NA)
        if pd.notna(wins) and pd.notna(filled):
            win_text = f" / 必要勝ち {int(wins)}勝/{int(filled)}約定"
        else:
            win_text = ""
        rows.append({
            "見るところ": label,
            "値": fmt_pct(row.get("必要変動率(%)"), digits=4, signed=True),
            "読み方": _daily_goal_required_pct_label(row.get("必要変動率(%)")),
            "メモ": f"1回必要Net {fmt_yen(row.get('1回必要Net'), digits=2, signed=True)}{win_text}。コスト込みの必要変動率です。",
        })

    for preferred_rate in [30.0, 50.0]:
        row = _pick_unfilled_rate_row(scenario_df, int(max_count), preferred_rate)
        label = f"未約定{preferred_rate:.0f}%で見る"
        if row is None:
            rows.append({"見るところ": label, "値": "—", "読み方": "未計算", "メモ": "未約定シナリオの計算行がありません。"})
            continue
        rows.append({
            "見るところ": label,
            "値": fmt_pct(row.get("必要変動率(%)"), digits=4, signed=True),
            "読み方": _daily_goal_required_pct_label(row.get("必要変動率(%)")),
            "メモ": f"{int(row.get('想定機会回数'))}回の機会中、有効約定 {int(row.get('有効約定回数'))}回。1回必要Net {fmt_yen(row.get('1回必要Net'), digits=2, signed=True)}。",
        })

    return pd.DataFrame(rows)


def build_daily_goal_practical_guidance(
    focus_df: pd.DataFrame,
    scenario_df: pd.DataFrame,
    daily_goal_profit_jpy: float,
    capital_amount_jpy: float,
    min_count: int,
    max_count: int,
    stop_loss_change_pct: float,
) -> str:
    """
    日次目標を、表を見る前に文章で整理する。
    売買提案ではなく、目標・資金・回数・未約定・損切りの厳しさを読むためのガイド。
    """
    goal = _to_float_or_na(daily_goal_profit_jpy)
    capital = _to_float_or_na(capital_amount_jpy)
    if pd.isna(goal) or pd.isna(capital) or float(capital) <= 0:
        return "今日の目標と資金を入れると、準備メモを表示します。"

    goal_ratio = (float(goal) / float(capital)) * 100.0
    one_row = _pick_count_row(focus_df, 1)
    min_row = _pick_count_row(focus_df, int(min_count))
    max_row = _pick_count_row(focus_df, int(max_count))
    unfilled30 = _pick_unfilled_rate_row(scenario_df, int(max_count), 30.0)
    unfilled50 = _pick_unfilled_rate_row(scenario_df, int(max_count), 50.0)

    pieces = []
    pieces.append(
        f"今日の目標は{fmt_yen(goal)}、資金/主投入額は{fmt_yen(capital)}なので、目標は資金の{fmt_pct(goal_ratio, digits=2)}です。"
        f"この比率の読み方は「{_daily_goal_target_ratio_label(goal_ratio)}」です。"
    )

    if one_row is not None:
        one_pct = one_row.get("必要変動率(%)")
        pieces.append(
            f"1回で狙う場合は、コスト込みで{fmt_pct(one_pct, digits=4, signed=True)}程度が必要です。"
            f"読み方は「{_daily_goal_required_pct_label(one_pct)}」です。"
        )

    if min_row is not None and max_row is not None:
        pieces.append(
            f"{int(min_count)}回で分けると1回必要Netは{fmt_yen(min_row.get('1回必要Net'), digits=2, signed=True)}、"
            f"{int(max_count)}回で分けると{fmt_yen(max_row.get('1回必要Net'), digits=2, signed=True)}になります。"
            f"回数を増やすと1回の必要額は軽くなりますが、未約定や損切りの管理が重要になります。"
        )

    if unfilled30 is not None and unfilled50 is not None:
        pieces.append(
            f"未約定を入れるなら、{int(max_count)}回の機会でも未約定30%では有効約定{int(unfilled30.get('有効約定回数'))}回、"
            f"未約定50%では有効約定{int(unfilled50.get('有効約定回数'))}回として見ます。"
            f"未約定50%側でも必要変動率が重すぎないかを確認してください。"
        )

    if max_row is not None:
        losses = max_row.get("目標許容損切り回数", pd.NA)
        loss_net = max_row.get("損切り1回Net", pd.NA)
        if pd.notna(losses):
            if int(losses) < 0:
                loss_text = "この条件では損切りを入れる余裕がほぼありません。"
            else:
                loss_text = f"約定後に{float(stop_loss_change_pct):.2f}%逆行した損切りは、目安として最大{int(losses)}回程度までです。"
            pieces.append(f"損切り1回の例は{fmt_yen(loss_net, digits=2, signed=True)}です。{loss_text}")

    pieces.append("これは売買の指示ではなく、今日の目標が資金・回数・未約定・損切りに対してどれくらい厳しいかを整理するための読み取りです。")
    return " ".join(pieces)

def seconds_until_next_save(last_saved_at, save_interval_sec: int):
    if last_saved_at is None:
        return 0

    now_utc = pd.Timestamp.now(tz="UTC")
    elapsed = (now_utc - last_saved_at).total_seconds()
    return max(0, int(save_interval_sec - elapsed))


CHART_INTERVAL_OPTIONS = {
    "そのまま": None,
    "1分": "1min",
    "5分": "5min",
    "15分": "15min",
    "30分": "30min",
    "1時間": "1h",
    "3時間": "3h",
    "1日": "1D",
}


def normalize_chart_interval(value: str) -> str:
    if value in CHART_INTERVAL_OPTIONS:
        return value
    return "そのまま"


def resample_symbol_for_chart(symbol_df: pd.DataFrame, interval_label: str) -> pd.DataFrame:
    """
    グラフ表示用に、実際の時刻軸のまま指定間隔で集約する。

    - そのまま: 保存された全点をそのまま表示
    - 1分/5分/15分/30分/1時間/3時間/1日:
      各時間枠の最後の価格を表示
    """
    df = symbol_df.copy()
    df = df.sort_values("timestamp_dt")
    df["price_jpy"] = pd.to_numeric(df["price_jpy"], errors="coerce")
    df = df.dropna(subset=["timestamp_dt", "price_jpy"])
    df = df[df["price_jpy"] > 0]

    if df.empty:
        return df

    interval_label = normalize_chart_interval(interval_label)
    freq = CHART_INTERVAL_OPTIONS[interval_label]

    if freq is None:
        return df.tail(300)

    symbol = str(df["symbol"].iloc[-1]) if "symbol" in df.columns and not df.empty else ""

    resampled = (
        df.set_index("timestamp_dt")
        .resample(freq)["price_jpy"]
        .last()
        .dropna()
        .reset_index()
    )

    if resampled.empty:
        return resampled

    resampled["symbol"] = symbol
    resampled["timestamp"] = (
        resampled["timestamp_dt"]
        .dt.tz_convert(JST)
        .dt.strftime("%Y-%m-%dT%H:%M:%S%z")
    )

    return resampled[["timestamp", "timestamp_dt", "symbol", "price_jpy"]].tail(300)




def chart_interval_ascii_label(interval_label: str) -> str:
    """
    matplotlib内のタイトルや軸ラベルは日本語フォント環境によって文字化けしやすい。
    グラフ内だけ英数字ラベルに変換する。
    """
    mapping = {
        "そのまま": "raw",
        "1分": "1min",
        "5分": "5min",
        "15分": "15min",
        "30分": "30min",
        "1時間": "1h",
        "3時間": "3h",
        "1日": "1d",
    }
    return mapping.get(str(interval_label), str(interval_label))

# =========================
# グラフ時刻軸
# =========================

def configure_time_axis(ax, chart_df: pd.DataFrame, chart_interval: str):
    """
    グラフの横軸を読みやすくする。
    目盛り・ラベルは必ずJST（日本時間）で表示する。

    特に「30分」を選んだときは、
    00分・30分の目盛りを明示して、30分ごとの流れが分かるようにする。
    横軸そのものは、実際の時刻間隔のまま。
    """
    if chart_df is None or chart_df.empty or "timestamp_jst" not in chart_df.columns:
        return

    start_time = chart_df["timestamp_jst"].min()
    end_time = chart_df["timestamp_jst"].max()

    if pd.isna(start_time) or pd.isna(end_time):
        return

    span_seconds = (end_time - start_time).total_seconds()

    if chart_interval == "30分":
        # 30分足でも、主目盛りは毎時00分だけにする。
        # 30分は補助目盛りに回すと、時間の区切りが読みやすい。
        ax.xaxis.set_major_locator(mdates.MinuteLocator(byminute=[0], tz=JST))
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%m-%d %H:%M", tz=JST))
        ax.xaxis.set_minor_locator(mdates.MinuteLocator(byminute=[30], tz=JST))

        # 00分の縦線を強め、30分の縦線を薄くする
        ax.grid(True, which="major", axis="x", alpha=0.50)
        ax.grid(True, which="minor", axis="x", alpha=0.18)

    elif chart_interval == "15分":
        ax.xaxis.set_major_locator(mdates.MinuteLocator(byminute=[0, 15, 30, 45], tz=JST))
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M", tz=JST))
        ax.xaxis.set_minor_locator(mdates.MinuteLocator(interval=5, tz=JST))
        ax.grid(True, which="major", axis="x", alpha=0.35)
        ax.grid(True, which="minor", axis="x", alpha=0.12)

    elif chart_interval == "1時間":
        ax.xaxis.set_major_locator(mdates.HourLocator(interval=1, tz=JST))
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%m-%d %H:%M", tz=JST))
        ax.xaxis.set_minor_locator(mdates.MinuteLocator(byminute=[30], tz=JST))
        ax.grid(True, which="major", axis="x", alpha=0.40)
        ax.grid(True, which="minor", axis="x", alpha=0.15)

    elif chart_interval == "3時間":
        ax.xaxis.set_major_locator(mdates.HourLocator(interval=3, tz=JST))
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%m-%d %H:%M", tz=JST))
        ax.grid(True, which="major", axis="x", alpha=0.40)

    elif chart_interval == "1日":
        ax.xaxis.set_major_locator(mdates.DayLocator(interval=1, tz=JST))
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%m-%d", tz=JST))
        ax.grid(True, which="major", axis="x", alpha=0.40)

    else:
        # 「そのまま」「1分」「5分」は、期間の長さに合わせて自動調整。
        if span_seconds <= 3 * 60 * 60:
            ax.xaxis.set_major_locator(mdates.MinuteLocator(interval=30, tz=JST))
            ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M", tz=JST))
            ax.xaxis.set_minor_locator(mdates.MinuteLocator(interval=10, tz=JST))
        elif span_seconds <= 24 * 60 * 60:
            ax.xaxis.set_major_locator(mdates.HourLocator(interval=1, tz=JST))
            ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M", tz=JST))
            ax.xaxis.set_minor_locator(mdates.MinuteLocator(byminute=[30], tz=JST))
        else:
            ax.xaxis.set_major_locator(mdates.AutoDateLocator(tz=JST))
            ax.xaxis.set_major_formatter(mdates.DateFormatter("%m-%d %H:%M", tz=JST))

        ax.grid(True, which="major", axis="x", alpha=0.35)
        ax.grid(True, which="minor", axis="x", alpha=0.12)

def floor_time_to_interval(ts, interval_label: str):
    """
    横軸の左端を、選択した時間間隔の境界に丸める。
    """
    ts = pd.Timestamp(ts)

    if interval_label == "30分":
        minute = 0 if ts.minute < 30 else 30
        return ts.replace(minute=minute, second=0, microsecond=0)

    if interval_label == "15分":
        minute = (ts.minute // 15) * 15
        return ts.replace(minute=minute, second=0, microsecond=0)

    if interval_label == "5分":
        minute = (ts.minute // 5) * 5
        return ts.replace(minute=minute, second=0, microsecond=0)

    if interval_label == "1分":
        return ts.replace(second=0, microsecond=0)

    if interval_label == "1時間":
        return ts.replace(minute=0, second=0, microsecond=0)

    if interval_label == "3時間":
        hour = (ts.hour // 3) * 3
        return ts.replace(hour=hour, minute=0, second=0, microsecond=0)

    if interval_label == "1日":
        return ts.replace(hour=0, minute=0, second=0, microsecond=0)

    # そのままの場合は、見やすさ優先で30分境界に丸める
    minute = 0 if ts.minute < 30 else 30
    return ts.replace(minute=minute, second=0, microsecond=0)


def ceil_time_to_interval(ts, interval_label: str):
    """
    横軸の右端を、選択した時間間隔の次の境界に丸める。
    これにより、グラフ右端が最新時刻ではなく、00分/30分などの基準時刻になる。
    """
    ts = pd.Timestamp(ts)
    floored = floor_time_to_interval(ts, interval_label)

    if ts == floored:
        return floored

    if interval_label == "1分":
        return floored + pd.Timedelta(minutes=1)

    if interval_label == "5分":
        return floored + pd.Timedelta(minutes=5)

    if interval_label == "15分":
        return floored + pd.Timedelta(minutes=15)

    if interval_label == "30分":
        return floored + pd.Timedelta(minutes=30)

    if interval_label == "1時間":
        return floored + pd.Timedelta(hours=1)

    if interval_label == "3時間":
        return floored + pd.Timedelta(hours=3)

    if interval_label == "1日":
        return floored + pd.Timedelta(days=1)

    # そのままの場合は30分境界
    return floored + pd.Timedelta(minutes=30)


def configure_time_xlim(ax, chart_df: pd.DataFrame, chart_interval: str):
    """
    横軸の表示範囲を、最新時刻そのものではなく、
    JST（日本時間）の時刻境界に合わせる。
    
    選択した時間間隔の境界に合わせる。

    例:
    - 30分表示なら、右端は 10:00 / 10:30 / 11:00 / 11:30 ...
    - 1時間表示なら、右端は 10:00 / 11:00 / 12:00 ...
    """
    if chart_df is None or chart_df.empty or "timestamp_jst" not in chart_df.columns:
        return

    start_time = chart_df["timestamp_jst"].min()
    end_time = chart_df["timestamp_jst"].max()

    if pd.isna(start_time) or pd.isna(end_time):
        return

    x_min = floor_time_to_interval(start_time, chart_interval)
    x_max = ceil_time_to_interval(end_time, chart_interval)

    # データが1点だけ、または範囲が潰れる場合の保険
    if x_max <= x_min:
        x_max = x_min + pd.Timedelta(minutes=30)

    ax.set_xlim(x_min, x_max)


# =========================
# グラフ
# =========================

def get_symbol_axis_settings(settings: dict, symbol: str):
    symbol_ranges = settings.get("symbol_axis_ranges", {})
    item = symbol_ranges.get(symbol, {}) if isinstance(symbol_ranges, dict) else {}

    return {
        "enabled": bool(item.get("enabled", False)),
        "min": item.get("min", 8000),
        "max": item.get("max", 13000),
    }


def calc_price_axis_domain(
    symbol_df: pd.DataFrame,
    min_axis_width: float,
    padding_pct: float,
    manual_enabled: bool = False,
    manual_min=None,
    manual_max=None,
):
    """
    価格グラフのY軸を決める。

    v0.4.1.12:
    - matplotlibのax.set_ylim()でY軸を固定する
    - 自動でも0始まりにしない
    - matplotlibのオフセット表示を禁止し、軸ラベルを実価格で表示する
    - 手動指定がONなら、その範囲を最優先する
    """
    prices = pd.to_numeric(symbol_df["price_jpy"], errors="coerce").dropna()
    prices = prices[prices > 0]

    if prices.empty:
        return None

    min_price = float(prices.min())
    max_price = float(prices.max())

    if manual_enabled:
        y_min = pd.to_numeric(manual_min, errors="coerce")
        y_max = pd.to_numeric(manual_max, errors="coerce")

        if pd.notna(y_min) and pd.notna(y_max):
            y_min = float(y_min)
            y_max = float(y_max)

            if y_min <= 0:
                y_min = max(min_price * 0.995, 1.0)

            if y_max > y_min:
                return [float(y_min), float(y_max)]

    actual_width = max_price - min_price
    min_axis_width = max(float(min_axis_width), 0.0)
    padding_pct = max(float(padding_pct), 0.0)

    if actual_width <= 0:
        fallback_width = min_axis_width if min_axis_width > 0 else max(min_price * 0.0005, 10.0)
        y_min = min_price - (fallback_width / 2)
        y_max = max_price + (fallback_width / 2)
    else:
        padding = max(actual_width * (padding_pct / 100.0), 1.0)
        y_min = min_price - padding
        y_max = max_price + padding

    current_width = y_max - y_min

    if min_axis_width > 0 and current_width < min_axis_width:
        shortage = min_axis_width - current_width
        y_min -= shortage * 0.25
        y_max += shortage * 0.75

    # 0に落ちないための最終補正
    if y_min <= 0:
        y_min = max(min_price - max(actual_width * 0.10, min_price * 0.001, 1.0), 1.0)
        if y_max <= y_min:
            y_max = y_min + max(actual_width, min_price * 0.001, 10.0)

    return [float(y_min), float(y_max)]


def make_price_chart_matplotlib(
    symbol_df: pd.DataFrame,
    symbol: str,
    min_axis_width: float,
    padding_pct: float,
    chart_interval: str,
    manual_enabled: bool = False,
    manual_min=None,
    manual_max=None,
):
    if not MATPLOTLIB_AVAILABLE:
        return None, None, "matplotlib がインストールされていません。"

    chart_df = resample_symbol_for_chart(symbol_df, chart_interval)

    if chart_df.empty:
        return None, None, "表示できる価格データがありません。"

    chart_df["timestamp_jst"] = chart_df["timestamp_dt"].dt.tz_convert(JST)
    chart_df["price_jpy"] = pd.to_numeric(chart_df["price_jpy"], errors="coerce")
    chart_df = chart_df.dropna(subset=["timestamp_jst", "price_jpy"])
    chart_df = chart_df[chart_df["price_jpy"] > 0]

    if chart_df.empty:
        return None, None, "表示できる価格データがありません。"

    domain = calc_price_axis_domain(
        chart_df,
        min_axis_width=min_axis_width,
        padding_pct=padding_pct,
        manual_enabled=manual_enabled,
        manual_min=manual_min,
        manual_max=manual_max,
    )

    if domain is None:
        return None, None, "Y軸範囲を計算できません。"

    fig, ax = plt.subplots(figsize=(10, 3.4))
    ax.plot(
        chart_df["timestamp_jst"],
        chart_df["price_jpy"],
        marker="o",
        linewidth=1.8,
        markersize=4,
    )

    # ここでY軸を強制固定する。これで0始まりを避ける。
    ax.set_ylim(domain[0], domain[1])

    ax.set_title(f"{symbol} / {chart_interval_ascii_label(chart_interval)}")
    ax.set_xlabel("Time")
    ax.set_ylabel("Price (JPY)")
    ax.grid(True, alpha=0.3)

    configure_time_axis(ax, chart_df, chart_interval)
    configure_time_xlim(ax, chart_df, chart_interval)

    # matplotlibは大きな価格を描くと、Y軸を「+20,000,000」のような
    # オフセット表示にして、目盛だけ 0〜12000 のように出すことがある。
    # それだと実価格レンジが分からないので、オフセット表示を完全に止める。
    ax.ticklabel_format(style="plain", axis="y", useOffset=False)
    ax.yaxis.get_major_formatter().set_useOffset(False)
    ax.yaxis.set_major_formatter(FuncFormatter(lambda x, pos: f"{x:,.0f}"))

    fig.autofmt_xdate()
    fig.tight_layout()

    return fig, domain, None


def make_pct_chart_matplotlib(symbol_df: pd.DataFrame, symbol: str, chart_interval: str):
    if not MATPLOTLIB_AVAILABLE:
        return None, "matplotlib がインストールされていません。"

    chart_df = resample_symbol_for_chart(symbol_df, chart_interval)
    chart_df = chart_df.sort_values("timestamp_dt")
    chart_df["timestamp_jst"] = chart_df["timestamp_dt"].dt.tz_convert(JST)
    chart_df["pct_change"] = pd.to_numeric(chart_df["price_jpy"], errors="coerce").pct_change() * 100
    chart_df = chart_df.dropna(subset=["timestamp_jst", "pct_change"]).tail(300)

    if chart_df.empty:
        return None, "履歴が2件以上になると表示されます。"

    fig, ax = plt.subplots(figsize=(6, 2.6))
    ax.plot(
        chart_df["timestamp_jst"],
        chart_df["pct_change"],
        marker="o",
        linewidth=1.5,
        markersize=3,
    )
    ax.set_title(f"{symbol} / {chart_interval_ascii_label(chart_interval)}")
    ax.set_xlabel("Time")
    ax.set_ylabel("Change (%)")
    ax.grid(True, alpha=0.3)

    configure_time_axis(ax, chart_df, chart_interval)
    configure_time_xlim(ax, chart_df, chart_interval)

    ax.yaxis.set_major_formatter(FuncFormatter(lambda x, pos: f"{x:.4f}%"))
    fig.autofmt_xdate()
    fig.tight_layout()

    return fig, None




# =========================
# 急騰検出アラート
# =========================

def parse_alert_start_time(time_text: str):
    """
    HH:MM形式の時刻を返す。失敗したら23:30。
    """
    try:
        parts = str(time_text).strip().split(":")
        hour = int(parts[0])
        minute = int(parts[1])
        if 0 <= hour <= 23 and 0 <= minute <= 59:
            return hour, minute
    except Exception:
        pass

    return 23, 30


def calc_linearity_stats(prices: pd.Series) -> dict:
    """
    価格推移がどれくらい一方向・直線的かを簡易評価する。

    rising_ratio:
        連続する価格差のうち、上昇だった割合。

    r2:
        価格を「時間順に一直線」と見たときの当てはまり。
    """
    y = pd.to_numeric(prices, errors="coerce").dropna().reset_index(drop=True)

    if len(y) < 2:
        return {"rising_ratio": pd.NA, "r2": pd.NA}

    diffs = y.diff().dropna()
    rising_ratio = float((diffs > 0).mean() * 100) if len(diffs) else pd.NA

    if len(y) < 3:
        return {"rising_ratio": rising_ratio, "r2": pd.NA}

    x = pd.Series(range(len(y)), dtype="float64")
    y = y.astype("float64")

    x_mean = x.mean()
    y_mean = y.mean()
    denom = ((x - x_mean) ** 2).sum()

    if denom == 0:
        return {"rising_ratio": rising_ratio, "r2": pd.NA}

    slope = ((x - x_mean) * (y - y_mean)).sum() / denom
    intercept = y_mean - slope * x_mean
    y_hat = slope * x + intercept

    ss_res = ((y - y_hat) ** 2).sum()
    ss_tot = ((y - y_mean) ** 2).sum()

    r2 = 1.0 if ss_tot == 0 else max(0.0, float(1 - ss_res / ss_tot))

    return {"rising_ratio": rising_ratio, "r2": r2}


def compute_rise_alerts(history_df: pd.DataFrame, current_df: pd.DataFrame, settings: dict) -> pd.DataFrame:
    """
    指定した基準時刻から現在までの急騰を監視する。

    例:
    - 基準時刻: 23:30
    - 現在: 23:40過ぎ
    - その間の上昇額、上昇率、上昇ステップ率、直線っぽさを計算
    """
    if history_df is None:
        history_df = empty_history_df()

    source_df = pd.concat([history_df, current_df], ignore_index=True)
    source_df = normalize_history_dataframe(source_df)

    if source_df.empty:
        return pd.DataFrame()

    alert_enabled = bool(settings.get("alert_enabled", True))
    start_text = str(settings.get("alert_start_time", "23:30"))
    start_hour, start_minute = parse_alert_start_time(start_text)

    threshold_pct = float(settings.get("alert_threshold_pct", 0.03))
    rising_ratio_threshold = float(settings.get("alert_rising_ratio", 70.0))
    r2_threshold = float(settings.get("alert_r2_threshold", 0.60))

    rows = []

    for symbol in SYMBOLS:
        symbol_setting = get_alert_symbol_setting(settings, symbol)

        if not symbol_setting["enabled"]:
            continue

        symbol_df = source_df[source_df["symbol"] == symbol].copy()
        symbol_df = symbol_df.sort_values("timestamp_dt")

        if symbol_df.empty:
            continue

        latest_ts = symbol_df["timestamp_dt"].max()
        latest_jst = latest_ts.tz_convert(JST)

        start_jst = latest_jst.replace(
            hour=start_hour,
            minute=start_minute,
            second=0,
            microsecond=0,
        )

        # 日付をまたいだ深夜にも対応。
        # 最新時刻が基準時刻より前なら、前日の基準時刻から見る。
        if latest_jst < start_jst:
            start_jst = start_jst - pd.Timedelta(days=1)

        start_utc = start_jst.tz_convert("UTC")

        window_df = symbol_df[symbol_df["timestamp_dt"] >= start_utc].copy()
        window_df = window_df.sort_values("timestamp_dt")

        if len(window_df) < 2:
            rows.append({
                "種類": "固定時刻",
                "通貨": symbol,
                "状態": "データ不足",
                "監視範囲": f"{start_text}から（実データ基準）",
                "基準時刻": symbol_df.iloc[-1]["timestamp_dt"].tz_convert(JST).strftime("%Y-%m-%d %H:%M"),
                "基準価格": pd.NA,
                "現在価格": pd.to_numeric(symbol_df.iloc[-1]["price_jpy"], errors="coerce"),
                "上昇額": pd.NA,
                "上昇率(%)": pd.NA,
                "上昇ステップ率(%)": pd.NA,
                "直線っぽさR2": pd.NA,
                "判定理由": "基準時刻以降の履歴が2点未満です。",
            })
            continue

        base_price = float(window_df.iloc[0]["price_jpy"])
        current_price = float(window_df.iloc[-1]["price_jpy"])
        diff_yen = current_price - base_price
        pct = (diff_yen / base_price) * 100 if base_price else pd.NA

        stats = calc_linearity_stats(window_df["price_jpy"])
        rising_ratio = stats["rising_ratio"]
        r2 = stats["r2"]

        threshold_yen = float(symbol_setting["threshold_yen"])

        amount_hit = diff_yen >= threshold_yen
        pct_hit = pd.notna(pct) and pct >= threshold_pct
        direction_hit = pd.notna(rising_ratio) and rising_ratio >= rising_ratio_threshold
        linear_hit = pd.notna(r2) and r2 >= r2_threshold

        if not alert_enabled:
            status = "OFF"
            reason = "アラートはOFFです。"
        elif diff_yen <= 0:
            status = "通常"
            reason = "基準時刻から上昇していません。"
        elif (amount_hit or pct_hit) and direction_hit and linear_hit:
            status = "急騰"
            reason = "上昇額/上昇率がしきい値以上で、上昇ステップ率と直線っぽさも高いです。"
        elif amount_hit or pct_hit:
            status = "注意"
            reason = "上昇額または上昇率がしきい値以上です。ただし直線性条件は未達の可能性があります。"
        elif direction_hit and linear_hit:
            status = "上昇傾向"
            reason = "しきい値未満ですが、上昇方向と直線っぽさがあります。"
        else:
            status = "通常"
            reason = "急騰条件には達していません。"

        actual_base_time = window_df.iloc[0]["timestamp_dt"].tz_convert(JST).strftime("%Y-%m-%d %H:%M")

        rows.append({
            "種類": "固定時刻",
            "通貨": symbol,
            "状態": status,
            "監視範囲": f"{start_text}から（実データ基準）",
            "基準時刻": actual_base_time,
            "基準価格": base_price,
            "現在価格": current_price,
            "上昇額": diff_yen,
            "上昇率(%)": pct,
            "上昇ステップ率(%)": rising_ratio,
            "直線っぽさR2": r2,
            "判定理由": reason,
        })

    return pd.DataFrame(rows)



def compute_rolling_rise_alerts(history_df: pd.DataFrame, current_df: pd.DataFrame, settings: dict) -> pd.DataFrame:
    """
    固定時刻ではなく、直近N分の値動きから急騰を検出する。

    例:
    - 直近10分
    - 直近15分
    - 直近30分

    判定は以下を見る:
    - 上昇額
    - 上昇率
    - 上昇ステップ率
    - 直線っぽさR2
    """
    if history_df is None:
        history_df = empty_history_df()

    source_df = pd.concat([history_df, current_df], ignore_index=True)
    source_df = normalize_history_dataframe(source_df)

    if source_df.empty:
        return pd.DataFrame()

    alert_enabled = bool(settings.get("alert_enabled", True))
    rolling_enabled = bool(settings.get("rolling_alert_enabled", True))
    window_minutes = int(settings.get("rolling_alert_window_minutes", 10))

    if window_minutes <= 0:
        window_minutes = 10

    threshold_pct = float(settings.get("alert_threshold_pct", 0.03))
    rising_ratio_threshold = float(settings.get("alert_rising_ratio", 70.0))
    r2_threshold = float(settings.get("alert_r2_threshold", 0.60))

    rows = []

    for symbol in SYMBOLS:
        symbol_setting = get_alert_symbol_setting(settings, symbol)

        if not symbol_setting["enabled"]:
            continue

        symbol_df = source_df[source_df["symbol"] == symbol].copy()
        symbol_df = symbol_df.sort_values("timestamp_dt")

        if symbol_df.empty:
            continue

        latest_ts = symbol_df["timestamp_dt"].max()
        start_utc = latest_ts - pd.Timedelta(minutes=window_minutes)

        window_df = symbol_df[symbol_df["timestamp_dt"] >= start_utc].copy()
        window_df = window_df.sort_values("timestamp_dt")

        if len(window_df) < 2:
            rows.append({
                "種類": "直近監視",
                "通貨": symbol,
                "状態": "データ不足",
                "監視範囲": f"直近{window_minutes}分",
                "基準時刻": symbol_df.iloc[-1]["timestamp_dt"].tz_convert(JST).strftime("%Y-%m-%d %H:%M"),
                "基準価格": pd.NA,
                "現在価格": pd.to_numeric(symbol_df.iloc[-1]["price_jpy"], errors="coerce"),
                "上昇額": pd.NA,
                "上昇率(%)": pd.NA,
                "上昇ステップ率(%)": pd.NA,
                "直線っぽさR2": pd.NA,
                "判定理由": "直近監視範囲内の履歴が2点未満です。",
            })
            continue

        base_price = float(window_df.iloc[0]["price_jpy"])
        current_price = float(window_df.iloc[-1]["price_jpy"])
        diff_yen = current_price - base_price
        pct = (diff_yen / base_price) * 100 if base_price else pd.NA

        stats = calc_linearity_stats(window_df["price_jpy"])
        rising_ratio = stats["rising_ratio"]
        r2 = stats["r2"]

        threshold_yen = float(symbol_setting["threshold_yen"])

        amount_hit = diff_yen >= threshold_yen
        pct_hit = pd.notna(pct) and pct >= threshold_pct
        direction_hit = pd.notna(rising_ratio) and rising_ratio >= rising_ratio_threshold
        linear_hit = pd.notna(r2) and r2 >= r2_threshold

        if not alert_enabled or not rolling_enabled:
            status = "OFF"
            reason = "直近監視アラートはOFFです。"
        elif diff_yen <= 0:
            status = "通常"
            reason = "直近監視範囲では上昇していません。"
        elif (amount_hit or pct_hit) and direction_hit and linear_hit:
            status = "急騰"
            reason = "直近監視範囲で、上昇額/上昇率・上昇ステップ率・直線っぽさが条件を満たしました。"
        elif amount_hit or pct_hit:
            status = "注意"
            reason = "直近監視範囲で、上昇額または上昇率がしきい値以上です。"
        elif direction_hit and linear_hit:
            status = "上昇傾向"
            reason = "しきい値未満ですが、直近監視範囲で直線的な上昇傾向があります。"
        else:
            status = "通常"
            reason = "直近監視の急騰条件には達していません。"

        rows.append({
            "種類": "直近監視",
            "通貨": symbol,
            "状態": status,
            "監視範囲": f"直近{window_minutes}分",
            "基準時刻": window_df.iloc[0]["timestamp_dt"].tz_convert(JST).strftime("%Y-%m-%d %H:%M"),
            "基準価格": base_price,
            "現在価格": current_price,
            "上昇額": diff_yen,
            "上昇率(%)": pct,
            "上昇ステップ率(%)": rising_ratio,
            "直線っぽさR2": r2,
            "判定理由": reason,
        })

    return pd.DataFrame(rows)





def parse_sustained_windows(text: str) -> list:
    """
    継続上昇検出に使う分数リストを読む。
    例: "15,20,30" → [15, 20, 30]
    """
    normalized = (
        str(text)
        .replace("、", ",")
        .replace("，", ",")
        .replace("分", "")
        .replace(" ", "")
    )

    windows = []
    for part in normalized.split(","):
        if not part:
            continue
        try:
            value = int(float(part))
        except Exception:
            continue
        if 5 <= value <= 180 and value not in windows:
            windows.append(value)

    return windows if windows else [15, 20, 30]


def calc_pullback_stats(prices: pd.Series) -> dict:
    """
    継続上昇のための押し戻しを簡易計算する。

    max_pullback_pct:
        途中の高値から、どれくらい押し戻されたかの最大値。
    close_from_high_pct:
        最後の価格が、窓内高値からどれくらい離れているか。
    """
    y = pd.to_numeric(prices, errors="coerce").dropna().reset_index(drop=True)

    if y.empty:
        return {"max_pullback_pct": pd.NA, "close_from_high_pct": pd.NA, "high_price": pd.NA}

    running_peak = float(y.iloc[0])
    max_pullback_pct = 0.0

    for value in y:
        value = float(value)
        if value > running_peak:
            running_peak = value
        if running_peak > 0:
            pullback = ((running_peak - value) / running_peak) * 100
            max_pullback_pct = max(max_pullback_pct, pullback)

    high_price = float(y.max())
    close_price = float(y.iloc[-1])
    close_from_high_pct = ((high_price - close_price) / high_price) * 100 if high_price else pd.NA

    return {
        "max_pullback_pct": max_pullback_pct,
        "close_from_high_pct": close_from_high_pct,
        "high_price": high_price,
    }


def compute_sustained_rise_alerts(history_df: pd.DataFrame, current_df: pd.DataFrame, settings: dict) -> pd.DataFrame:
    """
    15分・20分・30分など、急騰より少し長い時間で上昇が続いているかを見る。

    急騰検出:
        短時間で強く上がったか。
    継続上昇検出:
        一時的な跳ねではなく、上昇が続いていて、最後も高値圏にいるか。
    """
    if history_df is None:
        history_df = empty_history_df()

    source_df = pd.concat([history_df, current_df], ignore_index=True)
    source_df = normalize_history_dataframe(source_df)

    if source_df.empty:
        return pd.DataFrame()

    alert_enabled = bool(settings.get("alert_enabled", True))
    sustained_enabled = bool(settings.get("sustained_rise_enabled", True))
    windows = parse_sustained_windows(settings.get("sustained_rise_windows_text", "15,20,30"))

    threshold_pct = float(settings.get("alert_threshold_pct", 0.03))
    rising_ratio_threshold = float(settings.get("alert_rising_ratio", 60.0))
    r2_threshold = float(settings.get("alert_r2_threshold", 0.45))
    max_pullback_limit_pct = float(settings.get("sustained_rise_max_pullback_pct", 0.05))
    close_near_high_limit_pct = float(settings.get("sustained_rise_close_near_high_pct", 0.03))

    rows = []

    for symbol in SYMBOLS:
        symbol_setting = get_alert_symbol_setting(settings, symbol)

        if not symbol_setting["enabled"]:
            continue

        symbol_df = source_df[source_df["symbol"] == symbol].copy()
        symbol_df = symbol_df.sort_values("timestamp_dt")

        if symbol_df.empty:
            continue

        latest_ts = symbol_df["timestamp_dt"].max()
        latest_price = pd.to_numeric(symbol_df.iloc[-1]["price_jpy"], errors="coerce")
        threshold_yen = float(symbol_setting["threshold_yen"])

        for window_minutes in windows:
            start_utc = latest_ts - pd.Timedelta(minutes=int(window_minutes))
            window_df = symbol_df[symbol_df["timestamp_dt"] >= start_utc].copy()
            window_df = window_df.sort_values("timestamp_dt")

            if len(window_df) < 2:
                rows.append({
                    "種類": "継続上昇",
                    "通貨": symbol,
                    "状態": "データ不足",
                    "監視範囲": f"直近{window_minutes}分",
                    "基準時刻": symbol_df.iloc[-1]["timestamp_dt"].tz_convert(JST).strftime("%Y-%m-%d %H:%M"),
                    "基準価格": pd.NA,
                    "現在価格": latest_price,
                    "上昇額": pd.NA,
                    "上昇率(%)": pd.NA,
                    "上昇ステップ率(%)": pd.NA,
                    "直線っぽさR2": pd.NA,
                    "押し戻し率(%)": pd.NA,
                    "高値離れ(%)": pd.NA,
                    "判定理由": "継続上昇の判定に使える履歴が2点未満です。",
                })
                continue

            base_price = float(window_df.iloc[0]["price_jpy"])
            current_price = float(window_df.iloc[-1]["price_jpy"])
            diff_yen = current_price - base_price
            pct = (diff_yen / base_price) * 100 if base_price else pd.NA

            line_stats = calc_linearity_stats(window_df["price_jpy"])
            rising_ratio = line_stats["rising_ratio"]
            r2 = line_stats["r2"]
            pullback_stats = calc_pullback_stats(window_df["price_jpy"])
            max_pullback_pct = pullback_stats["max_pullback_pct"]
            close_from_high_pct = pullback_stats["close_from_high_pct"]

            amount_hit = diff_yen >= threshold_yen
            pct_hit = pd.notna(pct) and pct >= threshold_pct
            direction_hit = pd.notna(rising_ratio) and rising_ratio >= rising_ratio_threshold
            linear_hit = pd.notna(r2) and r2 >= r2_threshold
            pullback_ok = pd.notna(max_pullback_pct) and max_pullback_pct <= max_pullback_limit_pct
            close_near_high = pd.notna(close_from_high_pct) and close_from_high_pct <= close_near_high_limit_pct

            if not alert_enabled or not sustained_enabled:
                status = "OFF"
                reason = "継続上昇検出はOFFです。"
            elif diff_yen <= 0:
                status = "通常"
                reason = "監視範囲では上昇していません。"
            elif (amount_hit or pct_hit) and direction_hit and close_near_high and (linear_hit or pullback_ok):
                status = "継続上昇"
                reason = "上昇額/上昇率がしきい値以上で、上昇方向が続き、最後も高値圏にあります。"
            elif (amount_hit or pct_hit) and direction_hit:
                status = "継続候補"
                reason = "上昇額/上昇率と上昇方向はありますが、直線性・押し戻し・高値圏条件の一部は未達です。"
            elif direction_hit and linear_hit and pullback_ok:
                status = "上昇傾向"
                reason = "しきい値未満ですが、監視範囲でじわじわ上がる傾向があります。"
            else:
                status = "通常"
                reason = "継続上昇条件には達していません。"

            rows.append({
                "種類": "継続上昇",
                "通貨": symbol,
                "状態": status,
                "監視範囲": f"直近{window_minutes}分",
                "基準時刻": window_df.iloc[0]["timestamp_dt"].tz_convert(JST).strftime("%Y-%m-%d %H:%M"),
                "基準価格": base_price,
                "現在価格": current_price,
                "上昇額": diff_yen,
                "上昇率(%)": pct,
                "上昇ステップ率(%)": rising_ratio,
                "直線っぽさR2": r2,
                "押し戻し率(%)": max_pullback_pct,
                "高値離れ(%)": close_from_high_pct,
                "判定理由": reason,
            })

    return pd.DataFrame(rows)

def compute_recent_rise_events(history_df: pd.DataFrame, current_df: pd.DataFrame, settings: dict) -> pd.DataFrame:
    """
    過去N時間の中から、急騰イベントが起きた時間帯を探す。

    v0.4.2-candidate-13:
    - 開始点から「窓の最後」だけでなく「窓内の最高値」も見る
    - 8:30〜8:40で上がって、その後少し戻った場合も拾いやすくする
    - しきい値未満でも、方向性が強い場合は「候補」として見えるようにする
    """
    if history_df is None:
        history_df = empty_history_df()

    source_df = pd.concat([history_df, current_df], ignore_index=True)
    source_df = normalize_history_dataframe(source_df)

    if source_df.empty:
        return pd.DataFrame()

    alert_enabled = bool(settings.get("alert_enabled", True))
    event_enabled = bool(settings.get("event_alert_enabled", True))
    use_peak_price = bool(settings.get("event_use_peak_price", True))
    candidate_mode = bool(settings.get("event_candidate_mode", True))

    lookback_hours = int(settings.get("event_lookback_hours", 6))
    window_minutes = int(settings.get("event_window_minutes", 15))

    if lookback_hours <= 0:
        lookback_hours = 6

    if window_minutes <= 0:
        window_minutes = 15

    threshold_pct = float(settings.get("alert_threshold_pct", 0.02))
    rising_ratio_threshold = float(settings.get("alert_rising_ratio", 60.0))
    r2_threshold = float(settings.get("alert_r2_threshold", 0.45))

    rows = []

    for symbol in SYMBOLS:
        symbol_setting = get_alert_symbol_setting(settings, symbol)

        if not symbol_setting["enabled"]:
            continue

        symbol_df = source_df[source_df["symbol"] == symbol].copy()
        symbol_df = symbol_df.sort_values("timestamp_dt")

        if symbol_df.empty:
            continue

        latest_ts = symbol_df["timestamp_dt"].max()
        lookback_start = latest_ts - pd.Timedelta(hours=lookback_hours)

        recent_df = symbol_df[symbol_df["timestamp_dt"] >= lookback_start].copy()
        recent_df = recent_df.sort_values("timestamp_dt").reset_index(drop=True)

        if len(recent_df) < 2:
            rows.append({
                "種類": "イベント検出",
                "通貨": symbol,
                "状態": "データ不足",
                "監視範囲": f"過去{lookback_hours}時間 / {window_minutes}分窓",
                "基準時刻": symbol_df.iloc[-1]["timestamp_dt"].tz_convert(JST).strftime("%Y-%m-%d %H:%M"),
                "基準価格": pd.NA,
                "現在価格": pd.to_numeric(symbol_df.iloc[-1]["price_jpy"], errors="coerce"),
                "上昇額": pd.NA,
                "上昇率(%)": pd.NA,
                "上昇ステップ率(%)": pd.NA,
                "直線っぽさR2": pd.NA,
                "判定理由": "イベント検出に使える履歴が2点未満です。",
            })
            continue

        threshold_yen = float(symbol_setting["threshold_yen"])
        candidates = []

        # 各保存点を開始点として、window_minutes以内の上昇イベントを探す。
        for start_idx in range(len(recent_df) - 1):
            start_row = recent_df.iloc[start_idx]
            start_ts = start_row["timestamp_dt"]
            end_limit = start_ts + pd.Timedelta(minutes=window_minutes)

            window_df = recent_df[
                (recent_df["timestamp_dt"] >= start_ts)
                & (recent_df["timestamp_dt"] <= end_limit)
            ].copy()

            if len(window_df) < 2:
                continue

            base_price = float(window_df.iloc[0]["price_jpy"])

            if use_peak_price:
                # 窓内の最高値を終点にする。
                # これにより、上昇後に少し戻ってもイベントとして拾える。
                peak_idx = pd.to_numeric(window_df["price_jpy"], errors="coerce").idxmax()
                event_df = window_df.loc[:peak_idx].copy()
                if len(event_df) < 2:
                    continue
                end_price = float(event_df.iloc[-1]["price_jpy"])
                end_ts = event_df.iloc[-1]["timestamp_dt"]
            else:
                event_df = window_df.copy()
                end_price = float(event_df.iloc[-1]["price_jpy"])
                end_ts = event_df.iloc[-1]["timestamp_dt"]

            diff_yen = end_price - base_price
            pct = (diff_yen / base_price) * 100 if base_price else pd.NA

            if diff_yen <= 0:
                continue

            stats = calc_linearity_stats(event_df["price_jpy"])
            rising_ratio = stats["rising_ratio"]
            r2 = stats["r2"]

            amount_hit = diff_yen >= threshold_yen
            pct_hit = pd.notna(pct) and pct >= threshold_pct
            direction_hit = pd.notna(rising_ratio) and rising_ratio >= rising_ratio_threshold
            linear_hit = pd.notna(r2) and r2 >= r2_threshold

            # 本アラート条件
            strong_hit = (amount_hit or pct_hit) and (direction_hit or linear_hit)

            # 候補条件:
            # しきい値に少し足りなくても、上昇方向が明確なら拾う。
            near_amount = diff_yen >= threshold_yen * 0.50
            near_pct = pd.notna(pct) and pct >= threshold_pct * 0.50
            candidate_hit = candidate_mode and (near_amount or near_pct) and (direction_hit or linear_hit)

            if not strong_hit and not candidate_hit:
                continue

            score = 0.0
            score += max(0.0, diff_yen / max(threshold_yen, 1.0))
            score += max(0.0, float(pct) / max(threshold_pct, 0.0001)) if pd.notna(pct) else 0.0
            score += (float(rising_ratio) / 100.0) if pd.notna(rising_ratio) else 0.0
            score += float(r2) if pd.notna(r2) else 0.0
            if use_peak_price:
                score += 0.25

            candidates.append({
                "score": score,
                "start_ts": event_df.iloc[0]["timestamp_dt"],
                "end_ts": end_ts,
                "base_price": base_price,
                "end_price": end_price,
                "diff_yen": diff_yen,
                "pct": pct,
                "rising_ratio": rising_ratio,
                "r2": r2,
                "amount_hit": amount_hit,
                "pct_hit": pct_hit,
                "direction_hit": direction_hit,
                "linear_hit": linear_hit,
                "candidate_hit": candidate_hit,
                "used_peak": use_peak_price,
            })

        if not event_enabled or not alert_enabled:
            rows.append({
                "種類": "イベント検出",
                "通貨": symbol,
                "状態": "OFF",
                "監視範囲": f"過去{lookback_hours}時間 / {window_minutes}分窓",
                "基準時刻": recent_df.iloc[0]["timestamp_dt"].tz_convert(JST).strftime("%Y-%m-%d %H:%M"),
                "基準価格": pd.NA,
                "現在価格": pd.to_numeric(symbol_df.iloc[-1]["price_jpy"], errors="coerce"),
                "上昇額": pd.NA,
                "上昇率(%)": pd.NA,
                "上昇ステップ率(%)": pd.NA,
                "直線っぽさR2": pd.NA,
                "判定理由": "イベント検出アラートはOFFです。",
            })
            continue

        if not candidates:
            rows.append({
                "種類": "イベント検出",
                "通貨": symbol,
                "状態": "通常",
                "監視範囲": f"過去{lookback_hours}時間 / {window_minutes}分窓",
                "基準時刻": recent_df.iloc[0]["timestamp_dt"].tz_convert(JST).strftime("%Y-%m-%d %H:%M"),
                "基準価格": pd.NA,
                "現在価格": pd.to_numeric(symbol_df.iloc[-1]["price_jpy"], errors="coerce"),
                "上昇額": pd.NA,
                "上昇率(%)": pd.NA,
                "上昇ステップ率(%)": pd.NA,
                "直線っぽさR2": pd.NA,
                "判定理由": "過去の監視範囲内に、条件を満たす急騰イベントは見つかりませんでした。",
            })
            continue

        best = sorted(candidates, key=lambda item: item["score"], reverse=True)[0]

        if (best["amount_hit"] or best["pct_hit"]) and best["direction_hit"] and best["linear_hit"]:
            status = "急騰"
            reason = "過去の監視範囲内で、上昇額/上昇率・上昇ステップ率・直線っぽさが条件を満たす区間がありました。"
        elif best["amount_hit"] or best["pct_hit"]:
            status = "注意"
            reason = "過去の監視範囲内で、上昇額または上昇率が条件を満たす区間がありました。"
        else:
            status = "候補"
            reason = "しきい値には少し届きませんが、急騰候補として見てよい区間がありました。"

        if best.get("used_peak"):
            reason += " 窓内の最高値を終点として検出しています。"

        start_label = best["start_ts"].tz_convert(JST).strftime("%Y-%m-%d %H:%M")
        end_label = best["end_ts"].tz_convert(JST).strftime("%H:%M")

        rows.append({
            "種類": "イベント検出",
            "通貨": symbol,
            "状態": status,
            "監視範囲": f"{start_label}〜{end_label} / {window_minutes}分窓",
            "基準時刻": start_label,
            "基準価格": best["base_price"],
            "現在価格": best["end_price"],
            "上昇額": best["diff_yen"],
            "上昇率(%)": best["pct"],
            "上昇ステップ率(%)": best["rising_ratio"],
            "直線っぽさR2": best["r2"],
            "判定理由": reason,
        })

    return pd.DataFrame(rows)


def display_alert_status(status: str) -> str:
    """
    内部状態名を画面表示向けに変換する。
    既存ロジック互換のため、内部的には「急上昇」が残っていてもよい。
    """
    if status == "急上昇":
        return "急騰"
    if status == "上昇傾向":
        return "上昇傾向"
    if status == "候補":
        return "急騰候補"
    if status == "継続候補":
        return "継続上昇候補"
    return status



def show_compact_top_alert(level: str, message: str):
    """
    ページ上部の急騰/注意表示を、小さめのバーとして表示する。
    Streamlit標準のst.warning/st.infoより高さを抑える。
    """
    css_class = "compact-alert-warning" if level == "warning" else "compact-alert-info"
    st.markdown(
        f'<div class="compact-alert {css_class}">{message}</div>',
        unsafe_allow_html=True,
    )


def extract_minutes_from_range(range_text) -> int:
    """
    「直近20分」「過去6時間 / 15分窓」のような表示から分数を取り出す。
    取れない場合は0を返す。
    """
    match = re.search(r"(\d+)\s*分", str(range_text))
    if not match:
        return 0
    try:
        return int(match.group(1))
    except Exception:
        return 0


def _safe_float(value, default: float = 0.0) -> float:
    num = pd.to_numeric(value, errors="coerce")
    if pd.isna(num):
        return float(default)
    return float(num)


def _best_alerts_by_symbol(alerts_df: pd.DataFrame, status_priority: dict, prefer_long_window: bool = False, max_items: int = 2) -> tuple:
    """
    上部通知がごちゃつかないよう、同じ通貨は一番重要な1件だけにまとめる。
    戻り値: (表示用DataFrame, ユニーク通貨数)
    """
    if alerts_df is None or alerts_df.empty:
        return pd.DataFrame(), 0

    df = alerts_df.copy()
    df["_priority"] = df["状態"].map(status_priority).fillna(99)
    df["_abs_pct"] = pd.to_numeric(df["上昇率(%)"], errors="coerce").abs().fillna(0.0)
    df["_window_minutes"] = df["監視範囲"].apply(extract_minutes_from_range)

    sort_cols = ["_priority"]
    ascending = [True]

    if prefer_long_window:
        sort_cols.append("_window_minutes")
        ascending.append(False)

    sort_cols.append("_abs_pct")
    ascending.append(False)

    df = df.sort_values(sort_cols, ascending=ascending)

    best_rows = []
    for symbol in SYMBOLS:
        symbol_df = df[df["通貨"] == symbol]
        if not symbol_df.empty:
            best_rows.append(symbol_df.iloc[0].to_dict())

    # 万一、SYMBOLS外の通貨が混ざった場合の保険。
    used_symbols = {row.get("通貨") for row in best_rows}
    for _, row in df.iterrows():
        symbol = row.get("通貨")
        if symbol not in used_symbols:
            best_rows.append(row.to_dict())
            used_symbols.add(symbol)

    if not best_rows:
        return pd.DataFrame(), 0

    best_df = pd.DataFrame(best_rows)
    best_df = best_df.sort_values(sort_cols, ascending=ascending)
    unique_count = int(best_df["通貨"].nunique()) if "通貨" in best_df.columns else len(best_df)

    return best_df.head(int(max_items)), unique_count


def format_alert_timing(row) -> str:
    """
    急騰・注意・継続上昇が、いつから/どの時間幅で判定されたかを短く表示する。

    例:
    - 直近10分
    - 2026-05-25 16:00〜16:15ごろ
    - 23:30から
    """
    monitor_range = str(row.get("監視範囲", "") or "").strip()
    base_time = str(row.get("基準時刻", "") or "").strip()
    window_minutes = extract_minutes_from_range(monitor_range)

    if monitor_range.startswith("直近"):
        return monitor_range

    if "〜" in monitor_range:
        main_range = monitor_range.split("/", 1)[0].strip()
        if main_range:
            return f"{main_range}ごろ"

    if base_time:
        if window_minutes > 0:
            return f"{base_time}から{window_minutes}分"
        return f"{base_time}から"

    if window_minutes > 0:
        return f"{window_minutes}分幅"

    return ""


def _format_grouped_alert_item(row, sustained: bool = False) -> str:
    symbol = row.get("通貨", "")
    status = display_alert_status(row.get("状態", ""))
    diff_yen = row.get("上昇額", pd.NA)
    pct = row.get("上昇率(%)", pd.NA)
    timing_label = format_alert_timing(row)

    if sustained:
        timing_part = f"/{timing_label}" if timing_label else ""
        return f"{symbol} {status}{timing_part}（{fmt_yen(diff_yen, signed=True)} / {fmt_pct(pct, signed=True)}）"

    alert_kind = row.get("種類", "")
    prefix = f"{symbol} {status}"
    if alert_kind:
        prefix += f"/{alert_kind}"
    if timing_label:
        prefix += f"・{timing_label}"

    return f"{prefix}（{fmt_yen(diff_yen, signed=True)} / {fmt_pct(pct, signed=True)}）"


def show_grouped_top_alerts(alert_df: pd.DataFrame):
    """
    上部通知を最大2系統にまとめる。
    - 急騰系: 直近監視・イベント検出・固定時刻確認
    - 継続系: 15分/20分/30分などの継続上昇

    詳細はアラートタブに任せ、上部は現在何が起きているかだけを短く見せる。
    """
    if alert_df is None or alert_df.empty:
        return

    active_df = alert_df[alert_df["状態"].isin(["急騰", "注意", "候補", "上昇傾向", "継続上昇", "継続候補"])].copy()
    if active_df.empty:
        return

    sustained_df = active_df[
        (active_df["種類"] == "継続上昇")
        & (active_df["状態"].isin(["継続上昇", "継続候補", "上昇傾向"]))
    ].copy()

    acute_df = active_df[
        (active_df["種類"] != "継続上昇")
        & (active_df["状態"].isin(["急騰", "注意", "候補", "上昇傾向"]))
    ].copy()

    acute_priority = {"急騰": 1, "注意": 2, "候補": 3, "上昇傾向": 4}
    sustained_priority = {"継続上昇": 1, "継続候補": 2, "上昇傾向": 3}

    acute_best, acute_unique_count = _best_alerts_by_symbol(
        acute_df,
        status_priority=acute_priority,
        prefer_long_window=False,
        max_items=2,
    )

    sustained_best, sustained_unique_count = _best_alerts_by_symbol(
        sustained_df,
        status_priority=sustained_priority,
        prefer_long_window=True,
        max_items=2,
    )

    if not acute_best.empty:
        items = [_format_grouped_alert_item(row, sustained=False) for _, row in acute_best.iterrows()]
        extra = max(0, acute_unique_count - len(items))
        suffix = f" / ほか{extra}通貨" if extra else ""
        level = "warning" if "急騰" in set(acute_df["状態"].astype(str)) else "info"
        show_compact_top_alert(
            level,
            "急騰系のお知らせ: " + " / ".join(items) + suffix + "。詳細はアラートタブ。",
        )

    if not sustained_best.empty:
        items = [_format_grouped_alert_item(row, sustained=True) for _, row in sustained_best.iterrows()]
        extra = max(0, sustained_unique_count - len(items))
        suffix = f" / ほか{extra}通貨" if extra else ""
        show_compact_top_alert(
            "info",
            "継続のお知らせ: " + " / ".join(items) + suffix + "。同一通貨の他時間幅はアラートタブ。",
        )

def make_alert_display(alert_df: pd.DataFrame) -> pd.DataFrame:
    """
    アラート表を見やすい表示に変換する。
    """
    if alert_df is None or alert_df.empty:
        return pd.DataFrame()

    rows = []

    for _, row in alert_df.iterrows():
        rows.append({
            "種類": row.get("種類", ""),
            "通貨": row.get("通貨", ""),
            "状態": display_alert_status(row.get("状態", "")),
            "判定タイミング": format_alert_timing(row),
            "監視範囲": row.get("監視範囲", ""),
            "実データ基準時刻": row.get("基準時刻", ""),
            "基準価格": fmt_yen(row.get("基準価格")),
            "現在価格": fmt_yen(row.get("現在価格")),
            "上昇額": fmt_yen(row.get("上昇額"), signed=True),
            "上昇率": fmt_pct(row.get("上昇率(%)"), signed=True),
            "上昇ステップ率": fmt_pct(row.get("上昇ステップ率(%)"), digits=1),
            "直線っぽさ": "—" if pd.isna(row.get("直線っぽさR2")) else f'{float(row.get("直線っぽさR2")):.2f}',
            "押し戻し率": "—" if pd.isna(row.get("押し戻し率(%)", pd.NA)) else f'{float(row.get("押し戻し率(%)")):.4f}%',
            "高値離れ": "—" if pd.isna(row.get("高値離れ(%)", pd.NA)) else f'{float(row.get("高値離れ(%)")):.4f}%',
            "判定理由": row.get("判定理由", ""),
        })

    return pd.DataFrame(rows)


# =========================
# Binance読み取り専用API確認
# =========================

def read_local_env_file(path: Path = ENV_FILE) -> dict:
    """
    PROJECT_DIR/.env から BINANCE_API_KEY / BINANCE_API_SECRET を読む。
    python-dotenv に依存せず、最小限の KEY=VALUE だけ対応する。

    例:
    BINANCE_API_KEY=xxxx
    BINANCE_API_SECRET=yyyy
    """
    path = Path(path)
    result = {}

    if not path.exists():
        return result

    try:
        for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
            line = str(raw_line).strip()
            if not line or line.startswith("#") or "=" not in line:
                continue

            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()

            # 前後の引用符だけ外す。中身は表示しない。
            if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
                value = value[1:-1]

            if key in ["BINANCE_API_KEY", "BINANCE_API_SECRET"]:
                result[key] = value.strip()

    except Exception as e:
        result["_error"] = str(e)

    return result


def check_env_gitignore_status(project_dir: Path = PROJECT_DIR) -> dict:
    """
    .env がGitに混ざりにくい状態かを簡易確認する。
    厳密なgitignore評価ではなく、初心者向けの安全表示。
    """
    gitignore_path = Path(project_dir) / ".gitignore"

    if not gitignore_path.exists():
        return {
            "status": "要確認",
            "message": ".gitignore が見つかりません。.env をGitに入れない設定を追加してください。",
        }

    try:
        lines = [line.strip() for line in gitignore_path.read_text(encoding="utf-8-sig").splitlines()]
    except Exception as e:
        return {"status": "要確認", "message": f".gitignore を読めません: {e}"}

    effective_lines = [line for line in lines if line and not line.startswith("#")]
    protected_patterns = {".env", ".env*", "*.env", ".env.local", ".env.*"}

    if any(line in protected_patterns for line in effective_lines):
        return {"status": "保護あり", "message": ".gitignore に .env 系の除外設定があります。"}

    return {
        "status": "要確認",
        "message": ".gitignore に .env の除外設定が見つかりません。`.env` を追加してください。",
    }


def get_binance_credentials_info() -> dict:
    """
    Binance APIキーを安全寄りに取得する。

    優先順位:
    1. PowerShellなどの環境変数
    2. PROJECT_DIR/.env

    settings.json には保存しない。
    """
    env_key = os.environ.get("BINANCE_API_KEY", "").strip()
    env_secret = os.environ.get("BINANCE_API_SECRET", "").strip()

    file_values = read_local_env_file(ENV_FILE)
    file_key = str(file_values.get("BINANCE_API_KEY", "") or "").strip()
    file_secret = str(file_values.get("BINANCE_API_SECRET", "") or "").strip()

    api_key = env_key or file_key
    api_secret = env_secret or file_secret

    return {
        "api_key": api_key,
        "api_secret": api_secret,
        "api_key_source": "環境変数" if env_key else (".env" if file_key else "未設定"),
        "api_secret_source": "環境変数" if env_secret else (".env" if file_secret else "未設定"),
        "env_file_path": str(ENV_FILE),
        "env_file_exists": ENV_FILE.exists(),
        "env_file_error": str(file_values.get("_error", "") or ""),
        "gitignore": check_env_gitignore_status(PROJECT_DIR),
    }


def get_binance_env_credentials() -> tuple:
    """
    互換用。APIキーとSecretだけ返す。
    """
    info = get_binance_credentials_info()
    return info.get("api_key", ""), info.get("api_secret", "")


def mask_secret_text(value: str, left: int = 4, right: int = 4) -> str:
    value = str(value or "")
    if not value:
        return "未設定"
    if len(value) <= left + right:
        return "*" * len(value)
    return value[:left] + "…" + value[-right:]


def signed_binance_get(path: str, api_key: str, api_secret: str, params: dict = None, recv_window: int = 5000) -> dict:
    """
    Binance Spot APIの署名付きGETを呼ぶ。
    USER_DATA読み取り専用エンドポイント用。
    実注文・注文テスト・出金系エンドポイントには使わない。
    """
    if not api_key or not api_secret:
        raise ValueError("BINANCE_API_KEY / BINANCE_API_SECRET が環境変数に設定されていません。")

    params = dict(params or {})
    params.setdefault("recvWindow", int(recv_window))
    params["timestamp"] = int(time.time() * 1000)

    query = urlencode(params, doseq=True)
    signature = hmac.new(
        api_secret.encode("utf-8"),
        query.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    url = f"https://api.binance.com{path}?{query}&signature={signature}"
    headers = {"X-MBX-APIKEY": api_key}
    response = requests.get(url, headers=headers, timeout=15)

    if response.status_code >= 400:
        try:
            error_data = response.json()
            error_message = error_data.get("msg", response.text)
            error_code = error_data.get("code", response.status_code)
            raise RuntimeError(f"Binance API error {error_code}: {error_message}")
        except ValueError:
            response.raise_for_status()

    response.raise_for_status()
    return response.json()


def fetch_binance_account_info(api_key: str, api_secret: str, recv_window: int = 5000) -> dict:
    """読み取り専用APIでSpot口座情報を取得する。"""
    return signed_binance_get("/api/v3/account", api_key, api_secret, recv_window=recv_window)


def fetch_binance_account_commission(api_key: str, api_secret: str, symbol: str, recv_window: int = 5000) -> dict:
    """読み取り専用APIでシンボル別の現在の手数料率を取得する。"""
    return signed_binance_get(
        "/api/v3/account/commission",
        api_key,
        api_secret,
        params={"symbol": symbol},
        recv_window=recv_window,
    )


def extract_focus_balances(account_info: dict, assets: list = None) -> pd.DataFrame:
    """
    監視アプリでまず必要な JPY/BTC/ETH/BNB の残高だけを表にする。
    """
    assets = assets or ["JPY", "BTC", "ETH", "BNB"]
    balances = account_info.get("balances", []) if isinstance(account_info, dict) else []
    by_asset = {}

    if isinstance(balances, list):
        for item in balances:
            if not isinstance(item, dict):
                continue
            asset = str(item.get("asset", ""))
            free = _to_float_or_na(item.get("free", 0))
            locked = _to_float_or_na(item.get("locked", 0))
            by_asset[asset] = {
                "free": 0.0 if pd.isna(free) else float(free),
                "locked": 0.0 if pd.isna(locked) else float(locked),
            }

    rows = []
    for asset in assets:
        item = by_asset.get(asset, {"free": 0.0, "locked": 0.0})
        free = float(item.get("free", 0.0))
        locked = float(item.get("locked", 0.0))
        rows.append({
            "資産": asset,
            "利用可能": free,
            "ロック中": locked,
            "合計": free + locked,
        })

    return pd.DataFrame(rows)


def get_asset_balance_from_account(account_info: dict, asset: str) -> dict:
    """
    account_info の balances から指定資産の free / locked / total を取り出す。
    読み取り専用APIの結果だけを使い、注文や出金には使わない。
    """
    result = {"asset": asset, "free": pd.NA, "locked": pd.NA, "total": pd.NA, "found": False}

    if not isinstance(account_info, dict):
        return result

    balances = account_info.get("balances", [])
    if not isinstance(balances, list):
        return result

    target = str(asset).upper()
    for item in balances:
        if not isinstance(item, dict):
            continue
        if str(item.get("asset", "")).upper() != target:
            continue
        free = _to_float_or_na(item.get("free", 0))
        locked = _to_float_or_na(item.get("locked", 0))
        if pd.isna(free):
            free = 0.0
        if pd.isna(locked):
            locked = 0.0
        result.update({
            "free": float(free),
            "locked": float(locked),
            "total": float(free) + float(locked),
            "found": True,
        })
        return result

    return result


def base_asset_from_symbol(symbol: str) -> str:
    """BTCJPY -> BTC, ETHJPY -> ETH のように、現在の監視通貨からbase assetを推定する。"""
    text = str(symbol).upper()
    if text.endswith("JPY"):
        return text[:-3]
    return text


def extract_taker_fee_pct_by_symbol(commissions: dict) -> dict:
    """
    account/commission の結果から、通貨別taker feeを%単位で返す。
    例: APIの 0.001 -> 0.1
    """
    result = {}
    if not isinstance(commissions, dict):
        return result

    for symbol in SYMBOLS:
        data = commissions.get(symbol, {})
        if not isinstance(data, dict) or data.get("_error"):
            continue
        standard = data.get("standardCommission", {}) or {}
        taker = _to_float_or_na(standard.get("taker", pd.NA))
        if pd.notna(taker):
            result[symbol] = float(taker) * 100.0
    return result


def make_live_taker_fee_display(commissions: dict) -> pd.DataFrame:
    """取引シミュレーターで使える実taker fee候補を小さく表示する。"""
    rows = []
    taker_by_symbol = extract_taker_fee_pct_by_symbol(commissions)

    for symbol in SYMBOLS:
        if symbol in taker_by_symbol:
            rows.append({"通貨": symbol, "実taker fee": f"{taker_by_symbol[symbol]:.4f}%", "状態": "取得済み"})
        else:
            rows.append({"通貨": symbol, "実taker fee": "—", "状態": "未取得"})

    if taker_by_symbol:
        rows.append({
            "通貨": "計算に使う値",
            "実taker fee": f"{max(taker_by_symbol.values()):.4f}%",
            "状態": "安全側として最大値を使用",
        })

    return pd.DataFrame(rows)


def make_trade_balance_check_display(
    trade_df: pd.DataFrame,
    account_info: dict,
    fee_mode: str,
    bnb_jpy_price=None,
) -> pd.DataFrame:
    """
    取引シミュレーターの投入額が、読み取り専用APIで取得した実残高に対して足りるかを表示する。
    v0.5-candidate-8 では、BNB別払い想定時に BNB 残高も判定する。
    実注文は行わず、JPY/BTC/ETH/BNBの見える化だけを行う。
    """
    if trade_df is None or trade_df.empty:
        return pd.DataFrame()

    jpy_balance = get_asset_balance_from_account(account_info, "JPY")
    bnb_balance = get_asset_balance_from_account(account_info, "BNB")
    bnb_free = bnb_balance.get("free", pd.NA)
    bnb_price = _to_float_or_na(bnb_jpy_price)
    account_loaded = isinstance(account_info, dict) and bool(account_info.get("balances"))

    rows = []
    for _, row in trade_df.iterrows():
        symbol = str(row.get("通貨", ""))
        base_asset = base_asset_from_symbol(symbol)
        base_balance = get_asset_balance_from_account(account_info, base_asset)
        required_jpy = _to_float_or_na(row.get("投入JPY", pd.NA))
        available_jpy = jpy_balance.get("free", pd.NA)

        if not account_loaded:
            status = "未確認"
            shortfall = pd.NA
            memo = "API・準備度タブで読み取り専用APIを確認すると、実残高と照合できます。"
        elif pd.isna(required_jpy) or pd.isna(available_jpy):
            status = "要確認"
            shortfall = pd.NA
            memo = "JPY残高を確認できませんでした。"
        elif float(available_jpy) >= float(required_jpy):
            status = "OK"
            shortfall = 0.0
            memo = "投入額はJPY利用可能残高以内です。"
        else:
            status = "不足"
            shortfall = max(0.0, float(required_jpy) - float(available_jpy))
            memo = "投入額がJPY利用可能残高を上回っています。"

        bnb_required_jpy = _to_float_or_na(row.get("BNB手数料必要額(JPY)", pd.NA))
        bnb_required_qty = pd.NA
        bnb_shortfall = pd.NA

        if fee_mode != TRADE_FEE_MODE_BNB:
            bnb_status = "対象外"
        elif not account_loaded:
            bnb_status = "未確認"
            memo += " BNB別払い想定ですが、BNB残高はまだ未確認です。"
        elif pd.isna(bnb_free):
            bnb_status = "要確認"
            memo += " BNB残高を確認できませんでした。"
        elif pd.isna(bnb_required_jpy) or float(bnb_required_jpy) <= 0:
            bnb_status = "要確認" if float(bnb_free) > 0 else "不足"
            memo += " BNB別払い想定ですが、BNB必要額を計算できませんでした。"
        elif pd.isna(bnb_price) or float(bnb_price) <= 0:
            # BNBJPYが取れない場合でも、BNB残高が0なら不足として強めに出す。
            bnb_status = "要確認" if float(bnb_free) > 0 else "不足"
            memo += " BNBJPY価格が取れないため、必要BNB数量は未換算です。BNB残高を別途確認してください。"
        else:
            bnb_required_qty = float(bnb_required_jpy) / float(bnb_price)
            if float(bnb_free) >= float(bnb_required_qty):
                bnb_status = "OK"
                bnb_shortfall = 0.0
                memo += " BNB手数料払いに必要な概算BNB残高も足りています。"
            else:
                bnb_status = "不足"
                bnb_shortfall = max(0.0, float(bnb_required_qty) - float(bnb_free))
                memo += " BNB手数料払いに必要な概算BNB残高が不足しています。"

        rows.append({
            "通貨": symbol,
            "投入額": fmt_yen(required_jpy),
            "JPY利用可能": fmt_yen(available_jpy),
            "JPY残高判定": status,
            "JPY不足額": fmt_yen(shortfall),
            f"{base_asset}保有": fmt_qty(base_balance.get("free", pd.NA), digits=10),
            "BNB利用可能": fmt_qty(bnb_free, digits=10),
            "BNB必要概算": fmt_qty(bnb_required_qty, digits=10),
            "BNB不足概算": fmt_qty(bnb_shortfall, digits=10),
            "BNB残高判定": bnb_status,
            "BNB価格": fmt_yen(bnb_price),
            "メモ": memo,
        })

    return pd.DataFrame(rows)

def format_rate_percent_from_decimal(value, digits: int = 4) -> str:
    """
    Binanceのcommission rateは小数形式なので、%表示へ変換する。
    例: 0.001 -> 0.1000%
    """
    value = _to_float_or_na(value)
    if pd.isna(value):
        return "—"
    return f"{float(value) * 100:.{digits}f}%"


def make_commission_display(commissions: dict) -> pd.DataFrame:
    rows = []
    for symbol in SYMBOLS:
        data = commissions.get(symbol, {}) if isinstance(commissions, dict) else {}
        if not isinstance(data, dict) or data.get("_error"):
            rows.append({
                "通貨": symbol,
                "maker": "—",
                "taker": "—",
                "buyer": "—",
                "seller": "—",
                "BNB割引": "—",
                "割引率": "—",
                "状態": data.get("_error", "未取得") if isinstance(data, dict) else "未取得",
            })
            continue

        standard = data.get("standardCommission", {}) or {}
        discount = data.get("discount", {}) or {}
        enabled_account = bool(discount.get("enabledForAccount", False))
        enabled_symbol = bool(discount.get("enabledForSymbol", False))
        discount_asset = str(discount.get("discountAsset", ""))
        discount_rate = discount.get("discount", pd.NA)

        if enabled_account and enabled_symbol:
            discount_text = f"有効 / {discount_asset or '—'}"
        elif enabled_account:
            discount_text = f"口座有効・通貨未有効 / {discount_asset or '—'}"
        else:
            discount_text = "無効または未設定"

        rows.append({
            "通貨": symbol,
            "maker": format_rate_percent_from_decimal(standard.get("maker", pd.NA)),
            "taker": format_rate_percent_from_decimal(standard.get("taker", pd.NA)),
            "buyer": format_rate_percent_from_decimal(standard.get("buyer", pd.NA)),
            "seller": format_rate_percent_from_decimal(standard.get("seller", pd.NA)),
            "BNB割引": discount_text,
            "割引率": format_rate_percent_from_decimal(discount_rate),
            "状態": "取得OK",
        })
    return pd.DataFrame(rows)


def extract_max_taker_fee_pct_from_commissions(commissions: dict) -> float:
    """
    取得済みcommissionから、BTCJPY/ETHJPYのtaker feeを%で返す。
    複数通貨で違う場合は安全側として最大値を使う。
    """
    rates = []

    if not isinstance(commissions, dict):
        return pd.NA

    for symbol in SYMBOLS:
        data = commissions.get(symbol, {})
        if not isinstance(data, dict) or data.get("_error"):
            continue

        standard = data.get("standardCommission", {}) or {}
        taker = _to_float_or_na(standard.get("taker", pd.NA))
        if pd.notna(taker):
            rates.append(float(taker) * 100.0)

    if not rates:
        return pd.NA

    return max(rates)


def make_commission_apply_display(commissions: dict) -> pd.DataFrame:
    """
    取引シミュレーターへ反映する候補値を表示する。
    """
    rows = []
    if not isinstance(commissions, dict):
        return pd.DataFrame()

    for symbol in SYMBOLS:
        data = commissions.get(symbol, {})
        if not isinstance(data, dict) or data.get("_error"):
            rows.append({"通貨": symbol, "taker fee候補": "—", "状態": data.get("_error", "未取得") if isinstance(data, dict) else "未取得"})
            continue
        standard = data.get("standardCommission", {}) or {}
        taker_pct = _to_float_or_na(standard.get("taker", pd.NA))
        rows.append({
            "通貨": symbol,
            "taker fee候補": "—" if pd.isna(taker_pct) else f"{float(taker_pct) * 100:.4f}%",
            "状態": "取得OK",
        })

    max_rate = extract_max_taker_fee_pct_from_commissions(commissions)
    rows.append({
        "通貨": "反映候補",
        "taker fee候補": "—" if pd.isna(max_rate) else f"{float(max_rate):.4f}%",
        "状態": "複数通貨で違う場合は安全側として最大値を使用",
    })
    return pd.DataFrame(rows)


def make_api_account_summary(account_info: dict) -> pd.DataFrame:
    if not isinstance(account_info, dict) or not account_info:
        return pd.DataFrame([{"項目": "口座情報", "値": "未取得"}])

    rows = [
        {"項目": "accountType", "値": str(account_info.get("accountType", "—"))},
        {"項目": "canTrade", "値": str(account_info.get("canTrade", "—"))},
        {"項目": "canWithdraw", "値": str(account_info.get("canWithdraw", "—"))},
        {"項目": "canDeposit", "値": str(account_info.get("canDeposit", "—"))},
        {"項目": "permissions", "値": ", ".join(account_info.get("permissions", [])) if isinstance(account_info.get("permissions", []), list) else str(account_info.get("permissions", "—"))},
        {"項目": "updateTime", "値": format_jst_timestamp(pd.to_datetime(account_info.get("updateTime", 0), unit="ms", utc=True)) if account_info.get("updateTime") else "—"},
    ]
    return pd.DataFrame(rows)


def build_readiness_check_rows(
    current_df: pd.DataFrame,
    rules_by_symbol: dict = None,
    account_info: dict = None,
    commissions: dict = None,
    trade_sim_df: pd.DataFrame = None,
    fee_mode: str = "",
    bnb_jpy_price=None,
) -> pd.DataFrame:
    """
    実取引前に足りないものを一目で確認するためのチェック表。
    ここでOKが増えても、実注文はまだ行わない。
    """
    rules_by_symbol = rules_by_symbol or {}
    commissions = commissions or {}

    price_ok = current_df is not None and not current_df.empty
    rule_ok = bool(rules_by_symbol) and all(
        isinstance(rules_by_symbol.get(symbol, {}), dict)
        and not rules_by_symbol.get(symbol, {}).get("raw_error")
        and str(rules_by_symbol.get(symbol, {}).get("status", "")).upper() == "TRADING"
        for symbol in SYMBOLS
    )
    balance_ok = isinstance(account_info, dict) and bool(account_info.get("balances"))
    commission_ok = bool(commissions) and all(
        isinstance(commissions.get(symbol, {}), dict)
        and not commissions.get(symbol, {}).get("_error")
        for symbol in SYMBOLS
    )
    sim_ok = trade_sim_df is not None and not trade_sim_df.empty

    jpy_sufficient = False
    if balance_ok and sim_ok:
        jpy_balance = get_asset_balance_from_account(account_info, "JPY")
        required_values = pd.to_numeric(trade_sim_df.get("投入JPY", pd.Series(dtype="float64")), errors="coerce").dropna()
        if not required_values.empty and pd.notna(jpy_balance.get("free", pd.NA)):
            jpy_sufficient = float(jpy_balance.get("free")) >= float(required_values.max())

    bnb_status = "対象外"
    bnb_memo = "BNB別払いを選んだ場合だけ確認します。"
    if fee_mode == TRADE_FEE_MODE_BNB:
        bnb_status = "未確認"
        bnb_memo = "BNB別払い想定のため、BNB残高も確認します。"
        if balance_ok and sim_ok:
            bnb_balance = get_asset_balance_from_account(account_info, "BNB")
            bnb_free = bnb_balance.get("free", pd.NA)
            bnb_price = _to_float_or_na(bnb_jpy_price)
            required_fee_jpy_values = pd.to_numeric(
                trade_sim_df.get("BNB手数料必要額(JPY)", pd.Series(dtype="float64")),
                errors="coerce",
            ).dropna()
            if pd.isna(bnb_free):
                bnb_status = "要確認"
                bnb_memo = "BNB残高を確認できませんでした。"
            elif required_fee_jpy_values.empty:
                bnb_status = "要確認" if float(bnb_free) > 0 else "不足"
                bnb_memo = "BNB必要額を計算できませんでした。"
            elif pd.isna(bnb_price) or float(bnb_price) <= 0:
                bnb_status = "要確認" if float(bnb_free) > 0 else "不足"
                bnb_memo = "BNBJPY価格が取れないため必要数量は未換算です。BNB残高が0なら不足です。"
            else:
                required_bnb = float(required_fee_jpy_values.max()) / float(bnb_price)
                if float(bnb_free) >= required_bnb:
                    bnb_status = "OK"
                    bnb_memo = f"概算必要BNB {required_bnb:.10f} に対して、利用可能BNBは足りています。"
                else:
                    bnb_status = "不足"
                    bnb_memo = f"概算必要BNB {required_bnb:.10f} に対して、利用可能BNBが不足しています。"

    rows = [
        {"項目": "現在価格", "状態": "OK" if price_ok else "未取得", "メモ": "公開APIまたは保存済みCSVから表示中。"},
        {"項目": "Binance注文ルール", "状態": "OK" if rule_ok else "要確認", "メモ": "exchangeInfoで最小数量・刻み・最小注文額を確認。"},
        {"項目": "残高", "状態": "OK" if balance_ok else "未確認", "メモ": "読み取り専用APIで JPY/BTC/ETH/BNB を確認。"},
        {"項目": "実手数料", "状態": "OK" if commission_ok else "未確認", "メモ": "account/commissionでシンボル別のmaker/takerを確認。"},
        {"項目": "投入額とJPY残高", "状態": "OK" if jpy_sufficient else ("要確認" if balance_ok and sim_ok else "未確認"), "メモ": "シミュレーターの投入額がJPY利用可能残高以内かを確認。"},
        {"項目": "BNB残高", "状態": bnb_status, "メモ": bnb_memo},
        {"項目": "損益シミュレーション", "状態": "OK" if sim_ok else "未計算", "メモ": "Gross / Net P/L と損益分岐を表示。"},
        {"項目": "paper trading", "状態": "未実装", "メモ": "次段階。実注文の前に必須。"},
        {"項目": "実注文", "状態": "無効", "メモ": "このアプリには注文送信処理を入れていません。"},
        {"項目": "自動売買", "状態": "無効", "メモ": "AIにもPythonにも売買判断・注文権限を持たせません。"},
        {"項目": "出金", "状態": "対象外", "メモ": "出金機能は実装しません。APIキー側でも必ずOFF。"},
    ]
    return pd.DataFrame(rows)

def store_api_session_result(account_info: dict, commissions: dict, error: str = ""):
    st.session_state["binance_readonly_account_info"] = account_info or {}
    st.session_state["binance_readonly_commissions"] = commissions or {}
    st.session_state["binance_readonly_last_error"] = str(error or "")
    st.session_state["binance_readonly_checked_at"] = datetime.now(JST).isoformat(timespec="seconds")


def get_api_session_result() -> tuple:
    return (
        st.session_state.get("binance_readonly_account_info", {}),
        st.session_state.get("binance_readonly_commissions", {}),
        st.session_state.get("binance_readonly_last_error", ""),
        st.session_state.get("binance_readonly_checked_at", ""),
    )


# =========================
# Ollamaコメント保存
# =========================

def load_ollama_comment() -> dict:
    """
    自動更新でページが再読み込みされてもOllamaコメントが消えないよう、
    最後に生成したコメントをJSONから読み込む。
    """
    default_data = {
        "comment": "",
        "created_at": "",
        "model": "",
        "version": APP_VERSION,
        "python_summary": "",
        "response_mode": "",
        "elapsed_sec": None,
        "prompt_chars": 0,
        "num_predict": 0,
    }

    if not OLLAMA_COMMENT_FILE.exists():
        return default_data

    try:
        with OLLAMA_COMMENT_FILE.open("r", encoding="utf-8") as f:
            loaded = json.load(f)

        if isinstance(loaded, dict):
            default_data.update(loaded)

        return default_data

    except Exception:
        return default_data


def save_ollama_comment(
    comment: str,
    model: str,
    python_summary: str = "",
    response_mode: str = "",
    elapsed_sec=None,
    prompt_chars: int = 0,
    num_predict: int = 0,
):
    """
    最後に生成したOllamaコメントを保存する。
    方向判定はPython側サマリーを優先するため、生成時のPythonサマリーも一緒に保存する。
    v0.5-candidate-10では、高速化の検証用に生成時間・モード・プロンプト長も保存する。
    """
    try:
        elapsed_value = None if elapsed_sec is None else round(float(elapsed_sec), 2)
    except Exception:
        elapsed_value = None

    data = {
        "comment": str(comment),
        "python_summary": str(python_summary),
        "created_at": datetime.now(JST).isoformat(timespec="seconds"),
        "model": str(model),
        "version": APP_VERSION,
        "response_mode": str(response_mode),
        "elapsed_sec": elapsed_value,
        "prompt_chars": int(prompt_chars or 0),
        "num_predict": int(num_predict or 0),
    }

    with OLLAMA_COMMENT_FILE.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def clear_ollama_comment():
    """
    保存済みOllamaコメントを削除する。
    """
    try:
        if OLLAMA_COMMENT_FILE.exists():
            OLLAMA_COMMENT_FILE.unlink()
    except Exception as e:
        st.warning(f"Ollamaコメントの削除に失敗しました: {e}")


def load_ollama_job_status() -> dict:
    """
    バックグラウンドOllama生成の状態を読む。
    """
    default_data = {
        "status": "idle",
        "started_at": "",
        "finished_at": "",
        "model": "",
        "message": "",
        "version": APP_VERSION,
    }

    if not OLLAMA_JOB_FILE.exists():
        return default_data

    try:
        with OLLAMA_JOB_FILE.open("r", encoding="utf-8") as f:
            loaded = json.load(f)
        if isinstance(loaded, dict):
            default_data.update(loaded)
    except Exception:
        pass

    return default_data


def save_ollama_job_status(status: str, model: str = "", message: str = "", started_at: str = "", finished_at: str = ""):
    """
    バックグラウンドOllama生成の状態を保存する。
    """
    now_text = datetime.now(JST).isoformat(timespec="seconds")

    data = load_ollama_job_status()
    data.update({
        "status": str(status),
        "model": str(model),
        "message": str(message),
        "version": APP_VERSION,
    })

    if started_at:
        data["started_at"] = str(started_at)
    elif status == "running":
        data["started_at"] = now_text

    if finished_at:
        data["finished_at"] = str(finished_at)
    elif status in ["done", "error", "invalid"]:
        data["finished_at"] = now_text

    try:
        with OLLAMA_JOB_FILE.open("w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def clear_ollama_job_status():
    try:
        if OLLAMA_JOB_FILE.exists():
            OLLAMA_JOB_FILE.unlink()
    except Exception:
        pass


def start_ollama_background_generation(
    ollama_url: str,
    model: str,
    prompt: str,
    python_summary: str,
    metrics_df: pd.DataFrame,
    response_mode: str = "高速",
):
    """
    Ollama生成をバックグラウンドで走らせる。

    これにより、Ollama生成中でも画面操作を止めにくくする。
    価格取得・自動保存はバックグラウンド保存係が継続し、Ollama生成結果は完了後にJSONへ保存する。
    v0.5-candidate-10では生成時間も記録し、高速/通常/詳細モードを切り替えられる。
    """
    current_status = load_ollama_job_status()
    if current_status.get("status") == "running":
        return False, "すでにOllamaコメント生成中です。完了を待つか、少し時間を置いてください。"

    started_at = datetime.now(JST).isoformat(timespec="seconds")
    mode_config = get_ollama_mode_config(response_mode)
    save_ollama_job_status(
        status="running",
        model=model,
        message=f"Ollamaコメントをバックグラウンド生成中です。モード: {mode_config['label']}",
        started_at=started_at,
    )

    metrics_snapshot = metrics_df.copy() if metrics_df is not None else pd.DataFrame()
    prompt_chars = len(str(prompt))

    def worker():
        started_monotonic = time.monotonic()
        try:
            comment, error = ask_ollama(
                ollama_url=ollama_url,
                model=model,
                prompt=prompt,
                response_mode=mode_config["label"],
            )
            elapsed_sec = time.monotonic() - started_monotonic

            if error:
                save_ollama_job_status(
                    status="error",
                    model=model,
                    message=f"Ollamaコメントの取得に失敗しました: {error}",
                    started_at=started_at,
                )
                return

            issues = validate_ollama_comment(comment, metrics_snapshot)
            if issues:
                save_ollama_job_status(
                    status="invalid",
                    model=model,
                    message="OllamaコメントにPython判定と矛盾する可能性があるため保存しませんでした。 " + " / ".join(issues),
                    started_at=started_at,
                )
                return

            save_ollama_comment(
                comment=comment,
                model=model,
                python_summary=python_summary,
                response_mode=mode_config["label"],
                elapsed_sec=elapsed_sec,
                prompt_chars=prompt_chars,
                num_predict=mode_config["num_predict"],
            )
            save_ollama_job_status(
                status="done",
                model=model,
                message=f"Ollamaコメントを保存しました。生成時間: {elapsed_sec:.1f}秒 / モード: {mode_config['label']} / プロンプト: {prompt_chars:,}文字",
                started_at=started_at,
            )
        except Exception as e:
            save_ollama_job_status(
                status="error",
                model=model,
                message=f"バックグラウンド生成中にエラーが起きました: {e}",
                started_at=started_at,
            )

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    return True, None


# =========================
# Ollama
# =========================

def direction_from_value(value, flat_threshold: float = 0.0) -> str:
    """
    数値から方向を決める。Ollamaにはこの方向を優先させる。
    """
    value = pd.to_numeric(value, errors="coerce")

    if pd.isna(value):
        return "履歴不足"

    if abs(float(value)) <= float(flat_threshold):
        return "横ばい"

    if float(value) > 0:
        return "上昇"

    return "下降"


def build_python_market_summary(metrics_df: pd.DataFrame, impact_df: pd.DataFrame, alert_df: pd.DataFrame = None) -> str:
    """
    Ollamaに渡す前に、Python側で方向を確定したサマリーを作る。
    Ollamaの方向判定はこの内容に従わせる。
    """
    lines = []

    if metrics_df is None or metrics_df.empty:
        return "Python判定: 価格メトリクスがありません。"

    for _, row in metrics_df.iterrows():
        symbol = row.get("通貨", "")
        current_price = row.get("現在価格", pd.NA)

        prev_diff = row.get("前回比(円)", pd.NA)
        prev_pct = row.get("前回比(%)", pd.NA)
        prev_direction = direction_from_value(prev_diff)

        short_diff = row.get("短期変化(円)", pd.NA)
        short_pct = row.get("短期変化(%)", pd.NA)
        short_direction = direction_from_value(short_diff)

        short_label = row.get("短期傾向", "")
        short_size = row.get("短期変化の大きさ", "")

        lines.append(
            f"{symbol}: 現在価格 {fmt_yen(current_price)}。"
            f"前回比は {prev_direction}（{fmt_yen(prev_diff, signed=True)} / {fmt_pct(prev_pct, signed=True)}）。"
            f"短期変化は {short_direction}（{fmt_yen(short_diff, signed=True)} / {fmt_pct(short_pct, signed=True)}）。"
            f"Python判定ラベルは「{short_label}」、大きさは「{short_size}」。"
        )

    if alert_df is not None and not alert_df.empty:
        active = alert_df[alert_df["状態"].isin(["急騰", "注意", "継続上昇", "継続候補", "上昇傾向", "候補"])]
        if not active.empty:
            for _, row in active.iterrows():
                timing_label = format_alert_timing(row)
                timing_text = f"判定区間は {timing_label}。" if timing_label else ""

                lines.append(
                    f"アラート/イベント: {row.get('種類', '')} / {row.get('通貨', '')} は「{row.get('状態', '')}」。"
                    f"{timing_text}"
                    f"監視範囲は {row.get('監視範囲', '')}、実データ基準 {row.get('基準時刻', '')} から {fmt_yen(row.get('上昇額', pd.NA), signed=True)} / "
                    f"{fmt_pct(row.get('上昇率(%)', pd.NA), signed=True)}。"
                )

    return "\n".join(lines)


def validate_ollama_comment(comment: str, metrics_df: pd.DataFrame) -> list:
    """
    OllamaコメントがPythonの方向判定と矛盾していないか、簡易チェックする。
    矛盾していそうなら保存しない。
    """
    issues = []

    if not comment or metrics_df is None or metrics_df.empty:
        return issues

    text = str(comment)

    down_words = ["下降", "下落", "下げ", "弱含み", "downward", "down trend", "bearish"]
    up_words = ["上昇", "上げ", "上向き", "upward", "up trend", "bullish"]
    negation_words = ["ではない", "ではありません", "ではなく", "とは言えない", "とはいえない"]

    sentences = re.split(r"[。\n]", text)

    for _, row in metrics_df.iterrows():
        symbol = str(row.get("通貨", ""))
        short_diff = pd.to_numeric(row.get("短期変化(円)", pd.NA), errors="coerce")
        prev_diff = pd.to_numeric(row.get("前回比(円)", pd.NA), errors="coerce")

        if not symbol:
            continue

        # 通貨名を含む文だけを見る。通貨名なしの全体コメントは警告を弱めるため対象外。
        related_sentences = [s for s in sentences if symbol in s]

        for sentence in related_sentences:
            has_negation = any(word in sentence for word in negation_words)

            if has_negation:
                continue

            if pd.notna(short_diff) and short_diff > 0:
                if any(word in sentence for word in down_words):
                    issues.append(
                        f"{symbol}: Pythonでは短期変化が上昇（{fmt_yen(short_diff, signed=True)}）ですが、Ollamaコメントに下降系の表現があります。"
                    )

            if pd.notna(short_diff) and short_diff < 0:
                if any(word in sentence for word in up_words):
                    issues.append(
                        f"{symbol}: Pythonでは短期変化が下降（{fmt_yen(short_diff, signed=True)}）ですが、Ollamaコメントに上昇系の表現があります。"
                    )

            if pd.notna(prev_diff) and prev_diff > 0 and "前回" in sentence:
                if any(word in sentence for word in down_words):
                    issues.append(
                        f"{symbol}: Pythonでは前回比が上昇（{fmt_yen(prev_diff, signed=True)}）ですが、Ollamaコメントに下降系の表現があります。"
                    )

            if pd.notna(prev_diff) and prev_diff < 0 and "前回" in sentence:
                if any(word in sentence for word in up_words):
                    issues.append(
                        f"{symbol}: Pythonでは前回比が下降（{fmt_yen(prev_diff, signed=True)}）ですが、Ollamaコメントに上昇系の表現があります。"
                    )

    return issues



def get_ollama_mode_config(response_mode: str) -> dict:
    """
    Ollamaコメント生成の速さと詳しさを切り替える。
    qwen3:8bでは、高速モードで送信量と出力量を小さくする。
    """
    label = str(response_mode or "高速")
    if label not in ["高速", "通常", "詳細"]:
        label = "高速"

    configs = {
        "高速": {
            "label": "高速",
            "num_predict": 90,
            "temperature": 0.15,
            "timeout": 60,
            "max_alerts": 2,
            "include_tables": False,
            "instruction": "2〜3行。重要なアラートがあれば最優先。結論だけ。",
        },
        "通常": {
            "label": "通常",
            "num_predict": 150,
            "temperature": 0.2,
            "timeout": 90,
            "max_alerts": 4,
            "include_tables": False,
            "instruction": "3〜5行。アラート、短期傾向、数量影響を分けて簡潔に。",
        },
        "詳細": {
            "label": "詳細",
            "num_predict": 240,
            "temperature": 0.2,
            "timeout": 120,
            "max_alerts": 8,
            "include_tables": True,
            "instruction": "5〜8行。必要な数字を少し詳しく。ただし売買判断はしない。",
        },
    }
    return configs[label]


def build_compact_ollama_context(metrics_df: pd.DataFrame, impact_df: pd.DataFrame, alert_df: pd.DataFrame = None, max_alerts: int = 2) -> str:
    """
    Ollamaに送る情報を短く圧縮する。
    DataFrame全体をto_stringで送るよりも軽く、方向判定の矛盾も減らす。
    """
    lines = []

    if metrics_df is not None and not metrics_df.empty:
        for _, row in metrics_df.iterrows():
            symbol = row.get("通貨", "")
            lines.append(
                f"{symbol}: price={fmt_yen(row.get('現在価格'))}, "
                f"prev={fmt_yen(row.get('前回比(円)'), signed=True)}/{fmt_pct(row.get('前回比(%)'), signed=True)}, "
                f"short={fmt_yen(row.get('短期変化(円)'), signed=True)}/{fmt_pct(row.get('短期変化(%)'), signed=True)}, "
                f"label={row.get('短期傾向', '')}/{row.get('短期変化の大きさ', '')}"
            )

    if impact_df is not None and not impact_df.empty:
        focus = impact_df.copy()
        if "想定額(JPY)" in focus.columns:
            # 10,000円があれば優先。なければ小さめの行数に抑える。
            focus["_amount_diff"] = (pd.to_numeric(focus["想定額(JPY)"], errors="coerce") - 10000).abs()
            focus = focus.sort_values(["通貨", "_amount_diff"]).groupby("通貨", as_index=False).head(1)
        else:
            focus = focus.head(2)

        for _, row in focus.iterrows():
            lines.append(
                f"impact {row.get('通貨', '')} {fmt_yen(row.get('想定額(JPY)'))}: "
                f"prev={fmt_yen(row.get('前回比の影響額(円)'), digits=2, signed=True)}, "
                f"short={fmt_yen(row.get('短期変化の影響額(円)'), digits=2, signed=True)}"
            )

    if alert_df is not None and not alert_df.empty:
        active = alert_df[alert_df["状態"].isin(["急騰", "注意", "継続上昇", "継続候補", "上昇傾向", "候補"])].copy()
        if not active.empty:
            priority = {"急騰": 1, "注意": 2, "継続上昇": 3, "継続候補": 4, "候補": 5, "上昇傾向": 6}
            active["_priority"] = active["状態"].map(priority).fillna(99)
            active["_abs_pct"] = pd.to_numeric(active.get("上昇率(%)", 0), errors="coerce").abs().fillna(0)
            active = active.sort_values(["_priority", "_abs_pct"], ascending=[True, False]).head(int(max_alerts))
            for _, row in active.iterrows():
                lines.append(
                    f"alert {row.get('種類', '')}/{row.get('通貨', '')}: "
                    f"{row.get('状態', '')}, {format_alert_timing(row)}, "
                    f"{fmt_yen(row.get('上昇額'), signed=True)}/{fmt_pct(row.get('上昇率(%)'), signed=True)}"
                )

    return "\n".join(lines)

def build_ollama_prompt(metrics_df: pd.DataFrame, impact_df: pd.DataFrame, alert_df: pd.DataFrame = None, response_mode: str = "高速") -> str:
    """
    Ollamaへ送るプロンプトを作る。
    v0.5-candidate-10では、高速/通常モードでは表全体を送らず、Python判定サマリーと圧縮コンテキストだけにする。
    """
    mode_config = get_ollama_mode_config(response_mode)
    python_summary = build_python_market_summary(metrics_df, impact_df, alert_df)
    compact_context = build_compact_ollama_context(
        metrics_df=metrics_df,
        impact_df=impact_df,
        alert_df=alert_df,
        max_alerts=mode_config["max_alerts"],
    )

    base_prompt = f"""
あなたは暗号資産のローカル監視ダッシュボードの補助コメント係です。

最重要ルール:
- 売買判断、投資助言、買い推奨、売り推奨、注文指示はしない。
- 上昇/下降の方向判定は、必ず下の「Python判定サマリー」に従う。
- Python判定サマリーで「上昇」とある通貨を「下降」「下落」「downward trend」と書いてはいけない。
- Python判定サマリーで「下降」とある通貨を「上昇」と書いてはいけない。
- 「前回比」「短期変化」「アラート/急騰検出」を混同しない。
- アラート/急騰検出に「急騰」「注意」「上昇傾向」「候補」がある場合は、短期傾向よりも先に触れる。
- 急騰・注意・継続上昇に触れるときは、判定区間や時間幅も書く。
- 思考過程は書かない。{mode_config['instruction']}
- 不明な場合は「Python表示を優先してください」と書く。

Python判定サマリー:
{python_summary}

圧縮データ:
{compact_context}
"""

    if mode_config["include_tables"]:
        base_prompt += f"""

詳細表（必要なときだけ参照）:
価格変化メトリクス:
{metrics_df.to_string(index=False) if metrics_df is not None else ''}

数量別の影響額:
{impact_df.to_string(index=False) if impact_df is not None else ''}
"""

    return base_prompt


def normalize_ollama_api_url(ollama_url: str, endpoint: str = "chat") -> str:
    """
    Ollama URLをAPIエンドポイント付きのURLへ整える。
    入力が http://host:11434 / http://host:11434/api/chat / http://host:11434/api/generate
    のどれでも動くようにする。
    """
    base = str(ollama_url or "").strip().rstrip("/")

    if not base:
        base = DEFAULT_OLLAMA_URL

    if base.endswith("/api/chat") or base.endswith("/api/generate"):
        return base

    endpoint = "generate" if endpoint == "generate" else "chat"
    return f"{base}/api/{endpoint}"


def extract_ollama_content(data: dict) -> str:
    """
    /api/chat と /api/generate の返答形式の違いを吸収する。
    """
    if not isinstance(data, dict):
        return ""

    message = data.get("message")
    if isinstance(message, dict):
        content = message.get("content", "")
        if content:
            return str(content).strip()

    response_text = data.get("response", "")
    if response_text:
        return str(response_text).strip()

    return ""


def post_ollama_json(api_url: str, payload: dict, timeout: int = 90):
    """
    qwen3系でthinkingを切るために think=False を入れる。
    古いOllamaでthinkフィールドが原因で失敗した場合は、thinkなしで一度だけ再試行する。
    """
    response = requests.post(api_url, json=payload, timeout=timeout)

    if response.status_code >= 400 and "think" in payload:
        error_text = str(response.text).lower()
        if "think" in error_text or "unknown" in error_text or "invalid" in error_text:
            retry_payload = dict(payload)
            retry_payload.pop("think", None)
            response = requests.post(api_url, json=retry_payload, timeout=timeout)

    response.raise_for_status()
    return response.json()


def ask_ollama(ollama_url: str, model: str, prompt: str, response_mode: str = "高速"):
    """
    Ollamaに補足コメントを依頼する。
    必ず (comment, error) の2つを返す。
    qwen3:8bではthinkを切り、モード別に送信量と出力量を抑える。
    """
    try:
        api_url = normalize_ollama_api_url(ollama_url, endpoint="chat")
        mode_config = get_ollama_mode_config(response_mode)

        common_payload = {
            "model": model,
            "stream": False,
            "think": False,
            "keep_alive": "30m",
            "options": {
                "temperature": float(mode_config["temperature"]),
                "num_predict": int(mode_config["num_predict"]),
            },
        }

        system_content = (
            "あなたは暗号資産価格監視ダッシュボードの補足コメント係です。"
            "売買判断や注文指示はしません。"
            "Python側で計算済みの方向・割合・注意ラベルを必ず尊重してください。"
            "思考過程は出さず、短く日本語で答えてください。"
        )

        if api_url.endswith("/api/generate"):
            payload = {
                **common_payload,
                "prompt": system_content + "\n" + prompt,
            }
        else:
            payload = {
                **common_payload,
                "messages": [
                    {
                        "role": "system",
                        "content": system_content,
                    },
                    {
                        "role": "user",
                        "content": prompt,
                    },
                ],
            }

        data = post_ollama_json(api_url, payload, timeout=int(mode_config["timeout"]))
        comment = extract_ollama_content(data)

        if not comment:
            return None, "Ollamaから空の返答が返りました。"

        return comment, None

    except Exception as e:
        return None, str(e)


def warmup_ollama(ollama_url: str, model: str):
    """
    モデルを先に読み込ませるための軽いウォームアップ。
    コメント生成はしない。
    """
    try:
        api_url = normalize_ollama_api_url(ollama_url, endpoint="generate")
        if api_url.endswith("/api/chat"):
            api_url = api_url[:-len("/api/chat")] + "/api/generate"

        payload = {
            "model": model,
            "prompt": "",
            "stream": False,
            "think": False,
            "keep_alive": "30m",
            "options": {
                "num_predict": 1,
                "temperature": 0.0,
            },
        }
        post_ollama_json(api_url, payload, timeout=90)
        return True, None
    except Exception as e:
        return False, str(e)


def set_ollama_client_busy(is_busy: bool):
    """
    Ollama生成中に既存の自動更新タイマーが走ってページを再読み込みしないよう、
    ブラウザ側に短時間のbusyフラグを置く。
    """
    if is_busy:
        script = """
        <script>
        const key = 'binance_watcher_ollama_busy_at';
        window.parent.localStorage.setItem(key, String(Date.now()));
        if (window.parent.__binanceWatcherRefreshTimer) {
            window.parent.clearTimeout(window.parent.__binanceWatcherRefreshTimer);
            window.parent.__binanceWatcherRefreshTimer = null;
        }
        </script>
        """
    else:
        script = """
        <script>
        window.parent.localStorage.removeItem('binance_watcher_ollama_busy_at');
        </script>
        """

    components.html(script, height=0)


def ollama_text_to_html(text: str) -> str:
    return html.escape(str(text)).replace("\n", "<br>")


def show_ollama_small_box(text: str, kind: str = "info"):
    css_class = "ollama-small-warning" if kind == "warning" else "ollama-small-info"
    st.markdown(
        f'<div class="ollama-small-box {css_class}">{ollama_text_to_html(text)}</div>',
        unsafe_allow_html=True,
    )


def test_ollama_connection(ollama_url: str):
    try:
        response = requests.get(f"{ollama_url.rstrip('/')}/api/tags", timeout=10)
        response.raise_for_status()
        models = response.json().get("models", [])
        names = [m.get("name") for m in models if m.get("name")]
        return names, None
    except Exception as e:
        return [], str(e)


# =========================
# Streamlit UI
# =========================

st.set_page_config(page_title=f"Binance Local Watcher {APP_VERSION}", layout="wide")

st.markdown(
    """
    <style>
    .main .block-container { padding-top: 1.2rem; padding-bottom: 2rem; }
    .app-title { font-size: 2.0rem; font-weight: 800; margin-bottom: 0.1rem; }
    .app-subtitle { color: #666; font-size: 0.95rem; margin-bottom: 1rem; }
    .version-pill {
        display:inline-block;
        padding: 3px 10px;
        border-radius:999px;
        border: 1px solid rgba(128,128,128,0.3);
        font-size: 0.85rem;
        background: rgba(250,250,250,0.85);
        margin-bottom: 0.8rem;
    }
    .price-card {
        border: 1px solid rgba(128,128,128,0.25);
        border-radius: 18px;
        padding: 16px 18px;
        margin-bottom: 12px;
        background: rgba(250,250,250,0.80);
        box-shadow: 0 1px 8px rgba(0,0,0,0.04);
    }
    .symbol-name { font-size: 1.25rem; font-weight: 800; margin-bottom: 4px; }
    .price-main { font-size: 1.85rem; font-weight: 800; margin-bottom: 8px; }
    .small-line { color: #555; font-size: 0.92rem; line-height: 1.6; }
    .badge {
        display: inline-block;
        padding: 3px 9px;
        border-radius: 999px;
        border: 1px solid rgba(128,128,128,0.25);
        font-size: 0.86rem;
        margin-top: 6px;
        background: rgba(255,255,255,0.75);
    }
    .note-box {
        border-left: 4px solid rgba(128,128,128,0.5);
        padding: 0.7rem 0.9rem;
        background: rgba(250,250,250,0.8);
        border-radius: 10px;
        margin: 0.4rem 0 1rem 0;
        color: #444;
    }

    .compact-alert {
        border-radius: 10px;
        padding: 0.34rem 0.58rem;
        margin: 0.18rem 0 0.28rem 0;
        font-size: 0.82rem;
        line-height: 1.35;
        border: 1px solid rgba(128,128,128,0.22);
    }
    .compact-alert-warning {
        background: rgba(255, 193, 7, 0.13);
        border-left: 4px solid rgba(255, 193, 7, 0.75);
    }
    .compact-alert-info {
        background: rgba(13, 110, 253, 0.08);
        border-left: 4px solid rgba(13, 110, 253, 0.45);
    }
    .summary-fetch-time {
        display: inline-block;
        font-size: 0.86rem;
        color: #555;
        margin: 0.1rem 0 0.55rem 0;
        padding: 0.18rem 0.55rem;
        border-radius: 999px;
        background: rgba(128, 128, 128, 0.08);
        border: 1px solid rgba(128, 128, 128, 0.16);
    }
    .ollama-small-area {
        font-size: 0.88rem;
        line-height: 1.55;
    }
    .ollama-small-area p,
    .ollama-small-area li,
    .ollama-small-area div {
        font-size: 0.88rem;
        line-height: 1.55;
    }
    .ollama-small-box {
        font-size: 0.86rem;
        line-height: 1.55;
        border-radius: 10px;
        padding: 0.58rem 0.72rem;
        margin: 0.28rem 0 0.65rem 0;
        border: 1px solid rgba(128,128,128,0.18);
    }
    .ollama-small-info {
        background: rgba(13, 110, 253, 0.07);
        border-left: 4px solid rgba(13, 110, 253, 0.35);
    }
    .ollama-small-warning {
        background: rgba(255, 193, 7, 0.12);
        border-left: 4px solid rgba(255, 193, 7, 0.75);
    }
    .ollama-small-meta {
        font-size: 0.78rem;
        color: #666;
        margin: -0.2rem 0 0.45rem 0;
    }
    </style>
    """,
    unsafe_allow_html=True,
)

st.markdown(f'<div class="app-title">Binance Local Watcher {APP_VERSION}</div>', unsafe_allow_html=True)
st.markdown(f'<div class="version-pill">現在の app.py: <b>{APP_VERSION}</b></div>', unsafe_allow_html=True)
st.markdown(
    f'<div class="app-subtitle">表示バージョン: <b>{APP_VERSION}</b> / 前回比・短期傾向・数量別影響額に加えて、手数料・成行コスト込みの取引前シミュレーターと、日次目標の未約定キャンセル/約定後損切りを確認できます。実注文は行いません。</div>',
    unsafe_allow_html=True,
)

# =========================
# タブ
# =========================

summary_tab, alert_tab, impact_tab, trade_tab, daily_goal_tab, api_tab, chart_tab, ollama_tab, detail_tab = st.tabs(
    ["サマリー", "アラート", "数量別影響", "取引シミュレーター", "日次目標", "API・準備度", "チャート・履歴", "Ollama", "保存状態"]
)


settings = load_settings()

with st.sidebar:
    st.header("設定")
    st.info(f"起動中の app.py バージョン: {APP_VERSION}")

    st.subheader("保存・監視")

    monitor_paused = st.checkbox(
        "短期監視を一時停止する",
        value=bool(settings.get("monitor_paused", False)),
        key="monitor_paused_input",
        help="ONにするとBinanceの現在価格取得と自動保存を止め、最後に保存された価格だけを表示します。",
    )
    update_setting_if_changed(settings, "monitor_paused", bool(monitor_paused))

    auto_save = st.checkbox(
        "一定間隔で価格を履歴に保存する",
        value=bool(settings.get("auto_save", True)),
        key="auto_save_input",
        disabled=bool(monitor_paused),
    )
    update_setting_if_changed(settings, "auto_save", bool(auto_save))

    save_interval_sec = st.number_input(
        "保存間隔（秒）",
        min_value=10,
        max_value=3600,
        value=int(settings.get("save_interval_sec", 60)),
        step=10,
        key="save_interval_sec_input",
        disabled=bool(monitor_paused),
    )
    update_setting_if_changed(settings, "save_interval_sec", int(save_interval_sec))

    manual_save = st.button(
        "今の価格を取得して履歴に保存",
        use_container_width=True,
        disabled=bool(monitor_paused),
        help="画面自動リロードは使わず、このボタンを押した時だけ今の価格を直接取得して保存します。",
    )

    refresh_view = st.button(
        "表示を更新",
        use_container_width=True,
        help="保存済みCSVを読み直して、サマリーやグラフ表示を更新します。",
    )

    st.subheader("長期分析データ")

    long_data_date = st.date_input(
        "取得する日付",
        value=datetime.now(JST).date(),
        key="long_data_date_input",
        help="指定日の1分足を取得して、日付単位CSVへ重複なしで追加します。",
    )

    long_data_skip_existing = st.checkbox(
        "既存CSVがあれば重複取得を避ける",
        value=bool(settings.get("long_data_skip_existing", True)),
        key="long_data_skip_existing_input",
        help="ONにすると、指定範囲のデータが既に十分ある通貨は再取得せず、CSV統合と重複削除だけ行います。",
    )
    update_setting_if_changed(settings, "long_data_skip_existing", bool(long_data_skip_existing))

    download_full_day = st.button(
        "この日の丸一日を取得（0:00〜24:00）",
        use_container_width=True,
        help="例: 2026/05/24を選ぶと、5/24 0:00〜5/25 0:00 JST の1分足を取得します。",
    )

    st.caption("指定時間帯を追加取得できます。例: 12:00〜13:00")

    range_cols = st.columns(2)
    with range_cols[0]:
        long_data_range_start = st.text_input(
            "開始時刻",
            value=str(settings.get("long_data_range_start", "12:00")),
            key="long_data_range_start_input",
            help="HH:MM形式。例: 12:00",
        )
        update_setting_if_changed(settings, "long_data_range_start", str(long_data_range_start))

    with range_cols[1]:
        long_data_range_end = st.text_input(
            "終了時刻",
            value=str(settings.get("long_data_range_end", "13:00")),
            key="long_data_range_end_input",
            help="HH:MM形式。丸一日取得では 24:00 も使えます。",
        )
        update_setting_if_changed(settings, "long_data_range_end", str(long_data_range_end))

    download_custom_range = st.button(
        "指定時間帯を追加取得",
        use_container_width=True,
        help="指定した時間帯を、日付単位CSVへ重複なしで追加します。",
    )

    download_until_noon = st.button(
        "午前データを取得（0:00〜12:00）",
        use_container_width=True,
        help="従来の0:00〜12:00取得です。保存先は日付単位CSVになります。",
    )

    st.subheader("短期傾向")
    trend_points = st.slider(
        "短期傾向に使う履歴数",
        min_value=3,
        max_value=30,
        value=int(settings.get("trend_points", 10)),
        step=1,
        key="trend_points_input",
    )
    update_setting_if_changed(settings, "trend_points", int(trend_points))

    flat_threshold_pct = st.number_input(
        "横ばい判定しきい値（%）",
        min_value=0.0,
        max_value=5.0,
        value=float(settings.get("flat_threshold_pct", 0.05)),
        step=0.01,
        format="%.2f",
        key="flat_threshold_pct_input",
    )
    update_setting_if_changed(settings, "flat_threshold_pct", float(flat_threshold_pct))

    st.subheader("変化の大きさ")
    small_threshold_pct = st.number_input(
        "微小 → 小 の境目（%）",
        min_value=0.0,
        max_value=10.0,
        value=float(settings.get("small_threshold_pct", 0.10)),
        step=0.01,
        format="%.2f",
        key="small_threshold_pct_input",
    )
    update_setting_if_changed(settings, "small_threshold_pct", float(small_threshold_pct))

    medium_threshold_pct = st.number_input(
        "小 → 中 の境目（%）",
        min_value=0.0,
        max_value=10.0,
        value=float(settings.get("medium_threshold_pct", 0.50)),
        step=0.01,
        format="%.2f",
        key="medium_threshold_pct_input",
    )
    update_setting_if_changed(settings, "medium_threshold_pct", float(medium_threshold_pct))

    large_threshold_pct = st.number_input(
        "中 → 大 の境目（%）",
        min_value=0.0,
        max_value=20.0,
        value=float(settings.get("large_threshold_pct", 1.00)),
        step=0.05,
        format="%.2f",
        key="large_threshold_pct_input",
    )
    update_setting_if_changed(settings, "large_threshold_pct", float(large_threshold_pct))

    st.subheader("数量別影響額")
    st.caption("金額設定は『数量別影響』タブ内へ移動しました。サイドバーは全体設定を中心にします。")

    st.subheader("急騰検出アラート")

    alert_enabled = st.checkbox(
        "急騰検出アラートを使う",
        value=bool(settings.get("alert_enabled", True)),
        key="alert_enabled_input",
    )
    update_setting_if_changed(settings, "alert_enabled", bool(alert_enabled))

    rolling_alert_enabled = st.checkbox(
        "直近の急騰を監視する",
        value=bool(settings.get("rolling_alert_enabled", True)),
        key="rolling_alert_enabled_input",
        help="23:30のような固定時刻ではなく、直近N分の値動きを常に監視します。",
    )
    update_setting_if_changed(settings, "rolling_alert_enabled", bool(rolling_alert_enabled))

    rolling_alert_window_minutes = st.selectbox(
        "直近監視の時間幅",
        options=[5, 10, 15, 20, 30, 60],
        index=[5, 10, 15, 20, 30, 60].index(int(settings.get("rolling_alert_window_minutes", 10))) if int(settings.get("rolling_alert_window_minutes", 10)) in [5, 10, 15, 20, 30, 60] else 1,
        key="rolling_alert_window_minutes_input",
        help="例: 10分を選ぶと、常に直近10分間の上昇を見ます。",
    )
    update_setting_if_changed(settings, "rolling_alert_window_minutes", int(rolling_alert_window_minutes))

    sustained_rise_enabled = st.checkbox(
        "継続上昇も検出する",
        value=bool(settings.get("sustained_rise_enabled", True)),
        key="sustained_rise_enabled_input",
        help="15分・20分・30分など、急騰より少し長く上昇が続く動きを別枠で見ます。",
    )
    update_setting_if_changed(settings, "sustained_rise_enabled", bool(sustained_rise_enabled))

    sustained_rise_windows_text = st.text_input(
        "継続上昇を見る時間幅（分）",
        value=str(settings.get("sustained_rise_windows_text", "15,20,30")),
        key="sustained_rise_windows_text_input",
        help="カンマ区切りで指定します。例: 15,20,30",
    )
    update_setting_if_changed(settings, "sustained_rise_windows_text", str(sustained_rise_windows_text))

    sustained_cols = st.columns(2)
    with sustained_cols[0]:
        sustained_rise_max_pullback_pct = st.number_input(
            "継続上昇の押し戻し許容（%）",
            min_value=0.0,
            max_value=5.0,
            value=float(settings.get("sustained_rise_max_pullback_pct", 0.05)),
            step=0.01,
            format="%.2f",
            key="sustained_rise_max_pullback_pct_input",
            help="途中の高値から何%まで押し戻してよいかです。小さいほど厳しい判定です。",
        )
        update_setting_if_changed(settings, "sustained_rise_max_pullback_pct", float(sustained_rise_max_pullback_pct))

    with sustained_cols[1]:
        sustained_rise_close_near_high_pct = st.number_input(
            "終値の高値離れ許容（%）",
            min_value=0.0,
            max_value=5.0,
            value=float(settings.get("sustained_rise_close_near_high_pct", 0.03)),
            step=0.01,
            format="%.2f",
            key="sustained_rise_close_near_high_pct_input",
            help="最後の価格が監視範囲内の高値から何%以内なら高値圏とみなすかです。",
        )
        update_setting_if_changed(settings, "sustained_rise_close_near_high_pct", float(sustained_rise_close_near_high_pct))

    event_alert_enabled = st.checkbox(
        "過去の急騰イベントも検出する",
        value=bool(settings.get("event_alert_enabled", True)),
        key="event_alert_enabled_input",
        help="直近監視から外れた後でも、過去数時間の中に急騰区間があれば拾います。",
    )
    update_setting_if_changed(settings, "event_alert_enabled", bool(event_alert_enabled))

    event_cols = st.columns(2)
    with event_cols[0]:
        event_lookback_hours = st.selectbox(
            "イベント探索範囲",
            options=[1, 3, 6, 12, 24],
            index=[1, 3, 6, 12, 24].index(int(settings.get("event_lookback_hours", 6))) if int(settings.get("event_lookback_hours", 6)) in [1, 3, 6, 12, 24] else 2,
            key="event_lookback_hours_input",
            help="過去何時間の中から急騰イベントを探すかです。",
        )
        update_setting_if_changed(settings, "event_lookback_hours", int(event_lookback_hours))

    with event_cols[1]:
        event_window_minutes = st.selectbox(
            "イベント判定窓",
            options=[5, 10, 15, 20, 30, 60],
            index=[5, 10, 15, 20, 30, 60].index(int(settings.get("event_window_minutes", 15))) if int(settings.get("event_window_minutes", 15)) in [5, 10, 15, 20, 30, 60] else 2,
            key="event_window_minutes_input",
            help="何分間の上昇を1つのイベントとして見るかです。",
        )
        update_setting_if_changed(settings, "event_window_minutes", int(event_window_minutes))

    event_use_peak_price = st.checkbox(
        "急騰検出で窓内の最高値も見る",
        value=bool(settings.get("event_use_peak_price", True)),
        key="event_use_peak_price_input",
        help="ONにすると、8:30〜8:40で上がってその後少し戻った場合も拾いやすくなります。",
    )
    update_setting_if_changed(settings, "event_use_peak_price", bool(event_use_peak_price))

    event_candidate_mode = st.checkbox(
        "しきい値未満の急騰候補も表示する",
        value=bool(settings.get("event_candidate_mode", True)),
        key="event_candidate_mode_input",
        help="ONにすると、急騰条件には少し足りないが方向性が強い動きも候補として表示します。",
    )
    update_setting_if_changed(settings, "event_candidate_mode", bool(event_candidate_mode))

    fixed_time_alert_enabled = st.checkbox(
        "固定時刻からの確認も使う",
        value=bool(settings.get("fixed_time_alert_enabled", False)),
        key="fixed_time_alert_enabled_input",
        help="例: 23:30から今まで、のように見たい時だけONにします。",
    )
    update_setting_if_changed(settings, "fixed_time_alert_enabled", bool(fixed_time_alert_enabled))

    alert_start_time = st.text_input(
        "固定基準時刻（HH:MM）",
        value=str(settings.get("alert_start_time", "23:30")),
        key="alert_start_time_input",
        help="固定時刻確認用です。通常監視は直近N分を使います。",
    )
    update_setting_if_changed(settings, "alert_start_time", str(alert_start_time))

    alert_threshold_pct = st.number_input(
        "上昇率しきい値（%）",
        min_value=0.0,
        max_value=10.0,
        value=float(settings.get("alert_threshold_pct", 0.03)),
        step=0.01,
        format="%.2f",
        key="alert_threshold_pct_input",
    )
    update_setting_if_changed(settings, "alert_threshold_pct", float(alert_threshold_pct))

    alert_rising_ratio = st.number_input(
        "上昇ステップ率しきい値（%）",
        min_value=0.0,
        max_value=100.0,
        value=float(settings.get("alert_rising_ratio", 70.0)),
        step=5.0,
        format="%.1f",
        key="alert_rising_ratio_input",
        help="基準時刻以降の隣り合う価格差のうち、上昇だった割合です。",
    )
    update_setting_if_changed(settings, "alert_rising_ratio", float(alert_rising_ratio))

    alert_r2_threshold = st.number_input(
        "直線っぽさしきい値",
        min_value=0.0,
        max_value=1.0,
        value=float(settings.get("alert_r2_threshold", 0.60)),
        step=0.05,
        format="%.2f",
        key="alert_r2_threshold_input",
        help="1.0に近いほど、一直線に近い上昇です。",
    )
    update_setting_if_changed(settings, "alert_r2_threshold", float(alert_r2_threshold))

    with st.expander("通貨別アラートしきい値"):
        for symbol in SYMBOLS:
            item = get_alert_symbol_setting(settings, symbol)

            enabled = st.checkbox(
                f"{symbol} を監視する",
                value=bool(item["enabled"]),
                key=f"{symbol}_alert_enabled",
            )
            update_alert_symbol_setting(settings, symbol, "enabled", bool(enabled))

            threshold = st.number_input(
                f"{symbol} 上昇額しきい値（円）",
                min_value=0,
                max_value=10000000,
                value=int(item["threshold_yen"]),
                step=100,
                key=f"{symbol}_alert_threshold_yen",
            )
            update_alert_symbol_setting(settings, symbol, "threshold_yen", int(threshold))

    st.subheader("グラフ表示")
    min_price_axis_width = st.number_input(
        "価格グラフの最低表示幅（円）",
        min_value=0,
        max_value=1000000,
        value=int(settings.get("min_price_axis_width", 0)),
        step=100,
        key="min_price_axis_width_input",
        help="0がおすすめです。値動きが小さすぎて見にくい時だけ増やしてください。",
    )
    update_setting_if_changed(settings, "min_price_axis_width", int(min_price_axis_width))

    saved_chart_interval = normalize_chart_interval(str(settings.get("chart_interval", "そのまま")))
    chart_interval = st.selectbox(
        "グラフの時間間隔",
        options=list(CHART_INTERVAL_OPTIONS.keys()),
        index=list(CHART_INTERVAL_OPTIONS.keys()).index(saved_chart_interval),
        key="chart_interval_input",
        help="横軸は実際の時刻間隔のままです。選んだ間隔ごとに、最後の価格を使ってグラフ表示します。",
    )
    update_setting_if_changed(settings, "chart_interval", str(chart_interval))

    chart_source_options = ["DLデータ＋ローカル補完", "ローカル保存のみ", "DLデータのみ"]
    saved_chart_data_source = str(settings.get("chart_data_source", "DLデータ＋ローカル補完"))

    if saved_chart_data_source not in chart_source_options:
        saved_chart_data_source = "DLデータ＋ローカル補完"

    chart_data_source = st.selectbox(
        "グラフ表示データ",
        options=chart_source_options,
        index=chart_source_options.index(saved_chart_data_source),
        key="chart_data_source_input",
        help="DLデータ＋ローカル補完では、DL済みCSVの最終時刻より後のローカル保存データだけを足します。",
    )
    update_setting_if_changed(settings, "chart_data_source", str(chart_data_source))

    long_files_for_chart = list_long_data_files()
    long_file_labels = ["自動選択（最新CSV）"] + [p.name for p in long_files_for_chart]

    selected_long_file_label = st.selectbox(
        "グラフに使うDL済みCSV",
        options=long_file_labels,
        index=0,
        key="selected_long_file_label_input",
        help="DLデータをグラフに使う場合のCSVです。通常は最新CSVの自動選択でOKです。",
    )

    if selected_long_file_label == "自動選択（最新CSV）":
        selected_long_file = latest_long_data_file()
    else:
        selected_long_file = next((p for p in long_files_for_chart if p.name == selected_long_file_label), None)

    price_axis_padding_pct = st.number_input(
        "価格グラフの上下余白（%）",
        min_value=0.0,
        max_value=20.0,
        value=float(settings.get("price_axis_padding_pct", 1.0)),
        step=0.5,
        format="%.1f",
        key="price_axis_padding_pct_input",
    )
    update_setting_if_changed(settings, "price_axis_padding_pct", float(price_axis_padding_pct))

    with st.expander("通貨別のデフォルト上下幅を調整する"):
        st.caption(
            "手動レンジを使わない通常表示で、上下幅が狭すぎる/広すぎる時に調整します。"
            "ETHJPYは初期値を3,000円にしています。"
        )

        for symbol in SYMBOLS:
            default_width = 3000 if symbol == "ETHJPY" else 0
            current_width = get_symbol_min_axis_width(settings, symbol, default_width)

            width = st.number_input(
                f"{symbol} の最低表示幅（円）",
                min_value=0,
                max_value=1000000,
                value=int(current_width),
                step=100,
                key=f"{symbol}_min_axis_width_input",
                help="0なら実際の価格レンジに密着します。ETHJPYで線が上下しすぎる場合は、3000〜5000円くらいを試してください。",
            )
            update_symbol_min_axis_width(settings, symbol, int(width))

    manual_price_axis_enabled = st.checkbox(
        "全通貨共通の表示範囲を手動指定する",
        value=bool(settings.get("manual_price_axis_enabled", False)),
        key="manual_price_axis_enabled_input",
    )
    update_setting_if_changed(settings, "manual_price_axis_enabled", bool(manual_price_axis_enabled))

    manual_axis_cols = st.columns(2)
    with manual_axis_cols[0]:
        manual_price_axis_min = st.number_input(
            "共通下限（円）",
            min_value=1,
            max_value=100000000,
            value=max(1, int(settings.get("manual_price_axis_min", 8000))),
            step=100,
            key="manual_price_axis_min_input",
        )
        update_setting_if_changed(settings, "manual_price_axis_min", int(manual_price_axis_min))

    with manual_axis_cols[1]:
        manual_price_axis_max = st.number_input(
            "共通上限（円）",
            min_value=1,
            max_value=100000000,
            value=max(1, int(settings.get("manual_price_axis_max", 13000))),
            step=100,
            key="manual_price_axis_max_input",
        )
        update_setting_if_changed(settings, "manual_price_axis_max", int(manual_price_axis_max))

    with st.expander("通貨別に表示範囲を指定する"):
        for symbol in SYMBOLS:
            symbol_axis = get_symbol_axis_settings(settings, symbol)
            st.markdown(f"**{symbol}**")

            enabled = st.checkbox(
                f"{symbol} の表示範囲を固定する",
                value=bool(symbol_axis["enabled"]),
                key=f"{symbol}_axis_enabled",
            )
            update_symbol_axis_setting(settings, symbol, "enabled", bool(enabled))

            cols = st.columns(2)
            with cols[0]:
                y_min = st.number_input(
                    f"{symbol} 下限",
                    min_value=1,
                    max_value=100000000,
                    value=max(1, int(symbol_axis["min"])),
                    step=100,
                    key=f"{symbol}_axis_min",
                )
                update_symbol_axis_setting(settings, symbol, "min", int(y_min))

            with cols[1]:
                y_max = st.number_input(
                    f"{symbol} 上限",
                    min_value=1,
                    max_value=100000000,
                    value=max(1, int(symbol_axis["max"])),
                    step=100,
                    key=f"{symbol}_axis_max",
                )
                update_symbol_axis_setting(settings, symbol, "max", int(y_max))

    st.subheader("Ollama補助コメント")
    use_ollama = st.checkbox(
        "Ollamaコメントを使う",
        value=bool(settings.get("use_ollama", True)),
        key="use_ollama_input",
    )
    update_setting_if_changed(settings, "use_ollama", bool(use_ollama))

    ollama_url = st.text_input(
        "Ollama URL",
        value=str(settings.get("ollama_url", DEFAULT_OLLAMA_URL)),
        key="ollama_url_input",
    )
    update_setting_if_changed(settings, "ollama_url", str(ollama_url))

    ollama_model = st.text_input(
        "Ollama model",
        value=str(settings.get("ollama_model", DEFAULT_OLLAMA_MODEL)),
        key="ollama_model_input",
    )
    update_setting_if_changed(settings, "ollama_model", str(ollama_model))

    ollama_mode_options = ["高速", "通常", "詳細"]
    saved_ollama_response_mode = str(settings.get("ollama_response_mode", "高速"))
    if saved_ollama_response_mode not in ollama_mode_options:
        saved_ollama_response_mode = "高速"

    ollama_response_mode = st.selectbox(
        "Ollama応答モード",
        options=ollama_mode_options,
        index=ollama_mode_options.index(saved_ollama_response_mode),
        key="ollama_response_mode_input",
        help="高速は送信データと出力を短くします。qwen3:8bが重い時は高速がおすすめです。",
    )
    update_setting_if_changed(settings, "ollama_response_mode", str(ollama_response_mode))

    test_ollama_button = st.button("Ollama接続テスト", use_container_width=True)


# =========================
# 数量別影響タブ用の金額設定
# =========================

# Streamlitはウィジェット変更時に先に session_state が更新されるため、
# タブ内ウィジェットより前の計算でも、変更後の値を使える。
impact_amount_preset = st.session_state.get(
    "impact_amount_preset_input",
    settings.get("impact_amount_preset", "比較"),
)
if impact_amount_preset not in IMPACT_AMOUNT_PRESETS:
    impact_amount_preset = "比較"

impact_custom_amount_text = st.session_state.get(
    "impact_amount_text_input",
    settings.get("amount_text", "1000,10000,100000"),
)

amount_text = get_impact_amount_text(impact_amount_preset, impact_custom_amount_text)
focus_amount = normalize_focus_amount(
    st.session_state.get("impact_focus_amount_input", settings.get("focus_amount", 10000)),
    fallback=int(settings.get("focus_amount", 10000)),
)


# =========================
# データ取得・保存
# =========================

# v0.4.2.3-candidate-8:
# 価格取得・自動保存は、画面自動リロードではなくバックグラウンド保存係に任せる。
collector_resource = get_background_price_collector()
collector_status = load_price_collector_status()

history_before_save_df = load_history()
raw_history_before_df = read_raw_history_csv()

long_data_download_result = None

def handle_long_data_download_result(long_df, long_file, long_errors, long_start_jst, long_end_jst, long_status):
    global selected_long_file

    result = {
        "df": long_df,
        "file": long_file,
        "errors": long_errors,
        "start": long_start_jst,
        "end": long_end_jst,
        "status": long_status,
    }

    if long_errors:
        st.warning("一部の長期分析データ取得に失敗しました。")
        for error in long_errors:
            st.write(error)

    if long_file is not None:
        # 今回DL/統合した日付単位CSVを、その場でグラフにも採用する。
        if selected_long_file is None or selected_long_file_label == "自動選択（最新CSV）":
            selected_long_file = long_file

        st.success(
            f"長期分析用データを保存しました: {long_file} "
            f"({len(long_df):,}行 / {long_start_jst.strftime('%Y-%m-%d %H:%M')}〜{long_end_jst.strftime('%Y-%m-%d %H:%M')} JST)"
        )

        if isinstance(long_status, dict):
            requested_range = long_status.get("requested_range", "")
            if requested_range:
                st.info(f"取得対象: {requested_range}")

            skipped = long_status.get("skipped_symbols", [])
            downloaded = long_status.get("downloaded_symbols", [])
            legacy_files = long_status.get("legacy_files_merged", [])

            if skipped:
                st.info(f"重複防止: 指定範囲の既存データが十分あるため再取得を省略: {', '.join(skipped)}")

            if downloaded:
                st.info(f"今回取得した通貨: {', '.join(downloaded)}")
            elif skipped:
                st.info("今回は新規DLなし。既存CSVを読み込んで重複削除のみ確認しました。")

            if legacy_files:
                st.info(f"旧形式CSVも日付単位CSVへ統合対象にしました: {', '.join(legacy_files)}")
    else:
        st.warning("保存できる長期分析用データがありませんでした。")

    return result


if download_full_day:
    with st.spinner("Binanceから丸一日分の1分足を取得・統合中です..."):
        try:
            long_df, long_file, long_errors, long_start_jst, long_end_jst, long_status = download_klines_full_day_to_daily_csv(
                download_date=long_data_date,
                symbols=SYMBOLS,
                interval="1m",
                skip_existing=bool(long_data_skip_existing),
            )
            long_data_download_result = handle_long_data_download_result(
                long_df, long_file, long_errors, long_start_jst, long_end_jst, long_status
            )
        except Exception as e:
            st.error("丸一日分データの取得に失敗しました。")
            st.code(str(e))

elif download_custom_range:
    with st.spinner("Binanceから指定時間帯の1分足を取得・統合中です..."):
        try:
            long_df, long_file, long_errors, long_start_jst, long_end_jst, long_status = download_klines_range_to_daily_csv(
                download_date=long_data_date,
                start_time_text=long_data_range_start,
                end_time_text=long_data_range_end,
                symbols=SYMBOLS,
                interval="1m",
                skip_existing=bool(long_data_skip_existing),
            )
            long_data_download_result = handle_long_data_download_result(
                long_df, long_file, long_errors, long_start_jst, long_end_jst, long_status
            )
        except Exception as e:
            st.error("指定時間帯データの取得に失敗しました。")
            st.code(str(e))

elif download_until_noon:
    with st.spinner("Binanceから0:00〜12:00の1分足を取得・統合中です..."):
        try:
            long_df, long_file, long_errors, long_start_jst, long_end_jst, long_status = download_klines_until_noon(
                download_date=long_data_date,
                symbols=SYMBOLS,
                interval="1m",
                skip_existing=bool(long_data_skip_existing),
            )
            long_data_download_result = handle_long_data_download_result(
                long_df, long_file, long_errors, long_start_jst, long_end_jst, long_status
            )
        except Exception as e:
            st.error("午前データの取得に失敗しました。")
            st.code(str(e))

if monitor_paused:
    current_df = latest_snapshot_from_history(history_before_save_df)
    errors = []

    if current_df.empty:
        st.warning("短期監視は停止中です。まだ履歴がないため、表示できる最新価格がありません。")
        st.stop()
    else:
        st.info("短期監視は一時停止中です。最後に保存された価格を表示しています。")
else:
    # 画面側は基本的に保存済みCSVの最新値を読む。
    # これにより、読む途中でのページ自動リロードを不要にする。
    if manual_save:
        current_df, errors = fetch_all_prices(SYMBOLS)
    else:
        current_df = latest_snapshot_from_history(history_before_save_df)
        errors = []

        # 履歴がまだ空のときだけ、表示用に現在価格を一度取得する。
        # 自動保存そのものはバックグラウンド保存係が担当する。
        if current_df.empty:
            current_df, errors = fetch_all_prices(SYMBOLS)

    if errors:
        st.warning("一部の価格取得に失敗しました。")
        for error in errors:
            st.write(error)

    if current_df.empty:
        st.error("表示できる価格データがありません。Binance APIまたは履歴CSVを確認してください。")
        st.stop()

if current_df is not None and not current_df.empty and "timestamp_dt" in current_df.columns:
    current_price_fetch_time_text = format_jst_timestamp(current_df["timestamp_dt"].max())
else:
    current_price_fetch_time_text = "なし"

now_utc = pd.Timestamp.now(tz="UTC")

if history_before_save_df.empty:
    last_saved_at = None
else:
    last_saved_at = history_before_save_df["timestamp_dt"].max()

can_auto_save = (
    last_saved_at is None
    or (now_utc - last_saved_at).total_seconds() >= int(save_interval_sec)
)

did_save = False
save_error = None
save_reason = "裏側保存に任せる" if auto_save and not monitor_paused else "自動保存OFF"
before_count = len(history_before_save_df)
after_count = len(history_before_save_df)

if monitor_paused:
    save_reason = "短期監視停止中"
elif manual_save:
    did_save, save_error, before_count, after_count = append_history(current_df)
    save_reason = "手動保存"

history_after_save_df = load_history()
raw_history_after_df = read_raw_history_csv()
history_for_metrics_df = history_without_current_snapshot(history_after_save_df, current_df)

if did_save:
    st.success(f"現在価格を履歴に保存しました。({save_reason}: {before_count}行 → {after_count}行)")
elif save_error:
    st.error("履歴保存に失敗しました。")
    st.code(save_error)


# =========================
# 計算
# =========================

amounts = parse_amounts(amount_text)

metrics_df = compute_metrics(
    history_df=history_for_metrics_df,
    current_df=current_df,
    trend_points=int(trend_points),
    flat_threshold_pct=float(flat_threshold_pct),
    small_threshold_pct=float(small_threshold_pct),
    medium_threshold_pct=float(medium_threshold_pct),
    large_threshold_pct=float(large_threshold_pct),
)

impact_df = compute_impact_table(metrics_df, amounts)

rolling_alert_df = compute_rolling_rise_alerts(history_for_metrics_df, current_df, settings)
sustained_alert_df = compute_sustained_rise_alerts(history_for_metrics_df, current_df, settings)
event_alert_df = compute_recent_rise_events(history_for_metrics_df, current_df, settings)

alert_parts = [rolling_alert_df, sustained_alert_df, event_alert_df]

if bool(settings.get("fixed_time_alert_enabled", False)):
    fixed_alert_df = compute_rise_alerts(history_for_metrics_df, current_df, settings)
    alert_parts.append(fixed_alert_df)
else:
    fixed_alert_df = pd.DataFrame()

alert_df = pd.concat(alert_parts, ignore_index=True) if alert_parts else pd.DataFrame()


# =========================
# Ollama接続テスト
# =========================

if test_ollama_button:
    with st.spinner("Ollama接続を確認中です..."):
        model_names, error = test_ollama_connection(ollama_url)

    if error:
        st.warning("Ollamaに接続できませんでした。")
        st.code(error)
    else:
        st.success("Ollamaに接続できました。")
        if model_names:
            st.write("利用可能モデル:")
            st.write(model_names)
        else:
            st.write("モデル一覧は空でした。Mac側で `ollama list` を確認してください。")


# =========================
# 上部ステータス
# =========================

remaining = seconds_until_next_save(
    history_after_save_df["timestamp_dt"].max() if not history_after_save_df.empty else None,
    int(save_interval_sec),
)

collector_status = load_price_collector_status()
collector_label_map = {
    "starting": "起動中",
    "waiting": "待機中",
    "saved": "保存済",
    "paused": "停止中",
    "disabled": "OFF",
    "error": "エラー",
    "idle": "未記録",
}
collector_label = collector_label_map.get(str(collector_status.get("status", "")), str(collector_status.get("status", "")) or "—")
collector_remaining = collector_status.get("remaining_sec", remaining)
try:
    collector_remaining = int(collector_remaining)
except Exception:
    collector_remaining = remaining

status_col1, status_col2, status_col3, status_col4, status_col5 = st.columns(5)
status_col1.metric("履歴行数", f"{len(history_after_save_df):,} 行")
status_col2.metric("短期監視", "停止中" if monitor_paused else "稼働中")
status_col3.metric("裏側保存", collector_label)
status_col4.metric("保存間隔", f"{int(save_interval_sec)} 秒")
status_col5.metric("次の保存目安", f"{collector_remaining} 秒後" if auto_save else "—")

if collector_status.get("status") == "error":
    st.warning(f"裏側保存エラー: {collector_status.get('last_error') or collector_status.get('message')}")


if alert_df is not None and not alert_df.empty:
    show_grouped_top_alerts(alert_df)


with summary_tab:
    st.markdown(
        f'<div class="summary-fetch-time">価格取得時間：{current_price_fetch_time_text}</div>',
        unsafe_allow_html=True,
    )

    st.markdown(
        """
        <div class="note-box">
        <b>見方：</b>「前回比」は直前の保存価格との差です。
        「短期傾向」は直近数回の履歴全体で見た方向です。
        直近だけ上昇でも、短期では下落という表示はあり得ます。
        </div>
        """,
        unsafe_allow_html=True,
    )

    card_cols = st.columns(len(metrics_df))

    for col, (_, row) in zip(card_cols, metrics_df.iterrows()):
        symbol = row["通貨"]

        focus_rows = impact_df[impact_df["通貨"] == symbol].copy()
        if focus_rows.empty:
            focus_prev_impact = pd.NA
            focus_trend_impact = pd.NA
        else:
            focus_rows["amount_diff"] = (
                pd.to_numeric(focus_rows["想定額(JPY)"], errors="coerce") - float(focus_amount)
            ).abs()
            focus_row = focus_rows.sort_values("amount_diff").iloc[0]
            focus_prev_impact = focus_row["前回比の影響額(円)"]
            focus_trend_impact = focus_row["短期変化の影響額(円)"]

        badge = trend_badge_text(row["短期傾向"], row["短期変化の大きさ"])

        col.markdown(
            f"""
            <div class="price-card">
                <div class="symbol-name">{symbol}</div>
                <div class="price-main">{fmt_yen(row["現在価格"])}</div>
                <div class="small-line">前回比：<b>{fmt_yen(row["前回比(円)"], signed=True)}</b> / {fmt_pct(row["前回比(%)"], signed=True)}</div>
                <div class="small-line">短期変化：<b>{fmt_yen(row["短期変化(円)"], signed=True)}</b> / {fmt_pct(row["短期変化(%)"], signed=True)}</div>
                <div class="small-line">{int(focus_amount):,}円ぶんの前回比影響：<b>{fmt_yen(focus_prev_impact, digits=2, signed=True)}</b></div>
                <div class="small-line">{int(focus_amount):,}円ぶんの短期影響：<b>{fmt_yen(focus_trend_impact, digits=2, signed=True)}</b></div>
                <div class="badge">{badge}</div>
            </div>
            """,
            unsafe_allow_html=True,
        )

    st.subheader("整理表")
    st.dataframe(
        make_summary_display(metrics_df, impact_df, focus_amount),
        use_container_width=True,
        hide_index=True,
    )

    if history_before_save_df.empty and not history_after_save_df.empty:
        st.info("今回が初回保存の場合、前回比は次回更新から表示されます。")



with alert_tab:
    st.subheader("急騰検出アラート")

    st.markdown(
        """
        <div class="note-box">
        通常は固定時刻ではなく、直近N分の値動きを常に監視します。
        さらに、15分・20分・30分などで上昇が続く「継続上昇」も別枠で確認します。
        過去数時間の中から「8:30〜8:40ごろ」「23:30〜23:40ごろ」のような急騰も探索します。
        上昇後に少し戻った場合でも、急騰検出では窓内の最高値を見て拾いやすくしています。
        上昇額・上昇率・上昇ステップ率・直線っぽさを見て、急騰として検出します。
        警告文には、計算上の境界時刻ではなく、履歴CSVに実際に存在するデータ時刻を表示します。
        これは売買判断ではなく、監視用の注意表示です。
        </div>
        """,
        unsafe_allow_html=True,
    )

    if alert_df is None or alert_df.empty:
        st.info("アラート判定に使える履歴がまだありません。")
    else:
        alert_display = make_alert_display(alert_df)
        st.dataframe(alert_display, use_container_width=True, hide_index=True)

        with st.expander("アラート計算の詳細"):
            detail_alert = safe_round_columns(
                alert_df,
                {
                    "基準価格": 2,
                    "現在価格": 2,
                    "上昇額": 2,
                    "上昇率(%)": 4,
                    "上昇ステップ率(%)": 1,
                    "直線っぽさR2": 3,
                    "押し戻し率(%)": 4,
                    "高値離れ(%)": 4,
                },
            )
            st.dataframe(detail_alert, use_container_width=True, hide_index=True)


with impact_tab:
    st.subheader("数量別影響 / 値動きインパクト")

    st.markdown(
        """
        <div class="note-box">
        このタブは、価格変化を「自分の金額なら何円くらいの影響か」に置き換える場所です。<br>
        ここでは手数料・スプレッド・スリッページは含めません。
        手数料込みで今から買って売る想定は「取引シミュレーター」で確認します。
        </div>
        """,
        unsafe_allow_html=True,
    )

    st.markdown("#### 金額設定")
    impact_setting_cols = st.columns([1.1, 2.2, 1.4])

    with impact_setting_cols[0]:
        preset_options = list(IMPACT_AMOUNT_PRESETS.keys())
        current_preset = str(impact_amount_preset)
        if current_preset not in preset_options:
            current_preset = "比較"
        selected_impact_preset = st.selectbox(
            "想定額プリセット",
            options=preset_options,
            index=preset_options.index(current_preset),
            key="impact_amount_preset_input",
            help="数量別影響で比較する金額セットです。カスタムを選ぶと右の入力値を使います。",
        )
        update_setting_if_changed(settings, "impact_amount_preset", str(selected_impact_preset))

    with impact_setting_cols[1]:
        selected_custom_text = st.text_input(
            "カスタム想定額リスト（円）",
            value=str(impact_custom_amount_text),
            key="impact_amount_text_input",
            disabled=str(selected_impact_preset) != "カスタム",
            help="カンマ区切りで入力します。例: 1000,10000,100000",
        )
        if str(selected_impact_preset) == "カスタム":
            update_setting_if_changed(settings, "amount_text", str(selected_custom_text))
        else:
            update_setting_if_changed(
                settings,
                "amount_text",
                get_impact_amount_text(str(selected_impact_preset), str(selected_custom_text)),
            )

    with impact_setting_cols[2]:
        selected_focus_amount = st.number_input(
            "カード強調額（円）",
            min_value=100,
            max_value=100000000,
            value=int(focus_amount),
            step=1000,
            key="impact_focus_amount_input",
            help="サマリーカードで強調する金額です。",
        )
        update_setting_if_changed(settings, "focus_amount", int(selected_focus_amount))

    active_amount_text = get_impact_amount_text(str(selected_impact_preset), str(selected_custom_text))
    active_amounts = parse_amounts(active_amount_text)
    st.caption(
        "現在の比較金額: "
        + " / ".join(f"{int(a):,}円" if float(a).is_integer() else f"{a:,.2f}円" for a in active_amounts)
    )

    st.markdown("#### 値動きの金額インパクト")
    st.dataframe(make_impact_display(impact_df), use_container_width=True, hide_index=True)

    st.markdown("#### 取引シミュレーターへの導線")
    route_cols = st.columns([1.5, 1.0, 2.0])
    with route_cols[0]:
        amount_labels = [f"{int(a):,}円" if float(a).is_integer() else f"{a:,.2f}円" for a in active_amounts]
        route_amount_label = st.selectbox(
            "シミュレーターに送る金額",
            options=amount_labels,
            index=0,
            key="impact_route_amount_label_input",
        )
        route_amount_value = active_amounts[amount_labels.index(route_amount_label)] if amount_labels else 10000

    with route_cols[1]:
        st.write("")
        st.write("")
        send_to_trade_sim = st.button(
            "この金額をセット",
            use_container_width=True,
            key="impact_send_to_trade_sim_button",
            help="取引シミュレーターの投入JPY金額へ反映します。",
        )

    with route_cols[2]:
        st.markdown(
            """
            <div class="note-box">
            数量別影響で金額感覚を確認してから、同じ金額で手数料込みの損益を確認できます。<br>
            ボタンを押した後、「取引シミュレーター」タブを開いてください。
            </div>
            """,
            unsafe_allow_html=True,
        )

    if send_to_trade_sim:
        route_amount_int = int(float(route_amount_value))
        settings["trade_sim_amount_jpy"] = route_amount_int
        save_settings(settings)
        st.session_state["trade_sim_amount_jpy_input"] = route_amount_int
        st.success(f"取引シミュレーターの投入JPY金額を {route_amount_int:,}円 にセットしました。")

    with st.expander("数値の詳細表示"):
        st.dataframe(
            safe_round_columns(
                impact_df,
                {
                    "想定額(JPY)": 0,
                    "現在価格": 2,
                    "概算数量": 8,
                    "前回比の影響額(円)": 2,
                    "短期変化の影響額(円)": 2,
                },
            ),
            use_container_width=True,
            hide_index=True,
        )


with trade_tab:
    st.subheader("取引シミュレーター")

    st.markdown(
        """
        <div class="note-box">
        ここは実注文ではなく、取引前に数量・手数料・成行コスト・損益を確認するための計算画面です。
        v0.5-candidate-11 では、数量別影響タブから同じ金額を取引シミュレーターへ渡しやすくしています。
        APIキー、注文、出金、自動売買は使いません。
        </div>
        """,
        unsafe_allow_html=True,
    )

    readonly_account_info, readonly_commissions, readonly_api_error, readonly_checked_at = get_api_session_result()
    live_taker_by_symbol = extract_taker_fee_pct_by_symbol(readonly_commissions)

    sim_cols = st.columns(4)

    with sim_cols[0]:
        trade_sim_amount_jpy = st.number_input(
            "投入するJPY金額",
            min_value=100,
            max_value=100000000,
            value=int(settings.get("trade_sim_amount_jpy", 10000)),
            step=1000,
            key="trade_sim_amount_jpy_input",
            help="この金額で買った場合の概算数量と損益を計算します。",
        )
        update_setting_if_changed(settings, "trade_sim_amount_jpy", int(trade_sim_amount_jpy))

    with sim_cols[1]:
        trade_sim_taker_fee_pct = st.number_input(
            "taker fee（%）",
            min_value=0.0,
            max_value=20.0,
            value=float(settings.get("trade_sim_taker_fee_pct", 0.10)),
            step=0.01,
            format="%.3f",
            key="trade_sim_taker_fee_pct_input",
            help="成行注文を想定した片道の取引手数料率です。実際の条件に合わせて変更してください。",
        )
        update_setting_if_changed(settings, "trade_sim_taker_fee_pct", float(trade_sim_taker_fee_pct))

    with sim_cols[2]:
        trade_sim_spread_pct = st.number_input(
            "spread（%）",
            min_value=0.0,
            max_value=20.0,
            value=float(settings.get("trade_sim_spread_pct", 0.05)),
            step=0.01,
            format="%.3f",
            key="trade_sim_spread_pct_input",
            help="買いでは高く、売りでは安く約定する不利幅として概算します。",
        )
        update_setting_if_changed(settings, "trade_sim_spread_pct", float(trade_sim_spread_pct))

    with sim_cols[3]:
        trade_sim_slippage_pct = st.number_input(
            "slippage（%）",
            min_value=0.0,
            max_value=20.0,
            value=float(settings.get("trade_sim_slippage_pct", 0.02)),
            step=0.01,
            format="%.3f",
            key="trade_sim_slippage_pct_input",
            help="成行時に想定より不利に約定する幅として概算します。",
        )
        update_setting_if_changed(settings, "trade_sim_slippage_pct", float(trade_sim_slippage_pct))

    if live_taker_by_symbol:
        live_fee_cols = st.columns([1.2, 2.2])
        with live_fee_cols[0]:
            trade_sim_use_live_taker_fee = st.checkbox(
                "取得済み実taker feeを使う",
                value=bool(settings.get("trade_sim_use_live_taker_fee", False)),
                key="trade_sim_use_live_taker_fee_input",
                help="API・準備度タブで取得済みのBTCJPY/ETHJPYのtaker feeを使います。複数通貨で違う場合は安全側として大きい方を使います。",
            )
            update_setting_if_changed(settings, "trade_sim_use_live_taker_fee", bool(trade_sim_use_live_taker_fee))
        with live_fee_cols[1]:
            st.dataframe(make_live_taker_fee_display(readonly_commissions), use_container_width=True, hide_index=True)

        effective_trade_taker_fee_pct = max(live_taker_by_symbol.values()) if trade_sim_use_live_taker_fee else float(trade_sim_taker_fee_pct)
        if trade_sim_use_live_taker_fee:
            st.info(
                f"この計算では、取得済みcommissionを優先します。"
                f"詳細commissionが使えない場合は実taker fee {effective_trade_taker_fee_pct:.4f}% にフォールバックします。"
            )
    else:
        trade_sim_use_live_taker_fee = False
        effective_trade_taker_fee_pct = float(trade_sim_taker_fee_pct)
        st.caption("実taker feeは未取得です。API・準備度タブで読み取り専用APIを確認すると、この画面で反映できます。")

    rule_cols = st.columns([1.4, 1.4, 1.0, 2.0])
    with rule_cols[0]:
        trade_sim_use_binance_rules = st.checkbox(
            "Binance注文ルールを確認",
            value=bool(settings.get("trade_sim_use_binance_rules", True)),
            key="trade_sim_use_binance_rules_input",
            help="公開APIのexchangeInfoから、最小注文額・数量刻み・価格刻みを確認します。",
        )
        update_setting_if_changed(settings, "trade_sim_use_binance_rules", bool(trade_sim_use_binance_rules))

    with rule_cols[1]:
        trade_sim_use_order_book = st.checkbox(
            "板情報で成行買いを概算",
            value=bool(settings.get("trade_sim_use_order_book", False)),
            key="trade_sim_use_order_book_input",
            help="公開APIのdepthからasksを読み、投入JPYで上から買った場合の平均価格を概算します。",
        )
        update_setting_if_changed(settings, "trade_sim_use_order_book", bool(trade_sim_use_order_book))

    with rule_cols[2]:
        depth_options = [5, 10, 20, 50, 100]
        saved_depth_limit = int(settings.get("trade_sim_depth_limit", 20))
        if saved_depth_limit not in depth_options:
            saved_depth_limit = 20
        trade_sim_depth_limit = st.selectbox(
            "板の深さ",
            options=depth_options,
            index=depth_options.index(saved_depth_limit),
            key="trade_sim_depth_limit_input",
            disabled=not bool(trade_sim_use_order_book),
        )
        update_setting_if_changed(settings, "trade_sim_depth_limit", int(trade_sim_depth_limit))

    with rule_cols[3]:
        saved_fee_mode = str(settings.get("trade_sim_fee_mode", TRADE_FEE_MODE_BASE_DEDUCT))
        if saved_fee_mode not in TRADE_FEE_MODE_OPTIONS:
            saved_fee_mode = TRADE_FEE_MODE_BASE_DEDUCT
        trade_sim_fee_mode = st.selectbox(
            "手数料の控除方式",
            options=TRADE_FEE_MODE_OPTIONS,
            index=TRADE_FEE_MODE_OPTIONS.index(saved_fee_mode),
            key="trade_sim_fee_mode_input",
            help="実際のcommissionAssetは設定や残高で変わります。ここでは概算方式を選びます。",
        )
        update_setting_if_changed(settings, "trade_sim_fee_mode", str(trade_sim_fee_mode))

    exit_mode_options = [TRADE_EXIT_MODE_RATE, TRADE_EXIT_MODE_PRICE]
    saved_exit_mode = str(settings.get("trade_sim_exit_mode", TRADE_EXIT_MODE_RATE))
    if saved_exit_mode not in exit_mode_options:
        saved_exit_mode = TRADE_EXIT_MODE_RATE

    exit_cols = st.columns([1, 2])
    with exit_cols[0]:
        trade_sim_exit_mode = st.selectbox(
            "売却想定の指定方法",
            options=exit_mode_options,
            index=exit_mode_options.index(saved_exit_mode),
            key="trade_sim_exit_mode_input",
        )
        update_setting_if_changed(settings, "trade_sim_exit_mode", str(trade_sim_exit_mode))

    exit_prices_for_calc = dict(settings.get("trade_sim_exit_prices", {})) if isinstance(settings.get("trade_sim_exit_prices", {}), dict) else {}

    with exit_cols[1]:
        if trade_sim_exit_mode == TRADE_EXIT_MODE_RATE:
            trade_sim_exit_change_pct = st.number_input(
                "想定価格変動率（%）",
                min_value=-99.0,
                max_value=1000.0,
                value=float(settings.get("trade_sim_exit_change_pct", 1.00)),
                step=0.10,
                format="%.3f",
                key="trade_sim_exit_change_pct_input",
                help="例: +1%上がったところで売る、-1%下がったところで売る、という想定です。",
            )
            update_setting_if_changed(settings, "trade_sim_exit_change_pct", float(trade_sim_exit_change_pct))
        else:
            trade_sim_exit_change_pct = float(settings.get("trade_sim_exit_change_pct", 1.00))
            direct_cols = st.columns(len(SYMBOLS))
            for direct_col, symbol in zip(direct_cols, SYMBOLS):
                current_symbol_df = current_df[current_df["symbol"] == symbol].copy()
                fallback_price = 0
                if not current_symbol_df.empty:
                    fallback_price = int(float(current_symbol_df.sort_values("timestamp_dt").iloc[-1]["price_jpy"]))

                saved_price = exit_prices_for_calc.get(symbol, 0) or fallback_price
                with direct_col:
                    direct_price = st.number_input(
                        f"{symbol} 売却想定価格",
                        min_value=1,
                        max_value=1000000000,
                        value=max(1, int(saved_price)),
                        step=100,
                        key=f"{symbol}_trade_sim_exit_price_input",
                    )
                    update_trade_exit_price_setting(settings, symbol, float(direct_price))
                    exit_prices_for_calc[symbol] = float(direct_price)

    # 設定更新後の最新値で計算する。
    exit_prices_for_calc = dict(settings.get("trade_sim_exit_prices", exit_prices_for_calc)) if isinstance(settings.get("trade_sim_exit_prices", {}), dict) else exit_prices_for_calc

    rules_by_symbol = {}
    order_books_by_symbol = {}

    if trade_sim_use_binance_rules:
        for symbol in SYMBOLS:
            try:
                info = fetch_binance_symbol_info_cached(symbol)
                rules_by_symbol[symbol] = parse_binance_symbol_rules(info)
            except Exception as e:
                rules_by_symbol[symbol] = {"raw_error": str(e)}
                st.warning(f"{symbol} のBinance注文ルールを取得できませんでした: {e}")

    if trade_sim_use_order_book:
        for symbol in SYMBOLS:
            try:
                order_books_by_symbol[symbol] = fetch_binance_order_book_cached(symbol, int(trade_sim_depth_limit))
            except Exception as e:
                order_books_by_symbol[symbol] = {}
                st.warning(f"{symbol} の板情報を取得できませんでした: {e}")

    trade_sim_df = compute_trade_simulation_table(
        current_df=current_df,
        investment_jpy=float(trade_sim_amount_jpy),
        exit_mode=str(trade_sim_exit_mode),
        exit_change_pct=float(trade_sim_exit_change_pct),
        exit_prices=exit_prices_for_calc,
        taker_fee_pct=float(effective_trade_taker_fee_pct),
        spread_pct=float(trade_sim_spread_pct),
        slippage_pct=float(trade_sim_slippage_pct),
        fee_mode=str(trade_sim_fee_mode),
        rules_by_symbol=rules_by_symbol,
        order_books_by_symbol=order_books_by_symbol,
        use_order_book_buy=bool(trade_sim_use_order_book),
        commissions=readonly_commissions if bool(trade_sim_use_live_taker_fee) else {},
    )

    if trade_sim_df.empty:
        st.info("取引シミュレーターに使える現在価格がありません。")
    else:
        st.markdown("#### 損益サマリー")
        st.dataframe(make_trade_simulation_display(trade_sim_df), use_container_width=True, hide_index=True)

        st.markdown(
            """
            <div class="note-box">
            <b>Gross P/L:</b> 手数料・spread・slippageを入れない単純な価格差の損益です。<br>
            <b>Net P/L:</b> BUY/SELL手数料、spread/slippage、売却可能数量への丸め、残りダスト評価を含めた概算です。<br>
            実commission取得時は BUY=taker+buyer、SELL=taker+seller を使い、BNB払いではstandard部分の割引も反映します。売却側の板は未来なので、想定価格ベースです。
            </div>
            """,
            unsafe_allow_html=True,
        )

        st.markdown("#### 手数料・成行コスト")
        st.dataframe(make_trade_fee_cost_display(trade_sim_df), use_container_width=True, hide_index=True)

        st.markdown("#### 手数料率の内訳")
        st.dataframe(make_trade_commission_breakdown_display(trade_sim_df), use_container_width=True, hide_index=True)

        st.markdown("#### Binance注文ルール・板情報")
        st.dataframe(make_trade_rule_book_display(trade_sim_df), use_container_width=True, hide_index=True)

        st.markdown("#### 実残高チェック（読み取り専用API）")
        bnb_jpy_price_for_fee = pd.NA
        bnb_price_error = ""
        if str(trade_sim_fee_mode) == TRADE_FEE_MODE_BNB:
            bnb_jpy_price_for_fee, bnb_price_error = fetch_optional_binance_price_cached("BNBJPY")
            if bnb_price_error:
                st.info("BNBJPY価格を公開APIで取得できませんでした。BNB必要数量は未換算になり、BNB残高は要確認として扱います。")
        balance_check_df = make_trade_balance_check_display(
            trade_sim_df,
            readonly_account_info,
            str(trade_sim_fee_mode),
            bnb_jpy_price=bnb_jpy_price_for_fee,
        )
        st.dataframe(balance_check_df, use_container_width=True, hide_index=True)
        if not (isinstance(readonly_account_info, dict) and readonly_account_info.get("balances")):
            st.info("API・準備度タブで『読み取り専用APIを確認する』を押すと、JPY残高と照合できます。")
        elif readonly_checked_at:
            st.caption(f"残高確認元: 読み取り専用API / 最終確認時刻 {readonly_checked_at}")

        with st.expander("数値の詳細をまとめて見る"):
            detail_trade_df = safe_round_columns(
                trade_sim_df,
                {
                    "投入JPY": 0,
                    "現在価格": 2,
                    "想定売却価格": 2,
                    "想定変動率(%)": 4,
                    "実質買い価格": 2,
                    "実質売り価格": 2,
                    "概算数量": 8,
                    "売却可能数量": 8,
                    "残りダスト数量": 10,
                    "残りダスト評価額": 2,
                    "板平均買い価格": 2,
                    "板使用段数": 0,
                    "板充足率": 4,
                    "Gross P/L": 2,
                    "Net P/L": 2,
                    "Net P/L(売却分のみ)": 2,
                    "買い手数料": 2,
                    "売り手数料": 2,
                    "買い手数料数量": 8,
                    "BNB手数料必要額(JPY)": 2,
                    "買い成行コスト": 2,
                    "売り成行コスト": 2,
                    "総コスト概算": 2,
                    "損益分岐価格": 2,
                    "損益分岐まで(%)": 4,
                    "BUY手数料率(%)": 6,
                    "SELL手数料率(%)": 6,
                    "BUY標準手数料率(%)": 6,
                    "BUY税手数料率(%)": 6,
                    "BUY特別手数料率(%)": 6,
                    "SELL標準手数料率(%)": 6,
                    "SELL税手数料率(%)": 6,
                    "SELL特別手数料率(%)": 6,
                    "丸め後数量": 8,
                    "最小注文額": 2,
                    "最小数量": 8,
                    "数量刻み": 8,
                },
            )
            st.dataframe(detail_trade_df, use_container_width=True, hide_index=True)

        if rules_by_symbol:
            with st.expander("Binance注文ルールの取得結果"):
                rule_rows = []
                for symbol in SYMBOLS:
                    rules = rules_by_symbol.get(symbol, {})
                    rule_rows.append({
                        "通貨": symbol,
                        "状態": rules.get("status", ""),
                        "base": rules.get("base_asset", ""),
                        "quote": rules.get("quote_asset", ""),
                        "tickSize": rules.get("tick_size", pd.NA),
                        "minQty": rules.get("min_qty", pd.NA),
                        "stepSize": rules.get("step_size", pd.NA),
                        "marketMinQty": rules.get("market_min_qty", pd.NA),
                        "marketStepSize": rules.get("market_step_size", pd.NA),
                        "minNotional": rules.get("min_notional", pd.NA),
                        "エラー": rules.get("raw_error", ""),
                    })
                st.dataframe(pd.DataFrame(rule_rows), use_container_width=True, hide_index=True)

        st.caption(
            "v0.5-candidate-18: 実注文なしのまま、公開APIのexchangeInfo/depthと、読み取り専用APIの残高・実手数料・BNB残高判定、日次目標の未約定シナリオ比較で未約定0回の行を表から省き、追記として扱うように整理した版です。"
            "取引シミュレーターでは最小注文額・数量刻み・成行買い平均価格を確認できます。"
        )



with daily_goal_tab:
    st.subheader("日次目標シミュレーター")

    st.markdown(
        """
        <div class="note-box">
        ここは売買判断ではなく、<b>一日の目標利益に対して、どれくらいの投入額・回数・値動きが必要か</b>を逆算する準備画面です。<br>
        candidate17では「価格確認→数量感覚→取引シミュレーター→日次目標」という流れに合わせ、失敗を2つに分けつつ、今日の目標・資金から、まず結論カードと回数別プランを上段で見ます。<br>
        <b>未約定キャンセル</b>：指値が刺さらない、または待ちすぎて取り消す状態。損益は0円として扱いますが、機会回数が減ります。<br>
        <b>約定後損切り</b>：買えた後に逆行し、戻らない前提で売って損失確定する状態。こちらはNet P/Lに反映します。<br>
        実注文・注文テスト・自動売買は行いません。
        </div>
        """,
        unsafe_allow_html=True,
    )

    goal_cols = st.columns(4)
    with goal_cols[0]:
        daily_goal_profit_jpy = st.number_input(
            "一日の目標利益（円）",
            min_value=0,
            max_value=10000000,
            value=int(settings.get("daily_goal_profit_jpy", 100)),
            step=100,
            key="daily_goal_profit_jpy_input",
            help="例: 100円。1日で増やしたいNet P/Lの目標です。",
        )
        update_setting_if_changed(settings, "daily_goal_profit_jpy", int(daily_goal_profit_jpy))

    with goal_cols[1]:
        daily_goal_amounts_text = st.text_input(
            "比較する投入額（円）",
            value=str(settings.get("daily_goal_amounts_text", "1000,10000,100000")),
            key="daily_goal_amounts_text_input",
            help="カンマ区切り。例: 1000,10000,100000",
        )
        update_setting_if_changed(settings, "daily_goal_amounts_text", str(daily_goal_amounts_text))

    with goal_cols[2]:
        daily_goal_trade_counts_text = st.text_input(
            "想定機会回数",
            value=str(settings.get("daily_goal_trade_counts_text", "1,3,5,10")),
            key="daily_goal_trade_counts_text_input",
            help="カンマ区切り。例: 1,3,5,10。実際に約定する回数ではなく、指値を置く/狙う機会数です。",
        )
        update_setting_if_changed(settings, "daily_goal_trade_counts_text", str(daily_goal_trade_counts_text))

    with goal_cols[3]:
        daily_goal_stop_loss_change_pct = st.number_input(
            "約定後の損切り逆行率（%）",
            min_value=0.0,
            max_value=50.0,
            value=float(settings.get("daily_goal_stop_loss_change_pct", settings.get("daily_goal_loss_change_pct", 1.00))),
            step=0.10,
            format="%.2f",
            key="daily_goal_stop_loss_change_pct_input",
            help="例: 1.0なら、買えた後に-1%まで逆行した時点で売る想定のNet P/L例を出します。",
        )
        update_setting_if_changed(settings, "daily_goal_stop_loss_change_pct", float(daily_goal_stop_loss_change_pct))
        update_setting_if_changed(settings, "daily_goal_loss_change_pct", float(daily_goal_stop_loss_change_pct))

    st.markdown("#### 指値の未約定キャンセル設定")
    cancel_cols = st.columns(4)
    with cancel_cols[0]:
        daily_goal_unfilled_cancel_rate_pct = st.number_input(
            "未約定キャンセル率（%）",
            min_value=0.0,
            max_value=100.0,
            value=float(settings.get("daily_goal_unfilled_cancel_rate_pct", 0.0)),
            step=5.0,
            format="%.1f",
            key="daily_goal_unfilled_cancel_rate_pct_input",
            help="例: 20なら、10回の機会のうち約2回は未約定キャンセルとして扱い、損益0円・機会減として計算します。",
        )
        update_setting_if_changed(settings, "daily_goal_unfilled_cancel_rate_pct", float(daily_goal_unfilled_cancel_rate_pct))

    with cancel_cols[1]:
        daily_goal_limit_wait_minutes = st.number_input(
            "指値待ち時間（分）",
            min_value=0.0,
            max_value=120.0,
            value=float(settings.get("daily_goal_limit_wait_minutes", 5.0)),
            step=1.0,
            format="%.0f",
            key="daily_goal_limit_wait_minutes_input",
            help="何分待って刺さらなければキャンセル候補にするか、という準備用メモです。",
        )
        update_setting_if_changed(settings, "daily_goal_limit_wait_minutes", float(daily_goal_limit_wait_minutes))

    with cancel_cols[2]:
        daily_goal_limit_cancel_move_pct = st.number_input(
            "未約定キャンセル乖離率（%）",
            min_value=0.0,
            max_value=20.0,
            value=float(settings.get("daily_goal_limit_cancel_move_pct", 0.30)),
            step=0.05,
            format="%.2f",
            key="daily_goal_limit_cancel_move_pct_input",
            help="価格が指値から不利方向にどれくらい離れたら、待つのをやめる候補にするかの準備用メモです。",
        )
        update_setting_if_changed(settings, "daily_goal_limit_cancel_move_pct", float(daily_goal_limit_cancel_move_pct))

    with cancel_cols[3]:
        daily_goal_show_suggestions = st.checkbox(
            "サジェストを表示",
            value=bool(settings.get("daily_goal_show_suggestions", True)),
            key="daily_goal_show_suggestions_input",
            help="必要勝ち回数・未約定キャンセル・損切り回数から、準備用のコメントを表示します。",
        )
        update_setting_if_changed(settings, "daily_goal_show_suggestions", bool(daily_goal_show_suggestions))

    daily_goal_unfilled_scenarios_text = st.text_input(
        "未約定シナリオ比較（%）",
        value=str(settings.get("daily_goal_unfilled_scenarios_text", "10,30,50,70")),
        key="daily_goal_unfilled_scenarios_text_input",
        help="カンマ区切り。例: 10,30,50,70。実際の未約定率を当てるのではなく、未約定が増えると目標がどう重くなるかを見るための比較です。",
    )
    update_setting_if_changed(settings, "daily_goal_unfilled_scenarios_text", str(daily_goal_unfilled_scenarios_text))

    st.markdown("#### 今日の組み立て")
    plan_cols = st.columns(3)
    with plan_cols[0]:
        default_plan_amount = int(settings.get("daily_goal_plan_amount_jpy", settings.get("trade_sim_amount_jpy", 2000)))
        daily_goal_plan_amount_jpy = st.number_input(
            "今日の資金 / 主投入額（円）",
            min_value=100,
            max_value=10000000,
            value=max(100, int(default_plan_amount)),
            step=100,
            key="daily_goal_plan_amount_jpy_input",
            help="例: 2000円。今日使える資金、または1回で使う中心投入額です。まずはこの金額で、1回/5回/10回ならどうなるかを見ます。",
        )
        update_setting_if_changed(settings, "daily_goal_plan_amount_jpy", int(daily_goal_plan_amount_jpy))

    with plan_cols[1]:
        daily_goal_plan_min_count = st.number_input(
            "最小機会回数",
            min_value=1,
            max_value=100,
            value=max(1, int(settings.get("daily_goal_plan_min_count", 5))),
            step=1,
            key="daily_goal_plan_min_count_input",
            help="例: 5回。今日の検討レンジの下限です。",
        )
        update_setting_if_changed(settings, "daily_goal_plan_min_count", int(daily_goal_plan_min_count))

    with plan_cols[2]:
        min_count_for_default = int(daily_goal_plan_min_count)
        saved_max_count = int(settings.get("daily_goal_plan_max_count", 10))
        daily_goal_plan_max_count = st.number_input(
            "最大機会回数",
            min_value=min_count_for_default,
            max_value=100,
            value=max(min_count_for_default, saved_max_count),
            step=1,
            key="daily_goal_plan_max_count_input",
            help="例: 10回。今日の検討レンジの上限です。",
        )
        update_setting_if_changed(settings, "daily_goal_plan_max_count", int(daily_goal_plan_max_count))

    daily_amounts = parse_positive_number_list(
        daily_goal_amounts_text,
        defaults=[1000, 10000, 100000],
        min_value=0,
        max_value=100000000,
    )
    if float(daily_goal_plan_amount_jpy) not in daily_amounts:
        daily_amounts = [float(daily_goal_plan_amount_jpy)] + daily_amounts

    daily_counts = [int(max(1, round(v))) for v in parse_positive_number_list(
        daily_goal_trade_counts_text,
        defaults=[1, 3, 5, 10],
        min_value=0,
        max_value=100,
    )]
    plan_counts = list(range(int(daily_goal_plan_min_count), int(daily_goal_plan_max_count) + 1))
    for count_value in plan_counts:
        if count_value not in daily_counts:
            daily_counts.append(count_value)
    daily_counts = sorted(set(daily_counts))

    st.caption(
        "この計算は、取引シミュレーターと同じ手数料・spread・slippage・BNB払い設定・注文ルール・板情報設定を使います。"
    )

    if "trade_sim_df" not in locals() or trade_sim_df is None or trade_sim_df.empty:
        st.info("取引シミュレーターに使える現在価格がありません。")
    else:
        daily_goal_df = compute_daily_goal_simulation_table(
            current_df=current_df,
            daily_goal_profit_jpy=float(daily_goal_profit_jpy),
            investment_amounts=daily_amounts,
            trade_counts=daily_counts,
            stop_loss_change_pct=float(daily_goal_stop_loss_change_pct),
            unfilled_cancel_rate_pct=float(daily_goal_unfilled_cancel_rate_pct),
            limit_wait_minutes=float(daily_goal_limit_wait_minutes),
            limit_cancel_move_pct=float(daily_goal_limit_cancel_move_pct),
            taker_fee_pct=float(effective_trade_taker_fee_pct),
            spread_pct=float(trade_sim_spread_pct),
            slippage_pct=float(trade_sim_slippage_pct),
            fee_mode=str(trade_sim_fee_mode),
            rules_by_symbol=rules_by_symbol if "rules_by_symbol" in locals() else {},
            order_books_by_symbol=order_books_by_symbol if "order_books_by_symbol" in locals() else {},
            use_order_book_buy=bool(trade_sim_use_order_book) if "trade_sim_use_order_book" in locals() else False,
            commissions=readonly_commissions if bool(trade_sim_use_live_taker_fee) else {},
        )

        plan_goal_df = compute_daily_goal_simulation_table(
            current_df=current_df,
            daily_goal_profit_jpy=float(daily_goal_profit_jpy),
            investment_amounts=[float(daily_goal_plan_amount_jpy)],
            trade_counts=plan_counts,
            stop_loss_change_pct=float(daily_goal_stop_loss_change_pct),
            unfilled_cancel_rate_pct=float(daily_goal_unfilled_cancel_rate_pct),
            limit_wait_minutes=float(daily_goal_limit_wait_minutes),
            limit_cancel_move_pct=float(daily_goal_limit_cancel_move_pct),
            taker_fee_pct=float(effective_trade_taker_fee_pct),
            spread_pct=float(trade_sim_spread_pct),
            slippage_pct=float(trade_sim_slippage_pct),
            fee_mode=str(trade_sim_fee_mode),
            rules_by_symbol=rules_by_symbol if "rules_by_symbol" in locals() else {},
            order_books_by_symbol=order_books_by_symbol if "order_books_by_symbol" in locals() else {},
            use_order_book_buy=bool(trade_sim_use_order_book) if "trade_sim_use_order_book" in locals() else False,
            commissions=readonly_commissions if bool(trade_sim_use_live_taker_fee) else {},
        )

        focus_counts = sorted(set([
            1,
            int(daily_goal_plan_min_count),
            int(daily_goal_plan_max_count),
        ]))
        focus_goal_df = compute_daily_goal_simulation_table(
            current_df=current_df,
            daily_goal_profit_jpy=float(daily_goal_profit_jpy),
            investment_amounts=[float(daily_goal_plan_amount_jpy)],
            trade_counts=focus_counts,
            stop_loss_change_pct=float(daily_goal_stop_loss_change_pct),
            unfilled_cancel_rate_pct=float(daily_goal_unfilled_cancel_rate_pct),
            limit_wait_minutes=float(daily_goal_limit_wait_minutes),
            limit_cancel_move_pct=float(daily_goal_limit_cancel_move_pct),
            taker_fee_pct=float(effective_trade_taker_fee_pct),
            spread_pct=float(trade_sim_spread_pct),
            slippage_pct=float(trade_sim_slippage_pct),
            fee_mode=str(trade_sim_fee_mode),
            rules_by_symbol=rules_by_symbol if "rules_by_symbol" in locals() else {},
            order_books_by_symbol=order_books_by_symbol if "order_books_by_symbol" in locals() else {},
            use_order_book_buy=bool(trade_sim_use_order_book) if "trade_sim_use_order_book" in locals() else False,
            commissions=readonly_commissions if bool(trade_sim_use_live_taker_fee) else {},
        )

        scenario_rates = parse_percentage_scenarios(
            daily_goal_unfilled_scenarios_text,
            defaults=[10, 30, 50, 70],
        )
        scenario_mid_count = int(round((int(daily_goal_plan_min_count) + int(daily_goal_plan_max_count)) / 2))
        scenario_focus_counts = sorted(set([
            int(daily_goal_plan_min_count),
            int(scenario_mid_count),
            int(daily_goal_plan_max_count),
        ]))
        unfilled_scenario_df = compute_daily_goal_unfilled_scenario_table(
            scenario_rates=scenario_rates,
            current_df=current_df,
            daily_goal_profit_jpy=float(daily_goal_profit_jpy),
            investment_amounts=[float(daily_goal_plan_amount_jpy)],
            trade_counts=scenario_focus_counts,
            stop_loss_change_pct=float(daily_goal_stop_loss_change_pct),
            limit_wait_minutes=float(daily_goal_limit_wait_minutes),
            limit_cancel_move_pct=float(daily_goal_limit_cancel_move_pct),
            taker_fee_pct=float(effective_trade_taker_fee_pct),
            spread_pct=float(trade_sim_spread_pct),
            slippage_pct=float(trade_sim_slippage_pct),
            fee_mode=str(trade_sim_fee_mode),
            rules_by_symbol=rules_by_symbol if "rules_by_symbol" in locals() else {},
            order_books_by_symbol=order_books_by_symbol if "order_books_by_symbol" in locals() else {},
            use_order_book_buy=bool(trade_sim_use_order_book) if "trade_sim_use_order_book" in locals() else False,
            commissions=readonly_commissions if bool(trade_sim_use_live_taker_fee) else {},
        )
        unfilled_scenario_all_df = compute_daily_goal_unfilled_scenario_table(
            scenario_rates=scenario_rates,
            current_df=current_df,
            daily_goal_profit_jpy=float(daily_goal_profit_jpy),
            investment_amounts=[float(daily_goal_plan_amount_jpy)],
            trade_counts=plan_counts,
            stop_loss_change_pct=float(daily_goal_stop_loss_change_pct),
            limit_wait_minutes=float(daily_goal_limit_wait_minutes),
            limit_cancel_move_pct=float(daily_goal_limit_cancel_move_pct),
            taker_fee_pct=float(effective_trade_taker_fee_pct),
            spread_pct=float(trade_sim_spread_pct),
            slippage_pct=float(trade_sim_slippage_pct),
            fee_mode=str(trade_sim_fee_mode),
            rules_by_symbol=rules_by_symbol if "rules_by_symbol" in locals() else {},
            order_books_by_symbol=order_books_by_symbol if "order_books_by_symbol" in locals() else {},
            use_order_book_buy=bool(trade_sim_use_order_book) if "trade_sim_use_order_book" in locals() else False,
            commissions=readonly_commissions if bool(trade_sim_use_live_taker_fee) else {},
        )

        st.markdown("#### まず結論：今日の目標と資金から見る")
        decision_note = build_daily_goal_decision_note(
            focus_goal_df,
            daily_goal_profit_jpy=float(daily_goal_profit_jpy),
            capital_amount_jpy=float(daily_goal_plan_amount_jpy),
            min_count=int(daily_goal_plan_min_count),
            max_count=int(daily_goal_plan_max_count),
            stop_loss_change_pct=float(daily_goal_stop_loss_change_pct),
            unfilled_cancel_rate_pct=float(daily_goal_unfilled_cancel_rate_pct),
        )
        st.markdown(
            f'<div class="note-box"><b>今日の読み取り：</b><br>{html.escape(str(decision_note))}</div>',
            unsafe_allow_html=True,
        )

        st.markdown("#### 今日の準備サジェスト")
        practical_note = build_daily_goal_practical_guidance(
            focus_goal_df,
            unfilled_scenario_df,
            daily_goal_profit_jpy=float(daily_goal_profit_jpy),
            capital_amount_jpy=float(daily_goal_plan_amount_jpy),
            min_count=int(daily_goal_plan_min_count),
            max_count=int(daily_goal_plan_max_count),
            stop_loss_change_pct=float(daily_goal_stop_loss_change_pct),
        )
        st.markdown(
            f'<div class="note-box"><b>まずここを見る：</b><br>{html.escape(str(practical_note))}</div>',
            unsafe_allow_html=True,
        )
        preparation_df = make_daily_goal_preparation_display(
            focus_goal_df,
            unfilled_scenario_df,
            daily_goal_profit_jpy=float(daily_goal_profit_jpy),
            capital_amount_jpy=float(daily_goal_plan_amount_jpy),
            min_count=int(daily_goal_plan_min_count),
            max_count=int(daily_goal_plan_max_count),
        )
        st.dataframe(preparation_df, use_container_width=True, hide_index=True)

        st.markdown("#### 回数別プラン")
        st.markdown(
            """
            <div class="note-box">
            ここでは、<b>1回で達成する場合</b>、<b>最小回数で分ける場合</b>、<b>最大回数で分ける場合</b>を並べます。<br>
            まず「必要変動率」「必要勝ち」「損切り許容」を見て、目標が資金に対してどれくらい厳しいかを確認します。
            </div>
            """,
            unsafe_allow_html=True,
        )
        decision_display_df = make_daily_goal_decision_display(focus_goal_df)
        st.dataframe(decision_display_df, use_container_width=True, hide_index=True)

        st.markdown("#### 未約定シナリオ比較")
        st.markdown(
            """
            <div class="note-box">
            未約定率は最初から1つに決めなくても大丈夫です。<br>
            ここでは <b>10% / 30% / 50% / 70%</b> のように並べて、指値が刺さらない回数が増えると、残りの約定でどれくらい重くなるかを見ます。<br>
            浅い指値は刺さりやすい一方でコストが増えやすく、深く待つ指値はコストを抑えやすい一方で未約定が増えます。
            </div>
            """,
            unsafe_allow_html=True,
        )
        unfilled_note = build_unfilled_scenario_note(
            unfilled_scenario_df,
            plan_amount=float(daily_goal_plan_amount_jpy),
            daily_goal_profit_jpy=float(daily_goal_profit_jpy),
            min_count=int(daily_goal_plan_min_count),
            max_count=int(daily_goal_plan_max_count),
        )
        st.markdown(
            f'<div class="note-box"><b>未約定の読み方：</b><br>{html.escape(str(unfilled_note))}</div>',
            unsafe_allow_html=True,
        )

        zero_unfilled_appendix = build_zero_unfilled_scenario_appendix(unfilled_scenario_df)
        if zero_unfilled_appendix:
            st.markdown(
                f'<div class="note-box"><b>追記：</b><br>{html.escape(str(zero_unfilled_appendix))}</div>',
                unsafe_allow_html=True,
            )

        unfilled_display_df = make_daily_goal_unfilled_scenario_display(unfilled_scenario_df)
        if unfilled_display_df.empty:
            st.info("未約定想定が1回以上になるシナリオはありません。未約定0回のケースは追記として扱っています。")
        else:
            st.dataframe(
                unfilled_display_df,
                use_container_width=True,
                hide_index=True,
            )

        with st.expander("未約定シナリオ詳細（全回数）"):
            zero_unfilled_all_appendix = build_zero_unfilled_scenario_appendix(unfilled_scenario_all_df)
            if zero_unfilled_all_appendix:
                st.caption(zero_unfilled_all_appendix)

            unfilled_all_display_df = make_daily_goal_unfilled_scenario_display(unfilled_scenario_all_df)
            if unfilled_all_display_df.empty:
                st.info("全回数でも、未約定想定が1回以上になるシナリオはありません。")
            else:
                st.dataframe(
                    unfilled_all_display_df,
                    use_container_width=True,
                    hide_index=True,
                )

        st.markdown("#### 今日の組み立て表")
        st.markdown(
            """
            <div class="note-box">
            ここは、上の結論をもう少し細かく見る場所です。<br>
            指定した最小〜最大回数のあいだで、回数ごとの厳しさを比較します。
            </div>
            """,
            unsafe_allow_html=True,
        )
        plan_display_df = make_daily_goal_plan_display(plan_goal_df)
        st.dataframe(plan_display_df, use_container_width=True, hide_index=True)

        plan_note = build_daily_goal_plan_note(
            plan_goal_df,
            daily_goal_profit_jpy=float(daily_goal_profit_jpy),
            plan_amount=float(daily_goal_plan_amount_jpy),
            min_count=int(daily_goal_plan_min_count),
            max_count=int(daily_goal_plan_max_count),
        )
        st.markdown("#### 補足メモ")
        st.markdown(
            f'<div class="note-box">{html.escape(str(plan_note))}</div>',
            unsafe_allow_html=True,
        )

        finite_goal_df = daily_goal_df.copy()
        finite_goal_df["_必要変動率_num"] = pd.to_numeric(finite_goal_df.get("必要変動率(%)"), errors="coerce")
        finite_goal_df = finite_goal_df.dropna(subset=["_必要変動率_num"])

        if not finite_goal_df.empty:
            best_row = finite_goal_df.sort_values("_必要変動率_num").iloc[0]
            metric_cols = st.columns(5)
            metric_cols[0].metric("最小必要変動率", fmt_pct(best_row.get("必要変動率(%)"), digits=4, signed=True))
            metric_cols[1].metric("その投入額", fmt_yen(best_row.get("投入額")))
            metric_cols[2].metric("機会/約定", f'{int(best_row.get("想定機会回数"))}回 / {int(best_row.get("有効約定回数"))}回')
            metric_cols[3].metric("必要勝率", fmt_pct(best_row.get("目標必要勝率(%)"), digits=1))
            metric_cols[4].metric("リスク感", str(best_row.get("リスク感", "")))

        st.markdown("#### 目標達成に必要な変動率・キャンセル・損切り")
        display_goal_df = make_daily_goal_display(daily_goal_df)
        if not bool(daily_goal_show_suggestions) and "サジェスト" in display_goal_df.columns:
            display_goal_df = display_goal_df.drop(columns=["サジェスト"])
        st.dataframe(display_goal_df, use_container_width=True, hide_index=True)

        if bool(daily_goal_show_suggestions):
            suggestion_df = daily_goal_df.copy()
            suggestion_df["_必要勝率_num"] = pd.to_numeric(suggestion_df.get("目標必要勝率(%)"), errors="coerce")
            suggestion_df["_必要変動率_num"] = pd.to_numeric(suggestion_df.get("必要変動率(%)"), errors="coerce")
            suggestion_df = suggestion_df.dropna(subset=["_必要変動率_num"])
            if not suggestion_df.empty:
                pick = suggestion_df.sort_values(["_必要勝率_num", "_必要変動率_num"], na_position="last").iloc[0]
                st.markdown("#### 準備用サジェスト")
                st.markdown(
                    f'<div class="note-box">{html.escape(str(pick.get("サジェスト", "")))}</div>',
                    unsafe_allow_html=True,
                )

        with st.expander("数値の詳細を見る"):
            detail_daily_goal_df = safe_round_columns(
                daily_goal_df,
                {
                    "投入額": 0,
                    "日次目標利益": 0,
                    "1回必要Net": 2,
                    "必要変動率(%)": 6,
                    "必要売却価格": 2,
                    "全成功時日次Net": 2,
                    "未約定キャンセル率(%)": 2,
                    "指値待ち時間(分)": 1,
                    "未約定キャンセル乖離率(%)": 4,
                    "約定後損切り逆行率(%)": 4,
                    "損切り1回Net": 2,
                    "損切り時日次Net": 2,
                    "目標必要勝率(%)": 2,
                },
            )
            st.dataframe(detail_daily_goal_df, use_container_width=True, hide_index=True)

        st.markdown(
            """
            <div class="note-box">
            <b>見方：</b> 未約定キャンセルは損益0円として扱いますが、目標達成に使える約定回数を減らします。<br>
            約定後損切りは、買えた後に戻らないと判断して売る想定なので、Net P/Lに損失として反映します。<br>
            この表は「目標額の現実味」と「キャンセル/損切りの準備」を見るためのもので、買う・売る・回数を増やすことを勧めるものではありません。
            </div>
            """,
            unsafe_allow_html=True,
        )


with api_tab:
    st.subheader("API・実取引準備度")

    st.markdown(
        """
        <div class="note-box">
        このタブは <b>読み取り専用API</b> の確認用です。
        APIキーとSecretは <code>settings.json</code> に保存せず、PowerShellの環境変数、またはプロジェクトフォルダの <code>.env</code> から読みます。
        <code>BINANCE_API_KEY</code> / <code>BINANCE_API_SECRET</code> を使います。<br>
        実注文・注文テスト・自動売買・出金は行いません。
        </div>
        """,
        unsafe_allow_html=True,
    )

    credentials_info = get_binance_credentials_info()
    api_key = credentials_info.get("api_key", "")
    api_secret = credentials_info.get("api_secret", "")
    gitignore_info = credentials_info.get("gitignore", {}) if isinstance(credentials_info.get("gitignore", {}), dict) else {}

    env_cols = st.columns(5)
    env_cols[0].metric("API Key", "設定あり" if api_key else "未設定")
    env_cols[1].metric("Secret", "設定あり" if api_secret else "未設定")
    env_cols[2].metric("キー取得元", credentials_info.get("api_key_source", "未設定"))
    env_cols[3].metric(".env", "あり" if credentials_info.get("env_file_exists") else "なし")
    env_cols[4].metric("注文API", "未実装")

    if credentials_info.get("env_file_error"):
        st.warning(f".env の読み込みで問題がありました: {credentials_info.get('env_file_error')}")

    gitignore_status = str(gitignore_info.get("status", "要確認"))
    gitignore_message = str(gitignore_info.get("message", ""))
    if credentials_info.get("env_file_exists") and gitignore_status != "保護あり":
        st.warning(gitignore_message)
    elif credentials_info.get("env_file_exists"):
        st.info(gitignore_message)

    with st.expander("APIキーの安全な設定例"):
        st.markdown("PowerShell履歴を避けたい場合は、プロジェクトフォルダの `.env` を使えます。`.env` はGitに入れないでください。")
        st.code(
            'cd C:\\Users\\ringo\\binance_local_watcher\n'
            'notepad .\\.env',
            language="powershell",
        )
        st.code(
            'BINANCE_API_KEY=ここにAPI Key\n'
            'BINANCE_API_SECRET=ここにSecret Key',
            language="text",
        )
        st.markdown("`.gitignore` に次の1行が入っているかも確認してください。")
        st.code('.env', language="text")
        st.caption(f"このアプリが読みに行く .env: {credentials_info.get('env_file_path', '')}")

    with st.expander("一時的にPowerShell環境変数で設定する例"):
        st.code(
            '$env:BINANCE_API_KEY="ここにAPI Key"\n'
            '$env:BINANCE_API_SECRET="ここにSecret Key"\n'
            'C:\\Python39\\python.exe -m streamlit run .\\app.py',
            language="powershell",
        )
        st.caption("Secretは画面やチャットに貼らないでください。PowerShellに入力した後も、スクリーンショット共有には注意してください。")

    recv_window = st.number_input(
        "recvWindow（ミリ秒）",
        min_value=1000,
        max_value=60000,
        value=int(settings.get("binance_api_recv_window", 5000)),
        step=1000,
        key="binance_api_recv_window_input",
        help="Binance署名付きAPIの許容時間差です。通常は5000で十分です。時計ズレのエラーが出る場合だけ増やします。",
    )
    update_setting_if_changed(settings, "binance_api_recv_window", int(recv_window))

    check_api_button = st.button(
        "読み取り専用APIを確認する",
        use_container_width=True,
        disabled=not (api_key and api_secret),
        help="/api/v3/account と /api/v3/account/commission を読み取り専用で呼びます。注文系APIは呼びません。",
    )

    if not api_key or not api_secret:
        st.warning("BINANCE_API_KEY / BINANCE_API_SECRET が環境変数に設定されていません。")

    if check_api_button:
        with st.spinner("Binance読み取り専用APIを確認中です..."):
            account_info = {}
            commissions = {}
            error_messages = []

            try:
                account_info = fetch_binance_account_info(api_key, api_secret, recv_window=int(recv_window))
            except Exception as e:
                error_messages.append(f"口座情報取得エラー: {e}")

            if account_info:
                for symbol in SYMBOLS:
                    try:
                        commissions[symbol] = fetch_binance_account_commission(
                            api_key,
                            api_secret,
                            symbol=symbol,
                            recv_window=int(recv_window),
                        )
                    except Exception as e:
                        commissions[symbol] = {"_error": str(e)}
                        error_messages.append(f"{symbol} 手数料取得エラー: {e}")

            store_api_session_result(
                account_info=account_info,
                commissions=commissions,
                error=" / ".join(error_messages),
            )

            if error_messages:
                st.warning("一部のAPI確認に失敗しました。")
                for message in error_messages:
                    st.write(f"- {message}")
            else:
                st.success("読み取り専用APIの確認が完了しました。")

    account_info, commissions, api_error, checked_at = get_api_session_result()

    if checked_at:
        st.caption(f"最終確認時刻: {checked_at}")
    if api_error:
        st.warning(api_error)

    st.markdown("#### 実取引準備度")
    readiness_df = build_readiness_check_rows(
        current_df=current_df,
        rules_by_symbol=rules_by_symbol if "rules_by_symbol" in locals() else {},
        account_info=account_info,
        commissions=commissions,
        trade_sim_df=trade_sim_df if "trade_sim_df" in locals() else pd.DataFrame(),
        fee_mode=str(trade_sim_fee_mode) if "trade_sim_fee_mode" in locals() else "",
        bnb_jpy_price=bnb_jpy_price_for_fee if "bnb_jpy_price_for_fee" in locals() else pd.NA,
    )
    st.dataframe(readiness_df, use_container_width=True, hide_index=True)

    if isinstance(account_info, dict) and account_info:
        st.markdown("#### 口座状態")
        st.dataframe(make_api_account_summary(account_info), use_container_width=True, hide_index=True)

        if account_info.get("canTrade"):
            st.info("Binance側の口座状態では canTrade が True です。ただし、このアプリには注文送信処理を入れていません。")
        if account_info.get("canWithdraw"):
            st.warning("Binance側の口座状態で canWithdraw が True と表示されています。APIキーの出金権限がOFFか、BinanceのAPI管理画面で必ず確認してください。")

        st.markdown("#### 残高（JPY / BTC / ETH / BNB）")
        balance_df = extract_focus_balances(account_info)
        display_balance_df = balance_df.copy()
        for col in ["利用可能", "ロック中", "合計"]:
            display_balance_df[col] = pd.to_numeric(display_balance_df[col], errors="coerce").map(lambda x: "—" if pd.isna(x) else f"{x:,.10f}".rstrip("0").rstrip("."))
        st.dataframe(display_balance_df, use_container_width=True, hide_index=True)

    else:
        st.info("まだ口座情報は取得していません。環境変数を設定してから『読み取り専用APIを確認する』を押してください。")

    st.markdown("#### 実手数料")
    if commissions:
        st.dataframe(make_commission_display(commissions), use_container_width=True, hide_index=True)
        st.caption("ここに表示されるmaker/takerはBinanceの小数形式を%に換算したものです。")

        with st.expander("取得したtaker feeを取引シミュレーターへ反映する"):
            apply_df = make_commission_apply_display(commissions)
            if not apply_df.empty:
                st.dataframe(apply_df, use_container_width=True, hide_index=True)

            suggested_taker_fee_pct = extract_max_taker_fee_pct_from_commissions(commissions)
            if pd.isna(suggested_taker_fee_pct):
                st.info("反映できるtaker feeが取得できていません。")
            else:
                st.caption(
                    f"反映候補: {float(suggested_taker_fee_pct):.4f}%。"
                    "BTCJPY/ETHJPYで値が違う場合は、安全側として大きい方を使います。"
                )
                if st.button("このtaker feeをシミュレーターに反映", use_container_width=True):
                    update_setting_if_changed(settings, "trade_sim_taker_fee_pct", float(suggested_taker_fee_pct))
                    st.success("取引シミュレーターの taker fee 設定へ反映しました。画面を更新すると入力欄にも反映されます。")
    else:
        st.info("実手数料は未取得です。API確認後に表示されます。")

    with st.expander("安全メモ"):
        st.markdown(
            """
            - API Key / Secret はこの画面に表示しません。
            - この候補版では、注文系API、注文テストAPI、出金APIは呼びません。
            - APIキーはまず読み取り専用にしてください。
            - 取引権限をONにするのは、paper trading・注文前プレビュー・order/test を設計してからです。
            - 出金権限はこのプロジェクトでは不要です。
            """
        )



with chart_tab:
    st.subheader("価格履歴")

    history_display_df, chart_source_info = build_chart_history_dataframe(
        local_history_df=history_after_save_df,
        current_snapshot_df=current_df if not did_save and not monitor_paused else pd.DataFrame(),
        chart_source=str(chart_data_source),
        selected_long_file=selected_long_file,
    )

    if not MATPLOTLIB_AVAILABLE:
        st.error(
            "matplotlib がインストールされていないため、グラフを表示できません。"
            "PowerShellで `C:\\Python39\\python.exe -m pip install --user matplotlib` を実行してください。"
        )

    if history_display_df.empty:
        st.warning("表示できる履歴がありません。CSV生データがある場合は「保存状態」タブを確認してください。")
    else:
        st.caption(
            f"表示: {chart_source_info.get('chart_source', '')} / "
            f"間隔: {chart_interval} / "
            f"表示行数: {chart_source_info.get('combined_rows', 0):,} 行"
        )

        if chart_source_info.get("chart_source") != "ローカル保存のみ" and chart_source_info.get("long_rows", 0) == 0:
            st.warning("DLデータを使う設定ですが、読み込めるDL済みCSVが見つかっていません。保存状態タブの『DL済み長期分析CSV一覧』を確認してください。")

        for symbol in SYMBOLS:
            symbol_df = history_display_df[history_display_df["symbol"] == symbol].copy()
            symbol_df = symbol_df.sort_values("timestamp_dt")

            st.markdown(f"### {symbol}")

            if symbol_df.empty:
                st.info(f"{symbol} の履歴がまだありません。")
                continue

            symbol_axis = get_symbol_axis_settings(settings, symbol)

            if symbol_axis["enabled"]:
                chart_manual_enabled = True
                chart_manual_min = symbol_axis["min"]
                chart_manual_max = symbol_axis["max"]
                st.caption(f"{symbol} は通貨別固定レンジを使用中: {chart_manual_min:,}円 〜 {chart_manual_max:,}円")
            else:
                chart_manual_enabled = bool(manual_price_axis_enabled)
                chart_manual_min = manual_price_axis_min
                chart_manual_max = manual_price_axis_max
                if chart_manual_enabled:
                    st.caption(f"{symbol} は共通固定レンジを使用中: {chart_manual_min:,}円 〜 {chart_manual_max:,}円")

            symbol_min_axis_width = get_symbol_min_axis_width(
                settings,
                symbol,
                3000 if symbol == "ETHJPY" else int(min_price_axis_width),
            )

            fig, domain, error = make_price_chart_matplotlib(
                symbol_df,
                symbol,
                min_axis_width=float(symbol_min_axis_width),
                padding_pct=float(price_axis_padding_pct),
                chart_interval=str(chart_interval),
                manual_enabled=chart_manual_enabled,
                manual_min=chart_manual_min,
                manual_max=chart_manual_max,
            )

            if error:
                st.info(error)
            elif fig is not None:
                st.pyplot(fig, use_container_width=True)

                if domain:
                    y_min, y_max = domain
                    actual_min = pd.to_numeric(symbol_df["price_jpy"], errors="coerce").min()
                    actual_max = pd.to_numeric(symbol_df["price_jpy"], errors="coerce").max()
                    st.caption(
                        f"表示Y軸: {y_min:,.0f}円 〜 {y_max:,.0f}円 / "
                        f"実価格範囲: {actual_min:,.0f}円 〜 {actual_max:,.0f}円 / "
                        f"最低表示幅: {float(symbol_min_axis_width):,.0f}円"
                    )

        with st.expander("グラフ表示データの詳細"):
            st.markdown(
                """
                <div class="note-box">
                DL済みCSVのclose価格をグラフに採用できます。
                「DLデータ＋ローカル補完」では、DL最終時刻より後のローカル保存データだけを追加します。
                価格グラフはmatplotlibで描画し、Y軸を<code>set_ylim()</code>で固定しています。
                </div>
                """,
                unsafe_allow_html=True,
            )
            st.caption(f"グラフ表示データ: {chart_source_info.get('chart_source', '')}")
            st.caption(f"DLデータCSV: {chart_source_info.get('long_file', '') or '未選択/なし'}")
            st.caption(f"DLデータ範囲: {chart_source_info.get('long_range', '') or 'なし'}")
            st.caption(f"ローカル補完範囲: {chart_source_info.get('local補完_range', '') or 'なし'}")
            st.caption(f"DLデータ行数: {chart_source_info.get('long_rows', 0):,} 行 / ローカル行数: {chart_source_info.get('local_rows', 0):,} 行 / 表示行数: {chart_source_info.get('combined_rows', 0):,} 行")
            st.info(chart_source_info.get("message", ""))

        st.subheader("変化率の履歴")
        pct_cols = st.columns(len(SYMBOLS))

        for col, symbol in zip(pct_cols, SYMBOLS):
            symbol_df = history_display_df[history_display_df["symbol"] == symbol].copy()
            symbol_df = symbol_df.sort_values("timestamp_dt")

            with col:
                st.markdown(f"#### {symbol}")
                fig, error = make_pct_chart_matplotlib(symbol_df, symbol, str(chart_interval))

                if error:
                    st.info(error)
                elif fig is not None:
                    st.pyplot(fig, use_container_width=True)

        st.subheader("履歴テーブル")
        st.caption("BTCJPYとETHJPYを同じ日時の行に横並びで表示します。")

        wide_history = history_display_df.pivot_table(
            index="timestamp_dt",
            columns="symbol",
            values="price_jpy",
            aggfunc="last",
        ).sort_index()

        wide_history = wide_history.reset_index()
        wide_history["日時"] = (
            wide_history["timestamp_dt"]
            .dt.tz_convert(JST)
            .dt.strftime("%Y-%m-%d %H:%M:%S")
        )

        display_columns = ["日時"] + [symbol for symbol in SYMBOLS if symbol in wide_history.columns]
        wide_history_display = wide_history[display_columns].copy()

        for symbol in SYMBOLS:
            if symbol in wide_history_display.columns:
                wide_history_display[symbol] = pd.to_numeric(
                    wide_history_display[symbol],
                    errors="coerce",
                ).round(2)

        st.dataframe(
            wide_history_display.tail(100).sort_values("日時", ascending=False),
            use_container_width=True,
            hide_index=True,
        )

        with st.expander("従来形式の縦長履歴も見る"):
            display_history = history_display_df[["timestamp", "symbol", "price_jpy"]].copy()
            display_history["price_jpy"] = pd.to_numeric(
                display_history["price_jpy"],
                errors="coerce",
            ).round(2)
            display_history = display_history.rename(
                columns={"timestamp": "日時", "symbol": "通貨", "price_jpy": "価格(JPY)"}
            )
            st.dataframe(
                display_history.tail(100).sort_values("日時", ascending=False),
                use_container_width=True,
                hide_index=True,
            )


with ollama_tab:
    st.markdown('<div class="ollama-small-area">', unsafe_allow_html=True)
    st.subheader("Ollama補助コメント")

    python_summary = build_python_market_summary(metrics_df, impact_df, alert_df)

    st.caption(
        "Ollamaコメントは画面更新後も残るよう、最後に生成した内容を "
        "`ollama_comment.json` に保存して再表示します。"
        "ただし、方向判定は下のPython判定サマリーを優先します。"
    )
    current_ollama_mode_config = get_ollama_mode_config(settings.get("ollama_response_mode", "高速"))
    st.caption(
        f"現在のOllama応答モード: {current_ollama_mode_config['label']} / "
        f"最大出力目安: {current_ollama_mode_config['num_predict']} tokens"
    )

    st.markdown("#### Python判定サマリー")
    show_ollama_small_box(python_summary)

    saved_ollama = load_ollama_comment()
    saved_comment = str(saved_ollama.get("comment", "") or "")

    job_status = load_ollama_job_status()
    job_state = str(job_status.get("status", "idle"))
    if job_state == "running":
        show_ollama_small_box(
            "Ollamaコメントをバックグラウンド生成中です。価格取得と自動保存は止めずに続けます。"
        )
    elif job_state in ["done", "error", "invalid"] and job_status.get("message"):
        box_kind = "warning" if job_state in ["error", "invalid"] else "info"
        show_ollama_small_box(str(job_status.get("message", "")), kind=box_kind)

    if saved_comment:
        st.markdown("#### 保存済みOllamaコメント")
        meta_parts = []
        if saved_ollama.get("created_at"):
            meta_parts.append(f'生成時刻: {saved_ollama.get("created_at")}')
        if saved_ollama.get("model"):
            meta_parts.append(f'モデル: {saved_ollama.get("model")}')
        if saved_ollama.get("version"):
            meta_parts.append(f'生成時バージョン: {saved_ollama.get("version")}')
        if saved_ollama.get("response_mode"):
            meta_parts.append(f'モード: {saved_ollama.get("response_mode")}')
        if saved_ollama.get("elapsed_sec") is not None:
            meta_parts.append(f'生成時間: {saved_ollama.get("elapsed_sec")}秒')
        if saved_ollama.get("prompt_chars"):
            meta_parts.append(f'プロンプト: {int(saved_ollama.get("prompt_chars", 0)):,}文字')

        if meta_parts:
            st.markdown(f'<div class="ollama-small-meta">{" / ".join(meta_parts)}</div>', unsafe_allow_html=True)

        saved_issues = validate_ollama_comment(saved_comment, metrics_df)
        if saved_issues:
            st.warning("保存済みOllamaコメントが現在のPython判定と矛盾している可能性があります。再生成してください。")
            for issue in saved_issues:
                st.write(f"- {issue}")

        show_ollama_small_box(saved_comment)

        saved_python_summary = str(saved_ollama.get("python_summary", "") or "")
        if saved_python_summary:
            with st.expander("このコメント生成時のPython判定サマリー"):
                st.text(saved_python_summary)
    else:
        show_ollama_small_box("まだ保存済みのOllamaコメントはありません。")

    if use_ollama:
        st.markdown("#### 新しく生成")

        col_generate, col_warmup, col_clear = st.columns(3)

        preview_prompt = build_ollama_prompt(metrics_df, impact_df, alert_df, response_mode=settings.get("ollama_response_mode", "高速"))
        st.caption(f"次回送信予定プロンプト長: {len(preview_prompt):,}文字 / モード: {current_ollama_mode_config['label']}")

        with col_generate:
            generate_ollama = st.button("Ollamaコメントを生成して保存", use_container_width=True)

        with col_warmup:
            warmup_ollama_button = st.button("Ollamaをウォームアップ", use_container_width=True)

        with col_clear:
            clear_comment_button = st.button("保存済みコメントを消す", use_container_width=True)

        if clear_comment_button:
            clear_ollama_comment()
            st.success("保存済みOllamaコメントを削除しました。ページ更新後に反映されます。")

        if warmup_ollama_button:
            with st.spinner("Ollamaをウォームアップ中です..."):
                ok, error = warmup_ollama(ollama_url, ollama_model)

            if ok:
                st.success("Ollamaをウォームアップしました。")
            else:
                st.warning("Ollamaのウォームアップに失敗しました。")
                st.code(error)

        if generate_ollama:
            prompt = build_ollama_prompt(
                metrics_df,
                impact_df,
                alert_df,
                response_mode=settings.get("ollama_response_mode", "高速"),
            )
            ok, error = start_ollama_background_generation(
                ollama_url=ollama_url,
                model=ollama_model,
                prompt=prompt,
                python_summary=python_summary,
                metrics_df=metrics_df,
                response_mode=settings.get("ollama_response_mode", "高速"),
            )

            if ok:
                st.success("Ollamaコメントのバックグラウンド生成を開始しました。裏側保存は止めずに続けます。")
            else:
                st.warning(error)
    else:
        show_ollama_small_box("Ollamaコメント生成はオフです。保存済みコメントの表示だけ行います。")

    st.markdown('</div>', unsafe_allow_html=True)


with detail_tab:
    st.subheader("保存状態")

    detail_cols = st.columns(2)

    with detail_cols[0]:
        st.write(f"起動中の app.py バージョン: `{APP_VERSION}`")
        st.write(f"アプリフォルダ: `{APP_DIR}`")
        st.write(f"データ参照フォルダ: `{PROJECT_DIR}`")
        if PROJECT_DIR != APP_DIR:
            st.warning("app.pyの場所とデータ参照フォルダが違います。履歴が反映されない場合は、app.pyをデータ参照フォルダへコピーして起動してください。")
        st.write(f"履歴ファイル: `{HISTORY_FILE}`")
        st.write(f"長期分析データフォルダ: `{LONG_DATA_DIR}`")
        st.write(f"長期データ重複取得回避: `{'ON' if settings.get('long_data_skip_existing', True) else 'OFF'}`")
        st.write(f"設定ファイル: `{SETTINGS_FILE}`")
        st.write(f"Ollamaコメントファイル: `{OLLAMA_COMMENT_FILE}`")
        st.write(f"Ollama生成状態ファイル: `{OLLAMA_JOB_FILE}`")
        st.write(f"裏側保存状態ファイル: `{COLLECTOR_STATUS_FILE}`")
        st.write(f"今回の保存判定: `{save_reason}`")
        st.write(f"短期監視: `{'停止中' if monitor_paused else '稼働中'}`")
        st.write(f"自動保存: `{'ON' if auto_save and not monitor_paused else 'OFF'}`")
        st.write(f"保存間隔: `{int(save_interval_sec)}秒`")
        st.write(f"急騰検出: `{'ON' if settings.get('alert_enabled', True) else 'OFF'}`")
        st.write(f"直近監視: `{'ON' if settings.get('rolling_alert_enabled', True) else 'OFF'}`")
        st.write(f"直近監視幅: `{settings.get('rolling_alert_window_minutes', 10)}分`")
        st.write(f"継続上昇検出: `{'ON' if settings.get('sustained_rise_enabled', True) else 'OFF'}`")
        st.write(f"継続上昇の時間幅: `{settings.get('sustained_rise_windows_text', '15,20,30')}分`")
        st.write(f"継続上昇の押し戻し許容: `{settings.get('sustained_rise_max_pullback_pct', 0.05)}%`")
        st.write(f"継続上昇の高値離れ許容: `{settings.get('sustained_rise_close_near_high_pct', 0.03)}%`")
        st.write(f"急騰検出: `{'ON' if settings.get('event_alert_enabled', True) else 'OFF'}`")
        st.write(f"急騰探索範囲: `{settings.get('event_lookback_hours', 6)}時間`")
        st.write(f"急騰判定窓: `{settings.get('event_window_minutes', 15)}分`")
        st.write(f"急騰最高値検出: `{'ON' if settings.get('event_use_peak_price', True) else 'OFF'}`")
        st.write(f"急騰候補表示: `{'ON' if settings.get('event_candidate_mode', True) else 'OFF'}`")
        st.write(f"固定時刻確認: `{'ON' if settings.get('fixed_time_alert_enabled', False) else 'OFF'}`")
        st.write(f"固定基準時刻: `{settings.get('alert_start_time', '23:30')}`")
        st.write(f"matplotlib: `{'使用可能' if MATPLOTLIB_AVAILABLE else '未インストール'}`")
        st.write("時刻表示: `JST（日本時間）固定`")
        st.write(f"Ollamaコメント保存: `{'あり' if OLLAMA_COMMENT_FILE.exists() else 'なし'}`")

    with detail_cols[1]:
        st.write(f"正規化後の履歴行数: `{len(history_after_save_df)}`")
        st.write(f"CSV生データ行数: `{len(raw_history_after_df)}`")
        st.write(f"裏側保存状態: `{collector_status.get('status', '')}`")
        st.write(f"裏側保存メッセージ: `{collector_status.get('message', '')}`")
        st.write(f"裏側保存更新時刻: `{collector_status.get('updated_at', '') or 'なし'}`")
        st.write(f"裏側保存の最新保存時刻: `{collector_status.get('last_saved_at', '') or 'なし'}`")
        if collector_status.get("last_error"):
            st.write(f"裏側保存エラー: `{collector_status.get('last_error')}`")

        if last_saved_at is None:
            st.write("前回保存時刻: `なし`")
        else:
            st.write(f"前回保存時刻: `{format_jst_timestamp(last_saved_at)}`")

        if not history_after_save_df.empty:
            latest_saved = history_after_save_df["timestamp_dt"].max()
            st.write(f"最新保存時刻: `{format_jst_timestamp(latest_saved)}`")

        if HISTORY_FILE.exists():
            st.write(f"履歴ファイルサイズ: `{HISTORY_FILE.stat().st_size} bytes`")


    if long_data_download_result is not None:
        with st.expander("今回取得した長期分析データ"):
            df = long_data_download_result.get("df", pd.DataFrame())
            file = long_data_download_result.get("file")

            if file is not None:
                st.write(f"保存先: `{file}`")

            status = long_data_download_result.get("status", {})
            if isinstance(status, dict):
                st.write(f"重複取得回避: `{'ON' if status.get('skip_existing') else 'OFF'}`")
                st.write(f"再取得を省略した通貨: `{', '.join(status.get('skipped_symbols', [])) if status.get('skipped_symbols') else 'なし'}`")
                st.write(f"今回DLした通貨: `{', '.join(status.get('downloaded_symbols', [])) if status.get('downloaded_symbols') else 'なし'}`")

            if df is not None and not df.empty:
                preview = df.copy()
                preview["timestamp_dt"] = preview["timestamp_dt"].apply(format_jst_timestamp)
                st.dataframe(preview.tail(20), use_container_width=True, hide_index=True)
            else:
                st.info("表示できる長期分析データはありません。")


    with st.expander("DL済み長期分析CSV一覧"):
        files = list_long_data_files()

        if not files:
            st.info("long_dataフォルダにCSVはまだありません。")
        else:
            rows = []
            for file_path in files:
                df = read_long_data_csv(file_path)
                if df.empty:
                    rows.append({
                        "ファイル名": file_path.name,
                        "行数": 0,
                        "通貨": "読み込み不可/空",
                        "期間(JST)": "—",
                        "サイズ": f"{file_path.stat().st_size:,} bytes",
                    })
                else:
                    rows.append({
                        "ファイル名": file_path.name,
                        "行数": len(df),
                        "通貨": ", ".join(sorted(df["symbol"].dropna().unique())),
                        "期間(JST)": format_time_range_jst(df["timestamp_dt"].min(), df["timestamp_dt"].max()),
                        "サイズ": f"{file_path.stat().st_size:,} bytes",
                    })

            st.dataframe(pd.DataFrame(rows), use_container_width=True, hide_index=True)

    with st.expander("CSV生データの末尾"):
        if raw_history_after_df.empty:
            st.info("CSV生データは空です。")
        else:
            st.dataframe(raw_history_after_df.tail(20), use_container_width=True, hide_index=True)

    with st.expander("正規化後の短期履歴末尾（JST）"):
        if history_after_save_df.empty:
            st.info("正規化後の履歴は空です。")
        else:
            display_tail = history_after_save_df.tail(20).copy()
            display_tail["timestamp_dt"] = display_tail["timestamp_dt"].apply(format_jst_timestamp)
            st.dataframe(display_tail, use_container_width=True, hide_index=True)

    with st.expander("計算用メトリクスの詳細"):
        st.dataframe(
            safe_round_columns(
                metrics_df,
                {
                    "現在価格": 2,
                    "前回価格": 2,
                    "前回比(円)": 2,
                    "前回比(%)": 4,
                    "短期基準価格": 2,
                    "短期変化(円)": 2,
                    "短期変化(%)": 4,
                },
            ),
            use_container_width=True,
            hide_index=True,
        )


# =========================
# フッター
# =========================

st.divider()

if monitor_paused:
    st.caption("短期監視: 停止中。裏側保存も停止しています。")
elif auto_save:
    st.caption(
        f"自動保存: ON / 保存間隔: {int(save_interval_sec)}秒。"
        "価格取得とCSV保存は裏側保存係が担当します。画面は自動リロードしません。"
        "表示を更新したいときはサイドバーの「表示を更新」を押してください。"
    )
else:
    st.caption("自動保存: OFF。必要なときに「今の価格を取得して履歴に保存」を押してください。")

st.caption(
    f"{APP_VERSION}: 実注文なし / 読み取り専用APIのみ任意 / 実残高・BNB残高チェック対応 / 売買判断なし。"
    "価格変化・数量別影響額・手数料込みの取引前シミュレーションをPython側で整理し、数量別影響から取引シミュレーターへつなげる版です。"
)
