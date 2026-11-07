"""
Mnemosyne Memory Provider for Hermes Agent
Cross-device centralized memory via Mnemosyne server.

Place in: plugins/memory/mnemosyne/__init__.py
Activate: set memory.provider=mnemosyne in config.yaml
Config:   MNEMOSYNE_URL, MNEMOSYNE_TOKEN in .env
"""

import json
import logging
import os
import threading
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider, spawn_context_thread

logger = logging.getLogger(__name__)


class MnemosyneProvider(MemoryProvider):
    """Mnemosyne cross-device memory provider.
    
    Auto-recall via prefetch(), auto-save via sync_turn().
    Agent doesn't need to know Mnemosyne exists.
    """

    def __init__(self):
        self._url = ""
        self._token = ""
        self._workspace = "default"
        self._session_id = ""
        self._hermes_home = ""
        self._pending_turns = []
        self._sync_thread = None
        self._last_prefetch = ""
        self._prefetch_cache = {}
        self._sync_lock = threading.Lock()

    @property
    def name(self) -> str:
        return "mnemosyne"

    def is_available(self) -> bool:
        """Check if MNEMOSYNE_TOKEN is configured. No network calls."""
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
        return "MNEMOSYNE_TOKEN not set. Add to .env: MNEMOSYNE_URL=..., MNEMOSYNE_TOKEN=..."

    def initialize(self, session_id: str, **kwargs) -> None:
        """Called once at agent startup."""
        self._session_id = session_id
        self._hermes_home = kwargs.get("hermes_home", str(Path.home() / ".hermes"))

        self._url = os.environ.get("MNEMOSYNE_URL", "https://mnemosyne.niao.fun")
        self._token = os.environ.get("MNEMOSYNE_TOKEN", "")
        self._workspace = os.environ.get("MNEMOSYNE_WS", "default")

        self._load_env()

        config_path = Path(self._hermes_home) / "mnemosyne.json"
        if config_path.exists():
            try:
                config = json.loads(config_path.read_text())
                self._url = config.get("url", self._url)
                self._workspace = config.get("workspace", self._workspace)
                if config.get("token"):
                    self._token = config["token"]
            except Exception as e:
                logger.warning("Failed to load mnemosyne.json: %s", e)

        logger.info(
            "Mnemosyne provider initialized: url=%s, workspace=%s, session=%s",
            self._url, self._workspace, session_id[:20]
        )

    def _load_env(self):
        if self._token:
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

    # === Recall ===

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Auto-recall: search Mnemosyne before each turn."""
        from agent.memory_provider import is_trivial_prompt
        if is_trivial_prompt(query):
            return ""

        cache_key = f"{session_id}:{query[:50]}"
        if cache_key in self._prefetch_cache:
            cached = self._prefetch_cache[cache_key]
            self._last_prefetch = cached
            return cached

        try:
            r = self._api("POST", "/memory/search", {
                "query": query, "limit": 3, "workspace": self._workspace,
            })
            if not r["success"]:
                return ""
            results = r["data"].get("results", [])
            if not results:
                return ""

            lines = [f"[Mnemosyne — {len(results)} relevant memories]"]
            for m in results:
                kind = m.get("kind", "?")
                text = (m.get("summary") or m.get("content", ""))[:150]
                lines.append(f"  [{kind}] {text}")

            block = "\n".join(lines)
            self._prefetch_cache[cache_key] = block
            self._last_prefetch = block
            return block
        except Exception as e:
            logger.debug("Mnemosyne prefetch error: %s", e)
            return ""

    def recall_status(self):
        from agent.memory_provider import RecallStatus
        if self._last_prefetch:
            count = self._last_prefetch.count("[")
            return RecallStatus(provider_label="Mnemosyne", count=max(count - 1, 1))
        return None

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        def _do():
            try:
                self.prefetch(query, session_id=session_id)
            except Exception:
                pass
        spawn_context_thread(_do, name="mnemosyne-prefetch").start()

    # === Store ===

    def sync_turn(self, user_content, assistant_content, *,
                  session_id="", messages=None, turn_author=None, **kwargs):
        """Auto-save: persist completed turn to Mnemosyne. Non-blocking."""
        with self._sync_lock:
            self._pending_turns.append({
                "user": user_content[:500],
                "assistant": assistant_content[:1000],
                "session_id": session_id or self._session_id,
                "timestamp": __import__("time").time(),
            })

        if self._sync_thread and self._sync_thread.is_alive():
            return
        self._sync_thread = spawn_context_thread(self._flush_pending, name="mnemosyne-sync")
        self._sync_thread.start()

    def _flush_pending(self):
        with self._sync_lock:
            turns = self._pending_turns[:]
            self._pending_turns.clear()

        for turn in turns:
            try:
                user = turn["user"].strip()
                if len(user) < 5:
                    continue

                kind = "episode"
                importance = 0.4
                if any(kw in user for kw in ["记住", "remember", "保存"]):
                    kind, importance = "fact", 0.7
                elif any(kw in user for kw in ["决定", "选定", "decision"]):
                    kind, importance = "decision", 0.8
                elif any(kw in user for kw in ["错误", "失败", "error", "failed"]):
                    kind, importance = "error", 0.7
                elif any(kw in user for kw in ["部署", "配置", "步骤", "流程"]):
                    kind, importance = "procedure", 0.6

                content = f"User: {turn['user']}\nAssistant: {turn['assistant'][:300]}"
                self._api("POST", "/memory/save", {
                    "content": content, "kind": kind,
                    "tags": ["auto-sync", "hermes", f"session:{turn['session_id'][:12]}"],
                    "importance": importance, "workspace": self._workspace,
                    "source_agent": "hermes-auto", "source_session": turn["session_id"],
                })
            except Exception as e:
                logger.debug("Mnemosyne sync error: %s", e)

    def on_session_end(self, messages: list) -> None:
        """Final save at session end."""
        if self._pending_turns:
            self._flush_pending()
        if not messages:
            return
        try:
            user_msgs = [m for m in messages if m.get("role") == "user"]
            asst_msgs = [m for m in messages if m.get("role") == "assistant"]
            if not user_msgs:
                return

            summary = f"Session: {len(user_msgs)} user, {len(asst_msgs)} assistant messages."
            topics = []
            for m in user_msgs[:5]:
                c = m.get("content", "")
                if isinstance(c, str) and len(c) > 10:
                    topics.append(c[:80])
            if topics:
                summary += "\nTopics:\n" + "\n".join(f"  - {t}" for t in topics)

            self._api("POST", "/memory/save", {
                "content": summary, "kind": "episode",
                "tags": ["session-summary", "auto", "hermes"],
                "importance": 0.5, "workspace": self._workspace,
                "source_agent": "hermes-session-end", "source_session": self._session_id,
            })
        except Exception as e:
            logger.warning("Mnemosyne on_session_end error: %s", e)

    def on_pre_compress(self, messages: list) -> str:
        """Preserve key facts before context compression."""
        try:
            key_facts = []
            for m in messages:
                if m.get("role") == "assistant":
                    c = m.get("content", "")
                    if isinstance(c, str):
                        for kw in ["决定", "选定", "部署成功", "错误", "失败"]:
                            if kw in c:
                                key_facts.append(c[:200])
                                break
            if key_facts:
                return f"[Mnemosyne: {len(key_facts)} key facts]\n" + "\n".join(key_facts[:3])
        except Exception:
            pass
        return ""

    # === Tools ===

    def get_tool_schemas(self) -> list:
        return [{
            "name": "mnemosyne",
            "description": "Cross-device centralized memory. Actions: save, search, recent, health, dream, stats.",
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
                },
                "required": ["action"],
            },
        }]

    def handle_tool_call(self, tool_name: str, args: dict, **kwargs) -> str:
        if tool_name != "mnemosyne":
            raise NotImplementedError(f"Unknown tool: {tool_name}")
        action = args.get("action", "")
        ws = args.get("workspace") or self._workspace
        try:
            if action == "save":
                r = self._api("POST", "/memory/save", {
                    "content": args.get("content", ""), "kind": args.get("kind", "fact"),
                    "tags": args.get("tags", []), "importance": args.get("importance", 0.5),
                    "workspace": ws, "source_agent": "hermes-tool",
                })
                if r["success"]:
                    return json.dumps({"success": True, "result": f"Saved to [{ws}]. ID: {r['data'].get('id', '?')}"})
                return json.dumps(r)
            elif action == "search":
                body = {"query": args.get("query", ""), "limit": args.get("limit", 10), "workspace": ws}
                if args.get("kind"): body["kind"] = args["kind"]
                r = self._api("POST", "/memory/search", body)
                if not r["success"]: return json.dumps(r)
                results = r["data"].get("results", [])
                if not results: return json.dumps({"success": True, "result": f"No results in [{ws}]"})
                lines = [f"Found {r['data']['count']} in [{ws}]:"]
                for m in results[:args.get("limit", 10)]:
                    lines.append(f"  [{m.get('kind','?')}] {(m.get('summary') or m.get('content',''))[:100]}")
                return json.dumps({"success": True, "result": "\n".join(lines)})
            elif action == "health":
                r = self._api("GET", f"/memory/health?workspace={ws}")
                if not r["success"]: return json.dumps(r)
                d = r["data"]
                return json.dumps({"success": True, "result": f"Health [{ws}]: {d.get('score',0)}/100, {d.get('total',0)} memories, {d.get('duplicates',0)} dupes"})
            elif action == "dream":
                r = self._api("POST", "/memory/dream", {"workspace": ws})
                if not r["success"]: return json.dumps(r)
                d = r["data"]
                return json.dumps({"success": True, "result": f"Dream [{ws}]: merged={d.get('duplicates_merged',0)}, summarized={d.get('memories_summarized',0)}"})
            else:
                return json.dumps({"success": False, "error": f"Unknown action: {action}"})
        except Exception as e:
            return json.dumps({"success": False, "error": str(e)})

    def get_config_schema(self) -> list:
        return [
            {"key": "url", "description": "Mnemosyne server URL", "default": "https://mnemosyne.niao.fun"},
            {"key": "token", "description": "Mnemosyne API token", "secret": True, "required": True, "env_var": "MNEMOSYNE_TOKEN"},
            {"key": "workspace", "description": "Default workspace", "default": "default"},
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
        if self._pending_turns:
            self._flush_pending()


def register(ctx) -> None:
    """Plugin entry point."""
    ctx.register_memory_provider(MnemosyneProvider())
