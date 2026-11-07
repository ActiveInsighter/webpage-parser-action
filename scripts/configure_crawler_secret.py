#!/usr/bin/env python3
"""Create/refresh a restricted PocketBase crawler identity and GitHub secret.

Existing root-only backend credentials bootstrap the writer. Only its restricted
JWT is sent to GitHub. No credentials are printed, passed as CLI args or committed.
"""
import json
import os
import secrets
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = 'http://127.0.0.1:8091'
REPO = 'ActiveInsighter/webpage-parser-action'
STATE = Path('/etc/anyworkflow/webpage-crawler.json')


def request(method, path, data=None, token=''):
    req = Request(ROOT + path, data=json.dumps(data).encode() if data is not None else None,
                  headers={'Content-Type': 'application/json', **({'Authorization': token} if token else {})}, method=method)
    try:
        with urlopen(req, timeout=15) as response:
            return json.loads(response.read() or b'null')
    except HTTPError as error:
        error.close()
        raise RuntimeError('PocketBase credential setup failed (HTTP ' + str(error.code) + ')') from None


def admin_token():
    for line in Path('/opt/anyworkflow-workers/deploy/.env').read_text().splitlines():
        key, _, value = line.partition('=')
        if key.strip() == 'POCKETBASE_SERVER_TOKEN':
            return value.strip().strip('"\'')
    raise RuntimeError('Existing backend server credential not found')


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run with sudo -n python3 scripts/configure_crawler_secret.py')
    if STATE.exists():
        state = json.loads(STATE.read_text())
    else:
        state = {'email': 'webpage-parser@services.anyworkflow.invalid', 'password': secrets.token_urlsafe(40)}
        STATE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(STATE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as out:
            json.dump(state, out)
    admin = admin_token()
    # Look up by the fixed service email; retrying setup reuses the same identity.
    from urllib.parse import urlencode
    query = urlencode({'filter': 'email="' + state['email'] + '"'})
    rows = request('GET', '/api/collections/aw_crawler_services/records?' + query, token=admin)['items']
    if not rows:
        request('POST', '/api/collections/aw_crawler_services/records', {
            'email': state['email'], 'password': state['password'], 'passwordConfirm': state['password'],
            'verified': True, 'label': 'webpage-parser GitHub Actions'}, admin)
    auth = request('POST', '/api/collections/aw_crawler_services/auth-with-password', {
        'identity': state['email'], 'password': state['password']})
    token = auth['token']
    # Verify the service token cannot enumerate application clients or collections.
    for path in ['/api/collections', '/api/collections/aw_clients/records']:
        try:
            payload = request('GET', path, token=token)
        except RuntimeError:
            continue
        if isinstance(payload, dict) and payload.get('items') == []:
            continue  # Owner-filtered collections can return an empty list.
        raise RuntimeError('Crawler identity has unexpected access outside crawl content')
    result = subprocess.run(['runuser', '-u', 'dev', '--', '/home/dev/.local/bin/gh', 'secret', 'set', 'WEBPAGE_POCKETBASE_TOKEN', '--repo', REPO],
                            input=token, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError('Failed to configure the GitHub secret: ' + result.stderr.replace(token, '[REDACTED]')[:800])
    state.update(recordId=auth['record']['id'], configuredAt=datetime.now(timezone.utc).isoformat())
    STATE.write_text(json.dumps(state) + '\n')
    os.chmod(STATE, 0o600)
    print(json.dumps({'status': 'configured', 'secret': 'WEBPAGE_POCKETBASE_TOKEN', 'repository': REPO,
                      'identity': 'aw_crawler_services', 'expiresInDays': 365}))


if __name__ == '__main__':
    main()
