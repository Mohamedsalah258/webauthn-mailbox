import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const app = express();
const prisma = new PrismaClient();

const RP_NAME = 'Secure Mailbox';
const RP_ID = process.env.RP_ID || 'localhost';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-dev-secret';
const JWT_EXPIRY = '8h';

app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

// ── Registration ──────────────────────────────────────────────────────────────

app.post('/auth/register/start', async (req, res) => {
  const { username } = req.body;
  if (!username?.trim()) return res.status(400).json({ error: 'Username required' });

  let user = await prisma.user.findUnique({
    where: { username },
    include: { credentials: true },
  });

  if (!user) {
    user = await prisma.user.create({
      data: { username },
      include: { credentials: true },
    });
  }

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userID: Buffer.from(user.id),
    userName: user.username,
    attestationType: 'none',
    excludeCredentials: user.credentials.map((c) => ({
      id: c.credentialId,
      type: 'public-key',
      transports: c.transports ? JSON.parse(c.transports) : [],
    })),
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      residentKey: 'preferred',
      userVerification: 'required',
    },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { currentChallenge: options.challenge },
  });

  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(options, (_k, v) => {
    if (ArrayBuffer.isView(v)) return Buffer.from(v).toString('base64url');
    if (v?.type === 'Buffer' && Array.isArray(v?.data)) return Buffer.from(v.data).toString('base64url');
    return v;
  }));
});

app.post('/auth/register/finish', async (req, res) => {
  const { username, credential } = req.body;
  console.log('[register/finish] storing credentialId:', credential?.id);

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user?.currentChallenge) {
    return res.status(400).json({ error: 'No active registration challenge' });
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: user.currentChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (!verification.verified || !verification.registrationInfo) {
    return res.status(400).json({ error: 'Verification failed' });
  }

  const { credentialPublicKey, counter } = verification.registrationInfo;

  await prisma.credential.create({
    data: {
      credentialId: credential.id,
      publicKey: Buffer.from(credentialPublicKey),
      counter,
      platform: 'WEB_PASSKEY',
      transports: JSON.stringify(credential.response?.transports ?? []),
      userId: user.id,
    },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { currentChallenge: null },
  });

  res.json({ success: true });
});

// ── Authentication ────────────────────────────────────────────────────────────

app.post('/auth/login/start', async (req, res) => {
  const { username } = req.body;

  const user = await prisma.user.findUnique({
    where: { username },
    include: { credentials: true },
  });

  const validCredentials = user?.credentials.filter(c => c.credentialId?.length > 0) ?? [];
  console.log('[login/start] DB credentials:', validCredentials.map(c => c.credentialId));
  if (!user || validCredentials.length === 0) {
    return res.status(404).json({ error: 'User not found or no credentials registered' });
  }

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: 'required',
    allowCredentials: validCredentials.map((c) => ({
      id: Buffer.from(c.credentialId, 'base64url'),
      type: 'public-key',
    })),
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { currentChallenge: options.challenge },
  });

  const payload = JSON.parse(JSON.stringify(options, (_k, v) => {
    if (ArrayBuffer.isView(v)) return Buffer.from(v).toString('base64url');
    if (v?.type === 'Buffer' && Array.isArray(v?.data)) return Buffer.from(v.data).toString('base64url');
    return v;
  }));
  console.log('[login/start] sending allowCredentials:', JSON.stringify(payload.allowCredentials));

  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
});

app.post('/auth/login/finish', async (req, res) => {
  const { credential } = req.body;
  console.log('[login/finish] browser credential.id:', credential?.id);

  const dbCredential = await prisma.credential.findUnique({
    where: { credentialId: credential.id },
    include: { user: true },
  });

  if (!dbCredential) {
    return res.status(400).json({ error: 'Credential not recognized' });
  }

  const user = await prisma.user.findUnique({
    where: { id: dbCredential.userId },
  });

  if (!user?.currentChallenge) {
    return res.status(400).json({ error: 'No active authentication challenge' });
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: user.currentChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      authenticator: {
        credentialID: Buffer.from(dbCredential.credentialId, 'base64url'),
        credentialPublicKey: new Uint8Array(dbCredential.publicKey),
        counter: dbCredential.counter,
        transports: dbCredential.transports ? JSON.parse(dbCredential.transports) : [],
      },
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (!verification.verified) {
    return res.status(401).json({ error: 'Authentication failed' });
  }

  await prisma.credential.update({
    where: { id: dbCredential.id },
    data: { counter: verification.authenticationInfo.newCounter },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { currentChallenge: null },
  });

  const token = jwt.sign(
    { sub: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );

  res.cookie('auth_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 8 * 60 * 60 * 1000,
  });

  res.json({ success: true, username: user.username });
});

// ── Protected Mailbox ─────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const token = req.cookies.auth_token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}

app.get('/mailbox', requireAuth, (req, res) => {
  res.json({
    username: req.user.username,
    messages: [
      { id: 1, from: 'system@secure.mail', subject: 'Welcome', body: `Mailbox secured for ${req.user.username}.` },
      { id: 2, from: 'noreply@secure.mail', subject: 'Passkey registered', body: 'Your fingerprint has been enrolled successfully.' },
    ],
  });
});

app.post('/auth/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.json({ success: true });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server → http://localhost:${PORT}`));
