"""An isolated PocketBase running the crawl schema and hooks vendored from AnyWorkflow-workers."""
import json
import os
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'tests/fixtures/pocketbase'
BINARY = os.getenv('POCKETBASE_BINARY') or shutil.which('pocketbase') or '/opt/pocketbase/pocketbase'
AVAILABLE = Path(BINARY).is_file()
CLIENTS_MIGRATION = '''migrate((app) => app.save(new Collection({
    name: 'aw_clients', type: 'auth', passwordAuth: {enabled: true, identityFields: ['email']}
})), (app) => app.delete(app.findCollectionByNameOrId('aw_clients')));'''


class PocketBaseServer:
    """Starts on construction; call `stop()` (or register it as a class cleanup)."""

    def __init__(self):
        self.temp = tempfile.TemporaryDirectory(prefix='webpage-parser-pb-')
        folder = Path(self.temp.name)
        migrations, hooks = folder / 'migrations', folder / 'hooks'
        migrations.mkdir()
        (migrations / '1000000000_clients.js').write_text(CLIENTS_MIGRATION)
        shutil.copytree(FIXTURES / 'pb_migrations', migrations, dirs_exist_ok=True)
        shutil.copytree(FIXTURES / 'pb_hooks', hooks)
        command = [BINARY, '--dir=' + str(folder / 'data'), '--migrationsDir=' + str(migrations),
                   '--hooksDir=' + str(hooks), '--hooksWatch=false', '--automigrate=false']
        subprocess.run(command + ['migrate', 'up'], capture_output=True, check=True)
        password = secrets.token_urlsafe(24)
        subprocess.run(command + ['superuser', 'upsert', 'test@example.invalid', password], capture_output=True, check=True)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        self.base = 'http://127.0.0.1:' + str(port)
        self.log = (folder / 'server.log').open('w')
        self.process = subprocess.Popen(command + ['serve', '--http=127.0.0.1:' + str(port)], stdout=self.log, stderr=self.log)
        for _ in range(200):
            try:
                if self.api('GET', '/api/health')[0] == 200:
                    break
            except OSError:
                pass
            time.sleep(.05)
        else:
            self.stop()
            raise RuntimeError('Isolated PocketBase did not become healthy')
        code, auth = self.api('POST', '/api/collections/_superusers/auth-with-password',
                              {'identity': 'test@example.invalid', 'password': password})
        assert code == 200, auth
        self.admin = auth['token']

    def api(self, method, path, body=None, token=None):
        request = Request(self.base + path, data=json.dumps(body).encode() if body is not None else None, method=method,
                          headers={'Content-Type': 'application/json', **({'Authorization': token} if token else {})})
        try:
            with urlopen(request, timeout=5) as response:
                return response.status, json.loads(response.read() or b'null')
        except HTTPError as error:
            with error:
                return error.code, json.loads(error.read() or b'null')

    def user(self, collection, email, **fields):
        """Create an account and return (record id, token)."""
        password = secrets.token_urlsafe(24)
        code, record = self.api('POST', f'/api/collections/{collection}/records',
                                {'email': email, 'password': password, 'passwordConfirm': password, **fields}, self.admin)
        assert code == 200, record
        code, auth = self.api('POST', f'/api/collections/{collection}/auth-with-password', {'identity': email, 'password': password})
        assert code == 200, auth
        return record['id'], auth['token']

    def stop(self):
        if getattr(self, 'process', None):
            self.process.terminate()
            self.process.wait(timeout=10)
            self.process = None
        if getattr(self, 'log', None):
            self.log.close()
        self.temp.cleanup()
