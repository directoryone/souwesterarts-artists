#!/usr/bin/env npx tsx
/**
 * Interactive setup wizard for spawned Directory Platform projects.
 *
 * Usage: pnpm setup
 *
 * Guides through:
 *   Phase 0 — Create GitHub repo (directoryone/<name>)
 *   Phase 1 — GitHub Packages auth + pnpm install
 *   Phase 2 — Supabase / .env.local configuration
 *   Phase 3 — Database migration + seed
 *   Phase 4 — Optional Vercel deployment
 *   Phase 5 — Optional Cloudflare DNS (gated on CLOUDFLARE_API_TOKEN)
 *
 * Uses only Node built-ins so it works before `pnpm install`.
 */

import * as readline from "readline";
import { execSync, spawnSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { randomBytes } from "crypto";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// __dirname is Node 21.2+; fall back when tsx transpiles to CJS
const __dirname =
  (import.meta as Record<string, unknown>).dirname as string | undefined
  ?? dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

// ────── Readline helpers ──────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

function askSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`${question}: `, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = await ask(`${question} (${hint})`);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

function banner(phase: string) {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`  ${phase}`);
  console.log(`${"─".repeat(50)}\n`);
}

function run(cmd: string, opts?: { cwd?: string; stdio?: "inherit" | "pipe" }) {
  execSync(cmd, {
    cwd: opts?.cwd || PROJECT_ROOT,
    stdio: opts?.stdio || "inherit",
    env: { ...process.env },
  });
}

// ────── Phase 0: Create GitHub Repo ──────

async function createGithubRepo(): Promise<void> {
  banner("Phase 0: Create GitHub Repo");

  let repoName = "";
  try {
    const pkg = JSON.parse(readFileSync(resolve(PROJECT_ROOT, "package.json"), "utf-8"));
    const name = String(pkg.name || "");
    repoName = name.startsWith("@directoryone/") ? name.slice("@directoryone/".length) : name;
  } catch {
    // ignore
  }
  if (!repoName) {
    console.log("Could not determine repo name from package.json — skipping.\n");
    return;
  }
  const fullName = `directoryone/${repoName}`;

  // Detect existing git repo + matching origin remote
  const isGitRepo = existsSync(resolve(PROJECT_ROOT, ".git"));
  let hasMatchingRemote = false;
  if (isGitRepo) {
    try {
      const remoteUrl = execSync("git remote get-url origin 2>/dev/null", {
        cwd: PROJECT_ROOT,
        encoding: "utf-8",
      }).trim();
      hasMatchingRemote = remoteUrl.includes(`directoryone/${repoName}`);
    } catch {
      // No origin remote configured
    }
  }
  if (hasMatchingRemote) {
    console.log(`✓ GitHub repo already configured (${fullName})\n`);
    return;
  }

  const shouldCreate = await confirm(`Create GitHub repo \`${fullName}\` now?`);
  if (!shouldCreate) {
    console.log("Skipping GitHub repo creation.\n");
    return;
  }

  const ghCheck = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
  if (ghCheck.status !== 0) {
    console.error("\nGitHub CLI (`gh`) is missing or not authenticated.");
    console.error("Install: https://cli.github.com/  then `gh auth login`");
    console.error(`Or create manually: gh repo create ${fullName} --private --source . --remote origin --push\n`);
    return;
  }

  if (!isGitRepo) {
    console.log("Initialising git repo...\n");
    try {
      run("git init");
      run("git add .");
      run('git commit -m "Initial commit"');
    } catch {
      console.error("git init / initial commit failed. Skipping repo creation.\n");
      return;
    }
  }

  console.log(`\nCreating ${fullName} on GitHub...\n`);
  try {
    run(`gh repo create ${fullName} --private --source . --remote origin --push`);
    console.log(`\nGitHub repo ${fullName} created and pushed.\n`);
  } catch {
    console.error(`\nFailed. Create manually: gh repo create ${fullName} --private --source . --remote origin --push\n`);
  }
}

// ────── Phase 1: GitHub Packages Auth + Install ──────

