# Deployment guide (branch strategy & CI/CD)

Operational reference for deploying the GPlay Cloud Functions. For the quick overview see the
**"Estrategia de branches y despliegue"** section in [../README.md](../README.md).

## Branch → environment model

```
feature/* ──PR──▶ development ──(push/merge)──▶ GitHub Action ──▶ DEV  (g-play-dd31d)
                       │
                       └──PR "release"──▶ main ──(push/merge)──▶ GitHub Action ──▶ PROD (g-play-dev-e4c4c)
```

| Branch        | Firebase project      | Alias  | Deploys via                         |
| ------------- | --------------------- | ------ | ----------------------------------- |
| `development` | `g-play-dd31d` (DEV)  | `dev`  | `.github/workflows/deploy-dev.yml`  |
| `main`        | `g-play-dev-e4c4c` (PROD) | `prod` | `.github/workflows/deploy-prod.yml` |

Rules:
- All work happens on short-lived `feature/*` (or `chore/*`, `fix/*`) branches off
  `development`, merged back via PR.
- Promote to production with a PR from `development` → `main`. Merging it triggers the PROD deploy.
- **No direct pushes** to `development` or `main` (enforce with branch protection, below).
- `main` always reflects what is live in production.

## How the CI/CD works

Each workflow ([deploy-dev.yml](../.github/workflows/deploy-dev.yml) /
[deploy-prod.yml](../.github/workflows/deploy-prod.yml)) runs on push to its branch (only when
`functions/**`, `firebase.json`, or `.firebaserc` change) and also supports **manual runs**
(`workflow_dispatch`, from the Actions tab). *Caveat:* GitHub only lists a workflow for manual
dispatch once its file exists on the **default branch** (`main`) — until the first
`development` → `main` promotion, trigger the DEV deploy with a push (any PR merged into
`development` touching `functions/**`), or re-run a previous run with `gh run rerun <id>`. Each job: checkout → Node 22 → `npm ci` → lint →
write `functions/.env` from GitHub secrets → authenticate with a service-account key → `firebase
deploy --only functions --project <alias> --non-interactive`.

`functions/.env` is gitignored, so CI generates it fresh from secrets on every run — this mirrors
how the 1st-gen functions read `process.env` locally today.

## One-time setup (required before CI can deploy)

### 1. Service accounts (one per project)
In each Google Cloud project, create a service account for CI (e.g. `github-deploy`) and grant
it these roles **on the IAM page** (IAM & Admin → IAM — *not* the Service Accounts page, whose
"Permissions" tab grants others access to the account instead):
- **Cloud Functions Admin** (`roles/cloudfunctions.admin`)
- **Service Account User** (`roles/iam.serviceAccountUser`)
- **Artifact Registry Administrator** (`roles/artifactregistry.admin`)
- **Cloud Build Editor** (`roles/cloudbuild.builds.editor`)
- **Firebase Viewer** (`roles/firebase.viewer`) — the CLI reads the project's `adminSdkConfig`
  before deploying; without it the deploy fails immediately with a 403
- **Cloud Scheduler Admin** (`roles/cloudscheduler.admin`) — upserts the cron jobs behind
  `pubsub.schedule(...)` functions; without it the 6 scheduled functions fail with
  `cloudscheduler.jobs.update` 403s
- **Pub/Sub Editor** (`roles/pubsub.editor`) — creates the topic that pairs with each *new*
  scheduled function

(This is the complete list verified against the first real DEV deploy on 2026-07-07 — the first
four alone are not enough. IAM changes can take a minute or two to propagate before a rerun.)

Download a JSON key for each.

### 2. GitHub repository secrets
Settings → Secrets and variables → Actions → New repository secret:

| Secret                       | Value                                             |
| ---------------------------- | ------------------------------------------------- |
| `DEV_FIREBASE_SA_KEY`        | DEV service-account JSON (whole file contents)    |
| `PROD_FIREBASE_SA_KEY`       | PROD service-account JSON                         |
| `DEV_STRIPE_SECRET`          | DEV Stripe secret (`sk_test_…`)                   |
| `DEV_STRIPE_WEBHOOK_SECRET`  | DEV Stripe webhook signing secret                 |
| `DEV_APPLE_SHARED_SECRET`    | DEV Apple shared secret                           |
| `PROD_STRIPE_SECRET`         | PROD Stripe secret (`sk_live_…`)                  |
| `PROD_STRIPE_WEBHOOK_SECRET` | PROD Stripe webhook signing secret                |
| `PROD_APPLE_SHARED_SECRET`   | PROD Apple shared secret                          |

(Take the DEV values from your local `functions/.env`; get PROD values from the Stripe live
dashboard and App Store Connect.)

### 3. Branch protection
Settings → Branches → add rules for `main` and `development`:
- Require a pull request before merging.
- (Optional) Require the deploy workflow / a lint status check to pass.
- Disallow direct pushes.

## First PROD cutover — do this carefully (one time)

Production currently runs old code that reads secrets via the deprecated `functions.config()`.
`main`'s new code reads `process.env` (Node 22 + firebase-functions v7 / firebase-admin v13).
The first promotion is therefore a real migration:

1. **Confirm the `PROD_*` secrets are set** in GitHub (step 2). Without them the new code has no
   Stripe/Apple credentials and payments break.
2. **Do the first deploy in a controlled way**: run `deploy-prod.yml` manually
   (`workflow_dispatch`) — or one manual CLI deploy — and validate *before* relying on the
   merge trigger.
3. **Smoke-test PROD** with the Postman collection ([gplay-dev.postman_collection.json](gplay-dev.postman_collection.json)),
   setting `baseUrl` to `https://us-central1-g-play-dev-e4c4c.cloudfunctions.net`. `checkEmail`
   returning `200` confirms admin/Firestore/secrets are wired.
4. **Update the Stripe (live) webhook endpoint** to the PROD `stripeWebhook` URL and confirm
   `PROD_STRIPE_WEBHOOK_SECRET` matches that endpoint's signing secret.
5. **Coordinate with the `gplay_24` app** so production points at the PROD function URLs.

## Manual fallback (if CI is unavailable)

```bash
nvm use                                            # Node 22 (.nvmrc)
firebase deploy --only functions --project dev     # → DEV
firebase deploy --only functions --project prod    # → PROD  (needs local functions/.env w/ prod values)
```

Always verify the target first with `firebase use`.
