import { SignJWT, jwtVerify, type JWTPayload } from "jose";

export const AUTH_COOKIE_NAME = "foundr_token";
export const TOKEN_TTL = "7d";
export const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export type UserRole = "Investor" | "Developer" | "Admin";

export interface AuthSessionPayload extends JWTPayload {
  id: string;
  role: UserRole;
  name: string;
  city?: string;
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

/** Signs a 7-day HS256 JWT containing verified user session claims. */
export async function signSessionToken(payload: {
  id: string;
  role: UserRole;
  name: string;
  city?: string;
}): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(getEncodedJwtSecret());
}

/** Verifies a JWT string against JWT_SECRET and validates required identity claims. */
export async function verifySessionToken(
  token: string,
): Promise<AuthSessionPayload> {
  const { payload } = await jwtVerify(token, getEncodedJwtSecret());
  if (
    typeof payload.id !== "string" ||
    (payload.role !== "Investor" &&
      payload.role !== "Developer" &&
      payload.role !== "Admin")
  ) {
    throw new Error("Invalid session token claims");
  }
  return payload as AuthSessionPayload;
}
