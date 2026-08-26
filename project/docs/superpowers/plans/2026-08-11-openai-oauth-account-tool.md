# OpenAI OAuth Account Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a loopback-only web application that logs into the existing admin backend, drives one isolated OpenAI OAuth browser flow with mailbox OTP retrieval, and creates the account through the backend API without exposing OAuth credentials.

**Architecture:** A Fastify process owns the backend session, SQLite task records, mailbox polling, Playwright lifecycle, and account creation state machine. A Vue/Vite frontend talks only to allowlisted local APIs and receives sanitized task events. Backend refresh tokens live in macOS Keychain; all task secrets remain in process memory.

**Tech Stack:** Node.js 24, TypeScript, Fastify, Vue 3, Vite, Zod, Playwright, `node:sqlite`, `@napi-rs/keyring`, Cheerio, Vitest, ESLint.

**Execution mode:** Inline execution in the current workspace. This directory is not a Git repository, so commit steps are intentionally omitted and no repository will be initialized without explicit user authorization.

**Accepted visual reference:** `docs/design/openai-account-tool-concept.png` (1536x1024). Implement a true-white `#ffffff` main canvas, `#f5f6f7` navigation rail, `#17191c` primary button/text, `#139b58` active/success accent, `#d8dde2` borders, 4-6px radii, 48px controls, 220px sidebar, 360px progress rail, and compact 14-16px operational typography. Visible copy and information order must follow the approved product requirements even where generated-image lettering differs.

---

### Task 1: Project Foundation and Shared Contracts

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.server.json`
- Create: `vite.config.ts`
- Create: `eslint.config.js`
- Create: `.gitignore`
- Create: `src/shared/contracts.ts`
- Create: `src/shared/task-state.ts`
- Create: `src/shared/errors.ts`
- Test: `tests/unit/contracts.test.ts`

- [x] **Step 1: Create the failing shared-contract tests**

Cover email normalization, the five allowed concurrency values, the four proxy modes, rejection of unknown task fields, and public task serialization that excludes secrets.

```ts
expect(CreateTaskInputSchema.parse(validInput).concurrency).toBe(10)
expect(() => CreateTaskInputSchema.parse({ ...validInput, concurrency: 7 })).toThrow()
expect(JSON.stringify(toPublicTask(secretTask))).not.toMatch(/mailboxPassword|access_token|refresh_token/)
```

- [x] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- tests/unit/contracts.test.ts`

Expected: failure because shared contracts do not exist.

- [x] **Step 3: Add build, lint, test scripts and minimal shared types**

Define `CreateTaskInputSchema`, `ProxyChoice`, `TaskStage`, `PublicTask`, `PublicTaskError`, and exact status transitions. The task input schema uses `.strict()` so the local API cannot receive hidden free-form fields.

```ts
export const concurrencySchema = z.union([
  z.literal(1), z.literal(3), z.literal(5), z.literal(10), z.literal(20),
])

export const CreateTaskInputSchema = z.object({
  accountEmail: z.string().trim().email().max(320),
  mailboxPassword: z.string().min(1).max(1024),
  proxyChoice: ProxyChoiceSchema,
  concurrency: concurrencySchema.default(10),
  supplier: z.string().trim().min(1).max(200).nullable(),
  groupIds: z.array(z.number().int().positive()).max(100),
}).strict()
```

- [x] **Step 4: Install dependencies and verify the focused test passes**

Run: `npm install`

Run: `npm test -- tests/unit/contracts.test.ts`

Expected: all contract tests pass.

### Task 2: Secret Redaction, Local Session, and SQLite Storage

**Files:**
- Create: `src/server/config.ts`
- Create: `src/server/security/redact.ts`
- Create: `src/server/security/secret-scope.ts`
- Create: `src/server/local-security.ts`
- Create: `src/server/storage/database.ts`
- Create: `src/server/storage/migrations.ts`
- Test: `tests/unit/redact.test.ts`
- Test: `tests/unit/storage.test.ts`
- Test: `tests/unit/local-security.test.ts`

