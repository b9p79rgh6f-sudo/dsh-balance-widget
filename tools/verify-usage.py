"""独立对账：直接从磁盘会话日志算今日 token 用量，和插件给的数字比。

不复用插件任何代码，口径按官方文档重写：assistant/message 事件自带的
usage 就是该次请求的计费用量，按事件时间归到北京时间的某一天。
"""
import glob
import io
import json
import os
import sys
from collections import Counter

import zstandard

DAY = sys.argv[1] if len(sys.argv) > 1 else None
# deepseek-flash 官方价目，单位：元每百万 tokens
PEAK = {"hit": 0.04, "miss": 2.0, "out": 8.0}
IDLE = {"hit": 0.02, "miss": 1.0, "out": 4.0}


def day_key(ms):
    from datetime import datetime, timezone, timedelta
    tz = timezone(timedelta(hours=8))
    return datetime.fromtimestamp(ms / 1000, tz).strftime("%Y-%m-%d")


totals = Counter()
per_model = Counter()
files = glob.glob(os.path.join(os.path.expanduser("~"), ".dsh", "sessions", "**", "session*.jsonl.zstd"),
                  recursive=True)
used_files = 0
errors = 0
for path in files:
    try:
        with open(path, "rb") as fh:
            reader = zstandard.ZstdDecompressor().stream_reader(fh)
            text = io.TextIOWrapper(reader, encoding="utf-8")
            for line in text:
                if '"assistant/message"' not in line:
                    continue
                event = json.loads(line)
                if event.get("type") != "assistant/message":
                    continue
                usage = event.get("data", {}).get("usage")
                if not isinstance(usage, dict):
                    continue
                if DAY is not None and day_key(event["time"]) != DAY:
                    continue
                used_files += 1
                totals["input"] += int(usage.get("inputTokens") or 0)
                totals["output"] += int(usage.get("outputTokens") or 0)
                totals["cacheRead"] += int(usage.get("cacheReadTokens") or 0)
                totals["cacheWrite"] += int(usage.get("cacheWriteTokens") or 0)
                totals["requests"] += 1
                from datetime import datetime, timezone, timedelta
                moment = datetime.fromtimestamp(event["time"] / 1000, timezone(timedelta(hours=8)))
                peak = moment.weekday() < 5 and ((9 <= moment.hour < 12) or (14 <= moment.hour < 18))
                rates = PEAK if peak else IDLE
                totals["cost_milli"] += round(
                    (int(usage.get("inputTokens") or 0) / 1e6) * rates["miss"] * 1000
                    + (int(usage.get("outputTokens") or 0) / 1e6) * rates["out"] * 1000
                    + (int(usage.get("cacheReadTokens") or 0) / 1e6) * rates["hit"] * 1000
                    + (int(usage.get("cacheWriteTokens") or 0) / 1e6) * rates["miss"] * 1000
                )
                model = (event.get("data", {}).get("message", {}).get("source", {}) or {}).get("model", "?")
                per_model[model] += 1
    except Exception:
        errors += 1

total = totals["input"] + totals["output"] + totals["cacheRead"] + totals["cacheWrite"]
print(json.dumps({
    "day": DAY or "all",
    "files": len(files),
    "errors": errors,
    "requests": totals["requests"],
    "uncachedInputTokens": totals["input"],
    "outputTokens": totals["output"],
    "cacheReadTokens": totals["cacheRead"],
    "cacheWriteTokens": totals["cacheWrite"],
    "totalTokens": total,
    "costCNY": round(totals["cost_milli"] / 1000, 6),
    "models": dict(per_model.most_common(6)),
}, ensure_ascii=False, indent=2))
