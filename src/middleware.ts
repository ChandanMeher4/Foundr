import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { AUTH_COOKIE_NAME, verifySessionToken } from "@/lib/auth-core";

export async function middleware(req: NextRequest) {
  const token = req.cookies.get(AUTH_COOKIE_NAME)?.value;
  const path = req.nextUrl.pathname;

  const isAdminRoute = path.startsWith("/admin");
  const isDeveloperRoute = path.startsWith("/list-project");
  const isAuthRoute = path === "/login" || path === "/register";

  if (!token && (isAdminRoute || isDeveloperRoute)) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  if (token) {
    try {
      const payload = await verifySessionToken(token);

      if (isAuthRoute) {
        return NextResponse.redirect(new URL("/", req.url));
      }

      if (isAdminRoute && payload.role !== "Admin") {
        return NextResponse.redirect(new URL("/", req.url));
      }

      if (
        isDeveloperRoute &&
        payload.role !== "Developer" &&
        payload.role !== "Admin"
      ) {
        return NextResponse.redirect(new URL("/", req.url));
      }
    } catch {
      const response = NextResponse.redirect(new URL("/login", req.url));
      response.cookies.delete(AUTH_COOKIE_NAME);
      return response;
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/list-project/:path*", "/login", "/register"],
};
