import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

/**
 * Repository smoke/static checks (tasks 8.5, 8.6) that ride the crypto `node --test`
 * step so they run in CI without any device toolchain. The repo root is resolved from
 * this compiled file's location (`packages/crypto/dist`), not the cwd, so the checks are
 * stable regardless of where the test runner is invoked.
 */
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

/** Recursively collect source files under `dir` (skipping build/dep output). */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next' || entry === 'build') {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Whether any file under `dir` imports one of the shared `@chat-app/*` packages. */
function importsSharedPackage(dir: string): boolean {
  return sourceFiles(dir).some((file) => {
    const text = readFileSync(file, 'utf8');
    return text.includes('@chat-app/crypto') || text.includes('@chat-app/types');
  });
}

// Task 8.6 — both apps consume the shared packages (Requirement 6.7).
test('8.6: the web app imports the shared @chat-app packages', () => {
  assert.ok(
    importsSharedPackage(join(REPO_ROOT, 'apps', 'web', 'app')),
    'apps/web should import @chat-app/crypto or @chat-app/types',
  );
});

test('8.6: the mobile app imports the shared @chat-app packages', () => {
  assert.ok(
    importsSharedPackage(join(REPO_ROOT, 'apps', 'mobile', 'src')),
    'apps/mobile should import @chat-app/crypto or @chat-app/types',
  );
});

// Task 8.5 / Requirement 8.4 — the Android config declares none of the restricted
// Google Play capabilities.
test('8.5: the Android app declares no restricted permissions (8.4)', () => {
  const appJson = readFileSync(join(REPO_ROOT, 'apps', 'mobile', 'app.json'), 'utf8');
  const config = JSON.parse(appJson) as {
    expo?: { android?: { permissions?: unknown } };
  };

  const FORBIDDEN = [/SMS/i, /CALL_LOG/i, /ACCESSIBILITY/i, /QUERY_ALL_PACKAGES/i];

  // 1. No restricted capability appears anywhere in the Expo config.
  for (const pattern of FORBIDDEN) {
    assert.ok(!pattern.test(appJson), `app.json must not reference ${pattern}`);
  }

  // 2. If an explicit android.permissions array is present, it excludes them too.
  const permissions = config.expo?.android?.permissions;
  if (Array.isArray(permissions)) {
    for (const perm of permissions) {
      assert.ok(
        typeof perm === 'string' && !FORBIDDEN.some((p) => p.test(perm)),
        `android.permissions must not include a restricted capability: ${String(perm)}`,
      );
    }
  }
});
