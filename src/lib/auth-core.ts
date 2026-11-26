import { SignJWT, jwtVerify, type JWTPayload } from "jose";

export const AUTH_COOKIE_NAME = "foundr_token";
export const BULLBOARD_COOKIE_NAME = "bullboard_session";
export const TOKEN_TTL = "7d";
export const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export type UserRole = "Investor" | "Developer" | "Admin";

export interface AuthSessionPayload extends JWTPayload {
  id: string;
  role: UserRole;
  name: string;
  city?: string;
  jti: string;
}

export interface BullBoardHandoffPayload extends JWTPayload {
  id: string;
  role: UserRole;
  purpose: "bullboard";
  jti: string;
}

export interface BullBoardSessionPayload extends JWTPayload {
  id: string;
  role: UserRole;
  purpose: "bullboard-session";
}

export class BullBoardAuthError extends Error {
  status: 401 | 403;
  constructor(message: string, status: 401 | 403) {
    super(message);
    this.status = status;
  }
}

/**
 * Returns the encoded JWT signing secret, failing immediately if JWT_SECRET is missing.
 */
export function getEncodedJwtSecret(): Uint8Array {
  const rawSecret = process.env.JWT_SECRET;
  if (!rawSecret || rawSecret.trim().length === 0) {
    throw new Error("Fatal: JWT_SECRET environment variable must be defined.");
  }
  return new TextEncoder().encode(rawSecret);
}

/** Signs a 7-day HS256 JWT containing verified user session claims and a random jti. */
export async function signSessionToken(payload: {
  id: string;
  role: UserRole;
  name: string;
  city?: string;
}): Promise<string> {
  const jti = globalThis.crypto.randomUUID();
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(getEncodedJwtSecret());
}

/** Verifies a JWT string against JWT_SECRET and validates required identity + jti claims. */
export async function verifySessionToken(
  token: string,
): Promise<AuthSessionPayload> {
  const { payload } = await jwtVerify(token, getEncodedJwtSecret());
  if (
    typeof payload.id !== "string" ||
    typeof payload.jti !== "string" ||
    payload.jti.length === 0 ||
    (payload.role !== "Investor" &&
      payload.role !== "Developer" &&
      payload.role !== "Admin")
  ) {
    throw new Error("Invalid session token claims");
  }
  return payload as AuthSessionPayload;
}

/** Signs a 60-second single-use JWT handoff token for /admin/queues/login. */
export async function signBullBoardHandoffToken(payload: {
  id: string;
  role: UserRole;
  jti?: string;
}): Promise<{ token: string; jti: string }> {
  const jti = payload.jti || globalThis.crypto.randomUUID();
  const token = await new SignJWT({
    id: payload.id,
    role: payload.role,
    purpose: "bullboard",
    jti,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(getEncodedJwtSecret());
  return { token, jti };
}

/** Verifies a short-lived Bull Board handoff JWT (signature, expiry, purpose, Admin role, jti). */
export async function verifyBullBoardHandoffToken(
  token: string,
): Promise<BullBoardHandoffPayload> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, getEncodedJwtSecret()));
  } catch {
    throw new BullBoardAuthError("Invalid or expired handoff token.", 401);
  }

  if (
    payload.purpose !== "bullboard" ||
    typeof payload.id !== "string" ||
    typeof payload.jti !== "string" ||
    payload.jti.length === 0
  ) {
    throw new BullBoardAuthError("Invalid handoff token claims.", 401);
  }
  if (payload.role !== "Admin") {
    throw new BullBoardAuthError("Forbidden. Admin role required.", 403);
  }
  return payload as BullBoardHandoffPayload;
}

/** Signs a 1-hour worker-scoped JWT stored in bullboard_session cookie. */
export async function signBullBoardSessionToken(payload: {
  id: string;
  role: UserRole;
}): Promise<string> {
  return new SignJWT({
    id: payload.id,
    role: payload.role,
    purpose: "bullboard-session",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(getEncodedJwtSecret());
}

/** Verifies a worker-scoped bullboard_session JWT. Rejects main login tokens. */
export async function verifyBullBoardSessionToken(
  token: string,
): Promise<BullBoardSessionPayload> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, getEncodedJwtSecret()));
  } catch {
    throw new BullBoardAuthError("Invalid or expired Bull Board session.", 401);
  }

  if (
    payload.purpose !== "bullboard-session" ||
    typeof payload.id !== "string"
  ) {
    throw new BullBoardAuthError("Invalid Bull Board session claims.", 401);
  }
  if (payload.role !== "Admin") {
    throw new BullBoardAuthError("Forbidden. Admin role required.", 403);
  }
  return payload as BullBoardSessionPayload;
}
