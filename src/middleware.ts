import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';

// Get secret key
const SECRET = new TextEncoder().encode(process.env.JWT_SECRET || "fallback_secret");

export async function middleware(req: NextRequest) {
  const token = req.cookies.get('foundr_token')?.value;
  const path = req.nextUrl.pathname;

  // route types
  const isAdminRoute = path.startsWith('/admin');
  const isDeveloperRoute = path.startsWith('/list-project');
  const isAuthRoute = path === '/login' || path === '/register';

  // 1. If trying to access protected routes without a token, kick to login
  if (!token && (isAdminRoute || isDeveloperRoute)) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  // 2. If have a token, verify who they are
  if (token) {
    try {
      // Decode the JWT using jose 
      const { payload } = await jwtVerify(token, SECRET);

      if (isAuthRoute) {
        return NextResponse.redirect(new URL('/', req.url));
      }

      // RABC: only admin
      if (isAdminRoute && payload.role !== 'Admin') {
        return NextResponse.redirect(new URL('/', req.url)); // Kick back to home
      }

      // RBAC: Only Developer 
      if (isDeveloperRoute && payload.role !== 'Developer' && payload.role !== 'Admin') {
        return NextResponse.redirect(new URL('/', req.url));
      }

    } catch (err) {
      // If the token is expired, delete it and kick to login
      const response = NextResponse.redirect(new URL('/login', req.url));
      response.cookies.delete('foundr_token');
      return response;
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/list-project/:path*', '/login', '/register'],
};