# Requirements Document

## Introduction

This document specifies the requirements for **Phase 1 — Client Messaging (First Vertical Slice)** of the
privacy chat application. It defines the **client (app) side** that consumes the already-built Phase 0
backend. Work stays in the existing monorepo: `apps/mobile` (React Native / Expo), `apps/web` (Next.js),
with shared logic in `packages/types` and `packages/crypto`.

This slice is intentionally narrow and end-to-end buildable. It delivers, on **both** mobile and web:

1. Firebase Authentication sign-in to obtain a Firebase ID token (phone OTP is the primary method).
2. Local generation of the device's libsignal identity material (private keys never leave the device).
3. Device registration against the Phase 0 endpoint `POST /api/devices/register`, publishing only the
   **public** prekey bundle, and handling the documented `201 / 400 / 401 / 503` outcomes.
4. A persistent, authenticated WebSocket connection to the `ws.` endpoint using the
   `Sec-WebSocket-Protocol: ['bearer', idToken]` handshake (matching the Phase 0 `RealtimeGateway`), with
   heartbeat/pong handling and exponential-backoff reconnection.
5. Sending and receiving **one** 1:1 end-to-end encrypted text message between two users, encrypted with
   libsignal (Signal Protocol), ciphertext-only in transit.
6. Minimal UI on both platforms: a sign-in screen and a single conversation screen (message list +
   composer), with shared logic factored into packages where practical.
7. On-device encrypted storage of keys and session state: SQLCipher on mobile; web keeps session keys in
   JavaScript memory only and shows an honest ephemerality warning (product decisions D9 / D10).

All backend-facing behavior is aligned to the Phase 0 contracts in
`.kiro/specs/phase0-foundation/design.md` and `.kiro/specs/phase0-foundation/requirements.md`: the device
registration endpoint shape, the WebSocket `bearer` subprotocol handshake, the close codes `4401`
(unauthorized) and `4503` (auth dependency unavailable), and the public-keys-only constraint.

### Phase 1 backend dependency (called out explicitly)

The Phase 0 backend authenticates and tracks WebSocket connections but **does not yet route chat
messages** (Phase 0 Requirement 3.5). Therefore requirement 5 below defines **client behavior and the wire
contract the client expects** for 1:1 message send/receive. The actual server-side message-routing endpoint
is a **Phase 1 backend deliverable** and is a dependency of this slice. Where this document specifies the
message frame format, sequencing, and acknowledgements, it is defining the contract the client implements
and the server must satisfy.

### Explicitly out of scope (deferred)

Group messaging; media / attachments; the seven signature privacy features (hidden chats, shadow chat,
decoy PIN, ephemeral segments, self-destructing messages, view-once media, in-chat identity verification);
reactions / edit / delete; typing indicators; presence / last-seen; multi-device sync beyond a single
device; FCM push (noted as a follow-up); contact discovery; offline send queue and message gap detection;
optimistic-UI retry beyond a single in-session send.

## Glossary

- **Mobile_App**: The React Native (Expo) application in `apps/mobile`.
- **Web_App**: The Next.js application in `apps/web`.
- **Client_App**: Either the Mobile_App or the Web_App; a requirement attributed to the Client_App applies
  to both platforms unless a platform is named explicitly.
- **Auth_Service**: The client-side component (built on `@react-native-firebase/auth` for mobile and the
  Firebase Web SDK for web) that performs Firebase sign-in and yields a Firebase ID token.
- **Firebase ID token**: The JWT issued by Firebase Authentication on successful sign-in, sent to the
  backend as `Authorization: Bearer <token>` for REST and via the `bearer` WebSocket subprotocol.
- **Identity_Manager**: The shared `packages/crypto` component that generates and holds the device's
  libsignal identity material.
- **Identity material**: The libsignal identity key pair, registration id, signed prekey (key pair +
  signature), and one-time prekeys generated on the device.
- **Public prekey bundle**: The public-only subset of the identity material sent to the backend — public
  identity key, signed prekey public key and signature, and one-time prekey public keys.
