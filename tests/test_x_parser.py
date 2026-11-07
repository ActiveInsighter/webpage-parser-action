import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from webpage_parser.cli import main
from webpage_parser.crawl import build_result, crawl_page
from webpage_parser.x import extract_x_posts, select_x_content, status_identity


def card(post_id, text='正文', handle='alice', extra=''):
    return f'''<article data-testid="tweet"><div data-testid="User-Name">{handle}</div>
<a href="/{handle}/status/{post_id}"><time datetime="2026-11-07T01:02:03Z">Nov 7</time></a>
<div data-testid="tweetText">{text}</div>{extra}</article>'''


def response(html, status=200):
    return SimpleNamespace(html=html, status_code=status, redirected_url=None, success=status < 400,
                           error_message='', markdown=None, screenshot=None)


class IdentityTests(unittest.TestCase):
    def test_status_aliases_tracking_and_media_suffix(self):
        for url in ('https://twitter.com/alice/status/123?s=20', 'https://x.com/alice/status/123/photo/2',
                    'https://mobile.x.com/alice/status/123/video/1', 'https://x.com/i/web/status/123'):
            self.assertEqual(status_identity(url)['id'], '123')
        for url in ('https://evil.test/alice/status/123', 'https://x.com/alice/status/123junk',
                    'https://x.com/alice', 'https://x.com/alice/status/123/likes'):
            self.assertIsNone(status_identity(url))

    def test_reply_target_after_parent_and_limit(self):
        html = card('111', 'parent') + card('222', 'reply') + card('333', 'neighbour')
        posts, target, error = select_x_content(html, 'https://x.com/alice/status/222', max_posts=1)
        self.assertIsNone(error)
        self.assertEqual([p['id'] for p in posts], ['222'])
        self.assertEqual(target['text'], 'reply')
        self.assertEqual(target['relation'], 'target')

    def test_missing_target_never_returns_parent_or_quote(self):
        html = card('111', 'parent', extra=card('222', 'quoted'))
        posts, target, error = select_x_content(html, 'https://x.com/alice/status/222', scope='visible')
        self.assertEqual(posts, [])
        self.assertIsNone(target)
        self.assertEqual(error, 'target_not_found')

    def test_quote_text_media_identity_and_metrics_are_isolated(self):
        quote = '<div data-testid="quoteTweet">' + card('222', 'quote', extra='''
<img src="https://pbs.twimg.com/media/quote.jpg"><div role="group" aria-label="999 likes"></div>''') + '</div>'
        html = card('111', 'own', extra=quote + '<div role="group" aria-label="1 reply, 2 reposts, 3 likes"></div>')
        post = extract_x_posts(html)[0]
        self.assertEqual(post['text'], 'own')
        self.assertEqual(post['images'], [])
        self.assertEqual(post['metrics'], {'replies': 1, 'reposts': 2, 'likes': 3})
        self.assertEqual(post['quoted_urls'], ['https://x.com/alice/status/222'])
        self.assertEqual(len(extract_x_posts(html)), 1)

    def test_preserves_cjk_emoji_and_newlines(self):
        post = extract_x_posts(card('111', '中<span>文</span><br>line  two <img alt="😀" src="emoji.svg">'))[0]
        self.assertEqual(post['text'], '中文\nline  two 😀')

    def test_quote_only_post_is_valid(self):
        html = card('111', extra='<div data-testid="quoteTweet">' + card('222') + '</div>')
        html = html.replace('<div data-testid="tweetText">正文</div>', '', 1)
        self.assertEqual(extract_x_posts(html)[0]['id'], '111')

    def test_visible_scope_target_first_and_deduplicated(self):
        html = card('111') + card('222') + card('222') + card('333')
        posts, _, _ = select_x_content(html, 'https://x.com/alice/status/222', max_posts=3, scope='visible')
        self.assertEqual([p['id'] for p in posts], ['222', '111', '333'])
        self.assertEqual([p['relation'] for p in posts], ['target', 'visible', 'visible'])
        self.assertIsNone(posts[1]['is_reply'])  # Page order is not a parent-child relationship.

    def test_wrong_page_is_failure_even_if_http_200(self):
        result = build_result(response(card('111')), 'https://x.com/alice/status/222', 'body', '', 'x', 1)
        self.assertFalse(result['success'])
        self.assertEqual(result['error_code'], 'target_not_found')
        self.assertEqual(result['count'], 0)

    def test_options_validation_and_failed_database_write(self):
        with tempfile.TemporaryDirectory() as folder:
            out = str(Path(folder) / 'result.json')
            for options in ('[]', '{"unknown":"x"}', '{"transport":false}', '{"request_id":"bad\\nvalue"}'):
                self.assertEqual(main(['--url', 'https://example.com', '--options', options, '--output', out]), 1)
                self.assertFalse(json.loads(Path(out).read_text())['success'])
            with patch('webpage_parser.cli.PocketBaseStore') as store, patch('webpage_parser.cli.crawl_urls', new=AsyncMock(return_value=[{'success': True, 'count': 1, 'items': ['x']}])):
                store.return_value.save.side_effect = RuntimeError('write failed')
                code = main(['--url', 'https://example.com', '--options', '{"save_to":"pocketbase","owner":"aaaaaaaaaaaaaaa"}', '--output', out])
            result = json.loads(Path(out).read_text())
            self.assertEqual(code, 1)
            self.assertTrue(result['crawl_success'])
            self.assertEqual(result['storage']['status'], 'failed')


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_auto_uses_http_without_starting_browser(self):
        crawler = SimpleNamespace(arun=AsyncMock())
        with patch('webpage_parser.crawl.fetch_http', return_value=response(card('222'))):
            result = await crawl_page(crawler, 'https://x.com/alice/status/222', transport='auto')
        self.assertTrue(result['success'])
        self.assertEqual(result['transport'], 'http')
        crawler.arun.assert_not_called()

    async def test_auto_falls_back_only_if_target_missing(self):
        crawler = SimpleNamespace(arun=AsyncMock(return_value=response(card('111') + card('222'))))
        with patch('webpage_parser.crawl.fetch_http', return_value=response(card('111'))):
            result = await crawl_page(crawler, 'https://x.com/alice/status/222', transport='auto')
        self.assertEqual(result['target']['id'], '222')
        self.assertEqual(result['transport'], 'browser')
        crawler.arun.assert_awaited_once()

    async def test_429_does_not_start_browser_fallback(self):
        crawler = SimpleNamespace(arun=AsyncMock())
        with patch('webpage_parser.crawl.fetch_http', return_value=response('', 429)):
            result = await crawl_page(crawler, 'https://x.com/alice/status/222', transport='auto', retries=0)
        self.assertFalse(result['success'])
        crawler.arun.assert_not_called()
