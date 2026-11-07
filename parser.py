"""Render webpages with Crawl4AI and extract CSS content or public X posts."""

import argparse
import asyncio
import base64
import json
import math
import os
import platform
import re
from contextlib import AsyncExitStack
from types import SimpleNamespace
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup
from soupsieve import compile as compile_selector

from x_parser import X_HOSTS, extract_x_posts, select_x_content, status_identity
from storage import PocketBaseStore

MAX_RESPONSE_BYTES = 20 * 1024 * 1024
TRANSIENT_STATUSES = {429, 500, 502, 503, 504}


def validate_url(url):
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("url must be an absolute http:// or https:// URL")
    if parsed.username or parsed.password:
        raise ValueError("URL credentials are not supported")
    return url


def extract(html, url, selector, attribute=""):
    soup = BeautifulSoup(html, "html.parser")
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


def build_result(crawled, url, selector, attribute, mode, max_posts, x_scope="target", transport="browser"):
    html = crawled.html or ""
    final_url = crawled.redirected_url or url
    parsed = extract(html, final_url, selector, attribute)
    status = getattr(crawled, "redirected_status_code", None) or crawled.status_code
    ok = bool(crawled.success) and bool(status) and status < 400
    result = {
        "engine": {"name": "urllib" if transport == "http" else "Crawl4AI",
                   "version": platform.python_version() if transport == "http" else version("crawl4ai")},
        "schema_version": 2, "transport": transport, "authenticated": False,
        "mode": mode, "success": ok, "requested_url": url, "final_url": final_url,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "status_code": status, "selector": selector,
        "attribute": attribute or None, **parsed, "count": len(parsed["items"]),
    }
    if mode == "x":
        posts, target, error_code = select_x_content(html, url, max_posts, x_scope)
        result.update(posts=posts, target=target, target_status_id=(status_identity(url) or {}).get("id"),
                      x_scope=x_scope, items=[post["text"] for post in posts], count=len(posts), source="x-" + transport,
                      coverage="visible_only", warnings=["Anonymous preview only; completeness of replies is not guaranteed."])
        result["success"] = ok and bool(posts)
        if error_code:
            result["error_code"] = error_code
    if not result["success"]:
        soup = BeautifulSoup(html, "html.parser")
        for node in soup.select("script, style, noscript"):
            node.decompose()
        result["diagnostics"] = {
            "error": crawled.error_message or (
                "Requested X status was not found in public cards; inspect evidence for login, unavailable content or layout changes."
                if mode == "x" and ok else "Browser navigation failed or returned an HTTP error."
            ),
            "page_text_preview": soup.get_text(" ", strip=True)[:1500],
        }
    return result


def save_evidence(crawled, prefix):
    prefix = Path(prefix)
    prefix.parent.mkdir(parents=True, exist_ok=True)
    prefix.with_suffix(".html").write_text(crawled.html or "", encoding="utf-8")
    markdown = crawled.markdown.raw_markdown if crawled.markdown else ""
    prefix.with_suffix(".md").write_text(markdown, encoding="utf-8")
    if crawled.screenshot:
        prefix.with_suffix(".png").write_bytes(base64.b64decode(crawled.screenshot))