- **Private key material**: The private halves of the identity key, signed prekey, and one-time prekeys,
  and any libsignal session secret. Never transmitted off the device.
- **Device_Registrar**: The shared client component that calls `POST /api/devices/register` and interprets
  the response.
- **Realtime_Client**: The shared client component that establishes and maintains the WebSocket connection
  to the `ws.` endpoint, runs the heartbeat, and reconnects.
- **Backend_API**: The Phase 0 NestJS backend (REST on the `api.` subdomain, WebSocket on the `ws.`
  subdomain).
- **Message_Session**: The libsignal session established between two devices that encrypts and decrypts 1:1
  messages.
- **Ciphertext envelope**: The wire frame carrying a libsignal-encrypted message between two users over the
  WebSocket, containing routing metadata and the ciphertext but no plaintext.
- **Key_Store**: The on-device storage holding identity material and session state — SQLCipher-encrypted
  SQLite on mobile; in-memory only on web.
- **Conversation_Screen**: The single-conversation UI showing a message list and a composer.
- **Sign_In_Screen**: The UI that collects the chosen Firebase sign-in input and triggers authentication.
- **Recipient_Identifier**: The Firebase UID of the other party in the 1:1 conversation, used as the
  routing address on the wire.
- **deviceId**: The server-issued device identifier returned by `POST /api/devices/register`, used to
  identify the WebSocket connection.

## Requirements

### Requirement 1: Firebase Sign-In and ID Token Acquisition

**User Story:** As a user, I want to sign in with Firebase on mobile and web, so that I obtain a Firebase ID
token that authenticates my device registration and my realtime connection.

#### Acceptance Criteria

1. WHEN the Client_App is launched on the Mobile_App or the Web_App and no valid Firebase ID token is
   present, THE Client_App SHALL present a Sign_In_Screen before any authenticated action is attempted.
2. WHERE phone OTP sign-in is selected, WHEN a user submits a phone number in E.164 format, THE Auth_Service
   SHALL request a one-time verification code through Firebase Authentication within 30 seconds and present
   an input field that accepts a 6-digit numeric code.
3. WHEN a user submits a 6-digit phone OTP verification code that matches the code issued by Firebase
   Authentication within its validity period, THE Auth_Service SHALL complete Firebase sign-in within 30
   seconds and obtain a Firebase ID token.
4. WHEN Firebase sign-in completes successfully, THE Auth_Service SHALL expose the current Firebase ID token
   and the signed-in user's Firebase UID to the Device_Registrar and the Realtime_Client.
5. IF a Firebase sign-in attempt fails because the submitted credential or verification code is rejected by
   Firebase Authentication, THEN THE Auth_Service SHALL keep the user on the Sign_In_Screen, SHALL retain the
   previously entered phone number, and SHALL display an error message that states the sign-in did not
   succeed.
6. WHEN the Backend_API rejects a request with HTTP 401 or closes a WebSocket with code 4401, THE
   Auth_Service SHALL refresh the Firebase ID token from Firebase Authentication, retrying at most 3 times,
   before the next authenticated request or reconnection attempt.
7. WHERE email/password or Google Sign-In is offered, THE Auth_Service SHALL obtain a Firebase ID token
   through the selected method using the same token-acquisition path consumed by the Device_Registrar and the
   Realtime_Client.
8. THE Auth_Service SHALL transmit the Firebase ID token only to the Backend_API `api.` and `ws.` endpoints
   over TLS and SHALL exclude the Firebase ID token value from application logs.
9. IF the Firebase ID token refresh fails on 3 consecutive attempts, THEN THE Auth_Service SHALL return the
   user to the Sign_In_Screen and SHALL display an error message that states re-authentication is required.
10. WHERE phone OTP sign-in is selected, WHEN a user requests a new verification code, THE Auth_Service SHALL
    permit at most 5 resend requests within any 60-minute window per phone number and SHALL reject additional
    requests with an error message indicating the resend limit has been reached.
