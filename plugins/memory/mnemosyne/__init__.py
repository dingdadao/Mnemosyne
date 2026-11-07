"""
Mnemosyne Memory Provider v3 — Multi-Tenant Support
Adds owner + visibility to all operations.
"""

import json
import logging
import os
import re
import threading
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider, spawn_context_thread

logger = logging.getLogger(__name__)


class MnemosyneProvider(MemoryProvider):
    """Mnemosyne cross-device memory provider v3 with multi-tenant support."""

    def __init__(self):
        self._url = ""
        self._token = ""
        self._workspace = "default"
        self._owner = "default"
        self._include = ["own", "shared"]
        self._session_id = ""
        self._hermes_home = ""
        self._pending_saves = []
        self._sync_thread = None
        self._last_prefetch = ""
        self._prefetch_cache = {}
        self._sync_lock = threading.Lock()
        self._save_count = 0

    @property
    def name(self) -> str:
        return "mnemosyne"

    def is_available(self) -> bool:
        token = os.environ.get("MNEMOSYNE_TOKEN", "")
        if token:
            return True
        try:
            from hermes_constants import get_hermes_home
            env_file = get_hermes_home() / ".env"
            if env_file.exists():
                for line in env_file.read_text().splitlines():
                    if line.strip().startswith("MNEMOSYNE_TOKEN="):
                        return bool(line.split("=", 1)[1].strip())
        except Exception:
            pass
        return False

    def unavailable_reason(self) -> str:
        return "MNEMOSYNE_TOKEN not set."

    def initialize(self, session_id: str, **kwargs) -> None:
        self._session_id = session_id
        self._hermes_home = kwargs.get("hermes_home", str(Path.home() / ".hermes"))
        
        # v3: owner from kwargs (user_id) or env
        self._owner = kwargs.get("user_id") or os.environ.get("MNEMOSYNE_OWNER", "default")
        self._include = os.environ.get("MNEMOSYNE_INCLUDE", "own,shared").split(",")
        
        self._url = os.environ.get("MNEMOSYNE_URL", "")
        self._token = os.environ.get("MNEMOSYNE_TOKEN", "")
        self._workspace = os.environ.get("MNEMOSYNE_WS", "default")
        self._load_env()

        config_path = Path(self._hermes_home) / "mnemosyne.json"
        if config_path.exists():
            try:
                config = json.loads(config_path.read_text())
                self._url = config.get("url", self._url)
                self._workspace = config.get("workspace", self._workspace)
                self._owner = config.get("owner", self._owner)
                if config.get("token"):
                    self._token = config["token"]
            except Exception:
                pass

        logger.info("Mnemosyne v3: url=%s, ws=%s, owner=%s, include=%s",
                     self._url, self._workspace, self._owner, self._include)

    def _load_env(self):
        if self._token and self._owner != "default":
            return
        try:
            from hermes_constants import get_hermes_home
            env_file = get_hermes_home() / ".env"
            if env_file.exists():
                for line in env_file.read_text().splitlines():
                    line = line.strip()
                    if line.startswith("MNEMOSYNE_URL="):
                        self._url = line.split("=", 1)[1].strip().strip("\"'")
                    elif line.startswith("MNEMOSYNE_TOKEN="):
                        self._token = line.split("=", 1)[1].strip().strip("\"'")
                    elif line.startswith("MNEMOSYNE_WS="):
                        self._workspace = line.split("=", 1)[1].strip().strip("\"'")
                    elif line.startswith("MNEMOSYNE_OWNER="):
                        self._owner = line.split("=", 1)[1].strip().strip("\"'")
        except Exception:
            pass

    def _api(self, method: str, path: str, body: dict = None) -> dict:
        if not self._token:
            return {"success": False, "error": "No token"}
        url = f"{self._url}{path}"
        data = json.dumps(body).encode("utf-8") if body else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self._token}")
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return {"success": True, "data": json.loads(resp.read().decode("utf-8"))}
        except urllib.error.HTTPError as e:
            return {"success": False, "error": f"HTTP {e.code}: {e.read().decode()[:200]}"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    # === RECALL ===

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        from agent.memory_provider import is_trivial_prompt
        if is_trivial_prompt(query):
            return ""
        if len(query.strip()) < 4:
            return ""

        cache_key = f"{session_id}:{self._owner}:{query[:60]}"
        if cache_key in self._prefetch_cache:
            cached = self._prefetch_cache[cache_key]
            self._last_prefetch = cached
            return cached

        try:
            r = self._api("POST", "/memory/search", {
                "query": query, "limit": 8,
                "owner": self._owner, "include": self._include,
                "workspace": self._workspace,
            })
            if not r["success"]:
                return ""
            
            results = r["data"].get("results", [])
            if not results:
                return ""

            filtered = []
            query_words = set(query.lower().split())
            
            for m in results:
                imp = m.get("importance", 0.5)
                if imp < 0.4:
                    continue
                content = m.get("content", "").lower()
                has_match = any(w in content for w in query_words if len(w) > 1)
                if not has_match:
                    continue
                filtered.append(m)
            
            filtered = filtered[:3]
            if not filtered:
                return ""

            # v3: show owner in recall
            lines = [f"[Mnemosyne — {len(filtered)} relevant memories]"]
            for m in filtered:
                kind = m.get("kind", "?")
                imp = m.get("importance", 0.5)
                owner = m.get("owner", "?")
                summary = m.get("summary", "")
                content = m.get("content", "")
                text = summary if summary else content[:200]
                if len(text) > 200:
                    text = text[:200] + "..."
                lines.append(f"  [{kind}|{imp:.1f}|{owner}] {text}")

            block = "\n".join(lines)
            self._prefetch_cache[cache_key] = block
            self._last_prefetch = block
            return block
            
        except Exception as e:
            logger.debug("prefetch error: %s", e)
            return ""

    def recall_status(self):
        from agent.memory_provider import RecallStatus
        if self._last_prefetch:
            return RecallStatus(provider_label="Mnemosyne", count=1)
        return None

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        def _do():
            try:
                self.prefetch(query, session_id=session_id)
            except Exception:
                pass
        spawn_context_thread(_do, name="mnemosyne-prefetch").start()

    # === STORE ===

    def sync_turn(self, user_content, assistant_content, *,
                  session_id="", messages=None, turn_author=None, **kwargs):
        user = (user_content or "").strip()
        
        remember_keywords = [
            "记住", "记下来", "备忘", "记一下",
            "remember", "save this", "note that",
        ]
        
        is_explicit_remember = any(kw in user.lower() for kw in remember_keywords)
        decision_keywords = ["我决定", "最终方案", "最终选择", "确定了"]
        error_keywords = ["报错", "错误", "失败了", "解决方法", "修复了"]
        
        is_decision = any(kw in user for kw in decision_keywords)
        is_error_solution = any(kw in user for kw in error_keywords)
        
        if not (is_explicit_remember or is_decision or is_error_solution):
            return
        
        if is_explicit_remember:
            kind, importance = "fact", 0.75
        elif is_decision:
            kind, importance = "decision", 0.85
        else:
            kind, importance = "error", 0.7
        
        content = user
        for kw in remember_keywords:
            if kw in user:
                idx = user.index(kw) + len(kw)
                content = user[idx:].strip().strip("：:，,。.")
                if content:
                    break
        
        if not content:
            content = user[:300]
        
        # v3: include owner in save
        with self._sync_lock:
            self._pending_saves.append({
                "content": content, "kind": kind, "importance": importance,
                "tags": ["explicit-save" if is_explicit_remember else "auto-detect"],
                "session_id": session_id or self._session_id,
                "owner": self._owner,
                "visibility": "private",
            })
        
        if self._sync_thread and self._sync_thread.is_alive():
            return
        self._sync_thread = spawn_context_thread(self._flush_saves, name="mnemosyne-save")
        self._sync_thread.start()

    def _flush_saves(self):
        with self._sync_lock:
            saves = self._pending_saves[:]
            self._pending_saves.clear()
        
        for item in saves:
            try:
                self._api("POST", "/memory/save", {
                    "content": item["content"], "kind": item["kind"],
                    "importance": item["importance"], "tags": item["tags"],
                    "workspace": self._workspace,
                    "owner": item["owner"], "visibility": item["visibility"],
                    "source_agent": "hermes-v3",
                    "source_session": item["session_id"],
                })
                self._save_count += 1
            except Exception as e:
                logger.debug("save error: %s", e)

    def on_memory_write(self, action, target, content, metadata=None):
        """Sync built-in MEMORY.md writes to Mnemosyne."""
        if not content or len(content) < 20:
            return
        
        kind = "preference" if target == "user" else "fact"
        
        def _sync():
            try:
                self._api("POST", "/memory/save", {
                    "content": content[:500], "kind": kind, "importance": 0.65,
                    "tags": ["memory-sync", target],
                    "workspace": self._workspace,
                    "owner": self._owner, "visibility": "private",
                    "source_agent": "hermes-memory-sync",
                    "source_session": self._session_id,
                })
            except Exception:
                pass
        spawn_context_thread(_sync, name="mnemosyne-mem-sync").start()

    def on_session_end(self, messages: list) -> None:
        if self._pending_saves:
            self._flush_saves()

    def on_pre_compress(self, messages: list) -> str:
        try:
            facts = []
            for m in messages:
                if m.get("role") == "assistant":
                    c = m.get("content", "")
                    if isinstance(c, str):
                        for kw in ["决定", "选定", "最终方案", "部署成功"]:
                            if kw in c:
                                facts.append(c[:150])
                                break
            if facts:
                return f"[Mnemosyne: {len(facts)} key facts]\n" + "\n".join(facts[:2])
        except Exception:
            pass
        return ""

    # === Tools ===

    def get_tool_schemas(self) -> list:
        return [{
            "name": "mnemosyne",
            "description": "Cross-device memory with owner isolation. Actions: save, search, recent, health, dream, stats.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["save", "search", "recent", "health", "dream", "stats"]},
                    "content": {"type": "string"},
                    "query": {"type": "string"},
                    "kind": {"type": "string", "enum": ["fact", "preference", "decision", "procedure", "error", "episode"]},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "importance": {"type": "number"},
                    "limit": {"type": "number"},
                    "workspace": {"type": "string"},
                    "owner": {"type": "string", "description": "Override default owner"},
                    "visibility": {"type": "string", "enum": ["private", "shared", "public"]},
                },
                "required": ["action"],
            },
        }]

    def handle_tool_call(self, tool_name: str, args: dict, **kwargs) -> str:
        if tool_name != "mnemosyne":
            raise NotImplementedError(f"Unknown tool: {tool_name}")
        action = args.get("action", "")
        ws = args.get("workspace") or self._workspace
        owner = args.get("owner") or self._owner
        vis = args.get("visibility") or "private"
        
        try:
            if action == "save":
                r = self._api("POST", "/memory/save", {
                    "content": args.get("content", ""), "kind": args.get("kind", "fact"),
                    "tags": args.get("tags", []), "importance": args.get("importance", 0.5),
                    "workspace": ws, "owner": owner, "visibility": vis,
                    "source_agent": "hermes-tool",
                })
                if r["success"]:
                    return json.dumps({"success": True, "result": f"Saved [{owner}/{vis}]. ID: {r['data'].get('id', '?')}"})
                return json.dumps(r)
            
            elif action == "search":
                body = {
                    "query": args.get("query", ""), "limit": args.get("limit", 10),
                    "workspace": ws, "owner": owner, "include": args.get("include", ["own", "shared"]),
                }
                if args.get("kind"): body["kind"] = args["kind"]
                r = self._api("POST", "/memory/search", body)
                if not r["success"]: return json.dumps(r)
                results = r["data"].get("results", [])
                if not results: return json.dumps({"success": True, "result": f"No results for [{owner}]"})
                lines = [f"Found {r['data']['count']} for [{owner}]:"]
                for m in results[:args.get("limit", 10)]:
                    o = m.get("owner", "?")
                    v = m.get("visibility", "?")
                    lines.append(f"  [{m.get('kind','?')}|{o}|{v}] {(m.get('summary') or m.get('content',''))[:80]}")
                return json.dumps({"success": True, "result": "\n".join(lines)})
            
            elif action == "recent":
                r = self._api("GET", f"/memory/recent?workspace={ws}&limit={args.get('limit', 10)}&owner={owner}")
                if not r["success"]: return json.dumps(r)
                results = r["data"].get("results", [])
                lines = [f"Recent {len(results)} for [{owner}]:"]
                for m in results:
                    lines.append(f"  [{m.get('kind','?')}] {m.get('content', '')[:80]}")
                return json.dumps({"success": True, "result": "\n".join(lines)})
            
            elif action == "health":
                r = self._api("GET", f"/memory/health?workspace={ws}")
                if not r["success"]: return json.dumps(r)
                d = r["data"]
                return json.dumps({"success": True, "result": f"Health [{ws}]: {d.get('score',0)}/100, {d.get('total',0)} memories"})
            
            elif action == "dream":
                r = self._api("POST", "/memory/dream", {"workspace": ws})
                if not r["success"]: return json.dumps(r)
                d = r["data"]
                return json.dumps({"success": True, "result": f"Dream [{ws}]: merged={d.get('duplicates_merged',0)}, summarized={d.get('memories_summarized',0)}"})
            
            elif action == "stats":
                r = self._api("GET", f"/memory/stats/detailed?workspace={ws}")
                if not r["success"]: return json.dumps(r)
                d = r["data"]
                lines = [f"Stats [{ws}]: {d.get('recent_7d',0)} recent (7d)"]
                for k in d.get("by_kind", []):
                    lines.append(f"  {k['kind']}: {k['count']}")
                return json.dumps({"success": True, "result": "\n".join(lines)})
            
            else:
                return json.dumps({"success": False, "error": f"Unknown action: {action}"})
        except Exception as e:
            return json.dumps({"success": False, "error": str(e)})

    def get_config_schema(self) -> list:
        return [
            {"key": "url", "description": "Mnemosyne server URL", "required": True},
            {"key": "token", "description": "Mnemosyne API token", "secret": True, "required": True, "env_var": "MNEMOSYNE_TOKEN"},
            {"key": "workspace", "description": "Default workspace", "default": "default"},
            {"key": "owner", "description": "Default owner (user identity)", "default": "default", "env_var": "MNEMOSYNE_OWNER"},
        ]

    def save_config(self, values: dict, hermes_home: str) -> None:
        config_path = Path(hermes_home) / "mnemosyne.json"
        config = {}
        if config_path.exists():
            try: config = json.loads(config_path.read_text())
            except Exception: pass
        config.update({k: v for k, v in values.items() if k != "token"})
        config_path.write_text(json.dumps(config, indent=2))

    def shutdown(self) -> None:
        if self._pending_saves:
            self._flush_saves()


def register(ctx) -> None:
    ctx.register_memory_provider(MnemosyneProvider())
