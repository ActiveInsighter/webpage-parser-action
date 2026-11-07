import argparse
import asyncio
import json
import os
import re
from pathlib import Path

from .crawl import crawl_urls
from .options import apply_json_options, validate_options
from .storage import PocketBaseStore


def main(argv=None):
    cli = argparse.ArgumentParser(description="Render webpages with Crawl4AI and extract CSS content or public X posts.")
    cli.add_argument("--url", required=True, help="One URL, or newline-separated URLs (at most 10)")
    cli.add_argument("--selector", default="body")
    cli.add_argument("--attribute", default="")
    cli.add_argument("--timeout", type=float, default=30)
    cli.add_argument("--retries", type=int, default=2)
    cli.add_argument("--mode", choices=("auto", "page", "x"), default="auto")
    cli.add_argument("--wait-for", default="", help="Optional CSS selector to wait for")
    cli.add_argument("--delay", type=float, default=3)
    cli.add_argument("--max-posts", type=int, default=1)
    cli.add_argument("--x-scope", default="target", choices=("target", "visible"))
    cli.add_argument("--transport", default="auto", choices=("auto", "http", "browser"))
    cli.add_argument("--save-to", default="none", choices=("none", "pocketbase"))
    cli.add_argument("--content-type", default="social_media")
    cli.add_argument("--owner", default="")
    cli.add_argument("--request-id", default="")
    cli.add_argument("--options", default="{}", help="JSON overrides for workflow dispatch")
    cli.add_argument("--pocketbase-url", default=os.getenv("POCKETBASE_URL", ""))
    cli.add_argument("--output", default="results/result.json")
    args = cli.parse_args(argv)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.unlink(missing_ok=True)
    for pattern in ("page*.html", "page*.md", "page*.png"):
        for stale in output.parent.glob(pattern):
            stale.unlink()
    urls = [url.strip() for url in args.url.splitlines() if url.strip()]
    try:
        apply_json_options(args)
        store = PocketBaseStore(args.pocketbase_url, os.getenv("POCKETBASE_TOKEN", ""), args.owner) if args.save_to == "pocketbase" else None
        if not 1 <= len(urls) <= 10:
            raise ValueError("provide between 1 and 10 URLs, separated by newlines")
        for url in urls:
            validate_options(url, args.selector, args.timeout, args.retries,
                             args.mode, args.wait_for, args.delay, args.max_posts)
        pages = asyncio.run(crawl_urls(
            urls, selector=args.selector, attribute=args.attribute, timeout=args.timeout,
            retries=args.retries, mode=args.mode, wait_for=args.wait_for,
            delay=args.delay, max_posts=args.max_posts, evidence_dir=output.parent,
            x_scope=args.x_scope, transport=args.transport,
        ))
        for page in pages:
            if store:
                try:
                    page["storage"] = store.save(page, args.content_type, args.request_id)
                except Exception as error:
                    page["storage"] = {"status": "failed", "error": str(error), "record_ids": getattr(error, "record_ids", [])}
                    page["crawl_success"] = page["success"]
                    page["success"] = False
            page["request_id"] = args.request_id
    except Exception as error:
        pages = [{"success": False, "count": 0, "diagnostics": {"error": f"{type(error).__name__}: {error}"}}]
    result = pages[0] if len(pages) == 1 else {
        "schema_version": 2, "request_id": args.request_id,
        "success": all(page["success"] for page in pages),
        "count": sum(page["count"] for page in pages), "results": pages,
    }
    content = "\n\n".join("\n\n".join([page.get("requested_url", ""), *page.get("items", [])]) for page in pages)
    output.with_name("content.md").write_text(content + "\n", encoding="utf-8")
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if os.getenv("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as handle:
            handle.write(f"count={result['count']}\n")
            handle.write(f"success={str(result['success']).lower()}\n")
            ids = [rid for page in pages for rid in page.get('storage', {}).get('record_ids', [])]
            handle.write("record-ids=" + json.dumps(ids) + "\n")
            safe_request_id = args.request_id if len(args.request_id) <= 128 and not re.search(r"[\x00-\x1f]", args.request_id) else ""
            handle.write("request-id=" + safe_request_id + "\n")
    if os.getenv("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as handle:
            handle.write(f"Crawl4AI: success={result['success']}, extracted items={result['count']}. See JSON, Markdown, HTML and screenshot artifacts.\n")
    print(f"Crawl4AI: success={result['success']}, items={result['count']}, output={output}")
    return 0 if result["success"] else 1
