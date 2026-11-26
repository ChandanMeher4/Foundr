import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  AUTH_COOKIE_NAME,
  clearSessionCookie,
  revokeTokenJti,
  verifySessionToken,
} from "@/lib/auth";

export async function POST() {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(AUTH_COOKIE_NAME)?.value;

    if (token) {
      try {
        const payload = await verifySessionToken(token);
        const nowSeconds = Math.floor(Date.now() / 1000);
        const remaining =
          typeof payload.exp === "number"
            ? Math.max(1, payload.exp - nowSeconds)
            : 60 * 60 * 24 * 7;
        await revokeTokenJti(payload.jti, remaining);
      } catch {
        // Ignore invalid/already-expired tokens on logout and proceed clearing cookie
      }
    }

    await clearSessionCookie();
    return NextResponse.json(
      { message: "Logged out successfully" },
      { status: 200 },
    );
  } catch {
    return NextResponse.json(
      { error: "Failed to log out" },
      { status: 500 },
    );
  }
}
