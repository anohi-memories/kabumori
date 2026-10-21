"""日次4:00 JSTの失効と、時計の検査。仕様 v5 §5-2・§5-3、v5.1 §6-2。

JST は UTC+9 の固定オフセットで計算する（夏時間なし・Macのタイムゾーン設定に依存しない）。
"""
import datetime

JST = datetime.timezone(datetime.timedelta(hours=9))
ROLLOVER_HOUR = 4
CLOCK_TOLERANCE_SECONDS = 300


def next_rollover(approved_at):
    """承認時刻の次に到来する 04:00:00 JST（epoch秒）。04:00:00ちょうどなら翌日。"""
    dt = datetime.datetime.fromtimestamp(approved_at, JST)
    candidate = dt.replace(hour=ROLLOVER_HOUR, minute=0, second=0, microsecond=0)
    if candidate <= dt:
        candidate += datetime.timedelta(days=1)
    return candidate.timestamp()


def is_expired(expires_at, now):
    return now >= expires_at


def jst_day(epoch):
    return datetime.datetime.fromtimestamp(epoch, JST).strftime("%Y-%m-%d")


def jst_text(epoch):
    return datetime.datetime.fromtimestamp(epoch, JST).strftime("%Y-%m-%d %H:%M:%S JST")


def clock_problem(local_now, reference_now, last_record_ts=None):
    """起動を止めるべき時計の問題があれば理由を返す（なければ None）。

    - 参照時計（GitHub応答の Date など）が無い・読めない → 起動しない。
    - ローカルと参照の差が5分を超える → 起動しない。
    - 台帳の最後の記録より5分以上前（逆行） → CLOCK_ANOMALY（安全違反）。
    """
    if reference_now is None:
        return "reference_clock_unavailable"
    if abs(local_now - reference_now) > CLOCK_TOLERANCE_SECONDS:
        return "clock_skew"
    if last_record_ts is not None and local_now < last_record_ts - CLOCK_TOLERANCE_SECONDS:
        return "CLOCK_ANOMALY"
    return None


def envelope_usable(expires_at, local_now, reference_now):
    """ローカル時刻と参照時計の両方が失効前のときだけ True（安全側）。"""
    if reference_now is None:
        return False
    return local_now < expires_at and reference_now < expires_at
