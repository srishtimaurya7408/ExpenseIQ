const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const clientDir = path.join(root, "node_modules", ".prisma", "client");
const hasGeneratedEngine = fs.existsSync(clientDir) && fs
  .readdirSync(clientDir)
  .some((file) =>
    (file.startsWith("query_engine-") || file.startsWith("libquery_engine-")) &&
    file.endsWith(".node")
  );

if (
  fs.existsSync(path.join(clientDir, "default.js")) &&
  fs.existsSync(path.join(clientDir, "schema.prisma")) &&
  hasGeneratedEngine
) {
  console.log("Prisma Client is already generated.");
  process.exit(0);
}

const prismaCli = path.join(root, "node_modules", "prisma", "build", "index.js");
if (!fs.existsSync(prismaCli)) {
  console.error("Prisma CLI is missing. Run npm install before starting the app.");
  process.exit(1);
}

try {
  execFileSync(process.execPath, [prismaCli, "generate"], {
    cwd: root,
    stdio: "inherit"
  });
} catch (error) {
  console.error("Prisma Client generation failed. Stop running app processes and retry with npm run prisma:generate.");
  process.exit(error.status || 1);
}
