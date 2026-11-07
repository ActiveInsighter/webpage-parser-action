import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import requests
from soupsieve import SelectorSyntaxError

from parser import extract, fetch_page, main


HTML = '''<!doctype html><html><head><meta charset="utf-8"><title>测试页面</title></head>
<body><script>unwanted</script><style>unwanted</style><main>
<h1>  Hello <span>世界</span> </h1><a class="link" href="../news"> 新闻 </a>
<a class="link" href="https://example.org">Other</a><a>Missing attribute</a>
</main></body></html>'''.encode()


class Handler(BaseHTTPRequestHandler):
    attempts = 0

    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/pages/index")
            self.end_headers()
            return
        if self.path == "/flaky":
            type(self).attempts += 1
            if type(self).attempts == 1:
                self.send_error(503)
                return
        if self.path == "/missing":
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json" if self.path == "/json" else "text/html")
        self.end_headers()
        self.wfile.write(HTML)


class ParserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def test_unicode_and_clean_text(self):
        result = fetch_page(self.url, "h1")
        self.assertEqual(result["title"], "测试页面")
        self.assertEqual(result["items"], ["Hello 世界"])
        self.assertNotIn("unwanted", extract(HTML, self.url, "body")["items"][0])

    def test_redirect_and_relative_links(self):
        result = fetch_page(self.url + "/redirect", "a", "href")
        self.assertEqual(result["final_url"], self.url + "/pages/index")
        self.assertEqual(result["items"], [self.url + "/news", "https://example.org"])
        self.assertEqual(result["count"], 2)

    def test_base_and_multi_value_attribute(self):
        html = b'<base href="https://example.org/assets/"><a class="a b" href="item">x</a>'
        self.assertEqual(extract(html, self.url, "a", "href")["items"], ["https://example.org/assets/item"])
        self.assertEqual(extract(html, self.url, "a", "class")["items"], ["a b"])

    def test_empty_matches(self):
        self.assertEqual(fetch_page(self.url, ".absent")["items"], [])

    def test_retry_transient_error(self):
        Handler.attempts = 0
        self.assertEqual(fetch_page(self.url + "/flaky", retries=1)["status_code"], 200)
        self.assertEqual(Handler.attempts, 2)

    def test_http_error_and_non_html(self):
        with self.assertRaises(requests.HTTPError):
            fetch_page(self.url + "/missing")
        with self.assertRaisesRegex(ValueError, "not HTML"):
            fetch_page(self.url + "/json")

    def test_input_validation(self):
        for kwargs in ({"url": "file:///etc/hosts"}, {"url": "https://user:pass@example.com"},
                       {"timeout": -1}, {"timeout": float("nan")}, {"retries": 6}, {"selector": ""}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                fetch_page(**({"url": self.url} | kwargs))
        with self.assertRaises(SelectorSyntaxError):
            fetch_page(self.url, "[")

    def test_response_size_limit(self):
        with patch("parser.MAX_BYTES", 10), self.assertRaisesRegex(ValueError, "10 MiB"):
            fetch_page(self.url)

    def test_cli_output_and_failed_run_removes_stale_result(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {}, clear=True):
            target = Path(folder) / "result.json"
            output = Path(folder) / "github-output"
            os.environ["GITHUB_OUTPUT"] = str(output)
            main(["--url", self.url, "--selector", "h1", "--output", str(target)])
            self.assertEqual(json.loads(target.read_text())["items"], ["Hello 世界"])
            self.assertEqual(output.read_text(), "count=1\n")
            with self.assertRaises(SystemExit) as raised:
                main(["--url", self.url + "/missing", "--output", str(target)])
            self.assertEqual(raised.exception.code, 1)
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
