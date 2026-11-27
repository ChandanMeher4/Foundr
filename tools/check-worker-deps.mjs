import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const pkg = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);
const deps = new Set(Object.keys(pkg.dependencies || {}));
const devDeps = new Set(Object.keys(pkg.devDependencies || {}));

const EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];

function resolveLocalFile(fromFile, specifier) {
  let candidateBase;
  if (specifier.startsWith("@/")) {
    candidateBase = path.join(repoRoot, "src", specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    candidateBase = path.resolve(path.dirname(fromFile), specifier);
  } else {
    return null;
  }

  for (const ext of ["", ...EXTS]) {
    const p = candidateBase + ext;
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  for (const ext of EXTS) {
    const p = path.join(candidateBase, `index${ext}`);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

function getPackageName(specifier) {
  if (specifier.startsWith("node:")) return null;
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split("/")[0];
}

function extractRuntimeSpecifiers(source) {
  // Remove single-line and multi-line comments cleanly before scanning imports
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  const specifiers = [];
  const staticImportRe =
    /(?:import|export)\s+(?!type\b)([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  let m;
  while ((m = staticImportRe.exec(stripped)) !== null) {
    specifiers.push(m[2]);
  }
  const sideEffectImportRe = /import\s+["']([^"']+)["']/g;
  while ((m = sideEffectImportRe.exec(stripped)) !== null) {
    specifiers.push(m[1]);
  }
  const dynamicRe = /(?:import|require)\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dynamicRe.exec(stripped)) !== null) {
    specifiers.push(m[1]);
  }
  return specifiers;
}

const visitedFiles = new Set();
const usedPackages = new Set();

function scanFile(filePath) {
  const normalized = path.resolve(filePath);
  if (visitedFiles.has(normalized)) return;
  visitedFiles.add(normalized);

  const source = fs.readFileSync(normalized, "utf8");
  for (const spec of extractRuntimeSpecifiers(source)) {
    const localTarget = resolveLocalFile(normalized, spec);
    if (localTarget) {
      scanFile(localTarget);
    } else if (!spec.startsWith(".") && !spec.startsWith("@/")) {
      const pkgName = getPackageName(spec);
      if (pkgName) usedPackages.add(pkgName);
    }
  }
}

// Check worker runner CLI binary declared in package.json scripts.worker
const workerScript = pkg.scripts?.worker || "";
const runnerBin = workerScript.trim().split(/\s+/)[0];
if (runnerBin && runnerBin !== "node") {
  usedPackages.add(runnerBin);
}

for (const entry of fs.readdirSync(path.join(repoRoot, "worker"))) {
  const full = path.join(repoRoot, "worker", entry);
  if (fs.statSync(full).isFile() && /\.(ts|js|mts|mjs)$/.test(entry)) {
    scanFile(full);
  }
}

const devOnlyViolations = [];
const missingPackages = [];
for (const p of Array.from(usedPackages).sort()) {
  if (!deps.has(p)) {
    if (devDeps.has(p)) devOnlyViolations.push(p);
    else missingPackages.push(p);
  }
}

console.log(
  JSON.stringify(
    {
      scannedFiles: Array.from(visitedFiles).map((f) =>
        path.relative(repoRoot, f).replace(/\\/g, "/"),
      ),
      requiredPackages: Array.from(usedPackages).sort(),
      devOnlyViolations,
      missingPackages,
    },
    null,
    2,
  ),
);

if (devOnlyViolations.length > 0 || missingPackages.length > 0) {
  process.exit(1);
}