11. IF a submitted phone OTP verification code is entered more than 300 seconds after its issuance, THEN THE
    Auth_Service SHALL reject the code, SHALL keep the user on the Sign_In_Screen, and SHALL display an error
    message indicating the code has expired.

### Requirement 2: Local libsignal Identity Generation

**User Story:** As a privacy-conscious user, I want my device to generate its own libsignal keys locally, so
that my private keys are created on my device and never leave it.

#### Acceptance Criteria

1. WHEN a Client_App completes first-time sign-in on a device that has no stored identity material, THE
   Identity_Manager SHALL generate exactly one libsignal identity key pair, one registration id, one signed
   prekey (key pair plus a signature over the signed prekey public key by the identity key), and one batch of
   one-time prekeys.
2. THE Identity_Manager SHALL generate a one-time prekey batch whose size is in the inclusive range of 1 to
   200 entries, matching the batch bounds accepted by the Backend_API.
3. THE Identity_Manager SHALL assign each generated signed prekey and one-time prekey a non-negative integer
   key id, SHALL assign a key id that is unique among all one-time prekeys within the same generated batch,
   and SHALL assign a registration id that is an integer of 1 or greater.
4. THE Identity_Manager SHALL retain Private key material only within the Key_Store on the device and SHALL
   NOT include any Private key material in any value passed to the Device_Registrar or the Realtime_Client.
5. THE Identity_Manager SHALL expose a Public prekey bundle containing only the public identity key, the
   signed prekey public key and its signature, and the one-time prekey public keys, each encoded as base64.
6. WHEN identity material already exists in the Key_Store for the signed-in user on a device, THE
   Identity_Manager SHALL reuse the existing identity material rather than generating a new identity key pair
   or registration id.
7. IF generation of any required key material fails before the complete identity set (identity key pair,
   registration id, signed prekey, and one-time prekey batch) is produced, THEN THE Identity_Manager SHALL
   NOT persist any partial identity material to the Key_Store and SHALL return an error indicating that
   identity generation failed.
8. IF identity material is persisted to the Key_Store, THEN THE Identity_Manager SHALL store the complete
   identity set such that no partial or incomplete identity material remains in the Key_Store.

### Requirement 3: Device Registration with the Phase 0 Backend

**User Story:** As a signed-in user, I want my device to register its public prekey bundle with the backend,
so that other users can establish an end-to-end encrypted session to my device.

#### Acceptance Criteria

1. WHEN a Client_App holds a Firebase ID token and a generated Public prekey bundle, THE Device_Registrar
   SHALL send `POST /api/devices/register` to the `api.` endpoint with the header
   `Authorization: Bearer <Firebase ID token>` and a JSON body containing `registrationId`, `identityKey`,
   `signedPreKey` (with `keyId`, `publicKey`, and `signature`), `oneTimePreKeys` (a collection of between 1
   and 200 entries, each with `keyId` and `publicKey`), and an optional `deviceName` of at most 64
   characters.
2. THE Device_Registrar SHALL include only public key material in the registration request body and SHALL
   exclude all Private key material from the request.
3. WHEN the Backend_API responds with HTTP 201 and a `deviceId`, THE Device_Registrar SHALL persist the
   `deviceId` in the Key_Store and SHALL make the `deviceId` available to the Realtime_Client.
4. IF the Backend_API responds with HTTP 401, THEN THE Device_Registrar SHALL discard the current Firebase ID
   token, trigger an Auth_Service token refresh, and retry registration at most once with the refreshed
   token before surfacing a sign-in-required state to the user.
5. IF the Backend_API responds with HTTP 400, THEN THE Device_Registrar SHALL surface a registration-failed
   state to the user, SHALL record the field identified by the response as invalid, and SHALL NOT retry the
   request with the same payload.
6. IF the Backend_API responds with HTTP 503, THEN THE Device_Registrar SHALL retry registration using
   exponential backoff that starts at 500 milliseconds, is capped at 30 seconds per interval, and includes
   randomised jitter, until a non-503 response is received or until a cumulative retry duration of 5 minutes
   has elapsed.
