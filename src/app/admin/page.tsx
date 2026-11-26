import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import AdminDashboardClient from "@/components/AdminDashboardClient";

export default async function AdminPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "Admin") redirect("/");

  return <AdminDashboardClient />;
}
