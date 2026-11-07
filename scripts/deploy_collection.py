#!/usr/bin/env python3
"""Apply only this additive migration to the existing local PocketBase service.

Requires root. Verify a consistent database copy before restarting the service.
No existing hooks, credentials, collections or worker images are replaced.
"""
import json
import os
import pwd
import shutil
import sqlite3
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run with sudo -n python3 scripts/deploy_collection.py')
    source = Path(__file__).resolve().parents[1]
    migration = source / 'pocketbase/pb_migrations/1794045600_crawled_contents.js'
    pb = Path('/opt/pocketbase')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = Path('/opt/anyworkflow-backups') / ('crawled-contents-' + stamp)
    backup.mkdir(mode=0o700)
    snapshot = backup / 'data.db'
    with sqlite3.connect('file:' + str(pb/'pb_data/data.db') + '?mode=ro', uri=True) as live, sqlite3.connect(snapshot) as dest:
        applied = live.execute('SELECT 1 FROM _migrations WHERE file=?', (migration.name,)).fetchone()
        if applied:
            print(json.dumps({'status': 'already-applied', 'migration': migration.name}))
            return
        pending = [p.name for p in (pb/'pb_migrations').glob('*.js') if not live.execute('SELECT 1 FROM _migrations WHERE file=?', (p.name,)).fetchone()]
        if pending:
            raise RuntimeError('Unrelated pending migrations must be resolved first')
        live.backup(dest)
        assert dest.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        names = [r[0] for r in dest.execute("SELECT name FROM _collections WHERE substr(name, 1, 1) != '_'")]
        counts = {name: dest.execute('SELECT COUNT(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0] for name in names}
    shutil.copytree(pb/'pb_migrations', backup/'migrations')
    shutil.copy2(migration, backup/'migrations'/migration.name)
    check_data = backup/'verify-data'
    check_data.mkdir()
    shutil.copy2(snapshot, check_data/'data.db')
    result = subprocess.run([str(pb/'pocketbase'), '--dir=' + str(check_data), '--hooksDir=' + str(backup/'no-hooks'),
                             '--migrationsDir=' + str(backup/'migrations'), 'migrate', 'up'], capture_output=True, text=True)
    (backup/'migration-verification.log').write_text(result.stdout + result.stderr)
    if result.returncode:
        raise RuntimeError('Isolated full-database migration failed; inspect root-only backup logs')
    with sqlite3.connect(check_data/'data.db') as db:
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        for name, count in counts.items():
            assert db.execute('SELECT COUNT(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0] == count, name
        assert db.execute('SELECT COUNT(*) FROM aw_crawled_contents').fetchone()[0] == 0
    target = pb/'pb_migrations'/migration.name
    shutil.copy2(migration, target)
    account = pwd.getpwnam('pocketbase')
    os.chown(target, account.pw_uid, account.pw_gid)
    os.chmod(target, 0o644)
    mirror = Path('/opt/anyworkflow-workers/pocketbase/pb_migrations')/migration.name
    if mirror.parent.is_dir():
        shutil.copy2(migration, mirror)
        os.chmod(mirror, 0o644)
    subprocess.run(['systemctl', 'restart', 'pocketbase'], check=True)
    for _ in range(100):
        try:
            with urlopen('http://127.0.0.1:8091/api/health', timeout=2) as response:
                if response.status == 200:
                    break
        except OSError:
            pass
        time.sleep(.2)
    else:
        raise RuntimeError('PocketBase did not become healthy; backup: ' + str(backup))
    with sqlite3.connect('file:' + str(pb/'pb_data/data.db') + '?mode=ro', uri=True) as db:
        assert db.execute('SELECT 1 FROM _migrations WHERE file=?', (migration.name,)).fetchone()
        fields = [r[1] for r in db.execute('PRAGMA table_info(aw_crawled_contents)')]
    report = {'status': 'applied', 'backup': str(backup), 'migration': migration.name,
              'verifiedExistingCollections': len(counts), 'fields': fields, 'health': 'ok'}
    (backup/'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
