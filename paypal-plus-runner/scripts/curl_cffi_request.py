#!/usr/bin/env python3
import json
import sys
import time


def fail(message, error_type="Error"):
    print(json.dumps({
        "ok": False,
        "error": str(message),
        "errorType": error_type,
    }, ensure_ascii=True))
    return 1


def main():
    try:
        from curl_cffi import requests
    except Exception as exc:
        return fail(f"curl_cffi is not available: {exc}", type(exc).__name__)

    try:
        payload = json.load(sys.stdin)
    except Exception as exc:
        return fail(f"invalid stdin json: {exc}", type(exc).__name__)

    url = str(payload.get("url") or "").strip()
    if not url:
        return fail("url is required", "ValueError")

    method = str(payload.get("method") or "GET").upper()
    headers = payload.get("headers") or {}
    body = payload.get("body", None)
    proxy_url = str(payload.get("proxyUrl") or "").strip()
    timeout_seconds = max(1.0, float(payload.get("timeoutSeconds") or 45))
    impersonate = str(payload.get("impersonate") or "").strip() or None

    options = {
        "headers": headers,
        "timeout": timeout_seconds,
    }
    if proxy_url:
        options["proxy"] = proxy_url
    if impersonate:
        options["impersonate"] = impersonate
    if body is not None:
        options["data"] = str(body)

    started_at = time.perf_counter()
    try:
        response = requests.request(method, url, **options)
    except Exception as exc:
        return fail(str(exc), type(exc).__name__)

    duration_ms = int((time.perf_counter() - started_at) * 1000)
    print(json.dumps({
        "ok": True,
        "status": int(response.status_code or 0),
        "urlEffective": str(response.url or ""),
        "remoteIp": "",
        "text": response.text,
        "durationMs": duration_ms,
        "impersonate": impersonate or "",
    }, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
