"""Run mode: crawl one AnyWorkflow crawl run (`aw_crawl_runs`) dispatched by the scheduler.

The workflow input is only the run id. The targets come from the run's snapshot in PocketBase, each
target's contents are stored there and its outcome is reported there, so no crawled URL or content
reaches the public repository's logs or artifacts. The scheduler settles the run when the workflow
ends; anything not reported by then counts as failed.
"""
import argparse
import asyncio
import os
import re
import sys
import time

from .crawl import browser_session, crawl_safely
from .pocketbase import PocketBaseClient, StorageError
from .storage import PocketBaseStore

RUN_ID = re.compile(r'[a-z0-9]{15}')
REPORTABLE = {'dispatching', 'pending', 'running'}
RUNS = 'aw_crawl_runs'
ERROR_CODE = re.compile(r'[a-z0-9_]{1,64}')
REPORT_ATTEMPTS = 4

# Target options (camelCase, validated by PocketBase) → crawl_page arguments, with the CLI defaults.
OPTION_ARGUMENTS = {
    'selector': ('selector', 'body', str),
    'attribute': ('attribute', '', str),
    'waitFor': ('wait_for', '', str),
    'delay': ('delay', 3.0, float),
    'timeout': ('timeout', 30.0, float),
    'xScope': ('x_scope', 'target', str),
    'maxPosts': ('max_posts', 1, int),
    'transport': ('transport', 'auto', str),
}


def crawl_arguments(item):
    """crawl_page keyword arguments for one run item; unknown or mistyped options are refused."""
    options = {} if item.get('options') is None else item['options']
    if not isinstance(options, dict) or options.keys() - OPTION_ARGUMENTS.keys():
        raise ValueError('target options contain unknown keys')
    arguments = {'mode': item.get('mode') or 'auto', 'retries': 2}
    for key, (name, default, kind) in OPTION_ARGUMENTS.items():
        value = options.get(key, default)
        if isinstance(value, bool) or not isinstance(value, (str, int, float)):
            raise ValueError(f'target option {key} is invalid')
        arguments[name] = kind(value)
    return arguments


def error_code(page):
    """A stable reason the console can explain without parsing English diagnostics."""
    if page.get('error_code') and ERROR_CODE.fullmatch(page['error_code']):
        return page['error_code']
    status = page.get('status_code')
    if isinstance(status, int) and status >= 400:
        return f'http_{status}'
    return 'crawl_failed'


def outcome_for(item, page, stored=None, failure=None):
    """The report for one target. Only counts, ids, the page title and a bounded error leave the runner."""
    outcome = {'target': item['target'], 'status': 'failed', 'itemCount': 0, 'recordIds': [],
               'title': (page or {}).get('title', '')[:512], 'error': '', 'errorCode': '',
               'transport': (page or {}).get('transport', '') if (page or {}).get('transport') in ('http', 'browser') else ''}
    if failure:
        outcome.update(errorCode=failure[0], error=failure[1][:2000])
    elif not page.get('success'):
        outcome.update(errorCode=error_code(page), error=str(page.get('diagnostics', {}).get('error', ''))[:2000])
    elif page.get('count', 0) == 0:
        outcome.update(errorCode='no_match', error='The selector matched no content on the page.')
    else:
        outcome.update(status='succeeded', itemCount=page['count'], recordIds=stored['record_ids'])
    return outcome


class RunClient:
    def __init__(self, client, sleep=time.sleep):
        self.client, self.sleep = client, sleep

    def load(self, run_id):
        return self.client.request('GET', f'/api/collections/{RUNS}/records/{run_id}')

    def report(self, run_id, outcome):
        """A report is idempotent (it overwrites the target's outcome), so transient failures are retried."""
        for attempt in range(REPORT_ATTEMPTS):
            try:
                return self.client.request('POST', f'/api/anyworkflow/crawl/runs/{run_id}/report', outcome)
            except StorageError as error:
                if error.status is not None and error.status < 500 and error.status != 429 or attempt == REPORT_ATTEMPTS - 1:
                    raise
                self.sleep(2 ** attempt)


async def run_job(run_id, client, *, log=print, sleep=time.sleep):
    """Crawl, store and report every target of one run. Returns the reported outcomes."""
    if not RUN_ID.fullmatch(run_id or ''):
        raise ValueError('run id must be a 15-character record ID')
    runs = RunClient(client, sleep)
    run = runs.load(run_id)
    if run.get('status') not in REPORTABLE:
        log(f'Run is {run.get("status") or "unknown"}; nothing to crawl.')
        return []
    store = PocketBaseStore.for_client(client, run['owner'])
    items = run.get('items') or []
    outcomes = []
    async with browser_session() as crawler:
        for index, item in enumerate(items, 1):
            page, stored, failure = None, None, None
            try:
                arguments = crawl_arguments(item)
            except ValueError as error:
                failure = ('invalid_options', str(error))
            if not failure:
                page = await crawl_safely(crawler, item['url'], **arguments)
                if page.get('success') and page.get('count', 0) > 0:
                    try:
                        stored = await asyncio.to_thread(store.save, page, item.get('contentType') or 'webpage', run_id, item['target'], run_id)
                    except StorageError as error:
                        failure = ('storage_failed', str(error))
            outcome = outcome_for(item, page, stored, failure)
            outcomes.append(outcome)
            reply = await asyncio.to_thread(runs.report, run_id, outcome)
            log(f'Target {index}/{len(items)}: {outcome["status"]}, {outcome["itemCount"]} item(s)'
                + (f', {outcome["errorCode"]}' if outcome['errorCode'] else ''))
            if reply and reply.get('cancelRequested'):
                log('Run canceled; remaining targets are left unreported.')
                break
    return outcomes


def main(argv=None):
    cli = argparse.ArgumentParser(prog='webpage_parser run', description='Crawl one AnyWorkflow crawl run and report each target.')
    cli.add_argument('--run-id', required=True, help='aw_crawl_runs record id')
    cli.add_argument('--pocketbase-url', default=os.getenv('POCKETBASE_URL', ''))
    args = cli.parse_args(argv)
    try:
        client = PocketBaseClient(args.pocketbase_url, os.getenv('POCKETBASE_TOKEN', ''))
        outcomes = asyncio.run(run_job(args.run_id, client))
    except (ValueError, StorageError) as error:
        print(f'Crawl run failed: {error}', file=sys.stderr)
        return 1
    succeeded = sum(outcome['status'] == 'succeeded' for outcome in outcomes)
    summary = f'Crawl run: {succeeded}/{len(outcomes)} target(s) succeeded, {sum(o["itemCount"] for o in outcomes)} item(s) stored.'
    print(summary)
    if os.getenv('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as handle:
            handle.write(summary + '\n')
    return 0 if succeeded == len(outcomes) else 1