- [x] **Step 1: Write failing redaction, storage, and CSRF tests**

Assert that JWT-like values, authorization headers, `pwd`, OTP values, callback query strings, OAuth token fields, proxy credentials, and mailbox bodies never survive `redactValue`. Assert the database persists public task data but has no secret columns. Assert write requests require the loopback session cookie, matching Origin, and CSRF header.

```ts
expect(redactValue('https://mail.test/?pwd=secret&limit=5')).toBe('https://mail.test/?pwd=[REDACTED]&limit=5')
expect(taskTableColumns).not.toContain('mailbox_password')
expect(validateLocalWriteRequest(validRequest)).toEqual({ ok: true })
```

- [x] **Step 2: Run focused tests and verify they fail**

Run: `npm test -- tests/unit/redact.test.ts tests/unit/storage.test.ts tests/unit/local-security.test.ts`

Expected: missing-module failures.

- [x] **Step 3: Implement the security primitives and storage schema**

Use a startup bootstrap nonce, a separate random local session ID, and a CSRF token. Bind runtime data under `APP_DATA_DIR` or macOS Application Support with directory mode `0700` and database mode `0600`.

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  account_email TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  selection_json TEXT NOT NULL,
  account_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

- [x] **Step 4: Run the focused tests**

Run: `npm test -- tests/unit/redact.test.ts tests/unit/storage.test.ts tests/unit/local-security.test.ts`

Expected: all security and storage tests pass.

### Task 3: Admin Backend Session and HTTP Client

**Files:**
- Create: `src/server/session/keychain.ts`
- Create: `src/server/session/manager.ts`
- Create: `src/server/backend/client.ts`
- Create: `src/server/backend/auth.ts`
- Test: `tests/unit/session-manager.test.ts`
- Test: `tests/integration/backend-auth.test.ts`
- Create: `tests/helpers/mock-backend.ts`

- [x] **Step 1: Write failing session tests**

Cover login, TOTP intermediate state, `/auth/me` verification, refresh-token rotation, one in-flight refresh shared by concurrent requests, a single retry after `401`, no refresh after `403`, `423` compliance errors, logout, and Keychain deletion.

```ts
const [first, second] = await Promise.all([manager.getAccessToken(), manager.getAccessToken()])
expect(first).toBe(second)
expect(mockBackend.refreshCalls).toBe(1)
```

- [x] **Step 2: Run focused tests and verify they fail**

Run: `npm test -- tests/unit/session-manager.test.ts tests/integration/backend-auth.test.ts`

Expected: missing backend/session modules.

- [x] **Step 3: Implement Keychain and backend session adapters**

Use `new Entry('up-icloud.coding-session', accountEmail)`. Store only the backend refresh token. Keep access token, expiry, TOTP temp token, and password in memory. The fixed backend origin is `https://coding.tu-zi.com/api/v1`; tests inject the mock origin through a constructor, not a task field.

```ts
export interface CredentialStore {
  get(account: string): Promise<string | null>
  set(account: string, value: string): Promise<void>
  delete(account: string): Promise<void>
}
```

- [x] **Step 4: Verify session behavior**

Run: `npm test -- tests/unit/session-manager.test.ts tests/integration/backend-auth.test.ts`

Expected: all session tests pass and no test output contains tokens.

### Task 4: Backend Options, Proxy Resolution, and Account Contract

**Files:**
- Create: `src/server/backend/options.ts`
- Create: `src/server/backend/accounts.ts`
- Create: `src/server/tasks/proxy-resolver.ts`
- Create: `src/server/tasks/account-creator.ts`
- Test: `tests/unit/options.test.ts`
- Test: `tests/unit/proxy-resolver.test.ts`
- Test: `tests/unit/account-creator.test.ts`

- [x] **Step 1: Write failing backend-contract tests**

Normalize `/admin/proxies/all`, `/admin/proxies/subscriptions`, `/admin/accounts/suppliers`, and `/admin/groups/all`. Test `none`, fixed, `random_fixed`, and dynamic proxy choices. Test two-stage exact duplicate lookup and create payload construction.

