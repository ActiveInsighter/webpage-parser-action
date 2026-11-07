#!/usr/bin/env python3
"""Vendor the crawl schema and hooks from AnyWorkflow-workers, which owns them.

    python3 scripts/sync_pocketbase_fixtures.py [path/to/AnyWorkflow-workers]

Tests run the real migrations and hooks on an isolated PocketBase. Never edit the copies under
tests/fixtures/pocketbase by hand: change AnyWorkflow-workers, run this script and commit both.
With WORKERS_DIR set, the test suite fails when the copies and the source disagree.
"""
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / 'tests/fixtures/pocketbase'
FILES = [
    'pb_migrations/1794045600_crawled_contents.js',
    'pb_migrations/1794120000_web_crawl.js',
    'pb_hooks/aw_crawl.pb.js',
    'pb_hooks/crawl.js',
    'pb_hooks/crawl_validation.js',
    'pb_hooks/capture_validation.js',
]


def main():
    workers = Path(sys.argv[1] if len(sys.argv) > 1 else os.getenv('WORKERS_DIR', ROOT.parent / 'AnyWorkflow-workers')).resolve()
    source = workers / 'pocketbase'
    if not (source / FILES[0]).is_file():
        raise SystemExit(f'No crawl schema under {source}')
    shutil.rmtree(TARGET, ignore_errors=True)
    checksums = {}
    for name in FILES:
        (TARGET / name).parent.mkdir(parents=True, exist_ok=True)
        data = (source / name).read_bytes()
        (TARGET / name).write_bytes(data)
        checksums[name] = hashlib.sha256(data).hexdigest()
    manifest = {'source': 'AnyWorkflow-workers/pocketbase', 'files': checksums}
    (TARGET / 'SOURCE.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Vendored {len(FILES)} PocketBase files from {source}')


if __name__ == '__main__':
    main()
