import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  AUTH_COOKIE_NAME,
  COOKIE_MAX_AGE_SECONDS,
  getEncodedJwtSecret,
  signSessionToken,
  verifySessionToken,
  type AuthSessionPayload,
  type UserRole,
} from "./auth-core";

// Assert JWT_SECRET is present when Next.js server module initializes
getEncodedJwtSecret();

export {
  AUTH_COOKIE_NAME,
  signSessionToken,
  verifySessionToken,
  type AuthSessionPayload,
  type UserRole,
};

/** Writes the HTTP-Only session cookie (`sameSite: "lax"`) on the active response context. */
export async function setSessionCookie(token: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: COOKIE_MAX_AGE_SECONDS,
    path: "/",
  });
}

/** Removes the session cookie from the active response context. */
export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(AUTH_COOKIE_NAME);
}

/** Reads and verifies the current request's session cookie, or returns null. */
export async function getSession(): Promise<AuthSessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE_NAME)?.value;
  if (!token) return null;

  try {
    return await verifySessionToken(token);
  } catch {
    return null;
  }
}

type RoleAuthResult =
  | { session: AuthSessionPayload; response?: never }
  | { session?: never; response: NextResponse };

/**
 * Enforces an authenticated session and optional role membership in API Route Handlers.
 */
export async function requireRole(
  allowedRoles?: UserRole | UserRole[],
): Promise<RoleAuthResult> {
  const session = await getSession();
  if (!session) {
    return {
      response: NextResponse.json(
        { error: "Unauthorized. Please log in." },
        { status: 401 },
      ),
    };
  }

  if (allowedRoles) {
    const allowed = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
    if (!allowed.includes(session.role)) {
      return {
        response: NextResponse.json(
          { error: "Forbidden. Insufficient permissions." },
          { status: 403 },
        ),
      };
    }
  }

  return { session };
}
