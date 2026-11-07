"""`python -m webpage_parser [crawl options]`, or `python -m webpage_parser run --run-id ID`."""
import sys

if len(sys.argv) > 1 and sys.argv[1] == 'run':
    from .jobs import main

    raise SystemExit(main(sys.argv[2:]))

from .cli import main

raise SystemExit(main())