async def crawl_page(crawler, url, selector="body", attribute="", timeout=30, retries=2,
                     mode="auto", wait_for="", delay=3, max_posts=1, evidence=None,
                     x_scope="target", transport="browser"):
    from crawl4ai import CacheMode, CrawlerRunConfig

    validate_options(url, selector, timeout, retries, mode, wait_for, delay, max_posts)
    if mode == "auto":
        mode = "x" if urlsplit(url).hostname in X_HOSTS else "page"
    if x_scope not in ("target", "visible") or transport not in ("auto", "http", "browser"):
        raise ValueError("invalid x-scope or transport")
    if mode == "x" and x_scope == "target" and not status_identity(url):
        raise ValueError("target scope requires a status URL; use x-scope=visible for profiles")
    if transport == "http" and wait_for:
        raise ValueError("wait-for requires the browser transport")
    if transport == "http" or (transport == "auto" and mode == "x" and not wait_for):
        crawled = await asyncio.to_thread(fetch_http, url, timeout, retries)
        http_result = build_result(crawled, url, selector, attribute, mode, max_posts, x_scope, "http")
        if evidence:
            save_evidence(crawled, evidence)
        if transport == "http" or http_result["success"] or crawled.status_code == 429:
            return http_result
    config = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS, wait_until="domcontentloaded",
        page_timeout=int(timeout * 1000), wait_for="css:" + wait_for if wait_for else None,
        wait_for_timeout=int(timeout * 1000), delay_before_return_html=delay,
        screenshot=bool(evidence), force_viewport_screenshot=True,
        verbose=False,
    )
    for attempt in range(retries + 1):
        crawled = await crawler.arun(url=url, config=config)
        transient = crawled.status_code in TRANSIENT_STATUSES or (not crawled.success and not crawled.status_code)
        if not transient or attempt == retries:
            break
        await asyncio.sleep(min(2 ** attempt, 8))
    if evidence:
        save_evidence(crawled, evidence)
    return build_result(crawled, url, selector, attribute, mode, max_posts, x_scope, "browser")


def fetch_http(url, timeout, retries):
    """Fresh anonymous requests, bounded body; no cookie jar or external proxy service."""
    import time
    for attempt in range(retries + 1):
        try:
            request = Request(url, headers={"User-Agent": "WebpageParser/2.0", "Accept": "text/html", "Accept-Language": "en"})
            try:
                response = urlopen(request, timeout=timeout)
            except HTTPError as error:
                response = error
            with response:
                status = response.code
                raw = response.read(MAX_RESPONSE_BYTES + 1)
                if len(raw) > MAX_RESPONSE_BYTES:
                    raise ValueError("HTTP response exceeds 20 MiB")
                html = raw.decode(response.headers.get_content_charset() or "utf-8", errors="replace")
                result = SimpleNamespace(html=html, status_code=status, redirected_url=response.geturl(),
                                         success=status < 400, error_message="", markdown=None, screenshot=None)
            if status not in TRANSIENT_STATUSES or attempt == retries:
                return result
        except (URLError, TimeoutError, OSError):
            if attempt == retries:
                return SimpleNamespace(html="", status_code=None, redirected_url=url, success=False,
                                       error_message="Anonymous HTTP request failed", markdown=None, screenshot=None)
        time.sleep(min(2 ** attempt, 8))


async def crawl_urls(urls, evidence_dir, **options):
    from crawl4ai import AsyncWebCrawler, BrowserConfig

    results = []
    # Start Chromium only when HTTP cannot extract the target, or it is explicitly requested.
    async with AsyncExitStack() as stack:
        class LazyBrowser:
            crawler = None

            async def arun(self, **kwargs):
                if self.crawler is None:
                    browser = BrowserConfig(headless=True, ignore_https_errors=False, verbose=False,
                                            viewport_width=1280, viewport_height=900)
                    self.crawler = await stack.enter_async_context(AsyncWebCrawler(config=browser, base_directory=str(Path.cwd())))
                return await self.crawler.arun(**kwargs)

        crawler = LazyBrowser()
        for index, url in enumerate(urls, 1):
            page = Path(evidence_dir) / ("page" if len(urls) == 1 else f"page-{index:02d}")
            try:
                budget = (options["timeout"] * 3 + options["delay"] + 30) * (options["retries"] + 1)
                async with asyncio.timeout(budget):
                    result = await crawl_page(crawler, url, evidence=page, **options)
            except Exception as error:
                result = {"requested_url": url, "success": False, "count": 0,
                          "items": [], "diagnostics": {"error": f"{type(error).__name__}: {error}"}}
            results.append(result)
    return results


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