```ts
expect(payload).toMatchObject({
  name: 'user@example.invalid', platform: 'openai', type: 'oauth',
  concurrency: 10, priority: 1, rate_multiplier: 1, group_ids: [],
})
expect(payload.credentials).not.toHaveProperty('model_mapping')
```

- [x] **Step 2: Run focused tests and verify they fail**

Run: `npm test -- tests/unit/options.test.ts tests/unit/proxy-resolver.test.ts tests/unit/account-creator.test.ts`

Expected: missing adapter failures.

- [x] **Step 3: Implement option snapshots and proxy resolution**

Validate every selected ID/string against the latest snapshot. For random and dynamic modes call `/admin/proxies/assignments/resolve`; fetch `/admin/proxies/{id}` and normalize Playwright `server`, `username`, and `password` in a secret-only result.

- [x] **Step 4: Implement OAuth/account backend contracts**

Add generate, exchange, duplicate lookup, create, and detail methods. Allowlist OpenAI credential fields and omit `model_mapping` unconditionally.

- [x] **Step 5: Run the focused tests**

Run: `npm test -- tests/unit/options.test.ts tests/unit/proxy-resolver.test.ts tests/unit/account-creator.test.ts`

Expected: all option, proxy, and account tests pass.

### Task 5: Mailbox Client, Normalization, and OTP Poller

**Files:**
- Create: `src/server/mail/client.ts`
- Create: `src/server/mail/normalize.ts`
- Create: `src/server/mail/otp.ts`
- Create: `src/server/mail/poller.ts`
- Create: `tests/fixtures/mail-json.json`
- Create: `tests/fixtures/mail-html.html`
- Test: `tests/unit/mail-normalize.test.ts`
- Test: `tests/unit/mail-otp.test.ts`
- Test: `tests/integration/mail-poller.test.ts`

- [x] **Step 1: Write failing mailbox tests**

Assert fixed HTTPS host/path, URL encoding, `limit=5`, manual redirect rejection, response-size limit, baseline filtering, new-message fingerprints, OpenAI sender/content checks, unique OTP extraction, conflict rejection, `429 Retry-After`, bounded backoff, authentication failure, and timeout.

```ts
expect(requestUrl.searchParams.get('mail')).toBe('user@example.invalid')
expect(requestUrl.searchParams.get('limit')).toBe('5')
expect(extractUniqueOtp(conflictingMessages)).toEqual({ kind: 'conflict' })
```

- [x] **Step 2: Run mailbox tests and verify they fail**

Run: `npm test -- tests/unit/mail-normalize.test.ts tests/unit/mail-otp.test.ts tests/integration/mail-poller.test.ts`

Expected: missing mail modules.

- [x] **Step 3: Implement the fixed mailbox client and normalizers**

Use `https://icloud.thefindnet.xyz/api/mail.php`, `redirect: 'manual'`, request abort timeouts, and a bounded body reader. Parse JSON structurally and HTML through Cheerio. Fixtures are synthetic and contain no user credential or real message.

- [x] **Step 4: Implement baseline and polling state**

Poll every 3 seconds, back off transient failures to at most 10 seconds, and stop after 10 minutes. Never return an old, unrelated, or ambiguous six-digit number.

- [x] **Step 5: Run mailbox tests**

Run: `npm test -- tests/unit/mail-normalize.test.ts tests/unit/mail-otp.test.ts tests/integration/mail-poller.test.ts`

Expected: all mailbox tests pass.

### Task 6: Browser Driver and OAuth Callback Capture

**Files:**
- Create: `src/server/browser/types.ts`
- Create: `src/server/browser/page-classifier.ts`
- Create: `src/server/browser/callback-capture.ts`
- Create: `src/server/browser/controller.ts`
- Create: `tests/fixtures/openai-email.html`
- Create: `tests/fixtures/openai-otp.html`
- Create: `tests/fixtures/openai-challenge.html`
- Test: `tests/unit/page-classifier.test.ts`
- Test: `tests/unit/callback-capture.test.ts`

