"""PocketBase persistence, scoped by owner and stable platform/content identity."""
import hashlib
import re
from urllib.parse import urlencode

from .pocketbase import PocketBaseClient, StorageError

COLLECTION = 'aw_crawled_contents'
RECORD_ID = re.compile(r'[a-z0-9]{15}')
# Post fields that already have their own column; metadata keeps only the rest.
POST_COLUMNS = {'id', 'url', 'author', 'handle', 'text', 'posted_at', 'images', 'videos', 'metrics'}

__all__ = ['COLLECTION', 'PocketBaseStore', 'StorageError', 'content_rows']


def _record_id(value, label):
    if value and not RECORD_ID.fullmatch(value):
        raise ValueError(f'{label} must be a 15-character record ID')
    return value


def content_rows(page, owner, content_type='social_media', request_id='', target='', run=''):
    """The rows a successful page stores: one per X post, or one for a web page."""
    posts = page.get('posts') if page.get('mode') == 'x' else None
    links = {'target': target, 'run': run} if target or run else {}
    common = {'owner': owner, 'type': content_type, 'source': page['requested_url'], 'title': page.get('title', '')[:512],
              'fetchedAt': page['fetched_at'], 'requestId': request_id, **links}
    if posts is None:
        markdown = page.get('markdown')
        return [{
            **common, 'platform': 'web', 'canonicalUrl': page['final_url'], 'externalId': '',
            'dedupeKey': hashlib.sha256(page['final_url'].encode()).hexdigest(),
            'content': markdown if markdown else '\n\n'.join(page['items']),
            'author': '', 'handle': '', 'publishedAt': '', 'media': {}, 'metrics': {},
            'metadata': {'selector': page['selector'], 'attribute': page['attribute'], 'format': 'markdown' if markdown else 'text',
                         'items': page['count'], 'status_code': page.get('status_code')},
        }]
    return [{
        **common, 'platform': 'x', 'canonicalUrl': post['url'], 'externalId': post['id'],
        'dedupeKey': hashlib.sha256(('x:' + post['id']).encode()).hexdigest(),
        'content': post['text'], 'author': (post.get('author') or '')[:512], 'handle': post.get('handle') or '',
        'publishedAt': post.get('posted_at') or '',
        'media': {'images': post['images'], 'videos': post.get('videos', [])}, 'metrics': post.get('metrics', {}),
        'metadata': {key: value for key, value in post.items() if key not in POST_COLUMNS},
    } for post in posts]


class PocketBaseStore:
    def __init__(self, url, token, owner, timeout=30, client=None):
        if not RECORD_ID.fullmatch(owner or ''):
            raise ValueError('PocketBase persistence requires a token and a 15-character owner record ID')
        self.client = client or PocketBaseClient(url, token, timeout)
        self.owner = owner

    @classmethod
    def for_client(cls, client, owner):
        return cls(None, None, owner, client=client)

    def request(self, method, path, body=None):
        return self.client.request(method, path, body)

    def find(self, key):
        query = urlencode({'filter': f'owner="{self.owner}" && dedupeKey="{key}"', 'perPage': 1, 'skipTotal': 'true'})
        rows = self.request('GET', f'/api/collections/{COLLECTION}/records?{query}')
        return next(iter(rows.get('items', [])), None)

    def save(self, page, content_type='social_media', request_id='', target='', run=''):
        if not page.get('success'):
            return {'status': 'skipped', 'reason': 'crawl_failed', 'record_ids': []}
        rows = content_rows(page, self.owner, content_type, request_id, _record_id(target, 'target'), _record_id(run, 'run'))
        record_ids = []
        for body in rows:
            try:
                record = self.upsert(body['dedupeKey'], body)
            except Exception as error:
                error.record_ids = record_ids
                raise
            record_ids.append(record['id'])
        return {'status': 'saved', 'collection': COLLECTION, 'record_ids': record_ids}

    def upsert(self, key, body):
        existing = self.find(key)
        if existing:
            return self.request('PATCH', f'/api/collections/{COLLECTION}/records/{existing["id"]}', body)
        try:
            return self.request('POST', f'/api/collections/{COLLECTION}/records', body)
        except StorageError:
            # Reconcile concurrent creation or an accepted write whose response was lost.
            existing = self.find(key)
            if not existing:
                raise
            return self.request('PATCH', f'/api/collections/{COLLECTION}/records/{existing["id"]}', body)
