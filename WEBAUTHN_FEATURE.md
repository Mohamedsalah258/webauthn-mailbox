# WebAuthn Passkey Authentication — Feature Documentation

## Overview

This document describes the WebAuthn (FIDO2) passkey authentication feature implemented in the Secure Mailbox web application. It is intended to help developers understand the architecture and replicate or integrate the same flow in other platforms (mobile, desktop, etc.).

---

## What Was Built

A passwordless authentication system using **WebAuthn / FIDO2 passkeys**. Instead of passwords, users authenticate using their device's biometrics (fingerprint, Face ID, Windows Hello, etc.).

**Key properties:**
- No passwords stored anywhere
- Each account is locked to one web browser profile (one passkey per platform)
- Works across mobile and web with separate passkeys per platform
- Device fingerprinting adds an extra layer to prevent multi-account abuse on the same device
- JWT-based session management after authentication

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express |
| WebAuthn Server | `@simplewebauthn/server` v9.0.3 |
| WebAuthn Browser | `@simplewebauthn/browser` (CDN ESM, latest) |
| Database ORM | Prisma |
| Database (local dev) | SQLite |
| Database (production) | PostgreSQL (Railway) |
| Session | JWT via httpOnly cookie |
| Deployment | Railway |

---

## Database Schema

```prisma
model User {
  id               String       @id @default(cuid())
  username         String       @unique
  currentChallenge String?
  credentials      Credential[]
  createdAt        DateTime     @default(now())
}

model Credential {
  id           String   @id @default(cuid())
  credentialId String   @unique
  publicKey    Bytes
  counter      Int      @default(0)
  platform     String   @default("WEB_PASSKEY")
  transports   String?
  deviceId     String?
  userId       String
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  createdAt    DateTime @default(now())
}
```

**Important fields:**
- `credentialId` — the unique ID returned by the authenticator (stored as base64url string)
- `publicKey` — the public key bytes from the authenticator
- `counter` — increments on every authentication (replay attack prevention)
- `platform` — `"WEB_PASSKEY"` for web, `"MOBILE"` for mobile app
- `deviceId` — SHA-256 hash of hardware fingerprint signals (see Device Fingerprinting section)
- `currentChallenge` — temporary challenge stored during auth flow, cleared after use

---

## Authentication Flow

### Registration Flow

```
Browser                          Server                        Database
  |                                |                               |
  |-- POST /auth/register/start -->|                               |
  |   { username, deviceId }       |-- check deviceId not taken -->|
  |                                |-- find or create user ------->|
  |                                |-- check no WEB_PASSKEY exists>|
  |                                |-- generateRegistrationOptions |
  |                                |-- save challenge to user ---->|
  |<-- { options } ----------------|                               |
  |                                |                               |
  | [browser shows biometric prompt]                              |
  |                                |                               |
  |-- POST /auth/register/finish ->|                               |
  |   { username, credential,      |-- verifyRegistrationResponse  |
  |     deviceId }                 |-- save credential+deviceId -->|
  |<-- { success: true } ----------|-- clear challenge ----------->|
```

### Login Flow

```
Browser                          Server                        Database
  |                                |                               |
  |-- POST /auth/login/start ----->|                               |
  |   { username }                 |-- find user + credentials --->|
  |                                |-- generateAuthenticationOptions
  |                                |-- save challenge ------------>|
  |<-- { options } ----------------|                               |
  |                                |                               |
  | [browser shows biometric prompt]                              |
  |                                |                               |
  |-- POST /auth/login/finish ---->|                               |
  |   { credential }               |-- find credential by id ----->|
  |                                |-- verifyAuthenticationResponse|
  |                                |-- update counter ------------>|
  |                                |-- clear challenge ----------->|
  |<-- { success, username } ------|                               |
  |                                |                               |
  | [JWT cookie set, mailbox shown]|                               |
```

---

## API Endpoints

### `POST /auth/register/start`
**Body:** `{ username: string, deviceId: string }`

**Returns:** WebAuthn registration options (JSON)

**Logic:**
1. Checks if `deviceId` is already registered to a **different** username — rejects if so
2. Creates user if not exists
3. Rejects if a `WEB_PASSKEY` credential already exists for this username
4. Generates and stores a challenge

---

### `POST /auth/register/finish`
**Body:** `{ username: string, credential: PublicKeyCredential, deviceId: string }`

**Returns:** `{ success: true }`

**Logic:**
- Verifies the credential against the stored challenge
- Stores `credentialId`, `publicKey`, `counter`, `platform`, `deviceId`

---

### `POST /auth/login/start`
**Body:** `{ username: string }`

**Returns:** WebAuthn authentication options (JSON)

