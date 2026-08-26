import { cp, lstat, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(appRoot, "../..");
const publicRoot = path.join(appRoot, "public");
const source = path.join(repositoryRoot, "public", "demo-products");
const destination = path.join(publicRoot, "demo-products");
const staging = path.join(publicRoot, `.demo-products-sync-${process.pid}`);

function assertSafePaths() {
  const expectedDestination = path.join(appRoot, "public", "demo-products");
  if (destination !== expectedDestination || !destination.startsWith(`${publicRoot}${path.sep}`)) {
    throw new Error(`Refusing to replace an unexpected destination: ${destination}`);
  }
  if (source === destination || !source.startsWith(`${repositoryRoot}${path.sep}`)) {
    throw new Error(`Refusing to copy from an unexpected source: ${source}`);
  }
}

async function inspectSource(directory, relativeDirectory = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  let files = 0;
  let bytes = 0;

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.join(relativeDirectory, entry.name);
    const details = await lstat(absolutePath);

    if (details.isSymbolicLink()) {
      throw new Error(`Demo assets may not contain symbolic links: ${relativePath}`);
    }
    if (details.isDirectory()) {
      const nested = await inspectSource(absolutePath, relativePath);
      files += nested.files;
      bytes += nested.bytes;
      continue;
    }
    if (!details.isFile()) {
      throw new Error(`Unsupported demo asset type: ${relativePath}`);
    }

    files += 1;
    bytes += details.size;
  }

  return { files, bytes };
}

assertSafePaths();

const sourceStats = await stat(source).catch(() => null);
if (!sourceStats?.isDirectory()) {
  throw new Error(`Demo asset source is missing: ${source}`);
}

const inventory = await inspectSource(source);
if (inventory.files < 12) {
  throw new Error(`Demo asset source looks incomplete: found ${inventory.files} files`);
}

await mkdir(publicRoot, { recursive: true });
await rm(staging, { recursive: true, force: true });

try {
  await cp(source, staging, { recursive: true, force: false, errorOnExist: true });
  await rm(destination, { recursive: true, force: true });
  await rename(staging, destination);
} catch (error) {
  await rm(staging, { recursive: true, force: true });
  throw error;
}

console.log(`Synced ${inventory.files} frozen Demo assets (${inventory.bytes} bytes) into ${destination}`);
