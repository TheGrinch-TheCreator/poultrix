// Transpile src/lib/server/pi-gateway.ts and run the gateway tests with Node.
// Usage: npm run test:gateway
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../../src/lib/server/pi-gateway.ts"), "utf8");
const out = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
writeFileSync(join(here, "gw.mjs"), out.outputText);
let failed = false;
for (const file of ["app.test.mjs", "maintenance.test.mjs"]) {
  console.log(`\n=== ${file}`);
  try {
    execFileSync(process.execPath, [join(here, file)], { stdio: "inherit" });
  } catch {
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
