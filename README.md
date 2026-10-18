# ExpenseIQ

ExpenseIQ is a demo expense-claim application with separate employee and finance workspaces. Employees can enter claims, scan receipts for editable Gemini OCR results, and submit a lost-receipt declaration with optional supporting evidence. Finance reviewers can inspect policy flags, receipt signals, duplicate matches, and reimbursement status.

> **Demo only:** The role selector is not authentication or authorization. Do not use this app with real employee or financial data until proper identity, access control, secure evidence storage, and production database hosting are implemented.

## Requirements

- Windows (the current embedded PostgreSQL dependency is configured for Windows)
- Node.js and npm
- A Gemini API key for receipt OCR (optional; manual entry and policy checks work without it)

## Run locally

1. Copy `.env.example` to `.env`.
2. Set `EMBEDDED_POSTGRES_PASSWORD` to a strong, URL-safe password. Keep this value stable while reusing the local database.
3. Add your Gemini API key to `GEMINI_API_KEY` to enable receipt scanning.
4. Install, build, and start:

   ```powershell
   npm ci
   npm run build
   npm start
   ```

   For development with TypeScript reloading:

   ```powershell
   npm run dev
   ```

5. Open `http://localhost:3000`.

The embedded PostgreSQL cluster and uploaded supporting evidence are stored under `data/`. That directory is intentionally ignored by Git and must be backed up separately if you need to preserve local demo data.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (defaults to `3000`) |
| `GEMINI_API_KEY` | Server-side key for Gemini receipt analysis |
| `GEMINI_MODEL` | Gemini model name (defaults to `gemini-3.8-flash`) |
| `EMBEDDED_POSTGRES_PASSWORD` | Password for the local embedded PostgreSQL server |
| `DATABASE_URL` | Prisma schema connection placeholder; the app sets its local embedded-database URL at startup |

Never commit `.env`, database files, or uploaded evidence.