**Logic:**
- Fetches valid credentials for the user
- Converts `credentialId` from base64url string to `Buffer` before passing to `generateAuthenticationOptions`
  ```js
  id: Buffer.from(c.credentialId, 'base64url')  // CRITICAL — library expects Uint8Array not string
  ```

---

### `POST /auth/login/finish`
**Body:** `{ credential: PublicKeyCredential }`

**Returns:** `{ success: true, username: string }` + sets JWT cookie

**Logic:**
- Looks up credential by `credential.id` (exact base64url match)
- Verifies response, updates counter, issues JWT

---

### `GET /mailbox` (protected)
Requires valid JWT cookie. Returns user's messages.

### `POST /auth/logout`
Clears JWT cookie.

---

## Critical Implementation Notes

### 1. credentialId Storage
Store `credential.id` **directly from the request body** — do NOT use `registrationInfo.credentialID` which is a `Uint8Array` that serializes differently.

```js
// CORRECT
credentialId: credential.id   // base64url string from browser, e.g. "RFW72Wd0P_..."

// WRONG — produces empty string after Buffer conversion
credentialId: Buffer.from(registrationInfo.credentialID).toString('base64url')
```

### 2. allowCredentials Must Use Buffer
In `generateAuthenticationOptions`, the `id` field must be a `Uint8Array`, not a string. The library calls `isoBase64URL.fromBuffer()` on it internally — passing a string returns `""`.

```js
allowCredentials: credentials.map(c => ({
  id: Buffer.from(c.credentialId, 'base64url'),  // CRITICAL
  type: 'public-key',
}))
```

### 3. JSON Serialization of Options
The options returned by `generateRegistrationOptions` and `generateAuthenticationOptions` contain `Uint8Array` / `Buffer` values. These must be serialized manually:

```js
res.setHeader('Content-Type', 'application/json');
res.end(JSON.stringify(options, (_k, v) => {
  if (ArrayBuffer.isView(v)) return Buffer.from(v).toString('base64url');
  if (v?.type === 'Buffer' && Array.isArray(v?.data)) return Buffer.from(v.data).toString('base64url');
  return v;
}));
```

### 4. Browser Library Syntax (v10+)
```js
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';

const attResp = await startRegistration({ optionsJSON: options });
const asseResp = await startAuthentication({ optionsJSON: options });
```

---

## Device-Locking Security Model

### Layer 1 — Account Lock (Username Level)
Each username can only have one `WEB_PASSKEY` credential. Any attempt to register the same username from a different device is rejected.

```js
if (user.credentials.some(c => c.platform === 'WEB_PASSKEY')) {
  return res.status(403).json({
    error: 'This account is already locked to another web device.'
  });
}
```

### Layer 2 — Device Lock (deviceId Level)
Each device fingerprint can only be associated with one account. Attempting to register a new account from a device that already has a registered account is rejected.

```js
const existingDeviceCredential = await prisma.credential.findFirst({
  where: { deviceId, platform: 'WEB_PASSKEY' },
  include: { user: true },
});
if (existingDeviceCredential && existingDeviceCredential.user.username !== username) {
  return res.status(403).json({
    error: 'This device is already registered to another account.'
  });
}
```

### Security Matrix

| Scenario | Result |
|---|---|
| First registration on a device | ✅ Allowed |
| Same username, same device, register again | ❌ Blocked — username already has WEB_PASSKEY |
| Same username, different device | ❌ Blocked — username already has WEB_PASSKEY |
| Different username, same device | ❌ Blocked — deviceId already taken |
| Different username, different device | ✅ Allowed |
| Login from registered device | ✅ Allowed |
| Login attempt from unregistered device | ❌ Blocked — passkey not present on device |

---

## Device Fingerprinting

### How It Works
A SHA-256 hash is computed from hardware-level signals that are stable across browser restarts and consistent across most browsers on the same physical device.

```js
async function getDeviceId() {
  const signals = [
    screen.width, screen.height, screen.colorDepth,
    navigator.hardwareConcurrency,
    navigator.deviceMemory || 'unknown',
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    navigator.platform,
    navigator.language,
    navigator.maxTouchPoints,
    getWebGLSignal(),   // GPU vendor + renderer from OS driver
  ].join('||');

  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signals));
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
```

### Signal Sources

| Signal | Source | Cross-browser stable? |
|---|---|---|
| `screen.width/height` | OS / display | ✅ Yes |
| `screen.colorDepth` | Display driver | ✅ Yes |
| `hardwareConcurrency` | CPU (OS) | ✅ Yes |
| `deviceMemory` | RAM (OS) | ✅ Yes |
| `timezone` | OS settings | ✅ Yes |
| `platform` | OS | ✅ Yes |
| `language` | OS/browser settings | ✅ Usually |
| `maxTouchPoints` | Hardware | ✅ Yes |
| WebGL renderer | GPU driver (OS) | ✅ Yes |