7. WHEN a device registration has already succeeded and a stored `deviceId` exists for the signed-in user on
   the device, THE Device_Registrar SHALL NOT issue a new registration request on subsequent app launches
   unless the stored identity material or `deviceId` is absent.
8. IF no HTTP response to a registration request is received within 10 seconds of sending it, THEN THE
   Device_Registrar SHALL cancel the in-flight request and retry registration using the exponential backoff
   defined in criterion 6, retaining the unsent prekey bundle for reuse.
9. IF the cumulative retry duration in criterion 6 elapses or 503 responses persist beyond that duration,
   THEN THE Device_Registrar SHALL surface a service-unavailable state to the user and SHALL NOT discard the
   generated prekey bundle.

### Requirement 4: Authenticated WebSocket Connection and Lifecycle

**User Story:** As a connected user, I want a persistent authenticated realtime connection, so that messages
can be delivered without polling and the connection survives transient network drops.

#### Acceptance Criteria

1. WHEN a Client_App holds a valid Firebase ID token and a registered `deviceId`, THE Realtime_Client SHALL
   open a WebSocket connection to the `ws.` endpoint over TLS using the `Sec-WebSocket-Protocol` value
   `['bearer', <Firebase ID token>]`.
2. THE Realtime_Client SHALL transmit the Firebase ID token only through the `bearer` subprotocol handshake
   and SHALL NOT place the Firebase ID token in the connection URL query string.
3. WHEN the Backend_API sends a heartbeat ping over the WebSocket, THE Realtime_Client SHALL respond with a
   pong within 5 seconds so that the connection is retained by the gateway.
4. IF the WebSocket connection closes with code 4401, THEN THE Realtime_Client SHALL trigger an Auth_Service
   token refresh and, upon successful refresh, SHALL attempt to reconnect using the refreshed Firebase ID
   token.
5. IF the WebSocket connection closes with code 4503, THEN THE Realtime_Client SHALL reconnect using
   exponential backoff that starts at 500 milliseconds, is capped at 30 seconds, and includes randomised
   jitter.
6. IF the WebSocket connection closes or fails for any reason other than a deliberate client-initiated
   disconnect, THEN THE Realtime_Client SHALL attempt to reconnect using exponential backoff that starts at
   500 milliseconds, is capped at 30 seconds, and includes randomised jitter.
7. WHILE the WebSocket connection is open, THE Realtime_Client SHALL expose a connected status to the
   Conversation_Screen, and WHILE the connection is closed or reconnecting THE Realtime_Client SHALL expose a
   disconnected status to the Conversation_Screen.
8. WHEN the user signs out, THE Realtime_Client SHALL perform a client-initiated disconnect and SHALL NOT
   attempt automatic reconnection until a new sign-in completes.
9. IF the Auth_Service token refresh triggered by a 4401 close fails, THEN THE Realtime_Client SHALL stop
   reconnection attempts, SHALL expose a disconnected status to the Conversation_Screen, and SHALL surface an
   indication that re-authentication is required.
10. IF the WebSocket handshake does not complete within 10 seconds of the open attempt, THEN THE
    Realtime_Client SHALL terminate the pending connection, expose a disconnected status to the
    Conversation_Screen, and treat the attempt as a connection failure subject to the exponential backoff
    reconnection in criterion 6.
11. WHILE no pong is sent in response to a heartbeat ping within 5 seconds, THE Realtime_Client SHALL treat
    the connection as failed, expose a disconnected status to the Conversation_Screen, and initiate
    reconnection subject to the exponential backoff in criterion 6.

### Requirement 5: Send and Receive One 1:1 End-to-End Encrypted Text Message

**User Story:** As a user, I want to send and receive a 1:1 text message that only the recipient can read, so
that my conversation is end-to-end encrypted and the server never sees plaintext.

> Note: routing of the Ciphertext envelope between users is a Phase 1 **backend** deliverable and a
> dependency of this slice. The criteria below define the client behavior and the wire contract the client
> implements and the server must satisfy.

#### Acceptance Criteria

