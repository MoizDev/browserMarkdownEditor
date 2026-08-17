# dev-loop end-to-end playbook

How this project gets tested the way a user experiences it. Read by the main session (which
provisions the kit once per run) and by every `end-to-end` agent (which uses it).

The premise: unit tests cover the layers that are cheap to test, and something is always left
over — the UI, the wiring, the real session, the real data. This is the only place that layer
is ever verified, so "the code looks right" is not a result here.

Everything in this playbook lives in **`WORKSPACE`**, the out-of-repo scratch directory named
in your prompt. Nothing here writes to the repository.

**If the product is not a web application**, the same structure holds — drive it through its
real interface instead of a browser (the CLI as a user invokes it, the HTTP API as a client
calls it, the built binary as it ships). Keep §2's isolated instance, §2's readiness positive
control, §3's coverage list, §4's teardown, and §5's data safety exactly as written; only the
driver changes.

---

## 1. The kit — provisioned once per run, by the main session

Do this at the start of Phase 4, iteration 1. Every `end-to-end` agent in every iteration
reuses it, so the browser download happens once and cannot race.

```bash
REPO="$(git rev-parse --show-toplevel)"
mkdir -p "$WORKSPACE/e2e-kit/specs"

cd "$WORKSPACE/e2e-kit"
npm init -y >/dev/null
npm i -D @playwright/test
npx playwright install chromium
```

If the repo already has a browser-automation harness of its own — Playwright, Cypress,
Selenium, an existing `e2e/` suite — **use that instead of installing a second one**, and note
in the manifest which one this run uses. A project's own harness already knows its fixtures,
its auth helper, and its base URL.

The kit above is the fallback, and it happens to be a Node one. If the project's language has
no Node toolchain available, install the same browser driver through that language's package
manager instead and write the spec in it — the tool is incidental, the procedure is not.

`playwright.config.ts` in `$WORKSPACE/e2e-kit`, when you are provisioning fresh:

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./specs",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: process.env.E2E_OUT ?? "./test-results",
  use: {
    baseURL: process.env.E2E_BASE_URL,
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
});
```

If the application's dependencies must be importable from `WORKSPACE` — for a provisioning or
seeding script that reuses the project's own client library — link them rather than
reinstalling: `ln -sfn "$REPO/<dependency dir>" "$WORKSPACE/<dependency dir>"`.

### The test identity

Most interesting surfaces are behind a login, so end-to-end coverage needs one. Take the
**first** of these that this project supports, and record which one in the manifest:

1. **A documented test or seed account** — a fixture user, a seeding command, a
   `docker-compose` dev stack with known credentials. Always prefer this: it is what the
   project's own maintainers use, and it touches no live data.
2. **A local or disposable environment** you can bring up and throw away — a seeded local
   database, a preview environment, a sandbox tenant. Create the identity in it.
3. **An admin/service credential or an MCP server that can create a user** (see
   `.dev-loop/context/00-mcp.md`). Create exactly one identity, **namespaced by `RUN_ID`** so
   it can never be confused with a real user, and delete it in Phase 5.
4. **Open self-service sign-up**, driven through the UI as a real user would, again namespaced
   by `RUN_ID`.
5. **None of the above** — then the authenticated surface is **blocked** for this run. Say so;
   Phase 4 still runs over everything reachable without a session.

Write the credentials to `$WORKSPACE/e2e-kit/identity.json`. That file contains a password: it
never enters the repository, never enters a report, and is deleted in Phase 5.

If the identity lives in a **shared or production** system, §5 is not advisory — it is the
only thing standing between this run and someone's real data.

## 2. An isolated app instance per `end-to-end` agent

Never test against a server you did not start, and never against the project's default dev
port — the user's own dev server may be running there, on a different branch entirely. Give
each tester its own copy of the working tree and its own port:

```bash
PORT=$(( 3200 + ITERATION ))            # anything free and far from the project default
APP="$WORKSPACE/app-$ITERATION"

rsync -a \
  --exclude .git --exclude .dev-loop --exclude '<dependency dir>' --exclude '<build output dir>' \
  "$REPO/" "$APP/"