def main(argv=None):
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--url", required=True, help="One URL, or newline-separated URLs (at most 10)")
    cli.add_argument("--selector", default="body")
    cli.add_argument("--attribute", default="")
    cli.add_argument("--timeout", type=float, default=30)
    cli.add_argument("--retries", type=int, default=2)
    cli.add_argument("--mode", choices=("auto", "page", "x"), default="auto")
    cli.add_argument("--wait-for", default="", help="Optional CSS selector to wait for")
    cli.add_argument("--delay", type=float, default=3)
    cli.add_argument("--max-posts", type=int, default=1)
    cli.add_argument("--x-scope", default="target", choices=("target", "visible"))
    cli.add_argument("--transport", default="auto", choices=("auto", "http", "browser"))
    cli.add_argument("--save-to", default="none", choices=("none", "pocketbase"))
    cli.add_argument("--content-type", default="social_media")
    cli.add_argument("--owner", default="")
    cli.add_argument("--request-id", default="")
    cli.add_argument("--options", default="{}", help="JSON overrides for workflow dispatch")
    cli.add_argument("--pocketbase-url", default=os.getenv("POCKETBASE_URL", ""))
    cli.add_argument("--output", default="results/result.json")
    args = cli.parse_args(argv)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.unlink(missing_ok=True)
    for pattern in ("page*.html", "page*.md", "page*.png"):
        for stale in output.parent.glob(pattern):
            stale.unlink()
    urls = [url.strip() for url in args.url.splitlines() if url.strip()]
    try:
        apply_json_options(args)
        store = PocketBaseStore(args.pocketbase_url, os.getenv("POCKETBASE_TOKEN", ""), args.owner) if args.save_to == "pocketbase" else None
        if not 1 <= len(urls) <= 10:
            raise ValueError("provide between 1 and 10 URLs, separated by newlines")
        for url in urls:
            validate_options(url, args.selector, args.timeout, args.retries,
                             args.mode, args.wait_for, args.delay, args.max_posts)
        pages = asyncio.run(crawl_urls(
            urls, selector=args.selector, attribute=args.attribute, timeout=args.timeout,
            retries=args.retries, mode=args.mode, wait_for=args.wait_for,
            delay=args.delay, max_posts=args.max_posts, evidence_dir=output.parent,
            x_scope=args.x_scope, transport=args.transport,
        ))
        for page in pages:
            if store:
                try:
                    page["storage"] = store.save(page, args.content_type, args.request_id)
                except Exception as error:
                    page["storage"] = {"status": "failed", "error": str(error), "record_ids": getattr(error, "record_ids", [])}
                    page["crawl_success"] = page["success"]
                    page["success"] = False
            page["request_id"] = args.request_id
    except Exception as error:
        pages = [{"success": False, "count": 0, "diagnostics": {"error": f"{type(error).__name__}: {error}"}}]
    result = pages[0] if len(pages) == 1 else {
        "schema_version": 2, "request_id": args.request_id,
        "success": all(page["success"] for page in pages),
        "count": sum(page["count"] for page in pages), "results": pages,
    }
    content = "\n\n".join("\n\n".join([page.get("requested_url", ""), *page.get("items", [])]) for page in pages)
    output.with_name("content.md").write_text(content + "\n", encoding="utf-8")
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if os.getenv("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as handle:
            handle.write(f"count={result['count']}\n")
            handle.write(f"success={str(result['success']).lower()}\n")
            ids = [rid for page in pages for rid in page.get('storage', {}).get('record_ids', [])]
            handle.write("record-ids=" + json.dumps(ids) + "\n")
            safe_request_id = args.request_id if len(args.request_id) <= 128 and not re.search(r"[\x00-\x1f]", args.request_id) else ""
            handle.write("request-id=" + safe_request_id + "\n")
    if os.getenv("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as handle:
            handle.write(f"Crawl4AI: success={result['success']}, extracted items={result['count']}. See JSON, Markdown, HTML and screenshot artifacts.\n")
    print(f"Crawl4AI: success={result['success']}, items={result['count']}, output={output}")
    return 0 if result["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
