/**
 * Creates the first owner account. Interactive by design:
 *   - the email is asked for (or passed as --email=...);
 *   - the password is read without echo from the terminal, or from the first line of stdin
 *     when piped. It is never accepted as a command-line argument or environment variable,
 *     so it cannot end up in shell history or process listings.
 * Refuses to run if an active owner already exists. Uses DATABASE_URL (the app role).
 */
import { createInterface } from "node:readline";

import { loadLocalEnv } from "./db-env";

loadLocalEnv();

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      const rl = createInterface({ input: stdin });
      rl.once("line", (line) => { rl.close(); resolve(line); });
      rl.once("close", () => resolve(""));
      return;
    }
    process.stdout.write(prompt);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\u0003") { stdin.setRawMode(false); reject(new Error("Cancelled")); return; }
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, (answer) => { rl.close(); resolve(answer); }));
}

async function main(): Promise<void> {
  const [{ getPool, closePool }, { createPasswordHasher, DEFAULT_SCRYPT_PARAMS }, { createUserService }, { syncAuthorizationCatalog }, { identityCatalog }] =
    await Promise.all([
      import("../src/shared/db/client"),
      import("../src/modules/identity/domain/password"),
      import("../src/modules/identity/application/users"),
      import("../src/modules/identity/application/catalog-sync"),
      import("../src/modules/identity/domain/catalog"),
    ]);
  const emailArg = process.argv.find((a) => a.startsWith("--email="))?.slice("--email=".length);
  const email = (emailArg ?? (await ask("Owner email: "))).trim();
  const password = await readHidden("Password (not shown): ");
  if (process.stdin.isTTY) {
    const again = await readHidden("Repeat password: ");
    if (again !== password) throw new Error("Passwords do not match.");
  }
  const pool = getPool();
  try {
    await syncAuthorizationCatalog(pool, identityCatalog);
    const users = createUserService({ pool, hasher: createPasswordHasher(DEFAULT_SCRYPT_PARAMS), now: () => new Date() });
    const result = await users.bootstrapOwner({ email, password });
    if (!result.ok) {
      const detail = result.error.code === "weak_password" ? ` (${result.error.issues.join(", ")})` : "";
      throw new Error(`Could not create the owner: ${result.error.code}${detail}`);
    }
    console.log(`Owner created: ${result.userId}`);
  } finally {
    await closePool();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Failed");
  process.exitCode = 1;
});
