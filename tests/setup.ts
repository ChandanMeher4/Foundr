import { loadLocalEnv } from "../worker/env";

loadLocalEnv();

function resolveMongoDatabaseName(uri: string): string {
  if (process.env.MONGODB_DB_NAME?.trim()) {
    return process.env.MONGODB_DB_NAME.trim();
  }
  const parsed = new URL(uri);
  const pathDb = parsed.pathname.replace(/^\//, "").split("/")[0]?.trim();
  return pathDb || "";
}

const hasDedicatedTestUri = Boolean(process.env.MONGODB_URI_TEST?.trim());
if (!hasDedicatedTestUri && !process.env.MONGODB_DB_NAME?.trim()) {
  // Isolate tests automatically when running against shared cluster URI
  process.env.MONGODB_DB_NAME = "foundr_test";
}

const targetUri = (
  process.env.MONGODB_URI_TEST ||
  process.env.MONGODB_URI ||
  ""
).trim();
if (!targetUri) {
  throw new Error(
    "Fatal test configuration error: MONGODB_URI_TEST or MONGODB_URI must be set.",
  );
}

const resolvedDbName = resolveMongoDatabaseName(targetUri);
if (!resolvedDbName || !resolvedDbName.endsWith("_test")) {
  throw new Error(
    `Refusing to run tests against non-test database "${resolvedDbName || "<default>"}". Test DB name must end with "_test".`,
  );
}

// Ensure tests never route outbound emails to external domains
process.env.EMAIL_MODE = "sandbox";
process.env.REDIS_KEY_PREFIX = "test:";
