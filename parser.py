"""Render webpages with Crawl4AI and extract CSS content or public X posts."""

import argparse
import asyncio
import base64
import json
import math
import os
import re
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup
from soupsieve import compile as compile_selector

X_HOSTS = {"x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"}
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


def extract_x_posts(html, max_posts=5):
    """Only count rendered tweet cards with their own timestamp permalink."""
    soup = BeautifulSoup(html, "html.parser")
    posts, seen = [], set()
    for card in soup.select('article'):
        avatar = card.select_one('[data-post-avatar] a[href]')
        if card.get("data-testid") != "tweet" and avatar is None:
            continue
        timestamp = card.select_one("time[datetime]")
        link = timestamp.find_parent("a", href=True) if timestamp else None
        if link is None and avatar:
            # X's newer logged-out layout has date links instead of <time>.
            for candidate in card.select('a[data-base-ui-tooltip-trigger][href*="/status/"]'):
                if candidate["href"].startswith(avatar["href"] + "/status/") and "Views" not in candidate.get_text():
                    link = candidate
                    break
        match = re.fullmatch(r"/([^/]+)/status/(\d+)(?:[/?].*)?", link["href"]) if link else None
        if not match or match[2] in seen:
            continue
        text = card.select_one('[data-testid="tweetText"], div[dir="auto"].whitespace-pre-wrap')
        images = list(dict.fromkeys(image["src"] for image in card.select('img[src]')
                                   if urlsplit(image["src"]).hostname == "pbs.twimg.com"
                                   and urlsplit(image["src"]).path.startswith("/media/")))
        if text is None and not images and not card.select_one('video, [data-testid="videoPlayer"]'):
            continue
        author = card.select_one('[data-testid="User-Name"]')
        posts.append({
            "id": match[2], "url": f"https://x.com/{match[1]}/status/{match[2]}",
            "handle": "@" + match[1],
            "author": author.get_text(" ", strip=True) if author else "@" + match[1],
            "text": text.get_text(" ", strip=True) if text else "",
            "posted_at": timestamp["datetime"] if timestamp else None,
            "posted_at_text": link.get_text(" ", strip=True), "images": images,
        })
        engagement = card.select_one('[role="group"][aria-label]')
        if engagement:
            posts[-1]["metrics"] = {label: int(number) for number, label in re.findall(
                r"(\d+) (replies|reposts|likes|bookmarks|views)", engagement["aria-label"])}
        seen.add(match[2])
        if len(posts) >= max_posts:
            break
    return posts


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


def build_result(crawled, url, selector, attribute, mode, max_posts):
    html = crawled.html or ""
    final_url = crawled.redirected_url or url
    parsed = extract(html, final_url, selector, attribute)
    status = getattr(crawled, "redirected_status_code", None) or crawled.status_code
    ok = bool(crawled.success) and bool(status) and status < 400
    result = {
        "engine": {"name": "Crawl4AI", "version": version("crawl4ai")},
        "mode": mode, "success": ok, "requested_url": url, "final_url": final_url,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "status_code": status, "selector": selector,
        "attribute": attribute or None, **parsed, "count": len(parsed["items"]),
    }
    if mode == "x":
        posts = extract_x_posts(html, max_posts)
        result.update(posts=posts, items=[post["text"] for post in posts], count=len(posts), source="x-browser")
        result["success"] = ok and bool(posts)
    if not result["success"]:
        soup = BeautifulSoup(html, "html.parser")
        for node in soup.select("script, style, noscript"):
            node.decompose()
        result["diagnostics"] = {
            "error": crawled.error_message or (
                "No rendered X post cards found; inspect HTML/screenshot for login, unavailable post or error page."
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
                     mode="auto", wait_for="", delay=3, max_posts=5, evidence=None):
    from crawl4ai import CacheMode, CrawlerRunConfig

    validate_options(url, selector, timeout, retries, mode, wait_for, delay, max_posts)
    if mode == "auto":
        mode = "x" if urlsplit(url).hostname in X_HOSTS else "page"
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
    return build_result(crawled, url, selector, attribute, mode, max_posts)


async def crawl_urls(urls, evidence_dir, **options):
    from crawl4ai import AsyncWebCrawler, BrowserConfig

    browser = BrowserConfig(headless=True, ignore_https_errors=False, verbose=False,
                            viewport_width=1280, viewport_height=900)
    results = []
    async with AsyncWebCrawler(config=browser, base_directory=str(Path.cwd())) as crawler:
        for index, url in enumerate(urls, 1):
            page = Path(evidence_dir) / ("page" if len(urls) == 1 else f"page-{index:02d}")
            try:
                budget = (options["timeout"] * 2 + options["delay"] + 20) * (options["retries"] + 1)
                async with asyncio.timeout(budget):
                    result = await crawl_page(crawler, url, evidence=page, **options)
            except Exception as error:
                result = {"requested_url": url, "success": False, "count": 0,
                          "items": [], "diagnostics": {"error": f"{type(error).__name__}: {error}"}}
            results.append(result)
    return results


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
    cli.add_argument("--max-posts", type=int, default=5)
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
        if not 1 <= len(urls) <= 10:
            raise ValueError("provide between 1 and 10 URLs, separated by newlines")
        for url in urls:
            validate_options(url, args.selector, args.timeout, args.retries,
                             args.mode, args.wait_for, args.delay, args.max_posts)
        pages = asyncio.run(crawl_urls(
            urls, selector=args.selector, attribute=args.attribute, timeout=args.timeout,
            retries=args.retries, mode=args.mode, wait_for=args.wait_for,
            delay=args.delay, max_posts=args.max_posts, evidence_dir=output.parent,
        ))
    except Exception as error:
        pages = [{"success": False, "count": 0, "diagnostics": {"error": f"{type(error).__name__}: {error}"}}]
    result = pages[0] if len(pages) == 1 else {
        "success": all(page["success"] for page in pages),
        "count": sum(page["count"] for page in pages), "results": pages,
    }
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if os.getenv("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as handle:
            handle.write(f"count={result['count']}\n")
    if os.getenv("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as handle:
            handle.write(f"Crawl4AI: success={result['success']}, extracted items={result['count']}. See JSON, Markdown, HTML and screenshot artifacts.\n")
    print(f"Crawl4AI: success={result['success']}, items={result['count']}, output={output}")
    return 0 if result["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
