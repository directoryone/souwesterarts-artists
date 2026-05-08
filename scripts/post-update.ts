#!/usr/bin/env npx tsx
/**
 * Post-update script — runs after `pnpm update @directoryone/*` in a spawned directory.
 *
 * 1. Syncs globals.css from the @directoryone/core reference.
 * 2. Backfills idempotent seed data (default legal pages).
 * 3. Updates `platformVersion` (and stamps `platformUpdatedAt`) in the directory config.
 *
 * Usage: npx tsx scripts/post-update.ts "1.2.3"
 */

import { resolve, relative, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, existsSync, realpathSync } from "fs";

// __dirname is Node 21.2+; fall back for Node 20 (Vercel default)
const __dirname =
  (import.meta as Record<string, unknown>).dirname as string | undefined
  ?? dirname(fileURLToPath(import.meta.url));

async function main() {
  const newVersion = process.argv[2];
  if (!newVersion) {
    console.error("Usage: npx tsx scripts/post-update.ts <version>");
    process.exit(1);
  }

  // Load .env.local for DATABASE_URL when running locally. On Vercel, env vars are
  // injected directly into process.env, so dotenv isn't installed and isn't needed.
  // Wrapped in try/catch so the script no-ops gracefully if dotenv is unavailable.
  try {
    const { config } = await import("dotenv");
    config({ path: resolve(__dirname, "../.env.local") });
  } catch {
    // dotenv not installed (e.g. Vercel build) — env vars come from the platform.
  }

  // Sync globals.css @theme variables from the reference in @directoryone/core
  try {
    const refCssPath = resolve(
      __dirname,
      "../node_modules/@directoryone/core/src/theme/globals-reference.css"
    );
    const localCssPath = resolve(__dirname, "../src/app/globals.css");
    if (existsSync(refCssPath)) {
      let refCss = readFileSync(refCssPath, "utf-8");
      // Resolve real pnpm store paths — pnpm symlinks at node_modules/@directoryone/* point to
      // .pnpm virtual store directories. Tailwind's Oxide scanner doesn't follow directory
      // symlinks, so using the resolved real paths ensures it finds the .tsx source files.
      const sourceLines: string[] = [];
      for (const pkg of ["app", "ui"]) {
        const symlinkPath = resolve(__dirname, `../node_modules/@directoryone/${pkg}`);
        try {
          const realPath = realpathSync(symlinkPath);
          const relPath = relative(dirname(localCssPath), realPath);
          sourceLines.push(`@source "${relPath}";`);
        } catch {
          // Package not installed, skip
        }
      }
      refCss = refCss.replace(
        '@import "tailwindcss";',
        sourceLines.length > 0
          ? `@import "tailwindcss";\n${sourceLines.join("\n")}`
          : '@import "tailwindcss";\n@source "../../node_modules/@directoryone";'
      );
      writeFileSync(localCssPath, refCss);
      console.log("Synced globals.css theme variables from @directoryone/core");
    }
  } catch (err) {
    console.warn("Could not sync globals.css:", err);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL not found in .env.local");
    process.exit(1);
  }

  // Dynamic imports so the database connection is established after env is loaded
  const { createDb } = await import("@directoryone/core/db");
  const { setPlatformVersion, getPlatformVersion } = await import(
    "@directoryone/core/actions"
  );

  const db = createDb(databaseUrl);

  // Idempotent data backfills — run on every deploy so existing directories
  // pick up new defaults without re-seeding. Each helper is responsible for
  // skipping rows that already exist.
  try {
    const { ensureDefaultLegalPages } = await import(
      "@directoryone/core/db/seed-pages"
    );
    const { inserted } = await ensureDefaultLegalPages(db);
    if (inserted.length > 0) {
      console.log(`Seeded missing pages: ${inserted.join(", ")}`);
    }
  } catch (err) {
    console.warn("ensureDefaultLegalPages failed (non-fatal):", err);
  }

  const oldVersion = await getPlatformVersion(db);
  if (oldVersion === newVersion) {
    console.log(`Already on version ${newVersion}, nothing further to do.`);
    process.exit(0);
  }

  // Update platform version (also stamps platformUpdatedAt). The current version
  // and update timestamp are surfaced in /admin/notifications, so per-update
  // notifications are not created here.
  await setPlatformVersion(db, newVersion);
  console.log(`Updated platformVersion: ${oldVersion} → ${newVersion}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Post-update failed:", err);
  process.exit(1);
});
