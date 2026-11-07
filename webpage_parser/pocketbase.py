"""Minimal PocketBase JSON client for the crawler service identity."""
import json
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener
from urllib.parse import urlsplit

USER_AGENT = 'WebpageParserAction/3.0 (+https://github.com/ActiveInsighter/webpage-parser-action)'
MAX_RESPONSE_BYTES = 8 * 1024 * 1024


class StorageError(RuntimeError):
    """A PocketBase call failed. Messages never carry server bodies, URLs or credentials."""

    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward database credentials to a redirect destination.


def validate_origin(url):
    parsed = urlsplit(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('pocketbase-url must be an absolute URL without credentials')
    if parsed.query or parsed.fragment or parsed.path not in ('', '/'):
        raise ValueError('pocketbase-url must be an origin without a path, query or fragment')
    if parsed.scheme != 'https' and parsed.hostname not in ('127.0.0.1', 'localhost', '::1'):
        raise ValueError('pocketbase-url requires HTTPS except on localhost')
    return url.rstrip('/')


class PocketBaseClient:
    def __init__(self, url, token, timeout=30):
        self.base = validate_origin(url)
        if not token:
            raise ValueError('PocketBase access requires a token')
        self.token, self.timeout = token, timeout
        self.opener = build_opener(NoRedirect())

    def request(self, method, path, body=None):
        headers = {'Authorization': self.token, 'Content-Type': 'application/json', 'Accept': 'application/json',
                   'User-Agent': USER_AGENT}
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        request = Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                return json.loads(response.read(MAX_RESPONSE_BYTES) or b'null')
        except HTTPError as error:
            error.close()
            raise StorageError(f'PocketBase {method} failed (HTTP {error.code})', error.code) from None
        except (URLError, TimeoutError, OSError, ValueError):
            raise StorageError(f'PocketBase {method} failed (connection or invalid response)') from None
