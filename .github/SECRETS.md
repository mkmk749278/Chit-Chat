# GitHub Secrets Classification

> Source of truth: product requirements `private-chat-app-requirements.md` §14.3 (GitHub Secrets —
> Complete Classification), mirrored by spec `design.md` §14.3 and Requirement 10 (CI/CD Pipelines
> and Secrets Management), acceptance criterion 10.5.

This document classifies every secret consumed by the Chit-Chat CI/CD pipelines into named
categories. It is **documentation only** — no real secret values appear here or anywhere in the
repository.

## Handling rules

- **Single source.** Every secret is stored exclusively in **GitHub repository (or organization)
  Secrets**. Zero plaintext secrets live in code or config files (Requirement 10.3).
- **Injected as environment variables.** Pipelines inject each secret as an environment variable at
  deploy time. The deploy step writes per-service `.env.{service}` files on the VPS from these env
  vars (design §14.5).
- **Never echoed in logs.** Secret values are masked and are never echoed to build or deploy log
  output. Pipelines pass secrets as env vars and never print them (Requirement 10.4).
- **Defined before any pipeline runs.** Categories **A, B, E, F, G, H, and I** MUST exist in
  repository/org secrets **before any pipeline runs** (Requirement 10.5). Categories **C** and **D**
  are noted below and are only required once the Android pipeline (`android.yml`) runs.

## Categories required before any pipeline runs

### Category A — VPS Access

| Secret Name | What It Is | Used In |
| --- | --- | --- |
| `VPS_SSH_KEY` | Private SSH key for VPS deployment user | backend.yml, web.yml, backup.yml |
| `VPS_HOST` | VPS IP address or hostname | All deploy pipelines |
| `VPS_USER` | SSH username on VPS (e.g. `deploy`) | All deploy pipelines |

### Category B — Firebase

| Secret Name | What It Is | Used In |
| --- | --- | --- |
| `FIREBASE_PROJECT_ID` | Firebase project ID | backend.yml (env var) |
| `FIREBASE_PRIVATE_KEY` | Firebase Admin SDK private key (JSON field) | backend.yml |
| `FIREBASE_CLIENT_EMAIL` | Firebase Admin SDK client email | backend.yml |
| `GOOGLE_SERVICES_JSON` | Full `google-services.json` (base64 encoded) | android.yml |

### Category E — Database

| Secret Name | What It Is | Used In |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection string (full URL with credentials) | backend.yml |
| `REDIS_URL` | Redis connection string | backend.yml |
| `PGBOUNCER_URL` | PgBouncer connection string | backend.yml |

### Category F — Storage

| Secret Name | What It Is | Used In |
| --- | --- | --- |
| `B2_KEY_ID` | Backblaze B2 application key ID | backend.yml, backup.yml |
| `B2_APPLICATION_KEY` | Backblaze B2 application key | backend.yml, backup.yml |
| `B2_BUCKET_NAME` | Main media bucket name | backend.yml |
| `B2_VIEWONCE_BUCKET_NAME` | View-once media bucket name | backend.yml |

### Category G — Monitoring & Alerting

| Secret Name | What It Is | Used In |
| --- | --- | --- |
| `SENTRY_DSN_BACKEND` | Sentry DSN for backend | backend.yml |
| `SENTRY_DSN_MOBILE` | Sentry DSN for mobile | android.yml |
| `SENTRY_DSN_WEB` | Sentry DSN for web | web.yml |
| `SENTRY_AUTH_TOKEN` | Sentry auth token for source map uploads | android.yml, web.yml |
| `GRAFANA_ADMIN_PASSWORD` | Grafana admin password | Set on VPS directly, not in Actions |

### Category H — Backup Encryption

| Secret Name | What It Is | Used In |
| --- | --- | --- |
| `BACKUP_GPG_KEY` | GPG private key for backup encryption | backup.yml |
| `BACKUP_GPG_PASSPHRASE` | GPG key passphrase | backup.yml |

### Category I — Application Security

| Secret Name | What It Is | Used In |
| --- | --- | --- |
| `JWT_SECRET` | App-level JWT signing secret (for any non-Firebase tokens) | backend.yml |
| `SHADOW_MASTER_KEY_SALT` | Salt for shadow thread ID derivation (server-side component) | backend.yml |
| `ENCRYPTION_KEY` | Server-side encryption key for metadata fields | backend.yml |

## Categories required later (Android pipeline only)

These categories are **not** required before the first backend/web pipeline run. They MUST exist
before the `android.yml` pipeline runs.

### Category C — Android Signing

| Secret Name | What It Is | Used In |
| --- | --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Release keystore file (base64 encoded) | android.yml |
| `ANDROID_KEY_ALIAS` | Key alias in the keystore | android.yml |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password | android.yml |
| `ANDROID_KEY_PASSWORD` | Key password | android.yml |

### Category D — Play Store

| Secret Name | What It Is | Used In |
| --- | --- | --- |
| `PLAY_STORE_JSON_KEY` | Google Play service account JSON (for Fastlane/API uploads) | android.yml |

## Summary

| Category | Name | Required before any pipeline runs? |
| --- | --- | --- |
| A | VPS Access | Yes |
| B | Firebase | Yes |
| C | Android Signing | No — required for the Android pipeline |
| D | Play Store | No — required for the Android pipeline |
| E | Database | Yes |
| F | Storage | Yes |
| G | Monitoring & Alerting | Yes |
| H | Backup Encryption | Yes |
| I | Application Security | Yes |
