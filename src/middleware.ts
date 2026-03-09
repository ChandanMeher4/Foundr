import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';

// Get the secret key
const SECRET = new TextEncoder().encode(process.env.JWT_SECRET || "fallback_secret");

export async function middleware(req: NextRequest) {
  const token = req.cookies.get('foundr_token')?.value;
  const path = req.nextUrl.pathname;

  // Define route types
  const isAdminRoute = path.startsWith('/admin');
  const isDeveloperRoute = path.startsWith('/list-project');
  const isAuthRoute = path === '/login' || path === '/register';

  // 1. If trying to access protected routes without a token, kick to login
  if (!token && (isAdminRoute || isDeveloperRoute)) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  // 2. If we DO have a token, let's verify who they are
  if (token) {
    try {
      // Decode the JWT using jose (Edge-compatible)
      const { payload } = await jwtVerify(token, SECRET);

      // If they are already logged in, they shouldn't see the Login/Register pages
      if (isAuthRoute) {
        return NextResponse.redirect(new URL('/', req.url));
      }

      // RBAC: Only "Admin" can see the admin panel
      if (isAdminRoute && payload.role !== 'Admin') {
        return NextResponse.redirect(new URL('/', req.url)); // Kick back to home
      }

      // RBAC: Only "Developer" (or Admin) can list projects
      if (isDeveloperRoute && payload.role !== 'Developer' && payload.role !== 'Admin') {
        return NextResponse.redirect(new URL('/', req.url));
      }

    } catch (err) {
      // If the token is fake or expired, delete it and kick to login
      const response = NextResponse.redirect(new URL('/login', req.url));
      response.cookies.delete('foundr_token');
      return response;
    }
  }

  return NextResponse.next();
}

// Tell Next.js exactly which routes this middleware should run on
export const config = {
  matcher: ['/admin/:path*', '/list-project/:path*', '/login', '/register'],
};