1. WHEN a user opens a conversation with a Recipient_Identifier and no Message_Session yet exists, THE
   Client_App SHALL establish a libsignal Message_Session using the recipient's Public prekey bundle before
   encrypting the first message.
2. WHEN a user submits text in the Conversation_Screen composer, THE Client_App SHALL encrypt the plaintext
   with libsignal into a Ciphertext envelope addressed to the Recipient_Identifier and SHALL send the
   Ciphertext envelope over the open WebSocket connection.
3. THE Client_App SHALL include in the Ciphertext envelope only the routing metadata (sender Firebase UID,
   Recipient_Identifier, sender `deviceId`, and a per-conversation monotonic sequence number) and the
   libsignal ciphertext, and SHALL exclude the message plaintext from the Ciphertext envelope.
4. WHEN the Client_App receives a Ciphertext envelope addressed to the signed-in user over the WebSocket, THE
   Client_App SHALL decrypt the ciphertext with libsignal and SHALL render the resulting plaintext in the
   Conversation_Screen message list.
5. IF a received Ciphertext envelope fails libsignal decryption, THEN THE Client_App SHALL NOT render
   plaintext for that envelope and SHALL display a delivery-error indication for that message.
6. WHEN a sent message is acknowledged as received by the Backend_API, THE Client_App SHALL update that
   message's status in the Conversation_Screen from sending to sent.
7. THE Client_App SHALL transmit message content only as libsignal ciphertext within the Ciphertext
   envelope and SHALL NOT transmit message plaintext to the Backend_API.
8. THE Client_App SHALL persist the libsignal Message_Session state required to decrypt subsequent messages
   in the Key_Store after the first message is sent or received.
9. IF establishing the libsignal Message_Session fails — because the recipient's Public prekey bundle cannot
   be retrieved or the session cannot be established within 10 seconds — THEN THE Client_App SHALL transmit
   neither plaintext nor ciphertext for the pending message, SHALL retain the composed text, and SHALL
   display an error indication for that message.
10. IF a user submits a message WHILE the WebSocket connection is not open, THEN THE Client_App SHALL hold
    the message in a pending-send state showing a sending status and SHALL transmit it once the connection is
    re-established.
11. IF a sent message is not acknowledged by the Backend_API within 30 seconds, THEN THE Client_App SHALL
    transition that message's status from sending to failed and SHALL display a delivery-error indication.

### Requirement 6: Minimal Conversation User Interface

**User Story:** As a user, I want a sign-in screen and a single conversation screen on both platforms, so
that I can sign in and exchange a message with shared logic across mobile and web.

#### Acceptance Criteria

1. THE Client_App SHALL provide a Sign_In_Screen and a Conversation_Screen on both the Mobile_App and the
   Web_App.
2. THE Conversation_Screen SHALL render a message list that displays each sent and received message exactly
   once, ordered by ascending per-conversation sequence number, with each list entry showing the message
   plaintext and that message's current status.
3. THE Conversation_Screen SHALL provide a composer that accepts a text input of 1 to 4096 characters and a
   send control that, when activated, submits the entered text to the Client_App send path defined in
   Requirement 5.
4. WHILE the composer contains no character other than whitespace, THE Conversation_Screen SHALL keep the
   send control in a disabled state that does not submit any text.
5. WHEN a message send is in progress, THE Conversation_Screen SHALL display a sending status for that
   message, and WHEN the send is acknowledged THE Conversation_Screen SHALL display a sent status for that
   message.
6. WHILE the Realtime_Client reports a disconnected status, THE Conversation_Screen SHALL display a
   connection indicator that shows the connection is not currently established, and WHILE the Realtime_Client
   reports a connected status, THE Conversation_Screen SHALL display a connection indicator that shows the
   connection is established.
7. THE Client_App SHALL implement the sign-in, registration, connection, encryption, and send/receive logic
   in the shared `packages/types` and `packages/crypto` packages such that the Mobile_App and the Web_App
   consume the same shared logic for these behaviors.
