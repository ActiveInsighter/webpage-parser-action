"""Exercise the actual migration, REST API, permissions and writer against isolated PocketBase."""
import json
import os
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

from storage import PocketBaseStore, StorageError

ROOT = Path(__file__).resolve().parents[1]
BINARY = os.getenv('POCKETBASE_BINARY') or shutil.which('pocketbase') or '/opt/pocketbase/pocketbase'


class ConfigTests(unittest.TestCase):
    def test_reject_invalid_storage_configuration(self):
        for url, token, owner in [('http://example.com', 'secret', 'a'*15), ('https://u:p@example.com', 'secret', 'a'*15),
                                  ('https://example.com/path', 'secret', 'a'*15), ('https://example.com', '', 'a'*15),
                                  ('https://example.com', 'secret', 'bad"owner')]:
            with self.assertRaises(ValueError):
                PocketBaseStore(url, token, owner)


@unittest.skipUnless(Path(BINARY).is_file(), 'Set POCKETBASE_BINARY to run real database tests')
class PocketBaseIntegrationTests(unittest.TestCase):
    @classmethod
    def api(cls, method, path, body=None, token=None):
        req = Request(cls.base + path, data=json.dumps(body).encode() if body is not None else None,
                      headers={'Content-Type': 'application/json', **({'Authorization': token} if token else {})}, method=method)
        try:
            with urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read() or b'null')
        except HTTPError as error:
            with error:
                return error.code, json.loads(error.read() or b'null')

    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='webpage-parser-pb-')
        cls.addClassCleanup(cls.temp.cleanup)
        folder = Path(cls.temp.name)
        migrations = folder / 'migrations'
        migrations.mkdir()
        (migrations / '1000000000_clients.js').write_text('''migrate((app) => app.save(new Collection({
            name: 'aw_clients', type: 'auth', passwordAuth: {enabled: true, identityFields: ['email']}
        })), (app) => app.delete(app.findCollectionByNameOrId('aw_clients')));''')
        shutil.copy2(ROOT / 'pocketbase/pb_migrations/1794045600_crawled_contents.js', migrations)
        cls.command = [BINARY, '--dir=' + str(folder/'data'), '--migrationsDir=' + str(migrations), '--hooksDir=' + str(folder/'hooks')]
        subprocess.run(cls.command + ['migrate', 'up'], capture_output=True, check=True)
        password = secrets.token_urlsafe(24)
        subprocess.run(cls.command + ['superuser', 'upsert', 'test@example.invalid', password], capture_output=True, check=True)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        cls.base = 'http://127.0.0.1:' + str(port)
        cls.log = (folder/'server.log').open('w')
        cls.addClassCleanup(cls.log.close)
        cls.server = subprocess.Popen(cls.command + ['serve', '--http=127.0.0.1:' + str(port)], stdout=cls.log, stderr=cls.log)
        def stop():
            cls.server.terminate()
            cls.server.wait(timeout=10)
        cls.addClassCleanup(stop)
        for _ in range(100):
            try:
                if cls.api('GET', '/api/health')[0] == 200:
                    break
            except OSError:
                pass
            time.sleep(.05)
        else:
            raise RuntimeError('Isolated PocketBase did not become healthy')
        code, auth = cls.api('POST', '/api/collections/_superusers/auth-with-password', {'identity': 'test@example.invalid', 'password': password})
        assert code == 200, auth
        cls.admin = auth['token']
        cls.owners, cls.tokens = [], []
        for label in ['one', 'two']:
            pwd = secrets.token_urlsafe(24)
            code, record = cls.api('POST', '/api/collections/aw_clients/records', {'email': label+'@example.invalid', 'password': pwd, 'passwordConfirm': pwd}, cls.admin)
            assert code == 200, record
            code, auth = cls.api('POST', '/api/collections/aw_clients/auth-with-password', {'identity': label+'@example.invalid', 'password': pwd})
            assert code == 200, auth
            cls.owners.append(record['id'])
            cls.tokens.append(auth['token'])

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
        from parser import build_result
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
