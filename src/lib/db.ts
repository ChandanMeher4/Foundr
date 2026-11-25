
import mongoose from "mongoose";

type GlobalWithMongoose = typeof globalThis & {
  mongoose?: {
    conn: typeof mongoose | null;
    promise: Promise<typeof mongoose> | null;
  };
};

function getMongoUri(): string {
  const isTest = process.env.NODE_ENV === "test" || Boolean(process.env.VITEST);
  const uri = isTest
    ? process.env.MONGODB_URI_TEST || process.env.MONGODB_URI
    : process.env.MONGODB_URI;

  if (!uri) {
    throw new Error(
      "Please define the MONGODB_URI environment variable in .env.local",
    );
  }
  return uri;
}

if (
  process.env.NODE_ENV !== "test" &&
  !process.env.VITEST &&
  !process.env.MONGODB_URI
) {
  throw new Error(
    "Please define the MONGODB_URI environment variable in .env.local",
  );
}

const g = globalThis as GlobalWithMongoose;
const cached = (g.mongoose ??= { conn: null, promise: null });

async function dbConnect() {
  if (cached.conn) return cached.conn;

  if (!cached.promise) {
    const uri = getMongoUri();
    const dbName = process.env.MONGODB_DB_NAME?.trim() || undefined;
    cached.promise = mongoose
      .connect(uri, dbName ? { dbName } : undefined)
      .then((m) => m);
  }
  cached.conn = await cached.promise;
  return cached.conn;
}

export default dbConnect;