ln -sfn "$REPO/<dependency dir>" "$APP/<dependency dir>"    # if the stack has one

cd "$APP"
<the dev-server command from run.md, bound to $PORT> > "$APP/server.log" 2>&1 &
echo $! > "$APP/server.pid"
```

The copy is byte-identical to the tree under review — Phase 4 has no concurrent writers. If
the app needs environment configuration to boot, it reads the same files the repo already
uses; do not print their contents anywhere.

### Readiness, with a positive control

A dev server may compile on first request, so allow real time. And prove the probe can tell a
live server from a dead one before you trust a 200:

```bash
BASE="http://127.0.0.1:$PORT"
for i in $(seq 1 120); do
  curl -fsS -o /dev/null "$BASE/" && break
  sleep 2
done

home=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")
bogus=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/__dev_loop_no_such_route__")
# home must be 200 AND bogus must be 404. If both are 200, or the loop timed out,
# the probe is not measuring anything: tail server.log and report BLOCKED.
```

A server that never came up is a **blocked** result with the last 50 lines of `server.log`
attached. It is never a pass, and it is never silence.

## 3. Writing the spec

One spec file per agent: `$WORKSPACE/e2e-kit/specs/iter<K>.spec.ts`. Run it:

```bash
cd "$WORKSPACE/e2e-kit"
E2E_BASE_URL="http://127.0.0.1:$PORT" \
E2E_OUT="$WORKSPACE/e2e-kit/results/iter$ITERATION" \
E2E_EMAIL="…" E2E_PASSWORD="…" \
  ./node_modules/.bin/playwright test "specs/iter$ITERATION.spec.ts" \
  --workers=1 --reporter=list
```

**Discover the app, do not assume it.** Routes, selectors and flows change; this playbook is
not a selector reference. Read the sign-in page's source, the main authenticated shell, and
the Phase 0 codebase map, then write selectors against what is actually there. Prefer role-
and label-based locators over CSS.

Verify the sign-in shape against the current code before relying on it, and assert on
something **only an authenticated user can see** — reaching the app's home route without an
error is not proof of a session.

**Always attach the two listeners.** They catch defects no assertion was written for, on
every page the spec visits:

```ts
const consoleErrors: string[] = [];
const pageErrors: string[] = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => pageErrors.push(String(e)));
```

Report every entry. A clean run with three console errors is not a clean run.

### What to cover

1. **The change itself** — the acceptance criteria in `plan.md`, exercised the way a user
   would reach them. If the task was a bug fix, reproduce the original symptom first and
   show it is gone.
2. **A regression sweep of the core product**, every iteration, not just the first: sign-up or
   sign-in; the main surface loads; the product's primary create / edit / move / delete
   actions; the change survives a reload; navigation across the app shell; settings; public
   and marketing pages render; a bogus URL 404s rather than 500s. Take the actual list from
   the Phase 0 map — this is the shape, not the contents.
3. **The pixel layer.** Look at the screenshots. Overlapping text, clipped controls,
   misaligned rows, a scrollbar that should not exist, a dark-mode contrast failure — if it
   clearly looks wrong, it is a finding. Say which screenshot shows it.

## 4. Teardown — yours, every time

```bash
kill "$(cat "$APP/server.pid")" 2>/dev/null || true
sleep 2
kill -9 "$(cat "$APP/server.pid")" 2>/dev/null || true
rm -rf "$APP"
```

Delete any data your run created through the UI. Keep the spec, the results directory, and any
failure screenshot — your report cites them by absolute path. The main session removes the
whole `WORKSPACE`, and the test identity, in Phase 5.

## 5. Data safety

Assume the identity is real and the system behind it is shared until you have proved
otherwise.

- Create only what you need, under your own identity. Delete what you created.
- Never touch a record you did not create, never run an unqualified `DELETE`/`UPDATE`, never
  exercise a destructive admin path against another user's data.
- Do not connect third-party accounts, do not start a payment flow against live keys, do not
  send email or notifications to real addresses, do not trigger a deploy. If a flow cannot be
  tested without one of those, report it as **not covered** and say why.
- Never echo a password, a session token, or any environment-file value into a report.
