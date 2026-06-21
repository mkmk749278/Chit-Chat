/**
 * FirebaseAdminService — design Component 1 (Requirement 8.1, 8.2, 8.3, 8.6, 8.7).
 *
 * Wraps the Firebase Admin SDK so token verification has a single, testable home.
 *
 * Lifecycle:
 *   - Initializes the Admin SDK **exactly once** at startup (`onModuleInit`) from
 *     `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY`
 *     read through the typed {@link AppConfigService} (Requirement 8.1).
 *   - Fails initialization — aborting startup before any token verification request
 *     is served — if any of those credentials is missing or invalid (Requirement 8.7).
 *
 * Verification:
 *   - `verifyIdToken` validates the token signature and expiration and performs
 *     revocation checking against the Firebase Admin API (Requirement 8.2).
 *   - On success it returns a {@link DecodedFirebaseToken} carrying the canonical
 *     Firebase UID (Requirement 8.6).
 *   - Any failure is translated into a domain {@link UnauthorizedError}; Firebase SDK
 *     internals are never propagated to the caller-facing error (Requirement 8.3).
 */

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type App, cert, deleteApp, getApps, initializeApp } from 'firebase-admin/app';
import { type Auth, type DecodedIdToken, getAuth } from 'firebase-admin/auth';
import type { DecodedFirebaseToken } from '@chat-app/types';

import { AppConfigService } from '../config';
import { UnauthorizedError } from './unauthorized.error';

/**
 * Unique name for the backend's Admin SDK app instance. Naming the app (rather than
 * using the unnamed default) lets us detect a pre-existing instance and guarantee the
 * SDK is initialized exactly once (Requirement 8.1), and keeps it isolated from any
 * other Firebase app that might be created in tests.
 *
 * Exported so other backend services that need the SAME initialized Admin app (e.g. the FCM push
 * sender via `firebase-admin/messaging`) can resolve it by name rather than re-initializing it.
 */
export const FIREBASE_APP_NAME = 'chat-backend';

