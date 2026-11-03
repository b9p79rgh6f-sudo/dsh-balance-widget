"""离线测试用的会话元数据生成器。

从挂件缓存里找出指定日期有用量的会话，再顺着 parentSession 找到根会话，
然后从磁盘会话日志里读出标题、创建时间、工作目录这些字段，写成一份
JSON 供 Node 侧的合并测试使用。

用法：
    python tools/build-conversation-fixture.py 2026-11-03 输出.json
"""

import glob
import json
import os
import sys

import zstandard

DSH_HOME = os.environ.get("DSH_HOME") or os.path.join(os.path.expanduser("~"), ".dsh")
SESSIONS_DIR = os.path.join(DSH_HOME, "sessions")


def session_paths():
    paths = {}
    pattern = os.path.join(SESSIONS_DIR, "*", "*", "session.v4.jsonl.zstd")
    for path in glob.glob(pattern):
        session_id = os.path.basename(os.path.dirname(path))
        paths[session_id] = path
    return paths


def header_of(path):
    """只解第一段 zstd 帧，拿会话头，避免为几百兆的大日志反复全解。"""
    try:
        with open(path, "rb") as handle:
            raw = handle.read(65536)
        obj = zstandard.ZstdDecompressor().decompressobj()
        text = obj.decompress(raw).decode("utf-8", "replace")
        first_line = text.split("\n", 1)[0]
        return json.loads(first_line)
    except Exception:
        return None


def meta_of(path):
    """完整解压日志，取会话头和最后一个标题事件。"""
    try:
        with open(path, "rb") as handle, zstandard.ZstdDecompressor().stream_reader(handle) as reader:
            text = reader.read().decode("utf-8", "replace")
    except Exception:
        return None
    meta = {}
    for line in text.split("\n"):
        if not line:
            continue
        try:
            event = json.loads(line)
        except Exception:
            continue
        if event.get("type") == "session":
            meta["createdAt"] = event.get("createdAt")
            meta["cwd"] = event.get("cwd")
            meta["parentSession"] = event.get("parentSession")
            meta["origin"] = event.get("origin")
        elif event.get("type") == "session/title":
            title = (event.get("data") or {}).get("title")
            if isinstance(title, str) and title.strip():
                meta["title"] = title.strip()
    return meta


def main():
    if len(sys.argv) < 3:
        print("用法: python tools/build-conversation-fixture.py <YYYY-MM-DD> <输出.json>")
        return 2
    day = sys.argv[1]
    output = sys.argv[2]

    with open(os.path.join(DSH_HOME, "storages", "balance-widget-cache.json"), encoding="utf-8") as handle:
        cache = json.load(handle)
    cache_sessions = cache.get("sessions") or {}

    paths = session_paths()
    targets = set()
    for session_id, entry in cache_sessions.items():
        if day in (entry.get("days") or {}):
            targets.add(session_id)

    # 顺着父会话往上找，保证根会话也被算进来（子代理可能跨天继续跑）。
    queue = list(targets)
    while queue:
        session_id = queue.pop()
        path = paths.get(session_id)
        if path is None:
            continue
        header = header_of(path) or {}
        parent = header.get("parentSession")
        if isinstance(parent, str) and parent and parent not in targets:
            targets.add(parent)
            queue.append(parent)

    meta = {}
    missing = []
    for session_id in sorted(targets):
        path = paths.get(session_id)
        if path is None:
            missing.append(session_id)
            continue
        info = meta_of(path)
        if info is not None:
            meta[session_id] = info

    with open(output, "w", encoding="utf-8") as handle:
        json.dump({"day": day, "meta": meta}, handle, ensure_ascii=False, indent=2)

    print(f"日期 {day}：当天会话 {len(targets)} 个，读到元数据 {len(meta)} 个")
    if missing:
        print(f"日志缺失 {len(missing)} 个：{', '.join(missing)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