async function checkAndInstallPackages(): Promise<void> {
  banner("Phase 1: GitHub Packages Auth + Install");

  const npmrcPath = resolve(PROJECT_ROOT, ".npmrc");
  const npmrcContent = existsSync(npmrcPath)
    ? readFileSync(npmrcPath, "utf-8")
    : "";

  const hasToken = npmrcContent.includes(":_authToken=");

  let githubToken = "";

  if (hasToken) {
    console.log("GitHub Packages auth token already configured in .npmrc");
    // Extract existing token for reuse as GITHUB_TOKEN
    const match = npmrcContent.match(/:_authToken=(.+)/);
    if (match) githubToken = match[1].trim();
  } else {
    console.log("To install @directoryone packages and enable auto-updates,");
    console.log("you need a GitHub Personal Access Token with the `repo` scope.");
    console.log("(The `repo` scope includes package read access.)\n");
    console.log("Create one at: https://github.com/settings/tokens/new?scopes=repo\n");

    const token = await askSecret("Enter your GitHub Personal Access Token");
    if (!token) {
      console.error("Token is required. Aborting.");
      process.exit(1);
    }

    githubToken = token;
    const newNpmrc = npmrcContent.trimEnd() +
      (npmrcContent.endsWith("\n") || !npmrcContent ? "" : "\n") +
      `//npm.pkg.github.com/:_authToken=${token}\n`;
    writeFileSync(npmrcPath, newNpmrc);
    console.log("Token written to .npmrc\n");
  }

  // Store the token for Phase 4 (Vercel env vars)
  (globalThis as any).__githubToken = githubToken;

  // Check if already installed
  const coreExists = existsSync(
    resolve(PROJECT_ROOT, "node_modules/@directoryone/core")
  );

  if (coreExists) {
    const reinstall = await confirm("Packages already installed. Re-install?", false);
    if (!reinstall) {
      console.log("Skipping install.");
      return;
    }
  }

  console.log("\nRunning pnpm install...\n");
  try {
    run("pnpm install");
  } catch {
    console.error("\npnpm install failed. Check your GitHub token and try again.");
    process.exit(1);
  }

  // Verify
  if (
    !existsSync(resolve(PROJECT_ROOT, "node_modules/@directoryone/core"))
  ) {
    console.error("Install appeared to succeed but @directoryone/core not found.");
    process.exit(1);
  }

  console.log("\nPackages installed successfully.");
}

// ────── Phase 2: Environment Configuration ──────

