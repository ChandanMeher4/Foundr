import Link from "next/link";
import { cookies } from "next/headers";
import { jwtVerify } from "jose";
import LogoutButton from "./LogoutButton";

export default async function Navbar() {
  // 1. Read the secure cookie
  const cookieStore = await cookies();
  const token = cookieStore.get("foundr_token")?.value;

  let user: { name?: string; role?: string; id?: string } | null = null;

  // 2. Decode the user's role if they are logged in
  if (token) {
    try {
      const SECRET = new TextEncoder().encode(
        process.env.JWT_SECRET || "fallback_secret",
      );
      const { payload } = await jwtVerify(token, SECRET);
      user = payload as { name?: string; role?: string; id?: string };
    } catch (err) {
      console.error("Invalid token in Navbar");
    }
  }

  return (
    <nav className="bg-stone-950 border-b border-stone-800 sticky top-0 z-40">
      {/* Gold accent line */}
      <div className="h-[2px] bg-gradient-to-r from-transparent via-amber-400 to-transparent absolute top-0 left-0 right-0" />

      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">

        {/* Logo */}
        <Link
          href="/"
          className="text-xl font-black tracking-tighter text-white hover:text-amber-400 transition-colors"
          style={{ fontFamily: "'Georgia', serif" }}
        >
          Foundr<span className="text-amber-400">.</span>
        </Link>

        {/* Dynamic Navigation Links */}
        <div className="flex items-center gap-1">
          <Link
            href="/"
            className="text-xs font-semibold text-stone-400 hover:text-white hover:bg-stone-800 px-4 py-2 rounded-lg tracking-wide transition-all"
          >
            Marketplace
          </Link>

          {/* Conditional Rendering Based on Role */}
          {user ? (
            <>
              {user.role === "Developer" && (
                <Link
                  href="/developer"
                  className="text-xs font-bold text-amber-400 hover:text-amber-300 hover:bg-stone-800 px-4 py-2 rounded-lg tracking-wide transition-all"
                >
                  Developer Dashboard
                </Link>
              )}

              {user.role === "Admin" && (
                <Link
                  href="/admin"
                  className="text-xs font-bold text-violet-400 hover:text-violet-300 hover:bg-stone-800 px-4 py-2 rounded-lg tracking-wide transition-all"
                >
                  Admin Panel
                </Link>
              )}

              <Link
                href="/profile"
                className="text-xs font-semibold text-stone-400 hover:text-white hover:bg-stone-800 px-4 py-2 rounded-lg tracking-wide transition-all"
              >
                My Profile
              </Link>

              <div className="pl-4 ml-2 border-l border-stone-700 flex items-center gap-3">
                {/* Clickable Avatar */}
                <Link
                  href="/profile"
                  className="w-8 h-8 rounded-full bg-amber-400 text-stone-900 flex items-center justify-center text-xs font-black hover:bg-amber-300 transition-colors shadow-md"
                  title="Go to Profile"
                >
                  {user.name ? String(user.name).charAt(0).toUpperCase() : "U"}
                </Link>

                <LogoutButton />
              </div>
            </>
          ) : (
            // Logged Out State
            <div className="flex items-center gap-3 pl-4 ml-2 border-l border-stone-700">
              <Link
                href="/login"
                className="text-xs font-semibold text-stone-400 hover:text-white hover:bg-stone-800 px-4 py-2 rounded-lg tracking-wide transition-all"
              >
                Log In
              </Link>
              <Link
                href="/register"
                className="text-xs font-bold bg-amber-400 text-stone-900 px-5 py-2 rounded-lg hover:bg-amber-300 transition-colors shadow-md tracking-wide"
              >
                Sign Up
              </Link>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}