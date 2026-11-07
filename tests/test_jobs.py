"""Run mode against the real crawl hooks: load a run, store contents, report targets, honour cancels."""
import asyncio
import hashlib
import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch

from pocketbase_server import AVAILABLE, FIXTURES, PocketBaseServer
from test_x_parser import card, response
from webpage_parser.crawl import build_result
from webpage_parser.jobs import crawl_arguments, outcome_for, run_job
from webpage_parser.pocketbase import PocketBaseClient, StorageError

PAGE_URL = 'https://example.com/news'
POST_URL = 'https://x.com/alice/status/888'
BROKEN_URL = 'https://example.com/forbidden'


def page_result(url, html='<html><head><title>新闻</title></head><body><main>今日要闻</main></body></html>', status=200, mode='page'):
    return build_result(response(html, status), url, 'body', '', mode, 1, 'target', 'http')


async def fake_crawl(crawler, url, **arguments):
    """Stands in for the network: the hooks, storage and reports are what these tests exercise."""
    if url == POST_URL:
        return page_result(url, card('888', text='帖子正文'), mode='x')
    if url == BROKEN_URL:
        return page_result(url, 'Forbidden', status=403)
    return page_result(url)


class ArgumentTests(unittest.TestCase):
    def test_target_options_map_to_crawl_arguments(self):
        self.assertEqual(crawl_arguments({'mode': 'x', 'options': {'xScope': 'visible', 'maxPosts': 5, 'delay': 0}}), {
            'mode': 'x', 'retries': 2, 'selector': 'body', 'attribute': '', 'wait_for': '', 'delay': 0.0,
            'timeout': 30.0, 'x_scope': 'visible', 'max_posts': 5, 'transport': 'auto'})
        for options in ({'cookie': 'x'}, {'delay': True}, {'selector': ['a']}, []):
            with self.assertRaises(ValueError):
                crawl_arguments({'options': options})

    def test_outcomes_carry_codes_not_content(self):
        item = {'target': 't' * 15}
        failed = outcome_for(item, page_result(BROKEN_URL, status=403))
        self.assertEqual((failed['status'], failed['errorCode']), ('failed', 'http_403'))
        empty = outcome_for(item, {**page_result(PAGE_URL), 'count': 0, 'items': []})
        self.assertEqual(empty['errorCode'], 'no_match')
        saved = outcome_for(item, page_result(PAGE_URL), {'record_ids': ['r' * 15]})
        self.assertEqual((saved['status'], saved['itemCount'], saved['recordIds'], saved['title']), ('succeeded', 1, ['r' * 15], '新闻'))
        self.assertNotIn('今日要闻', json.dumps(saved, ensure_ascii=False))
        storage = outcome_for(item, page_result(PAGE_URL), failure=('storage_failed', 'PocketBase POST failed (HTTP 400)'))
        self.assertEqual((storage['status'], storage['errorCode']), ('failed', 'storage_failed'))


class FixtureTests(unittest.TestCase):
    @unittest.skipUnless(os.getenv('WORKERS_DIR'), 'Set WORKERS_DIR to compare the vendored schema with AnyWorkflow-workers')
    def test_vendored_schema_matches_workers(self):
        manifest = json.loads((FIXTURES / 'SOURCE.json').read_text())
        source = Path(os.environ['WORKERS_DIR']) / 'pocketbase'
        for name, checksum in manifest['files'].items():
            self.assertEqual(hashlib.sha256((FIXTURES / name).read_bytes()).hexdigest(), checksum, name)
            self.assertEqual((source / name).read_bytes(), (FIXTURES / name).read_bytes(),
                             f'{name} differs from AnyWorkflow-workers; run scripts/sync_pocketbase_fixtures.py')


