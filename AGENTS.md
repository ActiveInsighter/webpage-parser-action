# AnyWorkflow Crawler agent guide

One parser, two executors: a GitHub Actions workflow (`cloud`, anonymous) and a Chrome MV3 extension (`browser`, the owner's logins). Read `README.md` and `docs/architecture.md` first; read `docs/site-profiles.md` before touching `src/sites/`.

## Rules

- Keep the layering: `core` → `sites` → `page` → `engine` → `extension` | `action`. `npm run check:layers` enforces it. `core` knows no runtime. `page/` runs in the target page and must not use `chrome.*` or Node. `engine/` is runtime-agnostic and reaches pages only through the `PageDriver` port (`src/engine/driver.ts`). `extension/` and `action/` never import each other.
- Parsing lives in `page/` and `sites/` only, so both executors get every fix. An executor adds a way to open a page (a route), never its own parsing.
- Job rows are remote input driving a logged-in browser. Options may only carry selectors and numbers, never code. Keep `checkUrl` (`src/core/url-policy.ts`) and `normalizeUrl` (`AnyWorkflow-workers/pocketbase/pb_hooks/crawl_validation.js`) in agreement.
- The contract lives in three places that must agree: `src/core/contract.ts` + `src/core/errors.ts`, the workers `crawl*.js` hooks and migration, and Remote `src/types/crawl.ts`. Change the workers side first, run `npm run sync:pocketbase -- ../AnyWorkflow-workers`, and let `tests/unit/contract.test.ts` tell you what else moved. Never edit `tests/fixtures/pocketbase/` by hand.
- The repository and its Actions logs are public. The cloud executor logs through `src/action/log.ts` only: ids, codes and counts, never a URL, selector, page text or error message. Never upload artifacts from `crawl.yml`.
- Never add code that bypasses a CAPTCHA, verification wall, login or paywall. A blocker is detected, reported with its error code, and the job ends.
- Capture windows are hidden or unfocused: `requestAnimationFrame` does not fire there. Use timers and `MutationObserver`. Content hashes are computed by the server.
- Use `visibleText` rather than `textContent` when judging a page: inline scripts count as text otherwise.
- A site profile must degrade to generic parsing when its selectors miss, unless the job asked for one specific entry (then `TARGET_NOT_FOUND`). Prefer data over `extract`, and record in `docs/site-profiles.md` how it was verified. Do not claim a profile is verified unless it ran against the real page.
- Keep the service worker small: use `zod/mini`, and keep Defuddle and Readability in the page agent only.

## Verification

```bash
npm run preflight
npm run build:action && POCKETBASE_BINARY=/opt/pocketbase/pocketbase WORKERS_DIR=../AnyWorkflow-workers npm run test:cloud
POCKETBASE_BINARY=/opt/pocketbase/pocketbase WORKERS_DIR=../AnyWorkflow-workers REMOTE_DIR=../Anyworkflow-remote npm run test:e2e
```

Run the cloud suite for any change to `action/`, `engine/` or the contract, and the extension suite for `extension/`, `page/`, `engine/` or the contract. Test real sites with `npm run crawl -- <url>` (cloud) and `tests/e2e/live.mjs` (extension); use `tests/e2e/replay.mjs` when the site blocks this machine.

## Do not

- Do not load a development build into the live execution browser (Chrome for Testing on CDP 40197): it runs long AnyWorkflow jobs.
- Do not build with `CRAWLER_ALLOW_LOCAL=1` into `dist/`; the build refuses it. The cloud executor refuses it on GitHub Actions outside the e2e suite.
- Do not commit `dist/`, `.env` or saved pages containing personal or third-party data.