async function configureEnvironment(): Promise<Record<string, string>> {
  banner("Phase 2: Supabase Configuration");

  const envPath = resolve(PROJECT_ROOT, ".env.local");

  if (existsSync(envPath)) {
    const overwrite = await confirm(".env.local already exists. Overwrite?", false);
    if (!overwrite) {
      console.log("Keeping existing .env.local\n");
      // Parse existing values
      const existing = readFileSync(envPath, "utf-8");
      const vars: Record<string, string> = {};
      for (const line of existing.split("\n")) {
        const match = line.match(/^([^#=]+)=(.*)$/);
        if (match) vars[match[1].trim()] = match[2].trim();
      }
      return vars;
    }
  }

  console.log("Enter your Supabase project credentials.");
  console.log("Find these in: Supabase Dashboard > Project Settings > API\n");

  const supabaseUrl = await ask("Supabase project URL (e.g. https://xxx.supabase.co)");
  const supabaseAnonKey = await ask("Supabase anon/public key");
  const serviceRoleKey = await askSecret("Supabase service role key");

  console.log("");
  console.log("IMPORTANT: Use the Transaction Pooler URL (port 6543) from Supabase, not the Direct connection or Session pooler.");
  console.log("Go to: Supabase Dashboard > Connect (top button) > Transaction pooler");
  console.log("The URL looks like: postgresql://postgres.PROJECT_REF:PASSWORD@aws-N-REGION.pooler.supabase.com:6543/postgres");
  console.log("(Direct connections use IPv6 which doesn't work on Vercel; Session pooler at 5432 has too few connections for serverless.)\n");

  const databaseUrl = await ask("Database URL (Transaction pooler, port 6543)");

  const siteUrl = await ask("Site URL", "http://localhost:3001");
  const resendKey = await ask("Resend API key for email (optional, press Enter to skip)");

  // Default User-Agent for the Nominatim geocode proxy. OSM's TOS asks
  // production traffic to identify itself with an app-specific UA. Derive
  // a reasonable default from the site URL; admin can edit later.
  let geocodeDefault = "directoryone-platform (admin@directoryone.local)";
  try {
    const host = new URL(siteUrl).host.replace(/^www\./, "");
    if (host && !host.startsWith("localhost")) {
      geocodeDefault = `${host} (admin@${host})`;
    }
  } catch {
    // Keep platform default if URL parsing fails.
  }
  console.log("");
  console.log(
    "GEOCODE_USER_AGENT identifies your site to OpenStreetMap's Nominatim"
  );
  console.log(
    "geocoder (used by the city autocomplete on listing forms). Their TOS"
  );
  console.log(
    "asks for an app-specific User-Agent on production traffic. Use a real"
  );
  console.log('contact email — e.g. "your-domain.com (admin@your-domain.com)".\n');
  const geocodeUserAgent = await ask("GEOCODE_USER_AGENT", geocodeDefault);

  // Stable Server Actions encryption key, baked at build + read at runtime.
  // Without this, Vercel auto-rotates the key per deploy and any browser
  // tab open from a previous build hits "Server Action ... not found" on
  // submit until the user hard-refreshes.
  const serverActionsKey = randomBytes(32).toString("base64");

  const vars: Record<string, string> = {
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: supabaseAnonKey,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    DATABASE_URL: databaseUrl,
    NEXT_PUBLIC_SITE_URL: siteUrl,
    GEOCODE_USER_AGENT: geocodeUserAgent,
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: serverActionsKey,
  };
  if (resendKey) vars.RESEND_API_KEY = resendKey;

  const envContent = Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n";
  writeFileSync(envPath, envContent);
  console.log("\n.env.local written.\n");

  // Test database connection
  console.log("Testing database connection...");
  try {
    const { createDb } = await import("@directoryone/core/db");
    const db = createDb(databaseUrl);
    // Simple query to verify connection
    await (db as any).execute({ sql: "SELECT 1" });
    console.log("Database connection successful.\n");
  } catch (err: any) {
    console.warn(`Warning: Could not connect to database — ${err.message}`);
    console.warn("You can continue, but migration/seed may fail.\n");
  }

  return vars;
}

// ────── Phase 3: Migration + Seed ──────

async function migrateAndSeed(envVars: Record<string, string>): Promise<void> {
  banner("Phase 3: Database Migration + Seed");

  const databaseUrl = envVars.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL not set. Skipping migration and seed.");
    return;
  }

  // Run migrations
  console.log("Running database migrations...\n");
  try {
    run(`npx drizzle-kit migrate`, {
      cwd: PROJECT_ROOT,
    });
    console.log("\nMigrations applied successfully.\n");
  } catch {
    console.error("Migration failed. Check your DATABASE_URL and try again.");
    return;
  }

  // Seed
  const templatePath = resolve(PROJECT_ROOT, "template.json");
  if (!existsSync(templatePath)) {
    console.log("No template.json found — skipping seed.");
    return;
  }

  const shouldSeed = await confirm("Seed the database with template data?");
  if (!shouldSeed) {
    console.log("Skipping seed.");
    return;
  }

  console.log("\nSeeding database...\n");

  try {
    const template = JSON.parse(readFileSync(templatePath, "utf-8"));
    const { createDb } = await import("@directoryone/core/db");
    const { seedFromTemplate } = await import("@directoryone/core/db/seed");

    const db = createDb(databaseUrl);
    const { apiKey } = await seedFromTemplate(db, template);

    console.log(`\n  API Key: ${apiKey}`);
    console.log("  Save this key — you'll need it to use the ingest API.\n");
  } catch (err: any) {
    console.error(`Seed failed: ${err.message}`);
    console.error("You can re-run: pnpm setup (and skip to the seed step)");
  }
}

// ────── Phase 4: Optional Vercel Deployment ──────

async function deployToVercel(envVars: Record<string, string>): Promise<void> {
  banner("Phase 4: Deploy to Vercel (Optional)");

  const shouldDeploy = await confirm("Deploy to Vercel?", false);
  if (!shouldDeploy) {
    console.log("Skipping Vercel deployment.\n");
    return;
  }

  // Check if vercel CLI is installed
  const vercelCheck = spawnSync("which", ["vercel"], { encoding: "utf-8" });
  if (vercelCheck.status !== 0) {
    console.log("Vercel CLI not found. Install it with: npm i -g vercel");
    const install = await confirm("Install vercel CLI now?");
    if (install) {
      try {
        run("npm i -g vercel");
      } catch {
        console.error("Failed to install Vercel CLI. Skipping deployment.");
        return;
      }
    } else {
      console.log("Skipping deployment.");
      return;
    }
  }

  // Link to Vercel project
  console.log("\nLinking to Vercel project...\n");
  try {
    run("vercel link");
  } catch {
    console.error("Failed to link Vercel project. Skipping deployment.");
    return;
  }

  // Set environment variables
  console.log("\nSetting environment variables on Vercel...\n");
  for (const [key, value] of Object.entries(envVars)) {
    try {
      execSync(`echo -n '${value.replace(/'/g, "'\\''")}' | vercel env add ${key} production`, {
        cwd: PROJECT_ROOT,
        stdio: "pipe",
      });
      console.log(`  Set ${key}`);
    } catch {
      // May already exist, try to update
      console.log(`  ${key} — may already be set, skipping`);
    }
  }

  // Set NPM_RC for build-time registry auth
  const npmrcPath = resolve(PROJECT_ROOT, ".npmrc");
  if (existsSync(npmrcPath)) {
    const npmrcContent = readFileSync(npmrcPath, "utf-8");
    try {
      execSync(
        `echo -n '${npmrcContent.replace(/'/g, "'\\''")}' | vercel env add NPM_RC production`,
        { cwd: PROJECT_ROOT, stdio: "pipe" }
      );
      console.log("  Set NPM_RC (build-time registry auth)");
    } catch {
      console.log("  NPM_RC — may already be set, skipping");
    }
  }

  // Deploy
  console.log("\nDeploying to production...\n");
  try {
    run("vercel --prod");
    console.log("\nDeployment complete!");
  } catch {
    console.error("Deployment failed. You can retry with: vercel --prod");
  }
}

// ────── Phase 5: Cloudflare DNS (Optional) ──────

async function cfFetch(path: string, token: string, init?: { method?: string; body?: unknown }) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method: init?.method || "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  return res.json() as Promise<any>;
}

async function configureCloudflareDns(envVars: Record<string, string>): Promise<void> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) return; // Silently skip when not configured

  banner("Phase 5: Cloudflare DNS (Optional)");

  // Resolve apex domain — prefer NEXT_PUBLIC_SITE_URL, else ask
  let domain = "";
  const siteUrl = envVars.NEXT_PUBLIC_SITE_URL || "";
  try {
    if (siteUrl) {
      const host = new URL(siteUrl).host;
      if (host && !host.startsWith("localhost")) domain = host.replace(/^www\./, "");
    }
  } catch {
    // ignore
  }
  if (!domain) domain = await ask("Domain to configure (e.g. example.com)");
  domain = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  if (!domain) {
    console.log("No domain provided. Skipping DNS.\n");
    return;
  }

  const shouldConfigure = await confirm(`Configure DNS for ${domain}?`);
  if (!shouldConfigure) {
    console.log("Skipping DNS configuration.\n");
    return;
  }

  let zoneId = "";
  try {
    const zones = await cfFetch(`/zones?name=${encodeURIComponent(domain)}`, token);
    if (!zones.success || !zones.result?.length) {
      console.error(`Cloudflare zone for ${domain} not found. Add the domain to Cloudflare first.\n`);
      return;
    }
    zoneId = zones.result[0].id;
  } catch (err: any) {
    console.error(`Cloudflare zone lookup failed: ${err.message}\n`);
    return;
  }

  // Vercel handles SSL termination; CF proxy on apex needs CNAME flattening
  // which adds latency, so leave proxy off for both records.
  const records = [domain, `www.${domain}`];
  for (const name of records) {
    try {
      const existing = await cfFetch(
        `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`,
        token
      );
      if (existing.success && existing.result?.length > 0) {
        console.log(`  ${name} — already exists, skipping`);
        continue;
      }
      const created = await cfFetch(`/zones/${zoneId}/dns_records`, token, {
        method: "POST",
        body: { type: "CNAME", name, content: "cname.vercel-dns.com", proxied: false, ttl: 1 },
      });
      if (created.success) {
        console.log(`  ${name} — created (CNAME → cname.vercel-dns.com)`);
      } else {
        console.log(`  ${name} — failed: ${created.errors?.[0]?.message || "unknown error"}`);
      }
    } catch (err: any) {
      console.log(`  ${name} — failed: ${err.message}`);
    }
  }

  // Alias the deployment to the custom domain so Vercel issues the cert.
  // Without this, `vercel domains add` only registers the domain at the
  // project level — it doesn't bind to the active deployment, so HTTPS
  // never becomes serving and the apex returns SSL_ERROR_SYSCALL.
  await aliasVercelDeployment(domain);
}

