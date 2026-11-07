"""Fetch a static HTML page and extract CSS-selected text or attributes."""

import argparse
import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from soupsieve import SelectorSyntaxError, compile as compile_selector
from urllib3.util.retry import Retry

MAX_BYTES = 10 * 1024 * 1024


def validate_url(url):
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("url must be an absolute http:// or https:// URL")
    if parsed.username or parsed.password:
        raise ValueError("URL credentials are not supported")
    return url


def extract(html, url, selector, attribute="", encoding=None):
    soup = BeautifulSoup(html, "html.parser", from_encoding=encoding)
    for element in soup.select("script, style, noscript, template"):
        element.decompose()
    base = soup.select_one("base[href]")
    base_url = urljoin(url, base["href"]) if base else url
    items = []
    for element in soup.select(selector):
        if attribute:
            value = element.get(attribute)
            if value is None:
                continue
            if isinstance(value, list):
                value = " ".join(value)
            if attribute in ("href", "src", "action"):
                value = urljoin(base_url, value)
        else:
            value = " ".join(element.get_text(" ", strip=True).split())
        items.append(value)
    return {"title": soup.title.get_text(" ", strip=True) if soup.title else "", "items": items}


def fetch_page(url, selector="body", attribute="", timeout=30, retries=2):
    validate_url(url)
    if not selector.strip():
        raise ValueError("selector must not be empty")
    compile_selector(selector)
    if not math.isfinite(timeout) or not 0 < timeout <= 120:
        raise ValueError("timeout must be between 0 (exclusive) and 120 seconds")
    if not 0 <= retries <= 5:
        raise ValueError("retries must be between 0 and 5")
    retry = Retry(
        total=retries, backoff_factor=1, status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET"}), respect_retry_after_header=False,
    )
    with requests.Session() as session:
        adapter = HTTPAdapter(max_retries=retry)
        session.mount("https://", adapter)
        session.mount("http://", adapter)
        session.headers.update({"User-Agent": "webpage-parser-action/1.0", "Accept": "text/html,application/xhtml+xml"})
        with session.get(url, timeout=timeout, stream=True) as response:
            response.raise_for_status()
            content_type = response.headers.get("Content-Type", "").lower()
            if content_type and not any(kind in content_type for kind in ("text/html", "application/xhtml+xml")):
                raise ValueError("response is not HTML")
            chunks, size = [], 0
            for chunk in response.iter_content(chunk_size=65536):
                size += len(chunk)
                if size > MAX_BYTES:
                    raise ValueError("response exceeds the 10 MiB limit")
                chunks.append(chunk)
            # Without an explicit HTTP charset, let BeautifulSoup inspect HTML metadata.
            encoding = response.encoding if "charset=" in content_type else None
            parsed = extract(b"".join(chunks), response.url, selector, attribute, encoding)
            return {
                "requested_url": url, "final_url": response.url,
                "fetched_at": datetime.now(timezone.utc).isoformat(),
                "status_code": response.status_code, "selector": selector,
                "attribute": attribute or None, **parsed, "count": len(parsed["items"]),
            }


def main(argv=None):
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--url", required=True)
    cli.add_argument("--selector", default="body")
    cli.add_argument("--attribute", default="")
    cli.add_argument("--timeout", type=float, default=30)
    cli.add_argument("--retries", type=int, default=2)
    cli.add_argument("--output", default="results/result.json")
    args = cli.parse_args(argv)
    output = Path(args.output)
    # Never leave a previous successful result after this invocation fails.
    output.unlink(missing_ok=True)
    try:
        result = fetch_page(args.url, args.selector, args.attribute, args.timeout, args.retries)
    except (requests.RequestException, ValueError, SelectorSyntaxError) as error:
        cli.exit(1, f"Fetch/parse failed ({type(error).__name__}): {error}\n")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if os.getenv("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as handle:
            handle.write(f"count={result['count']}\n")
    if os.getenv("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as handle:
            handle.write(f"Parsed page successfully. Matched items: **{result['count']}**. Download the JSON artifact for full results.\n")
    print(f"Saved {result['count']} item(s) to {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