@unittest.skipUnless(AVAILABLE, 'Set POCKETBASE_BINARY to run real database tests')
class RunJobTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = PocketBaseServer()
        cls.addClassCleanup(cls.server.stop)
        cls.owner, cls.owner_token = cls.server.user('aw_clients', 'owner@example.invalid')
        _, service_token = cls.server.user('aw_crawler_services', 'crawler@example.invalid', verified=True)
        cls.client = PocketBaseClient(cls.server.base, service_token)

    def api(self, method, path, body=None, token=None):
        code, payload = self.server.api(method, path, body, token or self.owner_token)
        self.assertLess(code, 300, payload)
        return payload

    def target(self, url, **fields):
        return self.api('POST', '/api/collections/aw_crawl_targets/records', {'owner': self.owner, 'url': url, **fields})['id']

    def dispatched_run(self, targets):
        run = self.api('POST', '/api/collections/aw_crawl_runs/records', {'owner': self.owner, 'targets': targets})
        # The scheduler's executor marks a run pending once GitHub accepts the dispatch.
        self.api('PATCH', f'/api/collections/aw_crawl_runs/records/{run["id"]}', {'status': 'pending'}, self.server.admin)
        return run['id']

    def run_job(self, run_id):
        lines = []
        with patch('webpage_parser.jobs.crawl_safely', new=fake_crawl):
            outcomes = asyncio.run(run_job(run_id, self.client, log=lines.append, sleep=lambda _: None))
        return outcomes, lines

    def test_a_run_stores_contents_reports_targets_and_settles(self):
        page, post, broken = self.target(PAGE_URL, contentType='新闻'), self.target(POST_URL), self.target(BROKEN_URL)
        run_id = self.dispatched_run([page, post, broken])
        outcomes, lines = self.run_job(run_id)
        self.assertEqual([outcome['status'] for outcome in outcomes], ['succeeded', 'succeeded', 'failed'])
        self.assertTrue(lines and not any('example.com' in line or 'x.com' in line for line in lines), 'logs never name a URL')

        run = self.api('GET', f'/api/collections/aw_crawl_runs/records/{run_id}')
        self.assertEqual((run['reportedCount'], run['succeededCount'], run['itemCount']), (3, 2, 2))
        self.assertEqual(run['results'][broken]['errorCode'], 'http_403')
        rows = self.api('GET', '/api/collections/aw_crawled_contents/records?perPage=10&sort=created')['items']
        by_target = {row['target']: row for row in rows}
        self.assertEqual(by_target[page]['type'], '新闻')
        self.assertEqual(by_target[page]['run'], run_id)
        self.assertEqual(by_target[post]['type'], 'social_media')
        self.assertEqual(by_target[post]['content'], '帖子正文')
        self.assertEqual(run['results'][post]['recordIds'], [by_target[post]['id']])
        target = self.api('GET', f'/api/collections/aw_crawl_targets/records/{page}')
        self.assertEqual((target['lastStatus'], target['pageTitle'], target['lastItemCount']), ('succeeded', '新闻', 1))

        settled = self.api('POST', f'/api/anyworkflow/crawl/runs/{run_id}/settle', {'conclusion': 'failure'}, self.server.admin)
        self.assertEqual(settled, {'status': 'partial'})
        # A second crawl of the same content updates it in place and keeps its change time.
        again = self.dispatched_run([page])
        self.run_job(again)
        row = self.api('GET', f'/api/collections/aw_crawled_contents/records/{by_target[page]["id"]}')
        self.assertEqual((row['run'], row['changedAt']), (again, by_target[page]['changedAt']))

    def test_a_cancel_stops_after_the_current_target(self):
        first, second = self.target('https://example.com/first'), self.target('https://example.com/second')
        run_id = self.dispatched_run([first, second])
        real_report = self.client.request

        def cancel_after_first(method, path, body=None):
            # The owner cancels while the first target is being crawled; its report learns of it.
            if path.endswith('/report'):
                self.api('POST', f'/api/anyworkflow/crawl/runs/{run_id}/cancel')
            return real_report(method, path, body)

        with patch.object(self.client, 'request', side_effect=cancel_after_first):
            outcomes, lines = self.run_job(run_id)
        self.assertEqual(len(outcomes), 1)
        self.assertIn('canceled', lines[-1])

    def test_a_finished_or_foreign_run_is_left_alone(self):
        run = self.api('POST', '/api/collections/aw_crawl_runs/records', {'owner': self.owner, 'targets': [self.target('https://example.com/queued')]})
        self.assertEqual(self.run_job(run['id'])[0], [], 'a run the scheduler has not dispatched is not crawled')
        with self.assertRaises(StorageError):
            self.run_job('zzzzzzzzzzzzzzz')
        with self.assertRaises(ValueError):
            self.run_job('../../etc')