async function aliasVercelDeployment(domain: string): Promise<void> {
  const projectFile = resolve(PROJECT_ROOT, ".vercel/project.json");
  if (!existsSync(projectFile)) {
    console.log(
      `\nSkipping Vercel alias for ${domain} — no .vercel/project.json found.`
    );
    console.log(`  Manual: vercel alias set <project>.vercel.app ${domain}\n`);
    return;
  }
  let projectName = "";
  try {
    const project = JSON.parse(readFileSync(projectFile, "utf-8"));
    projectName = String(project.projectName || "");
  } catch {
    // ignore
  }
  if (!projectName) {
    console.log(`\nSkipping Vercel alias — could not read projectName.\n`);
    return;
  }
  const source = `${projectName}.vercel.app`;

  console.log(`\nAliasing Vercel deployment to ${domain} (and www)...`);

  // Vercel issues the cert via an HTTP-01 ACME challenge when alias is set,
  // which only succeeds once DNS resolves to Vercel's anycast IP. CF DNS
  // updates propagate fast (proxy off → ~30s globally), but be patient.
  for (const target of [domain, `www.${domain}`]) {
    await waitForVercelDns(target);
    try {
      execSync(`vercel alias set ${source} ${target}`, {
        cwd: PROJECT_ROOT,
        stdio: "inherit",
      });
    } catch {
      console.log(
        `  ${target} — alias failed. Retry once DNS settles:\n` +
        `    vercel alias set ${source} ${target}`
      );
    }
  }
}

