#!/usr/bin/env python3
"""Extract Google cookies from Chrome and output as JSON"""

import browser_cookie3
import json
import sys


def get_google_cookies():
    """Extract Google cookies from Chrome"""
    cookies = {}

    try:
        cj = browser_cookie3.chrome(domain_name=".google.com")

        for cookie in cj:
            # Store by name, preferring certain domains
            key = cookie.name

            # For OSID, prefer chat.google.com domain
            if key == "OSID":
                if cookie.domain == "chat.google.com" or key not in cookies:
                    cookies[key] = cookie.value
            # For most cookies, prefer .google.com
            elif cookie.domain == ".google.com" or key not in cookies:
                cookies[key] = cookie.value

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return None

    return cookies


if __name__ == "__main__":
    cookies = get_google_cookies()
    if cookies:
        print(json.dumps(cookies))
    else:
        sys.exit(1)
