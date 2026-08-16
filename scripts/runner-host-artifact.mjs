import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

const ARTIFACT_FILENAME = "runner-host.mjs";
const MANIFEST_FILENAME = "runner-host.manifest.json";

async function atomicWrite(path, content) {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { mode: 0o644 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

/** Build the one dependency-free runner artifact and publish its manifest last. */
export async function stageRunnerHostArtifact({ root, outDir, entryPoint, packageVersion }) {
  await mkdir(outDir, { recursive: true });
  const temporaryBundle = join(outDir, `.${ARTIFACT_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
  const artifactPath = join(outDir, ARTIFACT_FILENAME);
  const manifestPath = join(outDir, MANIFEST_FILENAME);
  try {
    await build({
      absWorkingDir: root,
      entryPoints: [entryPoint],
      outfile: temporaryBundle,
      bundle: true,
      platform: "node",
      format: "esm",
      banner: {
        js: 'import { createRequire as __hsrCreateRequire } from "node:module"; const require = __hsrCreateRequire(import.meta.url);',
      },
      target: "node18",
      minify: false,
      define: {
        __HIVE_RUNNER_HOST_CONTENT_ADDRESSABLE__: "true",
        __HIVE_RUNNER_HOST_PACKAGE_VERSION__: JSON.stringify(packageVersion),
      },
      logLevel: "silent",
    });
    const bytes = await readFile(temporaryBundle);
    const digest = createHash("sha256").update(bytes).digest("hex");
    await rename(temporaryBundle, artifactPath);
    const manifest = {
      schemaVersion: 1,
      artifact: ARTIFACT_FILENAME,
      packageVersion,
      sha256: digest,
      bytes: bytes.byteLength,
    };
    // The manifest is the publication point. A crash before this rename leaves
    // old/mismatched evidence that runtime verification refuses fail-closed.
    await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { artifactPath, manifestPath, digest, bytes: bytes.byteLength };
  } finally {
    await rm(temporaryBundle, { force: true }).catch(() => undefined);
  }
}
