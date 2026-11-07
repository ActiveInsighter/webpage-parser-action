"""Exercise the actual migrations, hooks, REST API, permissions and writer against isolated PocketBase."""
import secrets
import unittest
from unittest.mock import patch

from pocketbase_server import AVAILABLE, PocketBaseServer
from webpage_parser.storage import PocketBaseStore, StorageError, content_rows


class ConfigTests(unittest.TestCase):
    def test_reject_invalid_storage_configuration(self):
        for url, token, owner in [('http://example.com', 'secret', 'a'*15), ('https://u:p@example.com', 'secret', 'a'*15),
                                  ('https://example.com/path', 'secret', 'a'*15), ('https://example.com', '', 'a'*15),
                                  ('https://example.com', 'secret', 'bad"owner')]:
            with self.assertRaises(ValueError):
                PocketBaseStore(url, token, owner)

    def test_rows_keep_columns_out_of_metadata_and_prefer_page_markdown(self):
        from test_x_parser import card, response
        from webpage_parser.crawl import build_result
        post = build_result(response(card('777')), 'https://x.com/alice/status/777', 'body', '', 'x', 1)
        [row] = content_rows(post, 'a' * 15, 'social_media', 'req', 'b' * 15, 'c' * 15)
        self.assertEqual((row['target'], row['run'], row['externalId'], row['content']), ('b' * 15, 'c' * 15, '777', '正文'))
        self.assertFalse({'text', 'images', 'url', 'id'} & row['metadata'].keys())
        self.assertEqual(row['metadata']['relation'], 'target')
        page = {'mode': 'page', 'requested_url': 'https://example.com/', 'final_url': 'https://example.com/', 'title': 'T',
                'fetched_at': '2026-11-07T00:00:00+00:00', 'items': ['flat text'], 'count': 1, 'selector': 'body',
                'attribute': None, 'markdown': '# Heading'}
        [web] = content_rows(page, 'a' * 15)
        self.assertEqual((web['content'], web['metadata']['format']), ('# Heading', 'markdown'))
        self.assertNotIn('target', web)
        self.assertEqual(content_rows({**page, 'markdown': ''}, 'a' * 15)[0]['content'], 'flat text')


@unittest.skipUnless(AVAILABLE, 'Set POCKETBASE_BINARY to run real database tests')
class PocketBaseIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = PocketBaseServer()
        cls.addClassCleanup(cls.server.stop)
        cls.base, cls.admin, cls.api = cls.server.base, cls.server.admin, cls.server.api
        cls.owners, cls.tokens = [], []
        for label in ['one', 'two']:
            owner, token = cls.server.user('aw_clients', label + '@example.invalid')
            cls.owners.append(owner)
            cls.tokens.append(token)

    def test_service_identity_writes_only_crawl_collection(self):
        password = secrets.token_urlsafe(24)
        status, record = self.api('POST', '/api/collections/aw_crawler_services/records', {
            'email': 'crawler@example.invalid', 'password': password, 'passwordConfirm': password,
            'verified': True, 'label': 'test writer'}, self.admin)
        self.assertEqual(status, 200, record)
        status, auth = self.api('POST', '/api/collections/aw_crawler_services/auth-with-password', {
            'identity': 'crawler@example.invalid', 'password': password})
        self.assertEqual(status, 200, auth)
        token = auth['token']
        writer = PocketBaseStore(self.base, token, self.owners[0])
        saved = writer.save(self.page('666'))
        rid = saved['record_ids'][0]
        self.assertEqual(writer.save(self.page('666'))['record_ids'], [rid])
        self.assertEqual(self.api('GET', '/api/collections/aw_crawled_contents/records/' + rid, token=self.tokens[0])[0], 200)
        self.assertIn(self.api('DELETE', '/api/collections/aw_crawled_contents/records/' + rid, token=token)[0], (403, 404))
        self.assertEqual(self.api('GET', '/api/collections/aw_clients/records', token=token)[0], 403)
        self.assertEqual(self.api('GET', '/api/collections', token=token)[0], 403)
        self.assertEqual(self.api('POST', '/api/collections/aw_crawler_services/records', {
            'email': 'forged@example.invalid', 'password': password, 'passwordConfirm': password})[0], 403)
        self.assertEqual(self.api('PATCH', '/api/collections/aw_crawler_services/records/' + record['id'], {'verified': True}, token)[0], 403)

    def page(self, post_id=None):
        from webpage_parser.crawl import build_result
        from test_x_parser import card, response
        return build_result(response(card(post_id or secrets.randbelow(10**16))),
                            'https://x.com/alice/status/' + str(post_id or '123'), 'body', '', 'x', 1)

    def test_save_update_dedup_and_owner_isolation(self):
        page = self.page('222')
        first = PocketBaseStore(self.base, self.tokens[0], self.owners[0])
        second = PocketBaseStore(self.base, self.tokens[1], self.owners[1])
        saved = first.save(page, 'social_media', 'request-one')
        again = first.save(page, '社交媒体', 'request-two')
        self.assertEqual(saved['record_ids'], again['record_ids'])
        rid = saved['record_ids'][0]
        path = '/api/collections/aw_crawled_contents/records/' + rid
        code, row = self.api('GET', path, token=self.tokens[0])
        self.assertEqual(code, 200, row)
        self.assertEqual(row['type'], '社交媒体')
        self.assertEqual(row['source'], page['requested_url'])
        self.assertEqual(row['content'], '正文')
        self.assertEqual(row['requestId'], 'request-two')
        self.assertEqual(self.api('GET', path, token=self.tokens[1])[0], 404)
        self.assertIn(self.api('GET', path)[0], (403, 404))
        for fields in ({'owner': self.owners[1]}, {'dedupeKey': 'a'*64}, {'externalId': '999'}, {'platform': 'web'}):
            self.assertIn(self.api('PATCH', path, fields, self.tokens[0])[0], (400, 404))
        self.assertNotEqual(second.save(page)['record_ids'], saved['record_ids'])
        forged = PocketBaseStore(self.base, self.tokens[0], self.owners[1])
        with self.assertRaises(StorageError):
            forged.save(self.page('333'))

    def test_failed_crawl_never_persists(self):
        store = PocketBaseStore(self.base, self.tokens[0], self.owners[0])
        with patch.object(store, 'request') as request:
            self.assertEqual(store.save({'success': False})['status'], 'skipped')
            request.assert_not_called()

    def test_concurrent_insert_conflict_reconciles(self):
        store = PocketBaseStore(self.base, self.tokens[0], self.owners[0])
        page = self.page('444')
        saved = store.save(page)
        real_find = store.find
        calls = 0
        def find(key):
            nonlocal calls
            calls += 1
            return None if calls == 1 else real_find(key)
        with patch.object(store, 'find', side_effect=find):
            self.assertEqual(store.save(page)['record_ids'], saved['record_ids'])

    def test_invalid_credentials_fail_without_leaking_token(self):
        token = 'test-secret-never-export'
        store = PocketBaseStore(self.base, token, self.owners[0])
        with self.assertRaises(StorageError) as failure:
            store.save(self.page('555'))
        self.assertNotIn(token, str(failure.exception))
