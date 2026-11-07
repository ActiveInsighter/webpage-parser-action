"""PocketBase persistence, scoped by owner and stable platform/content identity."""
import hashlib
import json
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

COLLECTION = 'aw_crawled_contents'


class StorageError(RuntimeError):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward database credentials to a redirect destination.


class PocketBaseStore:
    def __init__(self, url, token, owner, timeout=30):
        parsed = urlsplit(url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError('pocketbase-url must be an absolute URL without credentials')
        if parsed.query or parsed.fragment or parsed.path not in ('', '/'):
            raise ValueError('pocketbase-url must be an origin without a path, query or fragment')
        if parsed.scheme != 'https' and parsed.hostname not in ('127.0.0.1', 'localhost', '::1'):
            raise ValueError('pocketbase-url requires HTTPS except on localhost')
        if not token or not re.fullmatch(r'[a-z0-9]{15}', owner):
            raise ValueError('PocketBase persistence requires a token and a 15-character owner record ID')
        self.base, self.token, self.owner, self.timeout = url.rstrip('/'), token, owner, timeout
        self.opener = build_opener(NoRedirect())

    def request(self, method, path, body=None):
        headers = {'Authorization': self.token, 'Content-Type': 'application/json', 'Accept': 'application/json'}
        request = Request(self.base + path, data=json.dumps(body, ensure_ascii=False).encode() if body is not None else None,
                          headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                return json.loads(response.read(8 * 1024 * 1024))
        except HTTPError as error:
            error.close()
            # Do not include server bodies, URLs or credentials in exported diagnostics.
            raise StorageError(f'PocketBase {method} failed (HTTP {error.code})') from None
        except (URLError, TimeoutError, OSError, ValueError):
            raise StorageError(f'PocketBase {method} failed (connection or invalid response)') from None

    def find(self, key):
        query = urlencode({'filter': f'owner="{self.owner}" && dedupeKey="{key}"', 'perPage': 1})
        rows = self.request('GET', f'/api/collections/{COLLECTION}/records?{query}')
        return next(iter(rows.get('items', [])), None)

    def save(self, page, content_type='social_media', request_id=''):
        if not page.get('success'):
            return {'status': 'skipped', 'reason': 'crawl_failed', 'record_ids': []}
        posts = page.get('posts') if page.get('mode') == 'x' else None
        objects = posts if posts is not None else [None]
        record_ids = []
        for post in objects:
            source = page['requested_url']
            canonical = post['url'] if post else page['final_url']
            platform = 'x' if post else 'web'
            identity = 'x:' + post['id'] if post else canonical
            key = hashlib.sha256(identity.encode()).hexdigest()
            body = {
                'owner': self.owner, 'dedupeKey': key, 'type': content_type, 'platform': platform,
                'source': source, 'canonicalUrl': canonical,
                'externalId': post['id'] if post else '',
                'title': page.get('title', '')[:512],
                'content': post['text'] if post else '\n\n'.join(page['items']),
                'author': (post.get('author') or '')[:512] if post else '',
                'handle': (post.get('handle') or '') if post else '',
                'publishedAt': (post.get('posted_at') or '') if post else '',
                'fetchedAt': page['fetched_at'], 'requestId': request_id,
                'media': {'images': post['images'], 'videos': post.get('videos', [])} if post else {},
                'metrics': post.get('metrics', {}) if post else {},
                'metadata': post if post else {'selector': page['selector'], 'attribute': page['attribute']},
            }
            try:
                record = self.upsert(key, body)
            except Exception as error:
                error.record_ids = record_ids
                raise
            record_ids.append(record['id'])
        return {'status': 'saved', 'collection': COLLECTION, 'record_ids': record_ids}

    def upsert(self, key, body):
        existing = self.find(key)
        if existing:
            record = self.request('PATCH', f'/api/collections/{COLLECTION}/records/{existing["id"]}', body)
        else:
            try:
                record = self.request('POST', f'/api/collections/{COLLECTION}/records', body)
            except StorageError:
                # Reconcile concurrent creation or an accepted write whose response was lost.
                existing = self.find(key)
                if not existing:
                    raise
                record = self.request('PATCH', f'/api/collections/{COLLECTION}/records/{existing["id"]}', body)
        return record
