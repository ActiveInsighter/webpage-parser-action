import json
import math
import re
from urllib.parse import urlsplit

from soupsieve import compile as compile_selector

from .x import X_HOSTS


def validate_url(url):
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("url must be an absolute http:// or https:// URL")
    if parsed.username or parsed.password:
        raise ValueError("URL credentials are not supported")
    return url


def validate_options(url, selector, timeout, retries, mode, wait_for, delay, max_posts):
    validate_url(url)
    if not selector.strip():
        raise ValueError("selector must not be empty")
    compile_selector(selector)
    if wait_for:
        compile_selector(wait_for)
    if not math.isfinite(timeout) or not 0 < timeout <= 120:
        raise ValueError("timeout must be between 0 (exclusive) and 120 seconds")
    if not 0 <= retries <= 5:
        raise ValueError("retries must be between 0 and 5")
    if not math.isfinite(delay) or not 0 <= delay <= 30:
        raise ValueError("delay must be between 0 and 30 seconds")
    if not 1 <= max_posts <= 50:
        raise ValueError("max-posts must be between 1 and 50")
    if mode not in ("auto", "page", "x"):
        raise ValueError("mode must be auto, page or x")
    if mode == "x" and urlsplit(url).hostname not in X_HOSTS:
        raise ValueError("x mode requires an x.com or twitter.com URL")


OPTION_KEYS = {"x_scope", "transport", "save_to", "content_type", "owner", "request_id"}


def apply_json_options(args):
    try:
        options = json.loads(args.options)
    except ValueError:
        raise ValueError("options must be a JSON object") from None
    if not isinstance(options, dict) or options.keys() - OPTION_KEYS:
        raise ValueError("options contains unknown keys; allowed: " + ", ".join(sorted(OPTION_KEYS)))
    for key, value in options.items():
        if not isinstance(value, str):
            raise ValueError("options values must be strings")
        setattr(args, key, value)
    if args.x_scope not in ("target", "visible"):
        raise ValueError("x_scope must be target or visible")
    if args.transport not in ("auto", "http", "browser"):
        raise ValueError("transport must be auto, http or browser")
    if args.save_to not in ("none", "pocketbase"):
        raise ValueError("save_to must be none or pocketbase")
    if not args.content_type.strip() or len(args.content_type) > 64:
        raise ValueError("content_type must contain 1 to 64 characters")
    if len(args.request_id) > 128 or re.search(r"[\x00-\x1f]", args.request_id):
        raise ValueError("request_id must be at most 128 characters without control characters")
