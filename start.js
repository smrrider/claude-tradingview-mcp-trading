/**
 * Railway entry point — reads START_MODE env var to decide what to run.
 * Bot service:       START_MODE=bot
 * Dashboard service: START_MODE=dashboard
 */

const mode = process.env.START_MODE || "bot";

if (mode === "dashboard") {
  console.log("Starting in DASHBOARD mode...");
  import("./dashboard.js");
} else {
  console.log("Starting in BOT mode...");
  import("./bot.js");
}