@Injectable()
export class FirebaseAdminService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseAdminService.name);

  /** The initialized Admin SDK app; set once during {@link onModuleInit}. */
  private app?: App;

  /** Cached Auth instance bound to {@link app}. */
  private auth?: Auth;

  constructor(private readonly config: AppConfigService) {}

  /**
   * Initializes the Admin SDK exactly once at startup. Throwing here aborts NestJS
   * bootstrap, so the Backend_API never accepts a token-verification request with a
   * missing or invalid credential set (Requirements 8.1, 8.7).
   */
  onModuleInit(): void {
    this.initialize();
  }

  /**
   * Builds (or reuses) the named Admin SDK app from the injected credentials.
   *
   * Idempotent: if the named app already exists (e.g. a prior init in the same
   * process), it is reused rather than re-created, preserving the exactly-once
   * guarantee (Requirement 8.1).
   */
  private initialize(): void {
    if (this.app) {
      return;
    }

    const credential = this.buildCredential();

    const existing = getApps().find((app) => app.name === FIREBASE_APP_NAME);
    this.app =
      existing ??
      initializeApp(
        {
          credential: cert({
            projectId: credential.projectId,
            clientEmail: credential.clientEmail,
            privateKey: credential.privateKey,
          }),
          projectId: credential.projectId,
        },
        FIREBASE_APP_NAME,
      );

    this.auth = getAuth(this.app);
    this.logger.log('Firebase Admin SDK initialized');
  }

  /**
   * Reads and validates the three Admin SDK credentials. Throws when any is missing
   * or structurally invalid so initialization fails fast (Requirement 8.7).
   *
   * `FIREBASE_PRIVATE_KEY` is commonly stored with literal `\n` escape sequences
   * (e.g. in CI secrets and `.env` files); those are converted back into real
   * newlines so the PEM block parses correctly.
   */
  private buildCredential(): {
    projectId: string;
    clientEmail: string;
    privateKey: string;
  } {
    const projectId = this.config.firebaseProjectId?.trim();
    const clientEmail = this.config.firebaseClientEmail?.trim();
    const rawPrivateKey = this.config.firebasePrivateKey;

    const missing: string[] = [];
    if (!projectId) {
      missing.push('FIREBASE_PROJECT_ID');
    }
    if (!clientEmail) {
      missing.push('FIREBASE_CLIENT_EMAIL');
    }
    if (!rawPrivateKey || rawPrivateKey.trim().length === 0) {
      missing.push('FIREBASE_PRIVATE_KEY');
    }

    if (missing.length > 0) {
      throw new Error(
        `Firebase Admin SDK initialization failed: missing credential(s): ${missing.join(', ')}`,
      );
    }

    const privateKey = this.normalizePrivateKey(rawPrivateKey);
    if (!this.looksLikePem(privateKey)) {
      throw new Error(
        'Firebase Admin SDK initialization failed: FIREBASE_PRIVATE_KEY is not a valid PEM-encoded private key',
      );
    }

    return {
      projectId: projectId as string,
      clientEmail: clientEmail as string,
      privateKey,
    };
  }

  /** Converts escaped `\n` sequences in the private key into real newlines. */
  private normalizePrivateKey(privateKey: string): string {
    return privateKey.replace(/\\n/g, '\n');
  }

  /** Minimal structural check that the value is a PEM private-key block. */
  private looksLikePem(privateKey: string): boolean {
    return (
      privateKey.includes('-----BEGIN') &&
      privateKey.includes('PRIVATE KEY-----') &&
      privateKey.includes('-----END')
    );
  }

  /**
   * Verifies a Firebase ID token.
   *
   * Delegates to the Admin SDK with revocation checking enabled, so the signature,
   * expiration, and revocation status are all validated (Requirement 8.2). On success
   * the decoded claims are mapped onto the transport-neutral {@link DecodedFirebaseToken}
   * (Requirement 8.6).
   *
   * Every failure path — empty token, malformed token, expired, revoked, or any SDK
   * error — is collapsed into a domain {@link UnauthorizedError}; the underlying SDK
   * error is retained only as the (internal) {@link UnauthorizedError.cause}
   * (Requirement 8.3).
   */
  async verifyIdToken(idToken: string): Promise<DecodedFirebaseToken> {
    if (typeof idToken !== 'string' || idToken.trim().length === 0) {
      throw new UnauthorizedError('Invalid authentication token');
    }

    const auth = this.requireAuth();

    let decoded: DecodedIdToken;
    try {
      // Second arg `checkRevoked = true` enables revocation checking against the
      // Firebase Admin API in addition to signature + expiration validation.
      decoded = await auth.verifyIdToken(idToken, true);
    } catch (err) {
      // Never surface SDK error codes / messages to the caller (Requirement 8.3).
      throw new UnauthorizedError('Invalid authentication token', { cause: err });
    }

    return this.toDecodedFirebaseToken(decoded);
  }

  /** Maps the SDK's `DecodedIdToken` onto the shared {@link DecodedFirebaseToken}. */
  private toDecodedFirebaseToken(decoded: DecodedIdToken): DecodedFirebaseToken {
    return {
      uid: decoded.uid,
      ...(decoded.email !== undefined ? { email: decoded.email } : {}),
      ...(decoded.phone_number !== undefined ? { phoneNumber: decoded.phone_number } : {}),
      exp: decoded.exp,
      authTime: decoded.auth_time,
    };
  }

  /**
   * Returns the initialized Auth instance, lazily initializing if `onModuleInit` has
   * not yet run (defensive — verification must never proceed on an uninitialized SDK).
   */
  private requireAuth(): Auth {
    if (!this.auth) {
      this.initialize();
    }
    if (!this.auth) {
      // Unreachable in practice: initialize() either sets `auth` or throws.
      throw new Error('Firebase Admin SDK is not initialized');
    }
    return this.auth;
  }
}

/**
 * Internal helper exported for test teardown: removes the named Admin SDK app so each
 * test starts from a clean slate. Not part of the runtime contract.
 */
export async function deleteFirebaseApp(): Promise<void> {
  const existing = getApps().find((app) => app.name === FIREBASE_APP_NAME);
  if (existing) {
    await deleteApp(existing);
  }
}
