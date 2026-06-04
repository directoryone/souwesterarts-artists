// Runs once per Node.js worker, before any request is handled. Eager-loads
// @/lib/init so initApp() has set the AppContext before any page or layout
// calls getAppContext(). Without this, page stubs that don't transitively
// import @/lib/init can throw "App context not initialized".
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./lib/init");
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export { captureRequestError as onRequestError } from "@sentry/nextjs";
