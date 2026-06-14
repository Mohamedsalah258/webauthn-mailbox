# WebAuthn Passkey Authentication — Feature Documentation

## Overview

This document describes the WebAuthn (FIDO2) passkey authentication feature implemented in the Secure Mailbox web application. It is intended to help developers understand the architecture and replicate or integrate the same flow in other platforms (mobile, desktop, etc.).

---

## What Was Built

A passwordless authentication system using **WebAuthn / FIDO2 passkeys**. Instead of passwords, users authenticate using their device's biometrics (fingerprint, Face ID, Windows Hello, etc.).

**Key properties:**
- No passwords stored anywhere
- Each account is locked to one web device (one passkey per platform)
- Works across mobile and web with separate passkeys per platform
- JWT-based session management after authentication

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express |
| WebAuthn Server | `@simplewebauthn/server` v9.0.3 |
| WebAuthn Browser | `@simplewebauthn/browser` (CDN ESM, latest) |
| Database ORM | Prisma |
| Database (local) | SQLite |
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
- `currentChallenge` — temporary challenge stored during auth flow, cleared after use

---

## Authentication Flow

### Registration Flow

```
Browser                          Server                        Database
  |                                |                               |
  |-- POST /auth/register/start -->|                               |
  |   { username }                 |-- find or create user ------->|
  |                                |-- generateRegistrationOptions |
  |                                |-- save challenge to user ---->|
  |<-- { options } ----------------|                               |
  |                                |                               |
  | [browser shows biometric prompt]                              |
  |                                |                               |
  |-- POST /auth/register/finish ->|                               |
  |   { username, credential }     |-- verifyRegistrationResponse  |
  |                                |-- save credential ----------->|
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
**Body:** `{ username: string }`

**Returns:** WebAuthn registration options (JSON)

**Logic:**
- Creates user if not exists
- Rejects if a `WEB_PASSKEY` credential already exists for this user (device-lock enforcement)
- Generates and stores a challenge

---

### `POST /auth/register/finish`
**Body:** `{ username: string, credential: PublicKeyCredential }`

**Returns:** `{ success: true }`

**Logic:**
- Verifies the credential against the stored challenge
- Stores `credentialId` (directly from `credential.id`), `publicKey`, `counter`, `platform`

---

### `POST /auth/login/start`
**Body:** `{ username: string }`

**Returns:** WebAuthn authentication options (JSON)

**Logic:**
- Fetches valid credentials for the user
- Converts `credentialId` from base64url string to `Buffer` before passing to `generateAuthenticationOptions`
  ```js
  id: Buffer.from(c.credentialId, 'base64url')  // CRITICAL — library expects Uint8Array, not string
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

// Registration
const attResp = await startRegistration({ optionsJSON: options });

// Authentication
const asseResp = await startAuthentication({ optionsJSON: options });
```

---

## Device-Locking Security Model

Each account is locked to the first device that registers it, **per platform**.

```
User "ahmed@example.com"
  ├── platform = "WEB_PASSKEY"  → only the web browser that registered can log in
  └── platform = "MOBILE"       → only the mobile device that registered can log in
```

**Rules enforced by the backend:**

| Scenario | Result |
|---|---|
| First registration (web) | Allowed — creates WEB_PASSKEY credential |
| Second web device tries to register same username | Blocked — "account locked to another device" |
| Second web device tries to login same username | Blocked — credential ID won't match |
| Mobile device registers same username | Allowed — different platform |
| Mobile device tries to login after registering | Allowed |

**Server-side enforcement (register/start):**
```js
if (user.credentials.some(c => c.platform === 'WEB_PASSKEY')) {
  return res.status(403).json({
    error: 'This account is already locked to another web device.'
  });
}
```

The mobile app must implement the equivalent check for `platform === 'MOBILE'`.

---

## Web vs Mobile Detection

### Detecting Platform on the Backend

When a credential is created, tag it with the originating platform. The web backend always sets:
```js
platform: 'WEB_PASSKEY'
```

The mobile app should set:
```js
platform: 'MOBILE'
```

This allows the backend to:
- Enforce one-device-per-platform restrictions
- Query credentials by platform
- Log or audit access per platform

### Detecting Platform on the Frontend (Web)

To detect if the current session came from a web browser or a mobile app, use the `User-Agent` header or a custom header sent by the mobile app.

**Option A — User-Agent detection (server-side):**
```js
app.post('/auth/login/finish', async (req, res) => {
  const ua = req.headers['user-agent'] || '';
  const isMobile = /Android|iPhone|iPad|Mobile/i.test(ua);
  const platform = isMobile ? 'MOBILE' : 'WEB_PASSKEY';
  // use platform to filter credentials or tag new registrations
});
```

**Option B — Custom header from mobile app (recommended):**

Mobile app sends:
```
X-Platform: mobile
```

Server reads:
```js
const platform = req.headers['x-platform'] === 'mobile' ? 'MOBILE' : 'WEB_PASSKEY';
```

**Option C — Separate endpoints per platform:**

| Endpoint | Used by |
|---|---|
| `POST /auth/register/start` | Web |
| `POST /auth/mobile/register/start` | Mobile app |

Each endpoint hardcodes its platform tag and applies its own device-lock check.

---

## Environment Variables

| Variable | Description | Example |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host/db` |
| `JWT_SECRET` | Secret for signing JWT tokens | any long random string |
| `RP_ID` | Relying Party ID — must match the domain exactly | `webauthn-mailbox-production.up.railway.app` |
| `ORIGIN` | Full origin URL — must match exactly | `https://webauthn-mailbox-production.up.railway.app` |
| `NODE_ENV` | Environment mode | `production` |
| `PORT` | Server port | `8080` (Railway sets this automatically) |

**RP_ID and ORIGIN must match the domain the app is served from. Any mismatch causes WebAuthn verification to fail.**

---

## Deployment (Railway)

- Build command runs `prisma generate` only (no DB connection needed)
- Start command runs `prisma db push` then starts the server (DB connection required at runtime)

```json
{
  "scripts": {
    "build": "node ./node_modules/prisma/build/index.js generate",
    "start": "node ./node_modules/prisma/build/index.js db push && node server.js"
  }
}
```

`prisma` is in `dependencies` (not `devDependencies`) so it is available in Railway's production build.

---

## Mobile Integration Checklist

For the mobile team to integrate with this backend:

- [ ] Use the same `/auth/register/start` and `/auth/register/finish` endpoints
- [ ] Send `X-Platform: mobile` header (or use dedicated `/auth/mobile/` endpoints)
- [ ] Store credentials with `platform = 'MOBILE'`
- [ ] Enforce one-device-per-platform on mobile side: reject registration if a `MOBILE` credential already exists for the user
- [ ] On login, send the credential response to `/auth/login/finish` — the backend matches by `credentialId`
- [ ] Handle the JWT cookie (or use `Authorization: Bearer` header if cookies are not practical on mobile)
