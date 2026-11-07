"""Crawl one page into a structured result, over anonymous HTTP or a fresh Chromium context."""
import asyncio
import platform
from contextlib import AsyncExitStack, asynccontextmanager
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path
from urllib.parse import urlsplit

from bs4 import BeautifulSoup

from .extract import extract
from .fetch import TRANSIENT_STATUSES, LazyBrowser, fetch_http, save_evidence
from .options import validate_options
from .x import X_HOSTS, select_x_content, status_identity


# Interstitials that stand in for the page: a bot check answers instead of the site.
CHALLENGE_TITLES = ("just a moment...", "attention required! | cloudflare", "access denied")
CHALLENGE_MARKERS = ("challenges.cloudflare.com", "/cdn-cgi/challenge-platform/", "cf-chl-", "_cf_chl_opt")


def is_bot_challenge(crawled):
    """Whether the response is an anti-bot check rather than the page (Cloudflare and the like)."""
    if "anti-bot" in (getattr(crawled, "error_message", "") or "").lower():
        return True
    html = crawled.html or ""
    title = BeautifulSoup(html[:20000], "html.parser").title
    if title and (title.get_text() or "").strip().lower() in CHALLENGE_TITLES:
        return True
    head = html[:50000]
    return any(marker in head for marker in CHALLENGE_MARKERS)


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
    markdown = getattr(crawled.markdown, "raw_markdown", "") if crawled.markdown else ""
    if mode != "x" and selector.strip() == "body" and not attribute and markdown.strip():
        # A whole page reads better with its headings, lists and links than as flattened text.
        result["markdown"] = markdown
    if mode == "x":
        posts, target, error_code = select_x_content(html, url, max_posts, x_scope)
        result.update(posts=posts, target=target, target_status_id=(status_identity(url) or {}).get("id"),
                      x_scope=x_scope, items=[post["text"] for post in posts], count=len(posts), source="x-" + transport,
                      coverage="visible_only", warnings=["Anonymous preview only; completeness of replies is not guaranteed."])
        result["success"] = ok and bool(posts)
        if error_code:
            result["error_code"] = error_code
    if is_bot_challenge(crawled):
        # Whatever was parsed belongs to the check page, not the site.
        result.update(success=False, error_code="blocked", items=[], count=0)
        if mode == "x":
            result.update(posts=[], target=None)
    if not result["success"]:
        soup = BeautifulSoup(html, "html.parser")
        for node in soup.select("script, style, noscript"):
            node.decompose()
        result["diagnostics"] = {
            "error": crawled.error_message or (
                "The site answered with an anti-bot check instead of the page." if result.get("error_code") == "blocked" else None
            ) or (
                "Requested X status was not found in public cards; inspect evidence for login, unavailable content or layout changes."
                if mode == "x" and ok else "Browser navigation failed or returned an HTTP error."
            ),
            "page_text_preview": soup.get_text(" ", strip=True)[:1500],
        }
    return result


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
        # A bot check over HTTP meets the browser too: it answers by network address, not client.
        if transport == "http" or http_result["success"] or crawled.status_code == 429 or http_result.get("error_code") == "blocked":
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


@asynccontextmanager
async def browser_session():
    """One lazily started Chromium shared by every page of a batch; closed when the batch ends."""
    async with AsyncExitStack() as stack:
        yield LazyBrowser(stack)


async def crawl_safely(crawler, url, evidence=None, **options):
    """Crawl one page within a time budget; any failure becomes a failed result, never an exception."""
    budget = (options.get("timeout", 30) * 3 + options.get("delay", 3) + 30) * (options.get("retries", 2) + 1)
    try:
        async with asyncio.timeout(budget):
            return await crawl_page(crawler, url, evidence=evidence, **options)
    except TimeoutError:
        return {"requested_url": url, "success": False, "count": 0, "items": [],
                "error_code": "timeout", "diagnostics": {"error": f"Crawl exceeded its {budget:.0f} s budget"}}
    except Exception as error:
        return {"requested_url": url, "success": False, "count": 0, "items": [],
                "diagnostics": {"error": f"{type(error).__name__}: {error}"}}


async def crawl_urls(urls, evidence_dir, **options):
    # Start Chromium only when HTTP cannot extract the target, or it is explicitly requested.
    async with browser_session() as crawler:
        return [await crawl_safely(crawler, url, evidence=Path(evidence_dir) / ("page" if len(urls) == 1 else f"page-{index:02d}"), **options)
                for index, url in enumerate(urls, 1)]
