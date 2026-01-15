#!/usr/bin/env python3
"""
Fetch Google Chat messages using mautrix-googlechat library approach
"""

import asyncio
import json
import os
import sys

# Add local maugclib and site-packages
script_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, script_dir)
sys.path.insert(0, os.path.expanduser("~/Library/Python/3.14/lib/python/site-packages"))

import browser_cookie3
import aiohttp

# Import local maugclib
try:
    from maugclib import client, http_utils, googlechat_pb2

    HAS_MAUTRIX = True
    print("Using local maugclib")
except ImportError as e:
    HAS_MAUTRIX = False
    print(f"maugclib import failed: {e}")


TARGET_SPACE_ID = os.environ.get("SPACE_ID", "AAAAHKvY2CQ")


def get_cookies():
    """Extract ALL cookies from Chrome for google.com domains"""
    cookies = {}
    cj = browser_cookie3.chrome(domain_name=".google.com")

    for cookie in cj:
        # Get all Google-related cookies
        if cookie.domain and "google.com" in cookie.domain:
            # For cookies that exist on multiple domains, prefer specific ones
            if cookie.name == "OSID":
                if cookie.domain == "chat.google.com":
                    cookies[cookie.name] = cookie.value
            elif cookie.name == "COMPASS":
                if cookie.domain == "chat.google.com" or cookie.name not in cookies:
                    cookies[cookie.name] = cookie.value
            elif cookie.name not in cookies:
                cookies[cookie.name] = cookie.value

    return cookies


async def main_mautrix():
    """Use mautrix client if available"""
    cookies = get_cookies()

    print("Cookies found:")
    for k in ["SID", "HSID", "SSID", "OSID", "COMPASS"]:
        print(f"  {k}: {'OK' if k in cookies else 'MISSING'}")

    if not all(k in cookies for k in ["SID", "HSID", "SSID", "OSID", "COMPASS"]):
        print("\nMissing required cookies!")
        return

    # Create Cookies namedtuple
    auth_cookies = http_utils.Cookies(
        compass=cookies.get("COMPASS", ""),
        ssid=cookies.get("SSID", ""),
        sid=cookies.get("SID", ""),
        osid=cookies.get("OSID", ""),
        hsid=cookies.get("HSID", ""),
    )

    # Create client
    gc = client.Client(auth_cookies)

    print("\nRefreshing tokens...")
    try:
        await gc.refresh_tokens()
        print(f"XSRF Token: {gc.xsrf_token[:30]}...")
    except Exception as e:
        print(f"Token refresh failed: {e}")
        return

    # Get self user status
    print("\n--- Self User Status ---")
    try:
        request = googlechat_pb2.GetSelfUserStatusRequest(
            request_header=gc.gc_request_header
        )
        response = await gc.proto_get_self_user_status(request)
        print(f"User: {response}")
    except Exception as e:
        print(f"Error: {e}")

    # Get paginated world (list of conversations)
    print("\n--- Conversations ---")
    try:
        request = googlechat_pb2.PaginatedWorldRequest(
            request_header=gc.gc_request_header,
            fetch_from_user_spaces=50,
            fetch_from_user_dms=50,
        )
        response = await gc.proto_paginated_world(request)

        # Extract spaces from response
        for world in response.world_items:
            if world.HasField("room"):
                room = world.room
                space_id = (
                    room.room_id.space_id
                    if room.room_id.HasField("space_id")
                    else "N/A"
                )
                name = room.name or "Unnamed"
                marker = " ← TARGET" if space_id == TARGET_SPACE_ID else ""
                print(f"  {name} ({space_id}){marker}")
            elif world.HasField("dm"):
                dm = world.dm
                print(f"  DM: {dm}")

    except Exception as e:
        print(f"Error: {e}")
        import traceback

        traceback.print_exc()

    # Get messages from target space
    print(f"\n--- Messages from {TARGET_SPACE_ID} ---")
    try:
        group_id = googlechat_pb2.GroupId(space_id=TARGET_SPACE_ID)
        request = googlechat_pb2.ListTopicsRequest(
            request_header=gc.gc_request_header, group_id=group_id, page_size=20
        )
        response = await gc.proto_list_topics(request)

        print(f"Found {len(response.topics)} topics")

        for topic in response.topics[:10]:
            # Get the first message in the topic
            if topic.HasField("message"):
                msg = topic.message
                text = msg.text_body[:100] if msg.text_body else "(no text)"
                creator = (
                    msg.creator.name if msg.creator.HasField("name") else "Unknown"
                )
                print(f"\n[{creator}]:")
                print(f"  {text}")

    except Exception as e:
        print(f"Error: {e}")
        import traceback

        traceback.print_exc()

    # Clean up
    await gc._session.close()


async def main_basic():
    """Basic approach without mautrix"""
    print("Using basic HTTP approach (no protobuf)")

    cookies = get_cookies()

    print("Cookies found:")
    for k in ["SID", "HSID", "SSID", "OSID", "COMPASS"]:
        print(f"  {k}: {'OK' if k in cookies else 'MISSING'}")

    # Build cookie string
    cookie_str = "; ".join(f"{k}={v}" for k, v in cookies.items())

    headers = {
        "Cookie": cookie_str,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Connection": "Keep-Alive",
    }

    async with aiohttp.ClientSession() as session:
        # Get XSRF token
        print("\nFetching XSRF token...")

        params = {
            "origin": "https://mail.google.com",
            "shell": "9",
            "hl": "en",
            "wfi": "gtn-roster-iframe-id",
            "hs": '["h_hs",null,null,[1,0],null,null,"gmail.pinto-server_20230730.06_p0",1,null,[15,38,36,35,26,30,41,18,24,11,21,14,6],null,null,"3Mu86PSulM4.en..es5",0,null,null,[0]]',
        }

        async with session.get(
            "https://chat.google.com/u/0/mole/world", params=params, headers=headers
        ) as resp:
            print(f"Response: {resp.status}")

            if resp.status != 200:
                print(f"Failed to get XSRF token: {resp.status}")
                return

            text = await resp.text()

            import re

            match = re.search(
                r">window\.WIZ_global_data = ({.+?});</script>", text, re.DOTALL
            )
            if not match:
                print("No WIZ_global_data found")
                return

            wiz_data = json.loads(match.group(1))

            if wiz_data.get("qwAQke") == "AccountsSignInUi":
                print("Not logged in!")
                return

            xsrf_token = wiz_data.get("SMqcke")
            print(f"XSRF Token: {xsrf_token[:30]}...")

        print("\nAPI calls require protobuf format - install mautrix-googlechat:")
        print("  pip3 install --user --break-system-packages mautrix-googlechat")


if __name__ == "__main__":
    if HAS_MAUTRIX:
        asyncio.run(main_mautrix())
    else:
        asyncio.run(main_basic())
