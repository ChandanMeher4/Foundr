import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { signBullBoardHandoffToken } from "@/lib/auth-core";

export async function GET() {
  const auth = await requireRole("Admin");
  if (auth.response) return auth.response;

  const { token } = await signBullBoardHandoffToken({
    id: auth.session.id,
    role: auth.session.role,
  });

  const workerBase = (
    process.env.NEXT_PUBLIC_WORKER_URL || "http://localhost:4000"
  ).replace(/\/+$/, "");

  const target = new URL(`${workerBase}/admin/queues/login`);
  target.searchParams.set("token", token);

  const response = NextResponse.redirect(target, 302);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
