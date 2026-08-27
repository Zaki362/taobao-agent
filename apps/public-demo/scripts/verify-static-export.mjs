import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDirectory, "..");
const outputRoot = path.join(appRoot, "out");
const repositoryRoot = path.resolve(appRoot, "../..");
const sourceAssetsRoot = path.join(repositoryRoot, "public", "demo-products");
const exportedAssetsRoot = path.join(outputRoot, "demo-products");

async function listFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(path.join(directory, entry.name), relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files.sort();
}

function exportedHtmlRoute(relativePath) {
  if (relativePath === "index.html") return "/";
  if (relativePath === "404.html" || relativePath === "_not-found.html") return "/404";
  if (relativePath.endsWith("/index.html")) {
    return `/${relativePath.slice(0, -"/index.html".length)}`;
  }
  if (relativePath.endsWith(".html")) return `/${relativePath.slice(0, -5)}`;
  return null;
}

await access(outputRoot).catch(() => {
  throw new Error(`Static export is missing: ${outputRoot}. Run npm run build first.`);
});

const outputFiles = await listFiles(outputRoot);
const publicRoutes = [...new Set(outputFiles.map(exportedHtmlRoute).filter(Boolean))].sort();
const allowedRoutes = new Set(["/", "/404", "/demo", "/product-guide"]);
const unexpectedRoutes = publicRoutes.filter((route) => !allowedRoutes.has(route));
const missingRoutes = [...allowedRoutes].filter((route) => !publicRoutes.includes(route));

if (unexpectedRoutes.length > 0 || missingRoutes.length > 0) {
  throw new Error([
    "Static route surface does not match the Demo-only contract.",
    `Expected: ${[...allowedRoutes].sort().join(", ")}`,
    `Actual: ${publicRoutes.join(", ") || "(none)"}`,
    unexpectedRoutes.length > 0 ? `Unexpected: ${unexpectedRoutes.join(", ")}` : "",
    missingRoutes.length > 0 ? `Missing: ${missingRoutes.join(", ")}` : ""
  ].filter(Boolean).join("\n"));
}

const forbiddenRoutePattern = /(^|\/)(api|hosted|login|settings)(\/|$)/;
const forbiddenFiles = outputFiles.filter((file) => {
  if (file.startsWith("_next/")) return false;
  return forbiddenRoutePattern.test(file.replace(/\.(html|txt|json)$/, ""));
});
if (forbiddenFiles.length > 0) {
  throw new Error(`Formal-product routes leaked into the static export:\n${forbiddenFiles.join("\n")}`);
}

const sourceAssets = await listFiles(sourceAssetsRoot);
const exportedAssets = await listFiles(exportedAssetsRoot);
if (JSON.stringify(sourceAssets) !== JSON.stringify(exportedAssets)) {
  throw new Error([
    "Frozen Demo asset export is incomplete.",
    `Source count: ${sourceAssets.length}`,
    `Exported count: ${exportedAssets.length}`
  ].join("\n"));
}

const appPathsManifestPath = path.join(appRoot, ".next", "server", "app-paths-manifest.json");
const appPathsManifest = JSON.parse(await readFile(appPathsManifestPath, "utf8"));
const manifestRoutes = Object.keys(appPathsManifest).sort();
const allowedManifestRoutes = new Set(["/_not-found/page", "/demo/page", "/page", "/product-guide/page"]);
const unexpectedManifestRoutes = manifestRoutes.filter((route) => !allowedManifestRoutes.has(route));
if (unexpectedManifestRoutes.length > 0) {
  throw new Error(`Unexpected App Router entries:\n${unexpectedManifestRoutes.join("\n")}`);
}

console.log(JSON.stringify({
  contract: "scenecart-public-demo-only",
  routes: publicRoutes,
  app_router_entries: manifestRoutes,
  frozen_asset_files: exportedAssets.length
}, null, 2));