- [x] **Step 1: Write failing classifier and callback tests**

Test semantic email/OTP selectors, unknown/challenge classification, allowed OpenAI auth origin, loopback redirect matching, exact state comparison, missing state/code, and duplicate callback rejection. Use static DOM fixtures only; do not launch a browser in automated tests.

- [x] **Step 2: Run focused tests and verify they fail**

Run: `npm test -- tests/unit/page-classifier.test.ts tests/unit/callback-capture.test.ts`

Expected: missing browser modules.

- [x] **Step 3: Implement the Playwright controller**

Launch headed Chromium with a non-persistent context and optional proxy config. Disable traces, video, HAR, downloads, and persistent profiles. Fill only classified email/OTP pages; stop automation and emit `manual_intervention` on CAPTCHA, MFA, password, account-selection, risk, or unknown pages.

- [x] **Step 4: Implement callback validation and cleanup**

Accept only the expected loopback redirect origin/path and exact state from the current task. Close the context and browser on success, cancel, failure, and process signals.

- [x] **Step 5: Run classifier and callback tests**

Run: `npm test -- tests/unit/page-classifier.test.ts tests/unit/callback-capture.test.ts`

Expected: all non-browser page logic tests pass.

### Task 7: Task State Machine and Orchestration

**Files:**
- Create: `src/server/tasks/state-machine.ts`
- Create: `src/server/tasks/orchestrator.ts`
- Test: `tests/unit/state-machine.test.ts`
- Test: `tests/integration/orchestrator.test.ts`

- [x] **Step 1: Write failing state-machine and orchestration tests**

Cover the full happy path, pre-auth duplicate, final duplicate race, manual intervention recovery, mailbox failure, state mismatch, cancel before create, cancel rejection after create starts, uncertain create with lookup success, uncertain create with no confirmation, one active-task lock, and restart classification as interrupted.

```ts
expect(await orchestrator.start(validInput)).toMatchObject({ stage: 'validating' })
expect(() => machine.transition('creating_account', 'cancelled')).toThrow()
expect(serializedTask).not.toContain('access_token')
```

- [x] **Step 2: Run focused tests and verify they fail**

Run: `npm test -- tests/unit/state-machine.test.ts tests/integration/orchestrator.test.ts`

Expected: missing orchestrator failures.

- [x] **Step 3: Implement orchestration with injected adapters**

Sequence: validate, snapshot options, first duplicate check, mailbox baseline, resolve proxy, generate URL, browser email, poll OTP, browser OTP, validate callback, exchange, second duplicate check, create, confirm. Store only public transitions; hold all secrets in `SecretScope` and dispose them in `finally`.

- [x] **Step 4: Implement cancellation and uncertain-result handling**

Use `AbortController` for mailbox/browser work. Disable cancel once the create request begins. On an uncertain response, query by exact normalized email and never automatically replay create.

- [x] **Step 5: Run orchestration tests**

Run: `npm test -- tests/unit/state-machine.test.ts tests/integration/orchestrator.test.ts`

Expected: all orchestration tests pass.

### Task 8: Fastify Local API and Static Serving

**Files:**
- Create: `src/server/routes/auth.ts`
- Create: `src/server/routes/options.ts`
- Create: `src/server/routes/tasks.ts`
- Create: `src/server/app.ts`
- Create: `src/server/index.ts`
- Test: `tests/integration/local-api.test.ts`

- [x] **Step 1: Write failing local API tests**

Test bootstrap cookie issuance, CSRF enforcement, Origin rejection, login/TOTP/logout, sanitized session response, options refresh, one-task conflict, SSE events, cancel boundary, task history, unknown-field rejection, and secret scanning over every JSON/SSE response.

- [x] **Step 2: Run the API test and verify it fails**

Run: `npm test -- tests/integration/local-api.test.ts`

Expected: the app factory does not exist.

- [x] **Step 3: Implement the loopback-only Fastify application**

