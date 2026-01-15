#!/usr/bin/env python3
"""
Google Chat Client - Enhanced Implementation
Fetches messages from Google Chat spaces using cookie-based authentication.

Features:
    - List all spaces you belong to
    - Search for spaces by name
    - Get recent messages from a space
    - Search messages in a specific space
    - Search messages across all spaces (local)
    - Server-side search using batchexecute API

Usage:
    python3 chat_client.py                        # Interactive menu
    python3 chat_client.py spaces                 # List all spaces
    python3 chat_client.py messages SPACE_ID      # Get messages from space
    python3 chat_client.py search QUERY           # Search all spaces (local)
    python3 chat_client.py server-search QUERY    # Server-side search
"""

import asyncio
import json
import os
import re
import subprocess
import sys
from datetime import datetime
from typing import Optional

import aiohttp

# Add local maugclib to path
script_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, script_dir)

from maugclib import googlechat_pb2

GC_BASE_URL = "https://chat.google.com/u/0"
API_KEY = "AIzaSyD7InnYR3VKdb4j2rMUEbTCIr2VyEazl6k"
DEFAULT_SPACE_ID = "AAAAHKvY2CQ"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36"
KNOWN_SPACES_FILE = "known_spaces.json"
CACHED_COOKIES_FILE = "cached_cookies.json"
CACHED_AUTH_FILE = "cached_auth.json"  # Stores cookies + XSRF token


