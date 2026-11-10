/**
 * Keep resuming Entregues Path C batch until remaining == 0 or maxRounds.
 * Survives Correios outages via waitPortalUp inside entregues script.
 *
 * Usage: node --env-file=.env.local scripts/run-entregues-batch-until-done.mjs
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_ROUNDS = Number(process.env.ENTREGUES_MAX_ROUNDS || 50);
const PAUSE_MS = Number(process.env.ENTREGUES_ROUND_PAUSE_MS || 60000);

function remaining() {
  const list = JSON.parse(readFileSync(join(ROOT, "storage/entregues/entregues-trackings.json"), "utf8"));
  const done = new Set();
  const progPath = join(ROOT, "storage/entregues/batch-progress.json");
  const paidPath = join(ROOT, "storage/entregues/neon-already-paid.json");
  if (existsSync(progPath)) {
    for (const t of JSON.parse(readFileSync(progPath, "utf8")).done || []) done.add(t);
  }
  if (existsSync(paidPath)) {
    for (const t of JSON.parse(readFileSync(paidPath, "utf8")).trackings || []) done.add(t);
  }
  return {
    listTotal: list.count || list.trackings.length,
    done: done.size,
    remaining: list.trackings.filter((t) => !done.has(t)).length,
  };
}

function runOnce() {
  return new Promise((resolvePromise) => {
    // Refresh neon paid skip each round
    const refresh = spawn(process.execPath, ["scripts/neon-entregues-paid.mjs"], {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    });
    refresh.on("exit", () => {
      const child = spawn(
        process.execPath,
        ["--env-file=.env.local", "scripts/correios-rpa-entregues.mjs", "--batch"],
        { cwd: ROOT, stdio: "inherit", env: { ...process.env, HEADED: process.env.HEADED || "1" } },
      );
      child.on("exit", (code) => resolvePromise(code ?? 1));
    });
  });
}

console.log("UNTIL_DONE_START", remaining());
for (let round = 1; round <= MAX_ROUNDS; round++) {
  const before = remaining();
  if (before.remaining <= 0) {
    console.log("UNTIL_DONE_COMPLETE", before);
    process.exit(0);
  }
  console.log("UNTIL_DONE_ROUND", round, before);
  const code = await runOnce();
  const after = remaining();
  console.log("UNTIL_DONE_ROUND_END", { round, exit: code, ...after });
  if (after.remaining <= 0) {
    console.log("UNTIL_DONE_COMPLETE", after);
    process.exit(0);
  }
  console.log("pause", PAUSE_MS);
  await new Promise((r) => setTimeout(r, PAUSE_MS));
}
console.log("UNTIL_DONE_MAX_ROUNDS", remaining());
process.exit(2);