Register cookies, security headers, JSON body limits, local session hooks, API routes, SSE cleanup, and production static files from `dist/web`. `index.ts` refuses non-loopback hosts and prints the one-time bootstrap URL.

- [x] **Step 4: Run the API tests**

Run: `npm test -- tests/integration/local-api.test.ts`

Expected: all local API tests pass with no external network calls.

### Task 9: Vue Operational Interface

**Files:**
- Create: `index.html`
- Create: `src/web/main.ts`
- Create: `src/web/App.vue`
- Create: `src/web/api.ts`
- Create: `src/web/styles.css`
- Create: `src/web/views/TaskView.vue`
- Create: `src/web/views/HistoryView.vue`
- Create: `src/web/views/SettingsView.vue`
- Create: `src/web/components/TaskForm.vue`
- Create: `src/web/components/TaskProgress.vue`
- Create: `src/web/components/OptionSelect.vue`
- Create: `src/web/components/AccountResult.vue`
- Test: `tests/unit/web-state.test.ts`

- [x] **Step 1: Write failing frontend state tests**

Test default concurrency 10, exactly two text/password inputs in the task form model, proxy-mode dependent selections, locked model clearing, disabled start on missing session/options, secret fields cleared after submit, status rendering, and no token keys accepted by frontend API types.

- [x] **Step 2: Run the frontend state test and verify it fails**

Run: `npm test -- tests/unit/web-state.test.ts`

Expected: missing web state modules.

- [x] **Step 3: Build the task, history, and settings views**

Use a restrained operational layout with a compact sidebar, status bar, semantic form controls, Lucide icons, tooltips, explicit loading/empty/error states, and responsive tracks. The task form has only email and mailbox-password text entry; proxy, concurrency, supplier, and groups are selectors. “清除所有模型” is visibly locked on.

- [x] **Step 4: Implement API and SSE state handling**

Keep CSRF only in memory, clear mailbox password immediately after the start response, reconnect task events after a page refresh, and never render or log unknown response properties.

- [x] **Step 5: Verify frontend state and build**

Run: `npm test -- tests/unit/web-state.test.ts`

Run: `npm run build`

Expected: tests pass and `dist/web` plus `dist/server/index.js` are produced.

### Task 10: Documentation, QA, and Final Verification

**Files:**
- Create: `README.md`
- Create: `DOC.md`
- Create: `QA.md`
- Modify: `docs/TECHNICAL_DESIGN.md`
- Modify: `docs/superpowers/plans/2026-08-11-openai-oauth-account-tool.md`

- [x] **Step 1: Run the full non-page verification suite**

Run: `npm run typecheck`

Run: `npm run lint`

Run: `npm test`

Run: `npm run build`

Run: `npm audit --omit=dev`

Expected: typecheck, lint, tests, and build pass; audit findings are either zero or documented with exact impact.

- [x] **Step 2: Run security and artifact checks**

Search source, tests, docs, built assets, and test output for credentials, token-like strings, real mailbox addresses, `pwd` values, and forbidden OAuth fields in public contracts. Verify generated runtime directories use `0700` and database files use `0600`.

- [x] **Step 3: Write README and DOC from actual behavior**

Document install, Playwright Chromium installation, production build/start, bootstrap URL, settings login, TOTP, task options, manual intervention, logout, local history deletion, Keychain item, limitations, and recovery. Do not include any real credential.

- [x] **Step 4: Write QA from actual command output**

Record environment, test counts, exact commands, results, simulated scenarios, unexecuted real backend/mail/OpenAI tests, and residual risks. Do not claim page or real-account acceptance.

- [x] **Step 5: Update implementation status**

Mark the technical design as implemented only if every required non-page check passes. Mark all completed plan checkboxes and leave any unverified real-world acceptance explicitly open in QA.

- [x] **Step 6: Start the production server**

Run: `npm start`

Expected: the service binds only to `127.0.0.1`, prints a one-time bootstrap URL, and remains running for user evaluation.
