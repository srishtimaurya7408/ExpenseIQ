import fs from "node:fs/promises";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { PrismaClient } from "@prisma/client";

const DATABASE_DIR = path.resolve(process.cwd(), "data", "postgres");
const DATABASE_NAME = "expenseiq";
const POSTMASTER_PID_PATH = path.join(DATABASE_DIR, "postmaster.pid");
const POSTMASTER_OPTS_PATH = path.join(DATABASE_DIR, "postmaster.opts");

let pg: EmbeddedPostgres | undefined;
let prisma: PrismaClient | undefined;
let postgresStarted = false;

function getPostgres(): EmbeddedPostgres {
  if (!pg) {
    throw new Error("Embedded PostgreSQL has not been configured.");
  }
  return pg;
}

async function clearStalePostgresLock() {
  try {
    const pidText = await fs.readFile(POSTMASTER_PID_PATH, "utf8");
    const pid = Number(pidText.trim().split(/\s+/)[0]);

    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error(`PostgreSQL lock file contains an invalid PID: ${POSTMASTER_PID_PATH}`);
    }

    try {
      process.kill(pid, 0);
      throw new Error(
        `Embedded PostgreSQL is already running (PID ${pid}). Stop the other ExpenseIQ server before starting another one.`
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Embedded PostgreSQL is already running")) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw new Error(`Could not verify PostgreSQL process ${pid}; refusing to remove its lock file.`, { cause: error });
      }
    }

    await fs.rm(POSTMASTER_PID_PATH, { force: true });
    await fs.rm(POSTMASTER_OPTS_PATH, { force: true });
    console.log("Removed stale embedded PostgreSQL lock files.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function ensureDatabaseCluster() {
  try {
    await fs.access(path.join(DATABASE_DIR, "PG_VERSION"));
    await clearStalePostgresLock();
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await getPostgres().initialise();
}

async function ensureSchema() {
  if (!prisma) {
    return;
  }

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Claim" (
      "id" SERIAL PRIMARY KEY,
      "employeeId" TEXT NOT NULL,
      "merchant" TEXT NOT NULL,
      "amountPaise" INTEGER NOT NULL,
      "category" TEXT NOT NULL,
      "expenseDate" TIMESTAMP(3) NOT NULL,
      "purpose" TEXT,
      "clientName" TEXT,
      "receiptHash" TEXT,
      "status" TEXT NOT NULL DEFAULT 'NEEDS_REVIEW',
      "eligiblePaise" INTEGER,
      "warning" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Claim"
      ADD COLUMN IF NOT EXISTS "attendees" TEXT,
      ADD COLUMN IF NOT EXISTS "tripReference" TEXT,
      ADD COLUMN IF NOT EXISTS "tripDate" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "perceptualHash" TEXT,
      ADD COLUMN IF NOT EXISTS "transactionReference" TEXT,
      ADD COLUMN IF NOT EXISTS "lostReceiptDeclaration" TEXT,
      ADD COLUMN IF NOT EXISTS "evidenceId" TEXT,
      ADD COLUMN IF NOT EXISTS "evidenceName" TEXT,
      ADD COLUMN IF NOT EXISTS "evidenceMimeType" TEXT,
      ADD COLUMN IF NOT EXISTS "lineItemsJson" TEXT,
      ADD COLUMN IF NOT EXISTS "taxPaise" INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "tipPaise" INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "discountPaise" INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "originalAmountPaise" INTEGER,
      ADD COLUMN IF NOT EXISTS "originalCurrency" TEXT NOT NULL DEFAULT 'INR',
      ADD COLUMN IF NOT EXISTS "exchangeRate" DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS "exchangeRateDate" TEXT,
      ADD COLUMN IF NOT EXISTS "reimbursedAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "receiptAssessment" TEXT,
      ADD COLUMN IF NOT EXISTS "receiptSignalsJson" TEXT,
      ADD COLUMN IF NOT EXISTS "extractedReceiptJson" TEXT;
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ReceiptAnalysis" (
      "receiptHash" TEXT PRIMARY KEY,
      "merchant" TEXT NOT NULL,
      "amountPaise" INTEGER NOT NULL,
      "currency" TEXT NOT NULL,
      "expenseDate" TIMESTAMP(3),
      "category" TEXT NOT NULL,
      "extractedJson" TEXT NOT NULL,
      "visualAssessment" TEXT NOT NULL,
      "visualSignalsJson" TEXT NOT NULL,
      "arithmeticAssessment" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

async function ensureDatabaseExists() {
  const client = getPostgres().getPgClient();
  await client.connect();
  try {
    const result = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [DATABASE_NAME]
    );
    if (result.rowCount === 0) {
      await getPostgres().createDatabase(DATABASE_NAME);
    }
  } finally {
    await client.end();
  }
}

export async function startDatabase() {
  const password = process.env.EMBEDDED_POSTGRES_PASSWORD?.trim();
  if (!password) {
    throw new Error("EMBEDDED_POSTGRES_PASSWORD must be set in the server environment.");
  }
  pg = new EmbeddedPostgres({
    databaseDir: DATABASE_DIR,
    user: "postgres",
    password,
    port: 5432,
    persistent: true
  });
  await ensureDatabaseCluster();
  try {
    await getPostgres().start();
    postgresStarted = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not start embedded PostgreSQL: ${message}`, { cause: error });
  }

  try {
    await ensureDatabaseExists();

    process.env.DATABASE_URL = `postgresql://postgres:${encodeURIComponent(password)}@localhost:5432/${DATABASE_NAME}?schema=public`;
    prisma = new PrismaClient();
    await prisma.$connect();
    await ensureSchema();
  } catch (error) {
    if (prisma) {
      try {
        await prisma.$disconnect();
      } catch (cleanupError) {
        console.error("Could not disconnect Prisma after database startup failed:", cleanupError);
      }
    }
    prisma = undefined;
    if (postgresStarted) {
      try {
        await getPostgres().stop();
      } catch (cleanupError) {
        console.error("Could not stop embedded PostgreSQL after startup failed:", cleanupError);
      }
      postgresStarted = false;
    }
    throw error;
  }

  console.log("Embedded PostgreSQL and Prisma are connected.");
  return prisma;
}

export async function stopDatabase() {
  const hadDatabaseResources = Boolean(prisma) || postgresStarted;

  if (prisma) {
    await prisma.$disconnect();
    prisma = undefined;
  }

  if (postgresStarted) {
    await getPostgres().stop();
    postgresStarted = false;
  }

  if (hadDatabaseResources) {
    console.log("Embedded PostgreSQL stopped.");
  }
}
