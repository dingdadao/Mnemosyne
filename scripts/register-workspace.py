#!/usr/bin/env python3
"""把本仓库注册成 DSH 工作区（幂等，可重复执行，也可撤销）。

DSH 的工作区清单在 ~/.dsh/storages/workspace.json（unit 存储 v2）：
  global.workspaceIds  —— 顺序列表
  tables.workspaces    —— {uuid: {path, title, sessionIds, createdAt, updatedAt}}

DSH 运行时会在会话创建/更新时写回这个文件，所以改完要重启 GUI 才 100% 稳妥；
本脚本按 realpath 去重，重复执行不会产生重复工作区。

用法:
  python3 scripts/register-workspace.py              # 注册（或确认已注册）
  python3 scripts/register-workspace.py --dry-run    # 只看结果
  python3 scripts/register-workspace.py --remove     # 从列表移除（不删目录）
  python3 scripts/register-workspace.py --list       # 列出所有工作区
"""

import argparse
import json
import os
import shutil
import sys
import time
import uuid

CONFIG = os.path.expanduser("~/.dsh/storages/workspace.json")
REPO = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
TITLE = os.path.basename(REPO)


def load():
    with open(CONFIG, encoding="utf-8") as f:
        return json.load(f)


def save(data):
    tmp = CONFIG + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.chmod(tmp, 0o600)
    os.replace(tmp, CONFIG)


def find(data):
    for wid, w in data["tables"]["workspaces"].items():
        p = w.get("path")
        if p and os.path.realpath(p) == REPO:
            return wid, w
    return None, None


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--remove", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--title", default=TITLE)
    args = ap.parse_args()

    if not os.path.exists(CONFIG):
        print(f"✗ 找不到 {CONFIG}（DSH 至少启动过一次才会生成）", file=sys.stderr)
        return 1

    data = load()
    ws = data["tables"]["workspaces"]

    if args.list:
        print(f"{'ID':38}  {'TITLE':28}  PATH")
        for wid in data["global"].get("workspaceIds", []):
            w = ws.get(wid, {})
            mark = " ←本仓库" if os.path.realpath(w.get("path", "")) == REPO else ""
            print(f"{wid:38}  {w.get('title',''):28}  {w.get('path','')}{mark}")
        return 0

    wid, entry = find(data)

    if args.remove:
        if not wid:
            print(f"· 未注册：{REPO}")
            return 0
        if args.dry_run:
            print(f"[dry-run] 将移除 {wid}  {entry.get('title')}")
            return 0
        shutil.copy2(CONFIG, CONFIG + ".bak-" + time.strftime("%Y%m%d-%H%M%S"))
        ws.pop(wid, None)
        if wid in data["global"].get("workspaceIds", []):
            data["global"]["workspaceIds"].remove(wid)
        save(data)
        print(f"✓ 已移除 {wid}（目录保留）")
        return 0

    if wid:
        print(f"· 已注册：{wid}  {entry.get('title')}")
        print(f"  {entry.get('path')}")
        if entry.get("title") != args.title and not args.dry_run:
            entry["title"] = args.title
            entry["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
            save(data)
            print(f"✓ 已修正标题为 {args.title}")
        return 0

    now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    wid = str(uuid.uuid4())
    if args.dry_run:
        print(f"[dry-run] 将新建 {wid}  {args.title}")
        print(f"          path={REPO}")
        return 0

    shutil.copy2(CONFIG, CONFIG + ".bak-" + time.strftime("%Y%m%d-%H%M%S"))
    ws[wid] = {"path": REPO, "title": args.title, "sessionIds": [], "createdAt": now, "updatedAt": now}
    data["global"].setdefault("workspaceIds", []).append(wid)
    save(data)
    print(f"✓ 已注册工作区 {wid}  {args.title}")
    print(f"  {REPO}")
    print(f"  共 {len(ws)} 个工作区；重启 DSH 后出现在工作区列表")
    return 0


if __name__ == "__main__":
    sys.exit(main())