### Known Limitation — Cross-Browser on Same Physical Device

> **This is a fundamental web platform limitation, not a code limitation.**

Different browsers (Chrome, Firefox, Edge) intentionally isolate their storage and actively resist fingerprinting for user privacy. As a result:
- The same physical device may produce a slightly different `deviceId` hash across different browsers
- This means a user could theoretically register two accounts — one in Chrome and one in Firefox — on the same physical machine

**Why this cannot be fully solved in a web app:**

Browsers do not expose a reliable unique hardware identifier to web pages. True device-level identification requires:
- A **native mobile/desktop app** with access to device APIs (IMEI, TPM, hardware UUID)
- **Enterprise MDM** (Mobile Device Management) with client certificates
- **Native browser extensions** with elevated OS permissions

**What the current implementation guarantees:**
- The same browser profile cannot register two accounts
- Any account registered on browser A cannot be accessed from browser B (the passkey is browser-specific)
- The WebAuthn passkey itself IS the strongest device lock — only the exact browser+device combination that created the passkey can authenticate

---

## SQLite (Local) vs PostgreSQL (Production)

The schema uses `sqlite` for local development. A build-time script automatically switches the provider to `postgresql` on Railway based on the `DATABASE_URL` value.

**`scripts/prepare-schema.js`:**
```js
import fs from 'fs';
const url = process.env.DATABASE_URL || '';
if (url.startsWith('postgresql') || url.startsWith('postgres')) {
  const schema = fs.readFileSync('prisma/schema.prisma', 'utf8');
  fs.writeFileSync('prisma/schema.prisma',
    schema.replace('provider = "sqlite"', 'provider = "postgresql"'));
}
```

**`package.json` scripts:**
```json
{
  "build": "node scripts/prepare-schema.js && node ./node_modules/prisma/build/index.js generate",
  "start": "node ./node_modules/prisma/build/index.js db push && node server.js"
}
```

- `build` — runs on Railway during image build (no DB connection needed)
- `start` — runs at container startup; `db push` applies any schema changes to the live DB automatically

`prisma` is in `dependencies` (not `devDependencies`) so it is available in Railway's production environment.

---

## Environment Variables

| Variable | Description | Example |
|---|---|---|
| `DATABASE_URL` | DB connection string | `file:./dev.db` (local) / `postgresql://...` (Railway) |
| `JWT_SECRET` | Secret for signing JWT tokens | any long random string |
| `RP_ID` | Relying Party ID — must match domain exactly | `webauthn-mailbox-production.up.railway.app` |
| `ORIGIN` | Full origin URL — must match exactly | `https://webauthn-mailbox-production.up.railway.app` |
| `NODE_ENV` | Environment mode | `production` |
| `PORT` | Server port (Railway sets automatically) | `8080` |

> **RP_ID and ORIGIN must exactly match the domain the app is served from. Any mismatch causes WebAuthn verification to fail with an origin error.**

---

## Web vs Mobile Detection

### Detecting Platform on the Backend

Tag each credential with its originating platform at registration time:

```js
// Web backend
platform: 'WEB_PASSKEY'

// Mobile app
platform: 'MOBILE'
```

**Option A — Custom header (recommended):**
```
X-Platform: mobile
```
```js
const platform = req.headers['x-platform'] === 'mobile' ? 'MOBILE' : 'WEB_PASSKEY';
```

**Option B — Separate endpoints:**

| Endpoint | Platform |
|---|---|
| `POST /auth/register/start` | Web |
| `POST /auth/mobile/register/start` | Mobile |

### Per-Platform Account Structure

```
User "ahmed@example.com"
  ├── platform = "WEB_PASSKEY"  deviceId = "a1b2c3..."  → web browser only
  └── platform = "MOBILE"       deviceId = "d4e5f6..."  → mobile device only
```

Each platform has its own device lock — one web browser and one mobile device per account.

---

## Mobile Integration Checklist

- [ ] Use the same `/auth/register/start` and `/auth/register/finish` endpoints
- [ ] Send `X-Platform: mobile` header on all requests
- [ ] Store credentials with `platform = 'MOBILE'`
- [ ] Generate a stable `deviceId` on mobile (use hardware device ID — IMEI, UUID, etc. — not a browser fingerprint)
- [ ] Enforce one-device-per-platform: reject registration if a `MOBILE` credential already exists for the user
- [ ] On login, send the credential response to `/auth/login/finish`
- [ ] Handle the JWT cookie (`Authorization: Bearer` header may be more practical than cookies on mobile)