def get_all_cookies(force_refresh: bool = False) -> dict:
    """
    Get cookies, using cache unless force_refresh is True.

    Cookies are cached to avoid slow Chrome extraction on every run.
    Cache is invalidated when authentication fails.
    """
    cache_path = os.path.join(script_dir, CACHED_COOKIES_FILE)

    # Try to load cached cookies first
    if not force_refresh and os.path.exists(cache_path):
        try:
            with open(cache_path) as f:
                cached = json.load(f)
                # Check required cookies are present
                required = ["SID", "HSID", "SSID", "OSID"]
                if all(name in cached for name in required):
                    return cached
        except Exception:
            pass  # Cache invalid, will refresh

    # Extract fresh cookies from Chrome
    print("Extracting fresh cookies from Chrome...")
    result = subprocess.run(
        ["python3", "extract_cookies.py"],
        cwd=script_dir,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise Exception(f"Cookie extraction failed: {result.stderr}")

    cookies = json.loads(result.stdout)

    # Cache the cookies
    try:
        with open(cache_path, "w") as f:
            json.dump(cookies, f)
    except Exception:
        pass  # Non-fatal if we can't cache

    return cookies


def invalidate_cookie_cache():
    """Remove cached cookies to force refresh on next run"""
    cache_path = os.path.join(script_dir, CACHED_COOKIES_FILE)
    try:
        if os.path.exists(cache_path):
            os.remove(cache_path)
    except Exception:
        pass


def invalidate_auth_cache():
    """Remove cached auth data (XSRF token, etc.) to force refresh"""
    cache_path = os.path.join(script_dir, CACHED_AUTH_FILE)
    try:
        if os.path.exists(cache_path):
            os.remove(cache_path)
    except Exception:
        pass


def _load_auth_cache() -> dict | None:
    """Load cached auth data if valid"""
    cache_path = os.path.join(script_dir, CACHED_AUTH_FILE)
    try:
        if os.path.exists(cache_path):
            with open(cache_path) as f:
                data = json.load(f)
                # Check cache has required fields and isn't too old (24 hours)
                if data.get("xsrf_token") and data.get("cached_at"):
                    age_hours = (datetime.now().timestamp() - data["cached_at"]) / 3600
                    if age_hours < 24:
                        return data
    except Exception:
        pass
    return None


def _save_auth_cache(xsrf_token: str, mole_world_body: str):
    """Save auth data to cache"""
    cache_path = os.path.join(script_dir, CACHED_AUTH_FILE)
    try:
        with open(cache_path, "w") as f:
            json.dump(
                {
                    "xsrf_token": xsrf_token,
                    "mole_world_body": mole_world_body,
                    "cached_at": datetime.now().timestamp(),
                },
                f,
            )
    except Exception:
        pass  # Non-fatal if we can't cache


def build_cookie_string(cookies: dict) -> str:
    """Build cookie header string"""
    return "; ".join(f"{k}={v}" for k, v in cookies.items())


class GoogleChatClient:
    """Google Chat API client using cookie-based authentication"""

    def __init__(self, cookies: dict):
        self.cookies = cookies
        self.cookie_string = build_cookie_string(cookies)
        self.xsrf_token = None
        self.api_reqid = 0
        self.session = None
        self._spaces_cache = None

        # Request header for protobuf API calls
        self.request_header = googlechat_pb2.RequestHeader(
            client_type=googlechat_pb2.RequestHeader.ClientType.WEB,
            client_version=2440378181258,
            client_feature_capabilities=googlechat_pb2.ClientFeatureCapabilities(
                spam_room_invites_level=googlechat_pb2.ClientFeatureCapabilities.FULLY_SUPPORTED,
            ),
        )

    def _get_headers(self, extra: dict = None) -> dict:
        headers = {
            "Cookie": self.cookie_string,
            "User-Agent": USER_AGENT,
            "Connection": "Keep-Alive",
        }
        if extra:
            headers.update(extra)
        return headers

    async def _ensure_session(self):
        if self.session is None or self.session.closed:
            self.session = aiohttp.ClientSession()

    async def close(self):
        if self.session and not self.session.closed:
            await self.session.close()

    async def refresh_tokens(self, force_refresh: bool = False):
        """Fetch XSRF token from /mole/world and extract initial data.

        Uses cached auth data when available to speed up startup.
        """
        await self._ensure_session()

        # Try to use cached auth data first
        if not force_refresh:
            cached = _load_auth_cache()
            if cached:
                self.xsrf_token = cached["xsrf_token"]
                self._mole_world_body = cached.get("mole_world_body", "")
                return

        params = {
            "origin": "https://mail.google.com",
            "shell": "9",
            "hl": "en",
            "wfi": "gtn-roster-iframe-id",
            "hs": '["h_hs",null,null,[1,0],null,null,"gmail.pinto-server_20230730.06_p0",1,null,[15,38,36,35,26,30,41,18,24,11,21,14,6],null,null,"3Mu86PSulM4.en..es5",0,null,null,[0]]',
        }

        headers = self._get_headers(
            {"authority": "chat.google.com", "referer": "https://mail.google.com/"}
        )

        async with self.session.get(
            f"{GC_BASE_URL}/mole/world",
            params=params,
            headers=headers,
            allow_redirects=False,
        ) as resp:
            if resp.status != 200:
                location = resp.headers.get("Location", "")
                raise Exception(
                    f"Auth failed: {resp.status}, redirect to {location[:100]}"
                )

            body = await resp.text()
            wiz_match = re.search(
                r">window\.WIZ_global_data = ({.+?});</script>", body, re.DOTALL
            )
            if not wiz_match:
                raise Exception("No WIZ_global_data found in response")

            wiz_data = json.loads(wiz_match.group(1))
            if wiz_data.get("qwAQke") == "AccountsSignInUi":
                raise Exception("Not logged in - session invalid")

            self.xsrf_token = wiz_data.get("SMqcke")
            if not self.xsrf_token:
                raise Exception("No XSRF token in response")

            # Store the full mole/world body for space extraction
            self._mole_world_body = body

            # Cache the auth data for next time
            _save_auth_cache(self.xsrf_token, body)

    async def _api_request_protojson(self, endpoint: str, request_pb) -> list:
        """Make a protobuf API request, returning pblite/protojson response"""
        await self._ensure_session()

        if not self.xsrf_token:
            await self.refresh_tokens()

        self.api_reqid += 1

        headers = self._get_headers(
            {
                "Content-Type": "application/x-protobuf",
                "x-framework-xsrf-token": self.xsrf_token,
            }
        )

        params = {
            "alt": "protojson",
            "key": API_KEY,
        }

        async with self.session.post(
            f"{GC_BASE_URL}/api/{endpoint}",
            params=params,
            headers=headers,
            data=request_pb.SerializeToString(),
        ) as resp:
            body = await resp.text()

            if resp.status != 200:
                raise Exception(f"API error {resp.status}: {body[:300]}")

            # Remove anti-XSS prefix
            cleaned = body.lstrip(")]}'").strip()
            if cleaned.startswith("\n"):
                cleaned = cleaned[1:]

            return json.loads(cleaned)

    def _make_group_id(self, space_id: str):
        """Create a GroupId from a space ID string"""
        return googlechat_pb2.GroupId(
            space_id=googlechat_pb2.SpaceId(space_id=space_id)
        )

    # =========================================================================
    # FEATURE 1: Get current user info
    # =========================================================================
    async def get_self_user_status(self) -> dict:
        """Get current user info"""
        request = googlechat_pb2.GetSelfUserStatusRequest(
            request_header=self.request_header
        )
        data = await self._api_request_protojson("get_self_user_status", request)

        try:
            if data and len(data) > 0 and len(data[0]) > 1:
                status = data[0][1]
                if status and len(status) > 0 and len(status[0]) > 0:
                    user_id = (
                        status[0][0][0]
                        if isinstance(status[0][0], list)
                        else status[0][0]
                    )
                    return {"user_id": user_id}
        except (IndexError, TypeError):
            pass
        return {"raw": data}

    # =========================================================================
    # FEATURE 2: List all spaces user belongs to
    # =========================================================================
    def _load_known_spaces(self) -> list:
        """Load known spaces from file"""
        try:
            if os.path.exists(KNOWN_SPACES_FILE):
                with open(KNOWN_SPACES_FILE) as f:
                    return json.load(f)
        except Exception:
            pass
        return []

    def _save_known_spaces(self, spaces: list):
        """Save known spaces to file"""
        try:
            with open(KNOWN_SPACES_FILE, "w") as f:
                json.dump(spaces, f, indent=2)
        except Exception as e:
            print(f"Warning: Could not save spaces: {e}")

    def add_space(self, space_id: str, name: str = None):
        """Manually add a space to the known spaces list"""
        spaces = self._load_known_spaces()

        # Check if already exists
        for s in spaces:
            if s["id"] == space_id:
                if name:
                    s["name"] = name
                self._save_known_spaces(spaces)
                return

        # Add new space
        spaces.append(
            {
                "id": space_id,
                "name": name or space_id,
                "type": "space" if space_id.startswith("AAAA") else "dm",
            }
        )
        self._save_known_spaces(spaces)
        self._spaces_cache = None  # Clear cache

    async def _api_request_protobuf(self, endpoint: str, request_pb) -> bytes:
        """Make a protobuf API request, returning raw protobuf response"""
        await self._ensure_session()

        if not self.xsrf_token:
            await self.refresh_tokens()

        self.api_reqid += 1

        headers = self._get_headers(
            {
                "Content-Type": "application/x-protobuf",
                "x-framework-xsrf-token": self.xsrf_token,
                "X-Goog-Encode-Response-If-Executable": "base64",
            }
        )

        params = {
            "alt": "proto",
            "key": API_KEY,
            "c": str(self.api_reqid),
            "rt": "b",
        }

        async with self.session.post(
            f"{GC_BASE_URL}/api/{endpoint}",
            params=params,
            headers=headers,
            data=request_pb.SerializeToString(),
        ) as resp:
            body = await resp.read()

            if resp.status != 200:
                raise Exception(f"API error {resp.status}: {body[:300]}")

            # Response may be base64 encoded
            import base64

            try:
                decoded = base64.b64decode(body)
                return decoded
            except Exception:
                return body

    async def list_spaces(self, refresh: bool = False) -> list:
        """
        Get list of all spaces/conversations the user belongs to.

        Fetches from paginated_world API using proper protobuf format.

        Returns:
            List of dicts with 'id', 'name', 'type' (space/dm)
        """
        if self._spaces_cache and not refresh:
            return self._spaces_cache

        # Start with known spaces from file
        spaces = self._load_known_spaces()
        seen_ids = {s["id"] for s in spaces}

        # Try to get spaces from API using proper protobuf
        try:
            # WorldSectionType enum values from googlechat_pb2.pyi:
            # STARRED_ROOMS = 2
            # NON_STARRED_ROOMS = 5
            # ALL_ROOMS = 8
            # ALL_DIRECT_MESSAGE_PEOPLE = 7
            # ALL_DIRECT_MESSAGE_BOTS = 9

            world_sections = [
                # All rooms/spaces (this is the correct enum value)
                googlechat_pb2.WorldSectionRequest(
                    page_size=100,
                    world_section=googlechat_pb2.WorldSection(
                        world_section_type=8  # ALL_ROOMS
                    ),
                ),
                # Starred rooms
                googlechat_pb2.WorldSectionRequest(
                    page_size=100,
                    world_section=googlechat_pb2.WorldSection(
                        world_section_type=2  # STARRED_ROOMS
                    ),
                ),
                # Non-starred rooms
                googlechat_pb2.WorldSectionRequest(
                    page_size=100,
                    world_section=googlechat_pb2.WorldSection(
                        world_section_type=5  # NON_STARRED_ROOMS
                    ),
                ),
                # DMs with people
                googlechat_pb2.WorldSectionRequest(
                    page_size=100,
                    world_section=googlechat_pb2.WorldSection(
                        world_section_type=7  # ALL_DIRECT_MESSAGE_PEOPLE
                    ),
                ),
            ]

            request = googlechat_pb2.PaginatedWorldRequest(
                request_header=self.request_header,
                world_section_requests=world_sections,
                fetch_from_user_spaces=True,
                fetch_snippets_for_unnamed_rooms=True,
            )

            # First, try extracting spaces from the mole/world bootstrap data
            if hasattr(self, "_mole_world_body") and self._mole_world_body:
                mole_spaces = self._extract_spaces_from_mole_world(
                    self._mole_world_body
                )
                for space in mole_spaces:
                    if space["id"] not in seen_ids:
                        seen_ids.add(space["id"])
                        spaces.append(space)

            # Also try the paginated_world API for additional spaces
            data = await self._api_request_protojson("paginated_world", request)
            self._extract_spaces_from_pblite(data, spaces, seen_ids)

        except Exception as e:
            print(f"Note: Could not fetch spaces from API: {e}")

        # Fetch names for spaces that don't have one
        for space in spaces:
            if space.get("name") is None and space["type"] == "space":
                try:
                    info = await self.get_group(space["id"])
                    space["name"] = info.get("name", space["id"])
                except Exception:
                    space["name"] = space["id"]

        # Save discovered spaces
        if spaces:
            self._save_known_spaces(spaces)

        self._spaces_cache = spaces
        return spaces

    def _extract_spaces_from_mole_world(self, body: str) -> list:
        """Extract spaces from /mole/world HTML response (bootstrap data)"""
        spaces = []

        # Look for AF_initDataCallback calls which contain embedded data
        # Format: AF_initDataCallback({key: 'ds:N', data: [...]});
        import re

        # Find all data callbacks
        callbacks = re.findall(
            r"AF_initDataCallback\s*\(\s*\{[^}]*data:\s*(\[[\s\S]*?\])\s*\}\s*\)\s*;",
            body,
        )

        for callback_data in callbacks:
            try:
                # Parse the JSON data
                data = json.loads(callback_data)
                self._find_spaces_in_data(data, spaces)
            except json.JSONDecodeError:
                continue

        # Also look for inline script data patterns
        # Sometimes space IDs appear in script blocks
        space_ids = re.findall(r'"(AAAA[A-Za-z0-9_-]{7})"', body)
        for space_id in set(space_ids):
            if not any(s["id"] == space_id for s in spaces):
                spaces.append(
                    {
                        "id": space_id,
                        "name": None,  # Will be fetched later
                        "type": "space",
                    }
                )

        return spaces

    def _find_spaces_in_data(self, data, spaces: list, depth: int = 0):
        """Recursively find space information in nested data structures"""
        if depth > 30 or not isinstance(data, (list, dict)):
            return

        if isinstance(data, dict):
            for value in data.values():
                self._find_spaces_in_data(value, spaces, depth + 1)
        elif isinstance(data, list):
            space_id = None
            space_name = None

            for item in data:
                if isinstance(item, str):
                    # Space ID pattern
                    if len(item) == 11 and item.startswith("AAAA"):
                        space_id = item
                    # Potential room name
                    elif (
                        3 < len(item) < 80
                        and not item.isdigit()
                        and not item.startswith("http")
                        and not item.startswith("AAAA")
                        and " " in item
                        or item[0].isupper()
                    ):
                        if space_name is None:
                            space_name = item
                elif isinstance(item, list):
                    self._find_spaces_in_data(item, spaces, depth + 1)

            if space_id:
                if not any(s["id"] == space_id for s in spaces):
                    spaces.append({"id": space_id, "name": space_name, "type": "space"})

    def _extract_spaces_from_pblite(self, data: list, spaces: list, seen_ids: set):
        """Extract space information from pblite/protojson response (fallback)"""

        def find_spaces(arr, depth=0):
            if depth > 25 or not isinstance(arr, list):
                return

            for item in arr:
                if isinstance(item, list):
                    space_id = None
                    space_name = None
                    space_type = "unknown"

                    # Check each element for space IDs and names
                    for sub in item:
                        if isinstance(sub, str):
                            # Space ID pattern: 11 chars starting with AAAA
                            if len(sub) == 11 and sub.startswith("AAAA"):
                                space_id = sub
                                space_type = "space"
                            # DM ID pattern: 21 digit string
                            elif len(sub) == 21 and sub.isdigit():
                                space_id = sub
                                space_type = "dm"
                            # Room name: reasonable length, not URL/timestamp
                            elif (
                                3 < len(sub) < 100
                                and not sub.isdigit()
                                and not sub.startswith("http")
                                and space_name is None
                            ):
                                space_name = sub
                        elif isinstance(sub, list):
                            # Check nested lists for space/dm IDs
                            for nested in sub:
                                if isinstance(nested, str):
                                    if len(nested) == 11 and nested.startswith("AAAA"):
                                        space_id = nested
                                        space_type = "space"
                                    elif len(nested) == 21 and nested.isdigit():
                                        space_id = nested
                                        space_type = "dm"
                                elif isinstance(nested, list):
                                    for deep in nested:
                                        if isinstance(deep, str):
                                            if len(deep) == 11 and deep.startswith(
                                                "AAAA"
                                            ):
                                                space_id = deep
                                                space_type = "space"

                    if space_id and space_id not in seen_ids:
                        seen_ids.add(space_id)
                        spaces.append(
                            {
                                "id": space_id,
                                "name": space_name,
                                "type": space_type,
                            }
                        )

                    find_spaces(item, depth + 1)

        find_spaces(data)

    # =========================================================================
    # FEATURE 3: Search for space by name
    # =========================================================================
    async def search_spaces(self, query: str) -> list:
        """
        Search for spaces by name (case-insensitive partial match).

        Args:
            query: Search string to match against space names

        Returns:
            List of matching spaces
        """
        all_spaces = await self.list_spaces()
        query_lower = query.lower()

        matches = []
        for space in all_spaces:
            name = space.get("name") or space.get("id") or ""
            if query_lower in name.lower():
                matches.append(space)

        return matches

    # =========================================================================
    # FEATURE 4: Get space/group info
    # =========================================================================
    async def get_group(self, space_id: str) -> dict:
        """Get space/group info"""
        request = googlechat_pb2.GetGroupRequest(
            request_header=self.request_header,
            group_id=self._make_group_id(space_id),
        )
        data = await self._api_request_protojson("get_group", request)

        try:
            if data and len(data) > 0 and len(data[0]) > 1:
                group_data = data[0][1]
                return {
                    "space_id": space_id,
                    "name": group_data[1] if len(group_data) > 1 else "Unknown",
                    "raw": group_data,
                }
        except (IndexError, TypeError):
            pass
        return {"space_id": space_id, "raw": data}

    # =========================================================================
    # FEATURE 5: Get recent messages from a space
    # =========================================================================
    async def get_messages(self, space_id: str, limit: int = 50) -> list:
        """
        Get recent messages from a space.

        Args:
            space_id: The space ID to fetch messages from
            limit: Maximum number of messages to return

        Returns:
            List of message dicts with 'text', 'sender', 'timestamp', 'message_id'
        """
        request = googlechat_pb2.ListTopicsRequest(
            request_header=self.request_header,
            group_id=self._make_group_id(space_id),
            page_size_for_topics=limit,
        )
        data = await self._api_request_protojson("list_topics", request)

        messages = []

        def parse_timestamp(ts_str: str) -> Optional[str]:
            """Convert microsecond timestamp to readable format"""
            if not ts_str or not ts_str.isdigit():
                return None
            try:
                ts_int = int(ts_str) / 1_000_000
                dt = datetime.fromtimestamp(ts_int)
                return dt.strftime("%Y-%m-%d %H:%M:%S")
            except Exception:
                return None

        def extract_messages(arr, depth=0, context=None):
            """Recursively extract messages from pblite structure"""
            if depth > 25 or not isinstance(arr, list):
                return

            # Track potential message fields
            msg_text = None
            msg_timestamp = None
            msg_sender = None
            msg_id = None

            for idx, item in enumerate(arr):
                if isinstance(item, str):
                    # Message text: longer strings with spaces
                    if len(item) > 5 and " " in item and not item.isdigit():
                        if len(item) < 50000:  # Reasonable message length
                            if msg_text is None or len(item) > len(msg_text):
                                msg_text = item
                    # Timestamp: 16-digit number
                    elif len(item) == 16 and item.isdigit():
                        msg_timestamp = item
                    # Message ID: various formats
                    elif len(item) > 10 and "/" in item:
                        msg_id = item
                    # Sender email
                    elif "@" in item and "." in item:
                        msg_sender = item

                elif isinstance(item, list):
                    extract_messages(item, depth + 1, context)

            # Save if we found meaningful text
            if msg_text and len(msg_text) > 3:
                # Avoid exact duplicates
                if not any(m["text"] == msg_text for m in messages):
                    messages.append(
                        {
                            "text": msg_text,
                            "timestamp": parse_timestamp(msg_timestamp),
                            "timestamp_usec": msg_timestamp,
                            "sender": msg_sender,
                            "message_id": msg_id,
                        }
                    )

        extract_messages(data)

        # Sort by timestamp (newest first)
        messages.sort(key=lambda m: m.get("timestamp_usec") or "0", reverse=True)

        return messages[:limit]

    # Legacy alias
    async def list_topics(self, space_id: str, page_size: int = 25) -> list:
        """Alias for get_messages for backwards compatibility"""
        return await self.get_messages(space_id, page_size)

    # =========================================================================
    # FEATURE 5b: Paginated messages with thread support
    # =========================================================================
    async def get_messages_paginated(
        self,
        space_id: str,
        page_size: int = 25,
        before_timestamp: int = None,
        include_replies: bool = True,
        replies_per_topic: int = 10,
    ) -> dict:
        """
        Get messages from a space with pagination and thread support.

        Args:
            space_id: The space ID to fetch messages from
            page_size: Number of topics/threads per page
            before_timestamp: Fetch messages before this timestamp (microseconds).
                             Pass 'next_cursor' from previous response for pagination.
            include_replies: Whether to fetch thread replies
            replies_per_topic: Max replies to fetch per topic/thread

        Returns:
            dict with:
                - 'messages': List of message dicts (flattened, with thread info)
                - 'topics': List of topic dicts with nested replies
                - 'has_more': Boolean indicating if more messages exist
                - 'next_cursor': Timestamp to use for next page
        """
        request = googlechat_pb2.ListTopicsRequest(
            request_header=self.request_header,
            group_id=self._make_group_id(space_id),
            page_size_for_topics=page_size,
        )

        if include_replies:
            request.page_size_for_replies = replies_per_topic

        # Use group_not_older_than for pagination (fetch topics older than this timestamp)
        if before_timestamp:
            request.group_not_older_than.CopyFrom(
                googlechat_pb2.ReferenceRevision(timestamp=before_timestamp)
            )

        # Use protojson for parsing (more reliable than protobuf decoding)
        data = await self._api_request_protojson("list_topics", request)


        return self._parse_topics_with_threads(data, space_id)

    def _parse_topics_with_threads(self, data: list, space_id: str) -> dict:
        """Parse list_topics response with thread/reply association"""
        topics = []
        messages = []
        oldest_timestamp = None

        def parse_timestamp(ts) -> tuple:
            """Return (formatted_str, raw_usec)"""
            if not ts:
                return None, None
            try:
                if isinstance(ts, str) and ts.isdigit():
                    ts = int(ts)
                if isinstance(ts, int) and ts > 1000000000000:
                    dt = datetime.fromtimestamp(ts / 1_000_000)
                    return dt.strftime("%Y-%m-%d %H:%M:%S"), ts
            except Exception:
                pass
            return None, ts if isinstance(ts, int) else None

        def extract_topic_and_messages(arr, depth=0, parent_topic_id=None):
            """Extract topic with all its messages/replies"""
            nonlocal oldest_timestamp

            if depth > 30 or not isinstance(arr, list):
                return

            topic_id = None
            topic_timestamp = None
            topic_messages = []

            # Try to extract from known topic structure:
            # Index 0: [null, "topicId", [[spaceId]]]
            # Index 1: timestamp (string)
            # Index 6: messages array

            # Get topic ID from index 0
            if len(arr) > 0 and isinstance(arr[0], list):
                if len(arr[0]) > 1 and isinstance(arr[0][1], str):
                    topic_id = arr[0][1]

            # Get timestamp from index 1
            if len(arr) > 1:
                ts = arr[1]
                if isinstance(ts, str) and ts.isdigit():
                    topic_timestamp = int(ts)
                elif isinstance(ts, int):
                    topic_timestamp = ts

            # Get messages from index 6
            if len(arr) > 6 and isinstance(arr[6], list):
                for msg_arr in arr[6]:
                    if isinstance(msg_arr, list):
                        msg = try_parse_message(msg_arr, topic_id or parent_topic_id)
                        if msg:
                            topic_messages.append(msg)

            # Fallback: recursively search if no messages found yet
            if not topic_messages:
                for idx, item in enumerate(arr):
                    if isinstance(item, list):
                        msg = try_parse_message(item, topic_id or parent_topic_id)
                        if msg:
                            topic_messages.append(msg)
                        else:
                            extract_topic_and_messages(
                                item, depth + 1, topic_id or parent_topic_id
                            )

            # If we found a topic with messages, add it
            if topic_id and topic_messages:
                # Track oldest for pagination
                for msg in topic_messages:
                    ts = msg.get("timestamp_usec")
                    if ts:
                        if oldest_timestamp is None or ts < oldest_timestamp:
                            oldest_timestamp = ts

                if topic_messages:
                    # Mark first message as topic starter, rest as replies
                    sorted_msgs = sorted(
                        topic_messages, key=lambda m: m.get("timestamp_usec") or 0
                    )
                    for i, msg in enumerate(sorted_msgs):
                        msg["is_thread_reply"] = i > 0
                        msg["reply_index"] = i

                    topics.append(
                        {
                            "topic_id": topic_id,
                            "space_id": space_id,
                            "timestamp": topic_timestamp,
                            "message_count": len(sorted_msgs),
                            "replies": sorted_msgs,
                        }
                    )
                    messages.extend(sorted_msgs)

        def try_parse_message(arr, topic_id=None) -> dict:
            """Try to parse an array as a message"""
            if not isinstance(arr, list) or len(arr) < 10:
                return None

            msg_text = None
            msg_timestamp = None
            msg_sender = None
            msg_id = None

            # Direct extraction based on known structure:
            # Index 9: message text
            # Index 2 or 3: timestamp
            # Index 0: contains message ID
            # Index 1: contains sender ID

            # Get message text (index 9)
            if len(arr) > 9 and isinstance(arr[9], str):
                msg_text = arr[9]

            # Get timestamp (index 2)
            if len(arr) > 2:
                ts = arr[2]
                if isinstance(ts, str) and ts.isdigit():
                    msg_timestamp = int(ts)
                elif isinstance(ts, int):
                    msg_timestamp = ts

            # Get message ID from index 0
            if len(arr) > 0 and isinstance(arr[0], list):
                # Structure: [[...], "msgId"]
                if len(arr[0]) > 1 and isinstance(arr[0][1], str):
                    msg_id = arr[0][1]

            # Get sender ID from index 1
            if len(arr) > 1 and isinstance(arr[1], list):
                # Structure: [["userId"]]
                if len(arr[1]) > 0 and isinstance(arr[1][0], list) and len(arr[1][0]) > 0:
                    msg_sender = arr[1][0][0]

            if msg_text:
                ts_str, ts_usec = parse_timestamp(msg_timestamp)
                return {
                    "message_id": msg_id,
                    "topic_id": topic_id,
                    "space_id": space_id,
                    "text": msg_text,
                    "timestamp": ts_str,
                    "timestamp_usec": ts_usec,
                    "sender": msg_sender,
                    "is_thread_reply": False,
                    "reply_index": 0,
                }
            return None

        # Parse the data - structure is data[0][1] = topics array
        # Each topic: [topic_id_struct, timestamp, null, null, null, null, messages_array]
        # Each message in messages_array: [..., text at index 9, ...]
        topics_array = None
        if isinstance(data, list) and len(data) > 0:
            if isinstance(data[0], list) and len(data[0]) > 1 and isinstance(data[0][1], list):
                topics_array = data[0][1]

        if topics_array:
            for topic_data in topics_array:
                extract_topic_and_messages(topic_data)
        else:
            # Fallback: parse entire structure
            extract_topic_and_messages(data)

        # Sort messages by timestamp (newest first)
        messages.sort(key=lambda m: m.get("timestamp_usec") or 0, reverse=True)

        # Deduplicate messages
        seen_texts = set()
        unique_messages = []
        for msg in messages:
            text_key = msg.get("text", "")[:100]
            if text_key not in seen_texts:
                seen_texts.add(text_key)
                unique_messages.append(msg)

        # Check contains_last_topic from response (index 4 in protojson format)
        # If contains_last_topic is True, there are no more topics to fetch
        contains_last_topic = False
        if isinstance(data, list) and len(data) > 4:
            contains_last_topic = data[4] is True

        # has_more is True if we have topics and haven't reached the last one
        has_more = (
            len(topics) > 0 and not contains_last_topic and oldest_timestamp is not None
        )

        return {
            "messages": unique_messages,
            "topics": topics,
            "has_more": has_more,
            "next_cursor": oldest_timestamp,
            "total_topics": len(topics),
            "total_messages": len(unique_messages),
        }

    async def get_all_messages(
        self,
        space_id: str,
        max_pages: int = 10,
        page_size: int = 25,
        include_replies: bool = True,
    ) -> list:
        """
        Fetch multiple pages of messages from a space.

        Args:
            space_id: The space ID
            max_pages: Maximum pages to fetch
            page_size: Topics per page
            include_replies: Include thread replies

        Returns:
            List of all messages (flattened, deduplicated)
        """
        all_messages = []
        cursor = None

        for page_num in range(max_pages):
            result = await self.get_messages_paginated(
                space_id=space_id,
                page_size=page_size,
                before_timestamp=cursor,
                include_replies=include_replies,
            )

            all_messages.extend(result["messages"])

            if not result["has_more"] or not result["next_cursor"]:
                break

            cursor = result["next_cursor"]

        # Deduplicate
        seen = set()
        unique = []
        for msg in all_messages:
            key = msg.get("message_id") or msg.get("text", "")[:50]
            if key not in seen:
                seen.add(key)
                unique.append(msg)

        return unique

    # =========================================================================
    # FEATURE 6: Search messages in a specific space
    # =========================================================================
    async def search_in_space(
        self, space_id: str, query: str, limit: int = 100
    ) -> list:
        """
        Search for messages containing query text in a specific space.

        Args:
            space_id: The space to search in
            query: Text to search for (case-insensitive)
            limit: Maximum messages to scan

        Returns:
            List of matching messages
        """
        messages = await self.get_messages(space_id, limit)
        query_lower = query.lower()

        matches = []
        for msg in messages:
            text = msg.get("text", "")
            if query_lower in text.lower():
                # Add context snippet
                idx = text.lower().find(query_lower)
                start = max(0, idx - 50)
                end = min(len(text), idx + len(query) + 50)
                msg["snippet"] = "..." + text[start:end] + "..."
                matches.append(msg)

        return matches

    # =========================================================================
    # FEATURE 7: Server-side search using batchexecute API
    # =========================================================================
    async def server_search(
        self, query: str, space_id: str = None, limit: int = 20
    ) -> list:
        """
        Server-side search using Google Chat's batchexecute API (SBNmJb RPC).

        This searches the actual Google Chat backend rather than just
        locally-fetched messages.

        Args:
            query: Search query string
            space_id: Optional space ID to limit search to
            limit: Maximum results to return

        Returns:
            List of search result dicts with message info
        """
        await self._ensure_session()

        if not self.xsrf_token:
            await self.refresh_tokens()

        self.api_reqid += 1

        # Use the correct RPC: SBNmJb for search
        result = await self._execute_search_rpc(query, space_id, limit)
        if result is not None:
            return result

        # Fall back to local search
        print("Server search unavailable, using local search...")
        return await self._local_search_all_spaces(query, limit)

    async def _execute_search_rpc(
        self, query: str, space_id: str, limit: int
    ) -> list | None:
        """Execute the SBNmJb search RPC with correct format from Chrome capture"""
        import urllib.parse
        import uuid
        import time

        # Generate a session UUID for the search (Google uses this format)
        search_uuid = str(uuid.uuid4()).upper()

        # Build the search params in the exact format from Chrome capture:
        # [null, null, null, "query", null, "UUID", [[config], null, [3], [limit]]]
        #
        # Position 7 is ONE array containing TWO nested elements:
        # [[[[[[1]]]]],[[[1]]]] = [ [[[[[1]]]]], [[[1]]] ]
        nested_flags = [
            [[[[[1]]]]],  # 5 levels of nesting
            [[[1]]],  # 3 levels of nesting
        ]

        search_config = [
            [],  # pos 0: Space filter (empty = all spaces)
            None,  # pos 1
            None,  # pos 2
            None,  # pos 3
            search_uuid,  # pos 4: Same UUID repeated
            None,  # pos 5
            0,  # pos 6
            nested_flags,  # pos 7: ONE array with two nested elements
        ]

        # If searching in specific space, add space filter
        if space_id:
            search_config[0] = [[space_id]]

        search_params = [
            None,
            None,
            None,
            query,  # Search query at index 3
            None,
            search_uuid,  # Session UUID at index 5
            [
                search_config,
                None,
                [3],  # Result type
                [limit],  # Page size / limit
            ],
        ]

        # Build the RPC request - note "4" instead of "generic"
        # Use separators to remove whitespace (matches Google's format exactly)
        # CRITICAL: Google's batchexecute format expects the inner params to be
        # TRUNCATED - missing the final closing bracket! This is intentional.
        inner_params = json.dumps(search_params, separators=(",", ":"))
        inner_params_truncated = inner_params[
            :-1
        ]  # Remove last ] to match Google's format
        rpc_data = json.dumps(
            [[["SBNmJb", inner_params_truncated, None, "4"]]], separators=(",", ":")
        )

        # The XSRF token from Google (SMqcke) already includes a timestamp
        # Format is: base_token:timestamp_ms (e.g., ALN8QKbvS4FCu6QB-SG4dRF3U4rX:1768486520791)
        # So we use it directly without adding another timestamp
        form_body = urllib.parse.urlencode(
            {
                "f.req": rpc_data,
                "at": self.xsrf_token,
            }
        )

        # Build headers matching Google's exact format
        headers = self._get_headers(
            {
                "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                "Origin": "https://chat.google.com",
                "Referer": "https://chat.google.com/",
                "x-same-domain": "1",
                "x-goog-ext-348566919-jspb": "[null,12,[null,null,null,null,2,2,2,2,2,2,null,null,null,null,null,2,2,2,2,2,null,2,2,2,2,2,2,null,2,2,null,2,2,null,null,0,2,2,null,2,2,null,2,2,null,2,2,2,2,2,2,2,2,2,2,2,2,2,null,0]]",
            }
        )

        # Generate a session ID (negative number like Google uses)
        f_sid = str(-abs(hash(self.xsrf_token)) % 10**19)

        params = {
            "rpcids": "SBNmJb",
            "source-path": "/u/0/mole/world",
            "f.sid": f_sid,
            "bl": "boq_dynamiteuiserver_20260112.05_p0",  # Current build label from capture
            "hl": "en",
            "soc-app": "1",
            "soc-platform": "1",
            "soc-device": "1",
            "_reqid": str(self.api_reqid * 100000 + 1323),
            "rt": "c",
        }

        # DEBUG: Print what we're sending
        import os

        if os.environ.get("DEBUG_SEARCH"):
            print("\n=== DEBUG: Search RPC Request ===")
            print(f"f.req: {rpc_data}")
            print(f"at: {self.xsrf_token}")
            print(f"params: {params}")
            print("=================================\n")

        try:
            async with self.session.post(
                "https://chat.google.com/u/0/_/DynamiteWebUi/data/batchexecute",
                params=params,
                headers=headers,
                data=form_body,
            ) as resp:
                body = await resp.text()

                if resp.status != 200:
                    print(f"Search RPC returned {resp.status}")
                    # Debug: show first part of error response
                    clean_body = body.lstrip(")]}'").strip()
                    if clean_body:
                        print(f"Response preview: {clean_body[:300]}...")
                    return None

                # Parse the response
                results = self._parse_batchexecute_response(body, query)

                if results:
                    print(f"Server search found {len(results)} results")
                    return results[:limit]
                else:
                    print("Server search returned empty results")
                    return None

        except Exception as e:
            print(f"Search RPC error: {e}")
            return None

    def _parse_batchexecute_response(self, body: str, query: str) -> list:
        """
        Parse batchexecute response format.

        The response is a series of length-prefixed JSON arrays.
        """
        results = []

        # Remove the anti-XSS prefix
        body = body.lstrip(")]}'").strip()

        # Try to extract JSON arrays from the response
        # Format is typically: number\n[json]\nnumber\n[json]...
        lines = body.split("\n")

        for i, line in enumerate(lines):
            line = line.strip()
            if not line:
                continue

            # Skip length indicators (pure numbers)
            if line.isdigit():
                continue

            # Try to parse as JSON
            if line.startswith("["):
                try:
                    data = json.loads(line)
                    # Extract search results from the nested structure
                    extracted = self._extract_search_results(data, query)
                    results.extend(extracted)
                except json.JSONDecodeError:
                    continue

        return results

    def _extract_search_results(self, data: list, query: str, depth: int = 0) -> list:
        """Extract search results from batchexecute response data"""
        results = []

        if depth > 15 or not isinstance(data, list):
            return results

        query_lower = query.lower()

        for item in data:
            if isinstance(item, str):
                # Check if this looks like a message containing our query
                if len(item) > 10 and query_lower in item.lower():
                    # Found a matching text - create a result entry
                    idx = item.lower().find(query_lower)
                    start = max(0, idx - 50)
                    end = min(len(item), idx + len(query) + 50)

                    results.append(
                        {
                            "text": item,
                            "snippet": "..." + item[start:end] + "...",
                            "source": "server_search",
                        }
                    )

            elif isinstance(item, list):
                # Recursively search nested arrays
                results.extend(self._extract_search_results(item, query, depth + 1))

        return results

    async def _local_search_all_spaces(self, query: str, limit: int = 50) -> list:
        """Fallback local search across spaces"""
        return await self.search_all_spaces(
            query, max_spaces=10, messages_per_space=limit
        )

    # =========================================================================
    # FEATURE 8: Search messages across all spaces (local fallback)
    # =========================================================================
    async def search_all_spaces(
        self, query: str, max_spaces: int = 20, messages_per_space: int = 50
    ) -> list:
        """
        Search for messages containing query text across all spaces.

        Args:
            query: Text to search for (case-insensitive)
            max_spaces: Maximum number of spaces to search
            messages_per_space: Messages to check per space

        Returns:
            List of matching messages with space info
        """
        spaces = await self.list_spaces()
        query_lower = query.lower()

        all_matches = []

        for space in spaces[:max_spaces]:
            space_id = space["id"]
            space_name = space.get("name") or space_id

            try:
                messages = await self.get_messages(space_id, messages_per_space)

                for msg in messages:
                    text = msg.get("text", "")
                    if query_lower in text.lower():
                        # Add space context
                        msg["space_id"] = space_id
                        msg["space_name"] = space_name

                        # Add snippet
                        idx = text.lower().find(query_lower)
                        start = max(0, idx - 40)
                        end = min(len(text), idx + len(query) + 40)
                        msg["snippet"] = text[start:end]

                        all_matches.append(msg)

            except Exception as e:
                print(f"  Warning: Could not search space {space_name}: {e}")

        # Sort by timestamp
        all_matches.sort(key=lambda m: m.get("timestamp_usec") or "0", reverse=True)

        return all_matches

    # Legacy method
    async def get_paginated_world(self, page_size: int = 50) -> list:
        """Legacy alias for list_spaces"""
        return await self.list_spaces()


# =============================================================================
# CLI Interface
# =============================================================================


async def cmd_list_spaces(client: GoogleChatClient):
    """List all spaces"""
    print("\nFetching spaces...")
    spaces = await client.list_spaces()

    print(f"\n{'=' * 60}")
    print(f" Found {len(spaces)} spaces")
    print(f"{'=' * 60}\n")

    if not spaces:
        print("No spaces found.")
        print("\nTo add a space manually:")
        print("  1. Go to chat.google.com and open a space")
        print("  2. Copy the space ID from the URL (e.g., AAAAHKvY2CQ)")
        print("  3. Use option 6 in the menu to add it")
        print("\nExample: python3 chat_client.py messages AAAAHKvY2CQ")
        return

    # Group by type
    rooms = [s for s in spaces if s["type"] == "space"]
    dms = [s for s in spaces if s["type"] == "dm"]

    if rooms:
        print("SPACES/ROOMS:")
        print("-" * 40)
        for s in rooms:
            name = s.get("name") or "(unnamed)"
            print(f"  {s['id']}  {name}")
        print()

    if dms:
        print("DIRECT MESSAGES:")
        print("-" * 40)
        for s in dms[:10]:  # Limit DMs shown
            print(f"  {s['id']}")
        if len(dms) > 10:
            print(f"  ... and {len(dms) - 10} more DMs")
        print()


async def cmd_get_messages(client: GoogleChatClient, space_id: str, limit: int = 20):
    """Get messages from a space"""
    # Get space info
    try:
        info = await client.get_group(space_id)
        space_name = info.get("name", space_id)
    except Exception:
        space_name = space_id

    print(f"\n{'=' * 60}")
    print(f" Messages from: {space_name}")
    print(f" Space ID: {space_id}")
    print(f"{'=' * 60}\n")

    messages = await client.get_messages(space_id, limit)

    if not messages:
        print("No messages found.")
        return

    print(f"Found {len(messages)} messages:\n")

    for msg in messages:
        ts = msg.get("timestamp") or "Unknown time"
        sender = msg.get("sender") or "Unknown"
        text = msg.get("text", "")

        # Truncate long messages
        if len(text) > 300:
            text = text[:300] + "..."

        print(f"[{ts}]")
        if sender != "Unknown":
            print(f"From: {sender}")
        print(f"{text}")
        print("-" * 40)


async def cmd_get_messages_paginated(
    client: GoogleChatClient,
    space_id: str,
    pages: int = 1,
    page_size: int = 25,
):
    """Get paginated messages with thread support"""
    try:
        info = await client.get_group(space_id)
        space_name = info.get("name", space_id)
    except Exception:
        space_name = space_id

    print(f"\n{'=' * 60}")
    print(f" Paginated Messages from: {space_name}")
    print(f" Space ID: {space_id}")
    print(f" Fetching {pages} page(s) of {page_size} topics each")
    print(f"{'=' * 60}\n")

    if pages == 1:
        result = await client.get_messages_paginated(space_id, page_size=page_size)
    else:
        messages = await client.get_all_messages(
            space_id, max_pages=pages, page_size=page_size
        )
        result = {"messages": messages, "total_messages": len(messages)}

    messages = result.get("messages", [])

    if not messages:
        print("No messages found.")
        return

    print(f"Found {len(messages)} messages:\n")

    # Group by topic for display
    topics = {}
    for msg in messages:
        topic_id = msg.get("topic_id") or "unknown"
        if topic_id not in topics:
            topics[topic_id] = []
        topics[topic_id].append(msg)

    for topic_id, topic_msgs in topics.items():
        # Sort by timestamp within topic
        topic_msgs.sort(key=lambda m: m.get("timestamp_usec") or 0)

        print(f"\n[THREAD: {topic_id[:30] if topic_id else 'N/A'}...]")
        print("=" * 50)

        for msg in topic_msgs:
            ts = msg.get("timestamp") or "Unknown"
            sender = msg.get("sender") or msg.get("sender_email") or ""
            text = msg.get("text", "")
            is_reply = msg.get("is_thread_reply", False)

            prefix = "  ↳ " if is_reply else ""

            if len(text) > 200:
                text = text[:200] + "..."

            print(f"{prefix}[{ts}] {sender}")
            print(f"{prefix}{text}")
            print("-" * 40)

    if result.get("has_more"):
        print(f"\n[More messages available. Next cursor: {result.get('next_cursor')}]")


async def cmd_search_spaces(client: GoogleChatClient, query: str):
    """Search for spaces by name"""
    print(f"\nSearching for spaces matching '{query}'...")
    matches = await client.search_spaces(query)

    if not matches:
        print("No matching spaces found.")
        return

    print(f"\nFound {len(matches)} matching spaces:\n")
    for s in matches:
        name = s.get("name") or "(unnamed)"
        print(f"  {s['id']}  {name}  [{s['type']}]")


async def cmd_search_in_space(client: GoogleChatClient, space_id: str, query: str):
    """Search messages in a specific space"""
    print(f"\nSearching for '{query}' in space {space_id}...")

    matches = await client.search_in_space(space_id, query)

    if not matches:
        print("No matching messages found.")
        return

    print(f"\nFound {len(matches)} matching messages:\n")
    for msg in matches:
        ts = msg.get("timestamp") or "Unknown"
        snippet = msg.get("snippet", msg.get("text", "")[:100])
        print(f"[{ts}] {snippet}")
        print("-" * 40)


async def cmd_search_all(client: GoogleChatClient, query: str):
    """Search messages across all spaces"""
    print(f"\nSearching for '{query}' across all spaces...")
    print("(This may take a moment...)\n")

    matches = await client.search_all_spaces(query)

    if not matches:
        print("No matching messages found.")
        return

    print(f"\nFound {len(matches)} matching messages:\n")
    for msg in matches:
        space = msg.get("space_name") or msg.get("space_id", "Unknown")
        ts = msg.get("timestamp") or "Unknown"
        snippet = msg.get("snippet", "")

        print(f"[{space}] [{ts}]")
        print(f"  {snippet}")
        print("-" * 40)


async def cmd_server_search(client: GoogleChatClient, query: str, space_id: str = None):
    """Server-side search using batchexecute API"""
    if space_id:
        print(f"\nServer searching for '{query}' in space {space_id}...")
    else:
        print(f"\nServer searching for '{query}' across all spaces...")
    print("(Using Google Chat's native search API...)\n")

    matches = await client.server_search(query, space_id)

    if not matches:
        print("No matching messages found.")
        return

    print(f"\nFound {len(matches)} matching messages:\n")
    for msg in matches:
        source = msg.get("source", "")
        space = msg.get("space_name") or msg.get("space_id", "")
        ts = msg.get("timestamp") or ""
        snippet = msg.get("snippet", msg.get("text", "")[:150])

        header = []
        if space:
            header.append(f"[{space}]")
        if ts:
            header.append(f"[{ts}]")
        if source:
            header.append(f"({source})")

        if header:
            print(" ".join(header))
        print(f"  {snippet}")
        print("-" * 40)


async def interactive_menu(client: GoogleChatClient):
    """Interactive menu for the client"""
    while True:
        print("\n" + "=" * 50)
        print(" GOOGLE CHAT CLIENT")
        print("=" * 50)
        print("\n1. List all spaces")
        print("2. Get messages from a space")
        print("3. Get messages (paginated with threads)")
        print("4. Search for a space by name")
        print("5. Search messages in a space (local)")
        print("6. Search messages in all spaces (local)")
        print("7. Server-side search (batchexecute API)")
        print("8. Add a space manually")
        print("9. Exit")

        choice = input("\nEnter choice (1-9): ").strip()

        if choice == "1":
            await cmd_list_spaces(client)

        elif choice == "2":
            space_id = input("Enter space ID: ").strip()
            if space_id:
                limit = input("Number of messages (default 20): ").strip()
                limit = int(limit) if limit.isdigit() else 20
                await cmd_get_messages(client, space_id, limit)

        elif choice == "3":
            space_id = input("Enter space ID: ").strip()
            if space_id:
                pages = input("Number of pages (default 1): ").strip()
                pages = int(pages) if pages.isdigit() else 1
                page_size = input("Topics per page (default 25): ").strip()
                page_size = int(page_size) if page_size.isdigit() else 25
                await cmd_get_messages_paginated(client, space_id, pages, page_size)

        elif choice == "4":
            query = input("Enter search term: ").strip()
            if query:
                await cmd_search_spaces(client, query)

        elif choice == "5":
            space_id = input("Enter space ID: ").strip()
            query = input("Enter search term: ").strip()
            if space_id and query:
                await cmd_search_in_space(client, space_id, query)

        elif choice == "6":
            query = input("Enter search term: ").strip()
            if query:
                await cmd_search_all(client, query)

        elif choice == "7":
            query = input("Enter search term: ").strip()
            if query:
                space_id = (
                    input("Limit to space ID (press Enter for all): ").strip() or None
                )
                await cmd_server_search(client, query, space_id)

        elif choice == "8":
            space_id = input("Enter space ID (e.g., AAAAHKvY2CQ): ").strip()
            if space_id:
                name = input("Enter space name (optional): ").strip() or None
                client.add_space(space_id, name)
                print(f"Added space: {space_id}")
                try:
                    info = await client.get_group(space_id)
                    actual_name = info.get("name", "Unknown")
                    print(f"Space name from API: {actual_name}")
                    if actual_name != "Unknown":
                        client.add_space(space_id, actual_name)
                except Exception as e:
                    print(f"Could not verify space: {e}")

        elif choice == "9":
            print("\nGoodbye!")
            break

        else:
            print("Invalid choice. Please enter 1-9.")


async def main():
    """Main entry point"""
    print("=== Google Chat Client ===\n")

    # Try cached cookies first, refresh if auth fails
    cookies = None
    client = None
    auth_attempts = 0

    while auth_attempts < 2:
        auth_attempts += 1
        force_refresh = auth_attempts > 1

        # Get cookies (cached or fresh)
        try:
            if force_refresh:
                print("\nRefreshing cookies and auth from Chrome...")
                invalidate_cookie_cache()
                invalidate_auth_cache()
            cookies = get_all_cookies(force_refresh=force_refresh)
            if not force_refresh:
                print(f"Using cached cookies ({len(cookies)} cookies)")
        except Exception as e:
            print(f"Cookie extraction failed: {e}")
            print("\nMake sure you're logged into Google Chat in Chrome.")
            return 1

        # Check required cookies
        required = ["SID", "HSID", "SSID", "OSID"]
        missing = [name for name in required if name not in cookies]
        if missing:
            if auth_attempts == 1:
                print(f"Cached cookies missing required fields, refreshing...")
                continue
            print(f"\nMissing required cookies: {', '.join(missing)}")
            return 1

        client = GoogleChatClient(cookies)

        try:
            # Authenticate (will use cache if available)
            cached_auth = _load_auth_cache()
            if cached_auth and not force_refresh:
                print("Authenticating (using cached auth)...")
            else:
                print("Authenticating (fetching from server)...")
            await client.refresh_tokens(force_refresh=force_refresh)
            print("Authentication successful!")
            break  # Success, exit the retry loop

        except Exception as auth_err:
            await client.close()
            if auth_attempts == 1:
                print(f"Auth failed with cached data: {auth_err}")
                print("Will retry with fresh cookies and auth...")
                continue
            else:
                print(f"\nAuthentication failed: {auth_err}")
                print("\nMake sure you're logged into Google Chat in Chrome.")
                return 1

    try:
        # Parse command line args
        args = sys.argv[1:]

        if not args:
            # Interactive mode
            await interactive_menu(client)

        elif args[0] == "spaces":
            await cmd_list_spaces(client)

        elif args[0] == "messages" and len(args) > 1:
            space_id = args[1]
            limit = int(args[2]) if len(args) > 2 else 20
            await cmd_get_messages(client, space_id, limit)

        elif args[0] == "search" and len(args) > 1:
            query = " ".join(args[1:])
            await cmd_search_all(client, query)

        elif args[0] == "server-search" and len(args) > 1:
            query = " ".join(args[1:])
            await cmd_server_search(client, query)

        elif args[0] == "find-space" and len(args) > 1:
            query = " ".join(args[1:])
            await cmd_search_spaces(client, query)

        else:
            # Assume it's a space ID
            space_id = args[0]
            await cmd_get_messages(client, space_id)

        return 0

    except Exception as e:
        print(f"\nError: {e}")
        import traceback

        traceback.print_exc()
        return 1

    finally:
        await client.close()


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code or 0)
