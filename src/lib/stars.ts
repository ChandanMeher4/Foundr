import dbConnect from "@/lib/db";
import User from "@/models/User";

/**
 * Returns stringified starred project IDs for a user, or null when the user does not exist.
 */
export async function getUserStarredIds(userId: string): Promise<string[] | null> {
  await dbConnect();
  const user = await User.findById(userId)
    .select("starredProjects")
    .lean<{ starredProjects?: Array<{ toString(): string }> } | null>();

  if (!user) {
    return null;
  }

  return Array.isArray(user.starredProjects)
    ? user.starredProjects.map((id) => id.toString())
    : [];
}