8. IF the Client_App reports that a message send failed, THEN THE Conversation_Screen SHALL display a failed
   status for that message and SHALL retain the message's text in the message list so that it is not
   discarded.
9. WHEN the Client_App reports a delivery-error for a received Ciphertext envelope as defined in Requirement
   5, THE Conversation_Screen SHALL display a delivery-error indication for that message and SHALL NOT
   display plaintext for it.

### Requirement 7: On-Device Encrypted Storage of Keys and Session State

**User Story:** As a privacy-conscious user, I want my keys and session state stored securely on my device,
so that my private material is protected at rest and the web client honestly discloses its limits.

#### Acceptance Criteria

1. THE Mobile_App SHALL store all identity material, session state, and the `deviceId` in a
   SQLCipher-encrypted SQLite Key_Store, and SHALL NOT write Private key material to any storage location
   outside the SQLCipher-encrypted Key_Store.
2. THE Web_App SHALL hold identity material and session state in JavaScript memory only, and SHALL NOT write
   Private key material to `localStorage`, `sessionStorage`, IndexedDB, Cache Storage, Web SQL, cookies, or
   any other persistent web storage mechanism.
3. WHEN the Web_App is first prepared for use in a session, THE Web_App SHALL display a warning message that
   explicitly states both (a) session keys exist only in memory and (b) historical messages become
   unreadable once the session ends, consistent with product decisions D9 and D10.
4. WHEN the Web_App session ends through page unload, tab close, or sign-out, THE Web_App SHALL discard the
   in-memory identity material and session state within the same event-handling cycle, such that no identity
   material or session state remains retrievable from JavaScript memory or any web storage mechanism
   afterward.
5. WHERE a device is lost or the Web_App session ends, THE Client_App SHALL NOT provide a key-backup or
   key-recovery path, preserving forward secrecy in accordance with product decision D9.
6. IF the Mobile_App cannot initialize, open, or decrypt the SQLCipher-encrypted Key_Store, THEN THE
   Mobile_App SHALL NOT write identity material, session state, or the `deviceId` to any unencrypted storage,
   SHALL retain no Private key material in persistent storage, and SHALL display an error indicating that
   secure storage is unavailable.
7. WHEN the Web_App displays the warning described in criterion 3, THE Web_App SHALL keep the warning visible
   until the user performs an explicit acknowledgment action, and SHALL NOT enable sending or receiving of
   messages until that acknowledgment is recorded.

### Requirement 8: Security and Compliance Constraints

**User Story:** As a security and compliance owner, I want the client slice to enforce the project's hard
privacy and Google Play constraints, so that the client stays end-to-end-encryption-safe and policy
compliant.

#### Acceptance Criteria

1. THE Client_App SHALL transmit only public key material and libsignal ciphertext to the Backend_API and
   SHALL provide no code path by which Private key material is sent off the device.
2. THE Client_App SHALL transmit 1:1 message content only as libsignal ciphertext and SHALL NOT transmit
   message plaintext to the Backend_API or any other network endpoint.
3. WHILE the Web_App has not recorded the user's acknowledgment of the in-memory-only ephemerality warning
   defined in Requirement 7, THE Web_App SHALL NOT enable sending or receiving of messages; WHEN that
   acknowledgment is recorded THE Web_App SHALL enable messaging.
4. THE Client_App SHALL NOT declare in its Android manifest, nor request at runtime, the Android SMS
   permission, the Android Call Log permission, an Android Accessibility Service, or the `QUERY_ALL_PACKAGES`
   permission.
5. THE Client_App SHALL exclude Firebase ID token values and Private key material from all application logs,
   error reports, and any off-device diagnostic data.
6. WHEN the Client_App connects to the Backend_API, THE Client_App SHALL use TLS for the `api.` and `ws.`
   endpoints and SHALL NOT transmit to those endpoints over any non-TLS channel.
7. IF a TLS connection to the `api.` or `ws.` endpoint cannot be established, THEN THE Client_App SHALL abort
   the request or connection without transmitting any payload, Firebase ID token, or key material, and SHALL
   surface a connection-error state.
