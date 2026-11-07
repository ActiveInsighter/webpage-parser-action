"""Page fetchers: bounded anonymous HTTP, and a Chromium context started only when needed."""
import asyncio
import base64
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


MAX_RESPONSE_BYTES = 20 * 1024 * 1024
TRANSIENT_STATUSES = {429, 500, 502, 503, 504}


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


def save_evidence(crawled, prefix):
    prefix = Path(prefix)
    prefix.parent.mkdir(parents=True, exist_ok=True)
    prefix.with_suffix(".html").write_text(crawled.html or "", encoding="utf-8")
    markdown = crawled.markdown.raw_markdown if crawled.markdown else ""
    prefix.with_suffix(".md").write_text(markdown, encoding="utf-8")
    if crawled.screenshot:
        prefix.with_suffix(".png").write_bytes(base64.b64decode(crawled.screenshot))


def install_browser():
    """Install Chromium and its system libraries on first use (GitHub runners allow sudo)."""
    subprocess.run([sys.executable, "-m", "playwright", "install", "--with-deps", "chromium"],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=600)


class LazyBrowser:
    """Starts Chromium on the first page that needs it. With WEBPAGE_PARSER_INSTALL_BROWSER=1 the
    browser itself is installed then too, so runs whose pages all succeed over HTTP skip it."""

    def __init__(self, stack):
        self.stack = stack
        self.crawler = None
        self.installed = os.getenv("WEBPAGE_PARSER_INSTALL_BROWSER") != "1"

    async def arun(self, **kwargs):
        from crawl4ai import AsyncWebCrawler, BrowserConfig

        if self.crawler is None:
            if not self.installed:
                # Attempt once per batch: a failed install fails the remaining browser pages fast.
                self.installed = True
                await asyncio.to_thread(install_browser)
            browser = BrowserConfig(headless=True, ignore_https_errors=False, verbose=False,
                                    viewport_width=1280, viewport_height=900)
            self.crawler = await self.stack.enter_async_context(AsyncWebCrawler(config=browser, base_directory=str(Path.cwd())))
        return await self.crawler.arun(**kwargs)
