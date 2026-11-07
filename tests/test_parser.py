import asyncio
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from parser import build_result, crawl_page, crawl_urls, extract, extract_x_posts, main, validate_options


LEGACY_POST = '''<article data-testid="tweet"><div data-testid="User-Name">Alice @alice</div>
<a href="/alice/status/123"><time datetime="2026-11-07T00:00:00Z">Nov 7</time></a>
<div data-testid="tweetText">Hello <span>世界</span></div>
<div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/photo.jpg"></div></article>'''
NEW_POST = '''<article class="group/post"><div data-post-avatar="true"><a href="/NASA">NASA</a></div>
<div dir="auto" class="whitespace-pre-wrap">Hello, Moon.</div>
<a href="/NASA/status/456/photo/1">Photo</a>
<a data-base-ui-tooltip-trigger href="/NASA/status/456">4:41 PM · Apr 7, 2026</a>
<a data-base-ui-tooltip-trigger href="/NASA/status/456">123 Views</a>
<div role="group" aria-label="12 replies, 34 reposts, 56 likes, 78 bookmarks, 123 views"></div>
<img src="https://pbs.twimg.com/media/moon.jpg"></article>'''


def crawled(html="<title>Test</title><body>Hello</body>", status=200, success=True):
    return SimpleNamespace(html=html, redirected_url=None, status_code=status, success=success,
                           error_message="", markdown=None, screenshot=None)


class ExtractionTests(unittest.TestCase):
    def test_text_unicode_and_excluded_nodes(self):
        html = '<title>测试</title><body><script>bad</script><style>bad</style><h1>Hello <b>世界</b></h1></body>'
        self.assertEqual(extract(html, "https://example.com", "body"), {"title": "测试", "items": ["Hello 世界"]})

    def test_attributes_and_base(self):
        html = '<base href="https://example.org/assets/"><a href="item" class="a b">x</a><a>missing</a>'
        self.assertEqual(extract(html, "https://example.com", "a", "href")["items"], ["https://example.org/assets/item"])
        self.assertEqual(extract(html, "https://example.com", "a", "class")["items"], ["a b"])

    def test_x_legacy_layout_and_deduplication(self):
        posts = extract_x_posts(LEGACY_POST * 2)
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0]["text"], "Hello 世界")
        self.assertEqual(posts[0]["posted_at"], "2026-11-07T00:00:00Z")
        self.assertEqual(posts[0]["url"], "https://x.com/alice/status/123")

    def test_x_new_logged_out_layout(self):
        post = extract_x_posts(NEW_POST)[0]
        self.assertEqual(post["id"], "456")
        self.assertEqual(post["handle"], "@NASA")
        self.assertEqual(post["text"], "Hello, Moon.")
        self.assertIsNone(post["posted_at"])
        self.assertEqual(post["posted_at_text"], "4:41 PM · Apr 7, 2026")
        self.assertEqual(post["metrics"]["likes"], 56)
        self.assertEqual(len(post["images"]), 1)

    def test_x_limit(self):
        self.assertEqual(len(extract_x_posts(NEW_POST + LEGACY_POST, 1)), 1)

    def test_login_and_unavailable_pages_are_failures(self):
        for html in ('<body>Log in to X</body>', '<article>Something went wrong</article>'):
            result = build_result(crawled(html), "https://x.com/NASA", "body", "", "x", 5)
            self.assertFalse(result["success"])
            self.assertEqual(result["count"], 0)
            self.assertIn("diagnostics", result)

    def test_http_error_not_success_even_with_cards(self):
        result = build_result(crawled(NEW_POST, 403), "https://x.com/NASA", "body", "", "x", 5)
        self.assertFalse(result["success"])

    def test_validation(self):
        defaults = dict(url="https://example.com", selector="body", timeout=30, retries=2,
                        mode="auto", wait_for="", delay=3, max_posts=5)
        for change in ({"url": "file:///etc/hosts"}, {"url": "https://u:p@example.com"},
                       {"timeout": float("nan")}, {"timeout": 0}, {"retries": 6},
                       {"delay": -1}, {"max_posts": 0}, {"mode": "x"}, {"selector": ""}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_options(**(defaults | change))

    def test_cli_batch_and_github_output(self):
        pages = [{"success": True, "count": 1}, {"success": False, "count": 0}]
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {}, clear=True):
            target = Path(folder) / "result.json"
            target.write_text('{"stale":true}')
            evidence = Path(folder) / "page.png"
            evidence.write_bytes(b"stale")
            os.environ["GITHUB_OUTPUT"] = str(Path(folder) / "outputs")
            with patch("parser.crawl_urls", new=AsyncMock(return_value=pages)) as crawl:
                status = main(["--url", "https://x.com/jack/status/20\nhttps://x.com/NASA", "--output", str(target)])
                self.assertEqual(crawl.call_args.args[0], ["https://x.com/jack/status/20", "https://x.com/NASA"])
            self.assertEqual(status, 1)
            self.assertEqual(json.loads(target.read_text())["count"], 1)
            self.assertFalse(evidence.exists())
            self.assertIn("count=1\n", Path(os.environ["GITHUB_OUTPUT"]).read_text())

    def test_bad_input_leaves_diagnostic_not_stale_success(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "result.json"
            target.write_text('{"success":true}')
            self.assertEqual(main(["--url", "file:///etc/hosts", "--output", str(target)]), 1)
            self.assertFalse(json.loads(target.read_text())["success"])


class CrawlerTests(unittest.IsolatedAsyncioTestCase):
    async def test_retry_only_transient_errors(self):
        crawler = SimpleNamespace(arun=AsyncMock(side_effect=[crawled(status=503), crawled()]))
        with patch("parser.asyncio.sleep", new=AsyncMock()):
            result = await crawl_page(crawler, "https://example.com", retries=1)
        self.assertTrue(result["success"])
        self.assertEqual(crawler.arun.await_count, 2)

    async def test_no_retries_for_login_wall(self):
        crawler = SimpleNamespace(arun=AsyncMock(return_value=crawled("Log in")))
        result = await crawl_page(crawler, "https://x.com/NASA/status/456", retries=2)
        self.assertFalse(result["success"])
        self.assertEqual(crawler.arun.await_count, 1)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/page")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write('''<title>动态页面</title><div id="content">Loading</div>
        <p>This local integration fixture serves a normal document with enough visible text
        to exercise browser rendering, rather than a challenge or placeholder page. The link
        below is created asynchronously so extraction must wait for JavaScript to finish.</p>
        <script>setTimeout(() => {document.querySelector('#content').innerHTML =
        '<a class="ready" href="/news">Rendered 世界</a>';}, 100);</script>'''.encode())


class BrowserIntegrationTests(unittest.TestCase):
    def test_real_crawl4ai_renders_javascript_and_saves_evidence(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as folder:
                url = f"http://127.0.0.1:{server.server_port}"
                results = asyncio.run(crawl_urls(
                    [url + "/redirect"], selector=".ready", attribute="", timeout=10,
                    retries=0, mode="page", wait_for=".ready", delay=0,
                    max_posts=5, evidence_dir=folder,
                ))
                result = results[0]
                self.assertTrue(result["success"], result)
                self.assertEqual(result["items"], ["Rendered 世界"])
                self.assertEqual(result["final_url"], url + "/page")
                self.assertEqual(result["engine"]["name"], "Crawl4AI")
                self.assertTrue(Path(folder, "page.png").exists())
                self.assertIn("Rendered 世界", Path(folder, "page.html").read_text())
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