async function waitForVercelDns(name: string): Promise<void> {
  const VERCEL_IP = "76.76.21.21";
  const MAX_TRIES = 18; // ~3 minutes at 10s each
  for (let i = 0; i < MAX_TRIES; i++) {
    try {
      const out = execSync(
        `dig +short +time=2 +tries=1 @1.1.1.1 ${name} A`,
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
      ).trim();
      if (out.split("\n").some((line) => line === VERCEL_IP)) return;
      // CNAME pointing at vercel-dns.com is also good — pooler will resolve it.
      if (out.includes("vercel-dns.com")) return;
    } catch {
      // `dig` not on PATH — just wait a bit and proceed.
      await new Promise((r) => setTimeout(r, 10000));
      return;
    }
    if (i === 0) console.log(`  ${name} — waiting for DNS to point at Vercel...`);
    await new Promise((r) => setTimeout(r, 10000));
  }
  console.log(
    `  ${name} — DNS not pointing at Vercel after 3 min; trying alias anyway.`
  );
}

// ────── Main ──────

async function main() {
  console.log("\n  Directory Platform Setup Wizard\n");
  console.log("This wizard will guide you through setting up your directory.\n");
  console.log("Prerequisites:");
  console.log("  1. A GitHub Personal Access Token with `repo` scope");
  console.log("  2. A Supabase project (https://supabase.com/dashboard)\n");

  await createGithubRepo();
  await checkAndInstallPackages();
  const envVars = await configureEnvironment();
  await migrateAndSeed(envVars);
  await deployToVercel(envVars);
  await configureCloudflareDns(envVars);

  banner("Setup Complete!");
  console.log("Start your development server with:\n");
  console.log("  pnpm dev\n");
  console.log("Your directory will be available at: http://localhost:3001\n");

  rl.close();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  rl.close();
  process.exit(1);
});
