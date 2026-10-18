import "dotenv/config";
import express, { type ErrorRequestHandler } from "express";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import { startDatabase, stopDatabase } from "./database";
import {
  amountsLikelyMatch,
  calculateItemEligibility,
  checkExpense,
  merchantsLikelyMatch
} from "./policy";
import type { PrismaClient } from "@prisma/client";

const app = express();
const PORT = Number(process.env.PORT || 3000);

let prisma: PrismaClient;
let server: Server | undefined;
let shuttingDown = false;

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(process.cwd(), "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.mimetype)) {
      callback(new InvalidUploadError("Upload a JPG, PNG, or WebP image."));
      return;
    }
    callback(null, true);
  }
});

const evidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    if (!allowed.includes(file.mimetype)) {
      callback(new InvalidUploadError("Alternative evidence must be a JPG, PNG, WebP, or PDF file."));
      return;
    }
    callback(null, true);
  }
});

class InvalidUploadError extends Error {}

const ai = process.env.GEMINI_API_KEY?.trim()
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY.trim() })
  : null;

const categories = new Set(["meal", "travel", "hotel", "other"]);
const itemKinds = new Set([
  "meal", "beverage", "travel", "lodging", "business",
  "alcohol", "personal", "tobacco", "entertainment", "souvenir", "unknown"
]);
const supportedCurrencies = new Set(["INR", "USD", "EUR", "GBP", "AED", "SGD", "AUD", "CAD", "JPY", "CHF"]);
const SPLIT_APPROVAL_THRESHOLD_PAISE = 500000;

function encodeDatabaseText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/[^\x00-\x7F]/g, (character) =>
    `\\u{${character.codePointAt(0)?.toString(16)}}`
  );
}

function decodeDatabaseText(value: string | null): string | null {
  return value?.replace(/\\u\{([0-9a-f]+)\}|\\\\/gi, (match, codePoint: string | undefined) =>
    codePoint ? String.fromCodePoint(Number.parseInt(codePoint, 16)) : "\\"
  ) ?? null;
}

function decodeClaim(claim: Record<string, unknown>): Record<string, unknown> {
  const textFields = [
    "employeeId", "merchant", "purpose", "clientName", "attendees",
    "tripReference", "transactionReference", "lostReceiptDeclaration", "evidenceName",
    "lineItemsJson", "warning", "receiptSignalsJson", "extractedReceiptJson"
  ];
  const decoded: Record<string, unknown> = { ...claim };
  for (const field of textFields) {
    const value = decoded[field];
    if (typeof value === "string" || value === null) {
      decoded[field] = decodeDatabaseText(value as string | null);
    }
  }
  return decoded;
}

function normalizedTransactionReference(value: string | null | undefined): string {
  return (value || "").normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function perceptualHashDistance(first: string, second: string): number {
  if (!/^[a-f0-9]{16}$/i.test(first) || !/^[a-f0-9]{16}$/i.test(second)) {
    return Number.POSITIVE_INFINITY;
  }
  let bits = BigInt(`0x${first}`) ^ BigInt(`0x${second}`);
  let distance = 0;
  while (bits) {
    distance += Number(bits & 1n);
    bits >>= 1n;
  }
  return distance;
}

const evidenceDirectory = path.resolve(process.cwd(), "data", "evidence");

function parseDateOnly(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
    ? null
    : date;
}

async function getExchangeRate(currency: string, date: string): Promise<{ rate: number; rateDate: string }> {
  if (currency === "INR") {
    return { rate: 1, rateDate: date };
  }

  const url = new URL(`https://api.frankfurter.dev/v1/${date}`);
  url.searchParams.set("base", currency);
  url.searchParams.set("symbols", "INR");
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    throw new Error(`The ECB reference exchange rate is unavailable for ${currency} on ${date}.`);
  }

  const data = await response.json() as { date?: unknown; rates?: Record<string, unknown> };
  const rate = data.rates?.INR;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || typeof data.date !== "string") {
    throw new Error(`The ECB reference exchange rate is unavailable for ${currency} on ${date}.`);
  }
  return { rate, rateDate: data.date };
}

app.get("/api/exchange-rate", async (req, res) => {
  const currency = typeof req.query.currency === "string" ? req.query.currency.toUpperCase() : "";
  const date = typeof req.query.date === "string" ? req.query.date : "";
  if (!supportedCurrencies.has(currency) || !parseDateOnly(date)) {
    res.status(400).json({ error: "Select a supported currency and valid transaction date." });
    return;
  }

  try {
    const quote = await getExchangeRate(currency, date);
    res.json({ currency, baseCurrency: "INR", rate: quote.rate, rateDate: quote.rateDate, source: "ECB reference rates via Frankfurter" });
  } catch (error) {
    console.error("Exchange-rate lookup failed:", error);
    res.status(503).json({ error: error instanceof Error ? error.message : "Could not load an exchange rate." });
  }
});

app.get("/api/status", (_req, res) => {
  res.json({
    api: "ok",
    receiptAI: Boolean(ai),
    model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
    demoPolicy: {
      splitExpenseThresholdRupees: SPLIT_APPROVAL_THRESHOLD_PAISE / 100,
      mealLimitRupeesPerDay: 2000,
      reportingDeadlineDays: 60,
      exchangeVariancePercent: 2,
      reportingTimezone: "Asia/Kolkata",
      exchangeRateSource: "ECB reference rates via Frankfurter"
    }
  });
});

app.post("/api/analyze-receipt", upload.single("receipt"), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "Please upload a receipt image." });
      return;
    }

    if (!ai) {
      res.status(500).json({ error: "Gemini API key is not configured." });
      return;
    }

    const receiptHash = crypto
      .createHash("sha256")
      .update(req.file.buffer)
      .digest("hex");

    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
      contents: [{
        role: "user",
        parts: [
          {
            text: `            Read the attached expense receipt and return ONLY a JSON object.
Use this exact structure:
{
  "merchant": "string or empty string",
              "amount": 0,
              "currency": "ISO 4217 currency code or INR",
              "category": "meal, travel, hotel, or other",
              "expenseDate": "YYYY-MM-DD or empty string",
              "tax": 0,
              "tip": 0,
              "discount": 0,
              "confidence": {
                "merchant": "high, medium, or low",
                "amount": "high, medium, or low",
                "currency": "high, medium, or low",
                "category": "high, medium, or low",
                "expenseDate": "high, medium, or low",
                "tax": "high, medium, or low",
                "tip": "high, medium, or low",
                "discount": "high, medium, or low",
                "lineItems": "high, medium, or low"
              },
              "lineItems": [{"description":"string","amount":0,"kind":"meal, beverage, travel, lodging, business, alcohol, personal, tobacco, entertainment, souvenir, or unknown"}],
              "documentAssessment": "receipt, not_a_receipt, or inconclusive",
              "documentSignals": ["specific visible evidence for document classification; empty if none"],
              "visualAssessment": "no_obvious_tampering, suspicious, or inconclusive",
              "visualSignals": ["specific visible alteration or consistency observations; empty if none"]
            }
            Rules:
            - Extract the final payable total, not the subtotal.
            - Read the printed receipt date and merchant name when visible.
            - Preserve the receipt's original amount and currency; do not convert currencies.
            - Extract each visible purchased item separately. Identify alcohol, tobacco, personal, souvenir, and entertainment items explicitly.
            - Extract tax, tip, and discount separately when visible.
            - Give each extracted field a qualitative confidence: high when clearly printed and readable, medium when partly unclear or inferred from nearby receipt text, low when ambiguous or not visible. Confidence is an estimate, not a calibrated probability.
            - A missing field or unreadable field must have low confidence. Do not make up values to raise confidence.
            - If the receipt is not itemized or a value is uncertain, return an empty lineItems array or kind "unknown"; never invent details.
            - First determine whether the image visibly appears to be a transaction receipt; use "not_a_receipt" only when the image is clearly another document or unrelated image.
            - Inspect visible evidence for possible editing, inconsistent fonts/alignment, pasted regions, altered totals/dates, repeated or obscured text, and inconsistent receipt layout.
            - Use "suspicious" only when there are specific observable signs of alteration; otherwise use "no_obvious_tampering" when the image is sufficiently clear, or "inconclusive" when quality/details prevent a useful assessment.
            - Describe observable evidence only. Do not infer that an image is genuine just because it looks consistent, and never claim certain authenticity or forgery.
            - Infer the category only from the receipt contents.
            - A receipt cannot establish business purpose, trip authorization, attendees, or client.
            - Do not invent missing or unreadable information.
            - Use 0 if the total cannot be identified confidently.`.trim()
          },
          {
            inlineData: {
              mimeType: req.file.mimetype,
              data: req.file.buffer.toString("base64")
            }
          }
        ]
      }],
      config: {
        responseMimeType: "application/json"
      }
    });

    const raw = response.text || "";
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed: unknown = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Gemini returned an invalid receipt response.");
    }
    const result = parsed as Record<string, unknown>;
    const lineItems = Array.isArray(result.lineItems)
      ? result.lineItems.slice(0, 100).flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const line = item as Record<string, unknown>;
        return [{
          description: typeof line.description === "string" ? line.description.trim().slice(0, 160) : "",
          amount: typeof line.amount === "number" && Number.isFinite(line.amount) && line.amount > 0
            ? Math.round(line.amount * 100) / 100
            : 0,
          kind: typeof line.kind === "string" && itemKinds.has(line.kind.toLowerCase())
            ? line.kind.toLowerCase()
            : "unknown"
        }];
      })
      : [];
    const extracted = {
      merchant: typeof result.merchant === "string" ? result.merchant.trim().slice(0, 160) : "",
      amount: typeof result.amount === "number" &&
        Number.isFinite(result.amount) &&
        result.amount > 0 &&
        result.amount <= 21474836.47
        ? Math.round(result.amount * 100) / 100
        : 0,
      currency: typeof result.currency === "string" && supportedCurrencies.has(result.currency.toUpperCase())
        ? result.currency.toUpperCase()
        : "",
      category: typeof result.category === "string" && categories.has(result.category.toLowerCase())
        ? result.category.toLowerCase()
        : "other",
      expenseDate: typeof result.expenseDate === "string" && parseDateOnly(result.expenseDate)
        ? result.expenseDate
        : "",
      tax: typeof result.tax === "number" && Number.isFinite(result.tax) && result.tax >= 0 ? result.tax : 0,
      tip: typeof result.tip === "number" && Number.isFinite(result.tip) && result.tip >= 0 ? result.tip : 0,
      discount: typeof result.discount === "number" && Number.isFinite(result.discount) && result.discount >= 0 ? result.discount : 0,
      lineItems
    };

    const confidenceFields = ["merchant", "amount", "currency", "category", "expenseDate", "tax", "tip", "discount", "lineItems"] as const;
    const confidence = Object.fromEntries(confidenceFields.map((field) => {
      const reported = result.confidence && typeof result.confidence === "object" && !Array.isArray(result.confidence)
        ? (result.confidence as Record<string, unknown>)[field]
        : undefined;
      const hasExtractedValue = field === "lineItems"
        ? lineItems.length > 0
        : field === "amount"
          ? extracted.amount > 0
          : field === "category"
            ? typeof result.category === "string" && categories.has(result.category.toLowerCase())
          : field === "tax" || field === "tip" || field === "discount"
            ? typeof result[field] === "number" && Number.isFinite(result[field])
            : Boolean(extracted[field]);
      const level = ["high", "medium", "low"].includes(String(reported))
        ? String(reported)
        : hasExtractedValue
          ? "medium"
          : "low";
      return [field, hasExtractedValue ? level : "low"];
    })) as Record<typeof confidenceFields[number], string>;

    const visualAssessment = ["no_obvious_tampering", "suspicious", "inconclusive"].includes(String(result.visualAssessment))
      ? String(result.visualAssessment)
      : "inconclusive";
    const visualSignals = Array.isArray(result.visualSignals)
      ? result.visualSignals.filter((signal): signal is string => typeof signal === "string").slice(0, 10).map((signal) => signal.trim().slice(0, 240))
      : [];
    const documentAssessment = ["receipt", "not_a_receipt", "inconclusive"].includes(String(result.documentAssessment))
      ? String(result.documentAssessment)
      : "inconclusive";
    const documentSignals = Array.isArray(result.documentSignals)
      ? result.documentSignals.filter((signal): signal is string => typeof signal === "string").slice(0, 10).map((signal) => signal.trim().slice(0, 240))
      : [];
    const lineSubtotal = lineItems.reduce((total, item) => total + Math.round(item.amount * 100), 0);
    const claimedReceiptTotal = Math.round(extracted.amount * 100);
    const calculatedReceiptTotal = lineSubtotal + Math.round(extracted.tax * 100) +
      Math.round(extracted.tip * 100) - Math.round(extracted.discount * 100);
    const arithmeticAssessment = lineItems.length === 0 || claimedReceiptTotal <= 0
      ? "inconclusive"
      : Math.abs(calculatedReceiptTotal - claimedReceiptTotal) <= Math.max(100, Math.round(claimedReceiptTotal * 0.02))
        ? "consistent"
        : "mismatch";
    const assessmentSignals = [
      ...(documentAssessment === "not_a_receipt" ? ["The uploaded image does not appear to be a transaction receipt."] : []),
      ...documentSignals,
      ...(visualAssessment === "suspicious" ? ["Gemini flagged possible visible receipt alterations; human review is required."] : []),
      ...visualSignals,
      arithmeticAssessment === "consistent"
        ? "Receipt total reconciles with extracted items, tax, tip, and discount."
        : arithmeticAssessment === "mismatch"
          ? "Extracted receipt total does not reconcile with extracted items, tax, tip, and discount."
          : "Receipt arithmetic could not be checked because the receipt is not itemized or its total is unclear."
    ];
    const extractedJson = encodeDatabaseText(JSON.stringify({
      ...extracted,
      confidence,
      documentAssessment,
      documentSignals,
      visualAssessment,
      visualSignals,
      arithmeticAssessment
    }));
    await prisma.receiptAnalysis.upsert({
      where: { receiptHash },
      create: {
        receiptHash,
        merchant: encodeDatabaseText(extracted.merchant || ""),
        amountPaise: Math.round(extracted.amount * 100),
        currency: extracted.currency || "UNKNOWN",
        expenseDate: extracted.expenseDate ? parseDateOnly(extracted.expenseDate) : null,
        category: extracted.category,
        extractedJson,
        visualAssessment,
        visualSignalsJson: encodeDatabaseText(JSON.stringify(assessmentSignals)),
        arithmeticAssessment
      },
      update: {
        merchant: encodeDatabaseText(extracted.merchant || ""),
        amountPaise: Math.round(extracted.amount * 100),
        currency: extracted.currency || "UNKNOWN",
        expenseDate: extracted.expenseDate ? parseDateOnly(extracted.expenseDate) : null,
        category: extracted.category,
        extractedJson,
        visualAssessment,
        visualSignalsJson: encodeDatabaseText(JSON.stringify(assessmentSignals)),
        arithmeticAssessment,
        createdAt: new Date()
      }
    });

    res.json({
      extracted,
      confidence,
      receiptHash,
      verification: {
        documentAssessment,
        documentSignals,
        visualAssessment,
        arithmeticAssessment,
        signals: assessmentSignals,
        disclaimer: "Image analysis and arithmetic checks are risk indicators only; they cannot authenticate a receipt with certainty or verify it against a merchant's transaction system."
      }
    });
  } catch (error) {
    console.error("Receipt analysis failed:", error);
    res.status(500).json({ error: "Could not read this receipt. Enter the details manually." });
  }
});

app.get("/api/claims", async (req, res) => {
  try {
    const employeeId = typeof req.query.employeeId === "string" ? req.query.employeeId.trim() : "";
    const claims = await prisma.claim.findMany({
      where: employeeId ? { employeeId: encodeDatabaseText(employeeId) } : undefined,
      orderBy: { createdAt: "desc" },
      take: 100
    });
    res.json(claims.map((claim) => decodeClaim(claim)));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load claims." });
  }
});

app.post("/api/evidence-upload", evidenceUpload.single("evidence"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "Choose a supporting-evidence file to upload." });
    return;
  }

  try {
    await fs.mkdir(evidenceDirectory, { recursive: true });
    const evidenceId = crypto.randomUUID();
    const evidenceName = path.basename(req.file.originalname).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 180) || "supporting-evidence";
    await fs.writeFile(path.join(evidenceDirectory, evidenceId), req.file.buffer, { flag: "wx" });
    res.status(201).json({
      evidenceId,
      evidenceName,
      evidenceMimeType: req.file.mimetype
    });
  } catch (error) {
    console.error("Supporting evidence upload failed:", error);
    res.status(500).json({ error: "Could not save the supporting evidence." });
  }
});

app.post("/api/claims", async (req, res) => {
  try {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      res.status(400).json({ error: "Please provide claim details as a JSON object." });
      return;
    }

    const {
      employeeId,
      merchant,
      amountRupees,
      category,
      expenseDate,
      purpose,
      clientName,
      attendees,
      tripReference,
      tripDate,
      receiptHash,
      perceptualHash,
      transactionReference = "",
      lostReceiptDeclared = false,
      lostReceiptDeclaration = "",
      evidenceId = "",
      evidenceName = "",
      evidenceMimeType = "",
      originalAmount,
      originalCurrency = "INR",
      tax = 0,
      tip = 0,
      discount = 0,
      lineItems = []
    } = req.body;

    if (
      typeof employeeId !== "string" ||
      !employeeId.trim() ||
      employeeId.length > 80 ||
      typeof merchant !== "string" ||
      !merchant.trim() ||
      merchant.length > 160 ||
      typeof category !== "string" ||
      !categories.has(category.toLowerCase()) ||
      typeof expenseDate !== "string" ||
      typeof amountRupees !== "number" ||
      !Number.isFinite(amountRupees) ||
      amountRupees <= 0 ||
      amountRupees > 21474836.47 ||
      typeof purpose !== "string" ||
      purpose.trim().length < 5 ||
      purpose.length > 1000 ||
      (clientName !== undefined && (typeof clientName !== "string" || clientName.length > 160)) ||
      (attendees !== undefined && (typeof attendees !== "string" || attendees.length > 500)) ||
      (tripReference !== undefined && (typeof tripReference !== "string" || tripReference.length > 100)) ||
      (tripDate !== undefined && tripDate !== "" && (typeof tripDate !== "string" || !parseDateOnly(tripDate))) ||
      (transactionReference !== undefined && (typeof transactionReference !== "string" || transactionReference.length > 100)) ||
      (perceptualHash !== undefined && perceptualHash !== "" &&
        (typeof perceptualHash !== "string" || !/^[a-f0-9]{16}$/i.test(perceptualHash))) ||
      typeof lostReceiptDeclared !== "boolean" ||
      (typeof lostReceiptDeclaration !== "string" || lostReceiptDeclaration.length > 1000) ||
      (evidenceId !== "" && (typeof evidenceId !== "string" || !/^[0-9a-f-]{36}$/i.test(evidenceId))) ||
      (typeof evidenceName !== "string" || evidenceName.length > 180) ||
      (typeof evidenceMimeType !== "string" ||
        (evidenceMimeType !== "" && !["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(evidenceMimeType))) ||
      Boolean(evidenceId) !== Boolean(evidenceName && evidenceMimeType) ||
      typeof originalCurrency !== "string" ||
      !supportedCurrencies.has(originalCurrency.toUpperCase()) ||
      (originalAmount !== undefined && (typeof originalAmount !== "number" || !Number.isFinite(originalAmount) || originalAmount <= 0 || originalAmount > 21474836.47)) ||
      ![tax, tip, discount].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 21474836.47) ||
      !Array.isArray(lineItems) ||
      lineItems.length > 100 ||
      !lineItems.every((item: unknown) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return false;
        const line = item as Record<string, unknown>;
        return typeof line.description === "string" &&
          line.description.trim().length > 0 &&
          line.description.length <= 160 &&
          typeof line.amount === "number" &&
          Number.isFinite(line.amount) &&
          line.amount > 0 &&
          line.amount <= 21474836.47 &&
          typeof line.kind === "string" &&
          itemKinds.has(line.kind.toLowerCase());
      }) ||
      (receiptHash !== undefined && receiptHash !== "" &&
        (typeof receiptHash !== "string" || !/^[a-f0-9]{64}$/i.test(receiptHash)))
    ) {
      res.status(400).json({ error: "Please provide valid claim details." });
      return;
    }

    if (!receiptHash && (
      !lostReceiptDeclared ||
      lostReceiptDeclaration.trim().length < 10
    )) {
      res.status(400).json({ error: "Without a receipt, confirm the lost-receipt declaration and explain what happened (at least 10 characters)." });
      return;
    }
    if (receiptHash && lostReceiptDeclared) {
      res.status(400).json({ error: "A lost-receipt declaration is only valid when no receipt image is attached." });
      return;
    }
    if (evidenceId) {
      try {
        await fs.access(path.join(evidenceDirectory, evidenceId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          res.status(400).json({ error: "The uploaded supporting evidence could not be found. Upload it again before submitting." });
          return;
        }
        throw error;
      }
    }

    const date = parseDateOnly(expenseDate);
    if (!date) {
      res.status(400).json({ error: "Please provide a valid expense date." });
      return;
    }

    const currency = originalCurrency.toUpperCase();
    const originalValue = typeof originalAmount === "number" ? originalAmount : amountRupees;
    const originalAmountPaise = Math.round(originalValue * 100);
    const amountPaise = Math.round(amountRupees * 100);
    if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0 || amountPaise > 2147483647) {
      res.status(400).json({ error: "Claim amount must be between ₹0.01 and ₹21,474,836.47." });
      return;
    }
    if (!Number.isSafeInteger(originalAmountPaise) || originalAmountPaise <= 0 || originalAmountPaise > 2147483647) {
      res.status(400).json({ error: "Original transaction amount must be between 0.01 and 21,474,836.47." });
      return;
    }
    const dateOnly = expenseDate;
    let fxQuote: { rate: number; rateDate: string };
    try {
      fxQuote = await getExchangeRate(currency, dateOnly);
    } catch (error) {
      console.error("Could not verify submitted currency conversion:", error);
      res.status(503).json({
        error: error instanceof Error ? error.message : "Could not verify the transaction-date exchange rate."
      });
      return;
    }
    const convertedOriginalPaise = Math.round(originalAmountPaise * fxQuote.rate);
    const exchangeDifference = Math.abs(amountPaise - convertedOriginalPaise);
    const exchangeVariance = currency !== "INR" &&
      exchangeDifference > Math.max(100, Math.round(convertedOriginalPaise * 0.02));
    if (!Number.isSafeInteger(convertedOriginalPaise) || convertedOriginalPaise <= 0 || convertedOriginalPaise > 2147483647) {
      res.status(400).json({ error: "The transaction-date conversion is outside the supported claim amount range." });
      return;
    }

    let duplicate = null;
    let receiptAnalysis = null;
    if (typeof receiptHash === "string" && receiptHash) {
      duplicate = await prisma.claim.findFirst({ where: { receiptHash } });
      receiptAnalysis = await prisma.receiptAnalysis.findUnique({ where: { receiptHash } });
    }
    const receiptSignals: string[] = [];
    let extractedReceipt: Record<string, unknown> | null = null;
    if (typeof receiptHash === "string" && receiptHash) {
      if (!receiptAnalysis) {
        receiptSignals.push("No server-stored Gemini analysis is linked to this receipt image; receipt details could not be reconciled.");
      } else {
        try {
          extractedReceipt = JSON.parse(decodeDatabaseText(receiptAnalysis.extractedJson) || "{}") as Record<string, unknown>;
        } catch (error) {
          console.error("Stored receipt analysis could not be parsed:", error);
          receiptSignals.push("Stored receipt extraction could not be parsed; manual review is required.");
        }
        const extractedMerchant = extractedReceipt?.merchant;
        if (typeof extractedMerchant === "string" && extractedMerchant &&
            !merchantsLikelyMatch(extractedMerchant, merchant)) {
          receiptSignals.push("Submitted merchant differs from the merchant Gemini extracted from the receipt.");
        }
        if (receiptAnalysis.currency !== "UNKNOWN" && currency !== receiptAnalysis.currency) {
          receiptSignals.push(`Submitted currency (${currency}) differs from the receipt extraction (${receiptAnalysis.currency}).`);
        }
        if (receiptAnalysis.amountPaise > 0 && !amountsLikelyMatch(receiptAnalysis.amountPaise, originalAmountPaise)) {
          receiptSignals.push("Submitted original amount differs from the amount Gemini extracted from the receipt.");
        }
        if (receiptAnalysis.expenseDate &&
            Math.abs(receiptAnalysis.expenseDate.getTime() - date.getTime()) >= 86400000) {
          receiptSignals.push("Submitted expense date differs from the date Gemini extracted from the receipt.");
        }
        if (extractedReceipt?.documentAssessment === "not_a_receipt") {
          receiptSignals.push("Gemini classified the uploaded image as not appearing to be a transaction receipt.");
        } else if (extractedReceipt?.documentAssessment === "inconclusive") {
          receiptSignals.push("Gemini could not confidently determine whether the uploaded image is a transaction receipt.");
        }
        const extractedLineItems = Array.isArray(extractedReceipt?.lineItems)
          ? extractedReceipt.lineItems.flatMap((item): Array<{ description: string; amount: number; kind: string }> => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return [];
            const line = item as Record<string, unknown>;
            if (typeof line.description !== "string" || typeof line.amount !== "number" ||
                !Number.isFinite(line.amount) || typeof line.kind !== "string") return [];
            return [{ description: line.description.trim(), amount: line.amount, kind: line.kind.toLowerCase() }];
          })
          : [];
        const submittedLineItems = lineItems as Array<{ description: string; amount: number; kind: string }>;
        const lineItemsDiffer = extractedLineItems.length !== submittedLineItems.length ||
          extractedLineItems.some((item, index) => {
            const submitted = submittedLineItems[index];
            return !submitted ||
              item.description.trim().toLowerCase() !== submitted.description.trim().toLowerCase() ||
              Math.round(item.amount * 100) !== Math.round(submitted.amount * 100) ||
              item.kind !== submitted.kind.toLowerCase();
          });
        if (lineItemsDiffer) {
          receiptSignals.push("Submitted receipt line items differ from Gemini's server-stored extraction; the extracted items will be used for eligibility and the changes need human review.");
        }
        for (const key of ["tax", "tip", "discount"] as const) {
          const extractedValue = extractedReceipt?.[key];
          const submittedValue = { tax, tip, discount }[key];
          if (typeof extractedValue === "number" && Math.round(extractedValue * 100) !== Math.round(submittedValue * 100)) {
            receiptSignals.push(`Submitted ${key} differs from Gemini's server-stored receipt extraction.`);
          }
        }
        if (receiptAnalysis.visualAssessment === "suspicious" || extractedReceipt?.documentAssessment === "not_a_receipt") {
          const storedSignals: unknown = JSON.parse(decodeDatabaseText(receiptAnalysis.visualSignalsJson) || "[]");
          if (Array.isArray(storedSignals)) {
            receiptSignals.push(...storedSignals.filter((signal): signal is string => typeof signal === "string"));
          }
        } else if (receiptAnalysis.visualAssessment === "inconclusive") {
          receiptSignals.push("Gemini could not reach a useful visual-integrity assessment.");
        }
        if (receiptAnalysis.arithmeticAssessment === "mismatch") {
          receiptSignals.push("Extracted receipt arithmetic does not reconcile; review the original image and itemization.");
        } else if (receiptAnalysis.arithmeticAssessment === "inconclusive") {
          receiptSignals.push("Receipt arithmetic could not be independently checked from extracted line items.");
        }
      }
    } else {
      receiptSignals.push("No receipt image was attached; purchase details cannot be checked against the receipt.");
    }
    if (!receiptHash) {
      receiptSignals.push("Lost receipt declaration submitted; claim requires human review.");
    }
    const receiptAssessment = receiptSignals.length > 0
      ? "NEEDS_REVIEW"
      : receiptAnalysis
        ? "NO_OBVIOUS_ISSUES"
        : null;

    const startOfDay = new Date(date);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay);
    endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);
    const duplicateWindowStart = new Date(startOfDay);
    duplicateWindowStart.setUTCDate(duplicateWindowStart.getUTCDate() - 1);
    const duplicateWindowEnd = new Date(endOfDay);
    duplicateWindowEnd.setUTCDate(duplicateWindowEnd.getUTCDate() + 1);
    const relatedClaims = await prisma.claim.findMany({
      where: {
        employeeId: encodeDatabaseText(employeeId.trim()),
        expenseDate: { gte: duplicateWindowStart, lt: duplicateWindowEnd }
      },
      orderBy: { createdAt: "desc" },
      take: 500
    });

    const employeeClaims = await prisma.claim.findMany({
      where: { employeeId: encodeDatabaseText(employeeId.trim()) },
      orderBy: { createdAt: "desc" },
      take: 1000
    });
    const submittedTransactionReference = normalizedTransactionReference(transactionReference);
    const transactionDuplicate = submittedTransactionReference
      ? employeeClaims.find((claim) =>
        normalizedTransactionReference(decodeDatabaseText(claim.transactionReference)) === submittedTransactionReference
      )
      : undefined;
    const imageDuplicate = typeof perceptualHash === "string" && perceptualHash
      ? employeeClaims.find((claim) => {
        if (!claim.perceptualHash || perceptualHashDistance(claim.perceptualHash, perceptualHash) > 8) return false;
        const merchantMatches = merchantsLikelyMatch(decodeDatabaseText(claim.merchant) || "", merchant);
        const daysApart = Math.abs(claim.expenseDate.getTime() - date.getTime()) / 86400000;
        return merchantMatches || daysApart <= 30;
      })
      : undefined;
    if (!duplicate) duplicate = transactionDuplicate || imageDuplicate || null;

    const fuzzyDuplicate = duplicate || relatedClaims.find((claim) =>
      Math.abs(claim.expenseDate.getTime() - date.getTime()) <= 86400000 &&
      merchantsLikelyMatch(decodeDatabaseText(claim.merchant) || "", merchant) &&
      amountsLikelyMatch(claim.amountPaise, amountPaise)
    );
    if (!duplicate) duplicate = fuzzyDuplicate || null;

    let previousMealPaise = 0;
    const sameDayClaims = relatedClaims.filter((claim) =>
      claim.expenseDate >= startOfDay && claim.expenseDate < endOfDay
    );
    previousMealPaise = sameDayClaims
      .filter((claim) => claim.category.toLowerCase() === "meal")
      .reduce((total, claim) => total + claim.amountPaise, 0);

    const sameMerchantClaims = sameDayClaims.filter((claim) =>
      merchantsLikelyMatch(decodeDatabaseText(claim.merchant) || "", merchant) &&
      (!tripReference || !claim.tripReference || decodeDatabaseText(claim.tripReference)?.toLowerCase() === tripReference.toLowerCase())
    );
    const splitTotalPaise = sameMerchantClaims.reduce((total, claim) => total + claim.amountPaise, amountPaise);
    const splitWarning = sameMerchantClaims.length > 0 &&
      amountPaise < SPLIT_APPROVAL_THRESHOLD_PAISE &&
      splitTotalPaise > SPLIT_APPROVAL_THRESHOLD_PAISE
      ? [`Related claims for this employee, merchant, date, and trip total ₹${(splitTotalPaise / 100).toFixed(2)}, above the demo ₹5,000 approval threshold. Review for possible split expenses.`]
      : [];
    if (splitWarning.length > 0) {
      await Promise.all(sameMerchantClaims
        .filter((claim) => !decodeDatabaseText(claim.warning)?.includes("possible split expenses"))
        .map((claim) => prisma.claim.update({
          where: { id: claim.id },
          data: {
            status: claim.status === "COMPLIANT" ? "NEEDS_REVIEW" : claim.status,
            warning: encodeDatabaseText(`${decodeDatabaseText(claim.warning) || ""} Related claims for the same employee, merchant, date, and trip exceed the demo ₹5,000 threshold; review for possible split expenses.`.trim())
          }
        })));
    }

    const lineItemsInRupees = (lineItems as Array<{ description: string; amount: number; kind: string }>).map((item) => ({
      description: item.description.trim(),
      amountPaise: Math.round(item.amount * fxQuote.rate * 100),
      kind: item.kind.toLowerCase()
    }));
    const policyReceiptItems = receiptAnalysis
      ? (Array.isArray(extractedReceipt?.lineItems) ? extractedReceipt.lineItems : [])
        .flatMap((item): Array<{ description: string; amount: number; kind: string }> => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return [];
          const line = item as Record<string, unknown>;
          return typeof line.description === "string" && typeof line.amount === "number" &&
            Number.isFinite(line.amount) && line.amount > 0 && typeof line.kind === "string" &&
            itemKinds.has(line.kind.toLowerCase())
            ? [{ description: line.description, amount: line.amount, kind: line.kind.toLowerCase() }]
            : [];
        })
      : (lineItems as Array<{ description: string; amount: number; kind: string }>);
    const policyLineItemsInRupees = policyReceiptItems.map((item) => ({
      description: item.description,
      amountPaise: Math.round(item.amount * fxQuote.rate * 100),
      kind: item.kind.toLowerCase()
    }));
    const policyTax = receiptAnalysis && typeof extractedReceipt?.tax === "number" ? extractedReceipt.tax : tax;
    const policyTip = receiptAnalysis && typeof extractedReceipt?.tip === "number" ? extractedReceipt.tip : tip;
    const policyDiscount = receiptAnalysis && typeof extractedReceipt?.discount === "number" ? extractedReceipt.discount : discount;
    const itemResult = calculateItemEligibility(
      convertedOriginalPaise,
      policyLineItemsInRupees,
      Math.round(policyTax * fxQuote.rate * 100),
      Math.round(policyTip * fxQuote.rate * 100),
      Math.round(policyDiscount * fxQuote.rate * 100)
    );

    const tripWarnings: string[] = [];
    if (["travel", "hotel"].includes(category.toLowerCase()) && (!tripReference || !tripDate)) {
      tripWarnings.push("Travel and hotel claims need an authorized trip reference and trip date; authorization cannot be verified without a travel-system integration.");
    } else if (["travel", "hotel"].includes(category.toLowerCase())) {
      tripWarnings.push("Trip reference captured but not checked against an authorized travel system; review trip approval.");
    }
    if (category.toLowerCase() === "meal" && clientName && !attendees) {
      tripWarnings.push("Client meal requires attendee details for review; the entered business purpose cannot be independently verified.");
    }
    if (currency !== "INR") {
      tripWarnings.push(`Converted using the ECB reference rate (${fxQuote.rateDate}). Variance from the entered INR claim is ${((exchangeDifference / convertedOriginalPaise) * 100).toFixed(2)}%.`);
      if (exchangeVariance) {
        tripWarnings.push("Entered INR amount differs from the transaction-date reference conversion by more than the demo 2% tolerance.");
      }
    }

    const result = checkExpense({
      employeeId: encodeDatabaseText(employeeId.trim()),
      merchant: encodeDatabaseText(merchant.trim()),
      amountPaise,
      category: category.toLowerCase(),
      expenseDate: date,
      purpose,
      clientName
    }, previousMealPaise, itemResult.eligiblePaise, [
      ...itemResult.warnings,
      ...splitWarning,
      ...tripWarnings,
      "Business purpose is employee-attested and cannot be verified from a receipt alone."
    ]);

    const status = duplicate
      ? "POSSIBLE_DUPLICATE"
      : receiptAssessment === "NEEDS_REVIEW"
        ? "NEEDS_REVIEW"
        : result.status;
    const warning = [
      duplicate ? `A receipt hash, transaction reference, similar receipt image, or matching claim details point to claim #${duplicate.id}; review both submissions for a possible duplicate.` : "",
      transactionDuplicate ? `Transaction reference matches claim #${transactionDuplicate.id}.` : "",
      imageDuplicate ? `Receipt image is perceptually similar to claim #${imageDuplicate.id}, even if details differ.` : "",
      !receiptHash ? "Lost receipt declared; alternate evidence and declaration require human review." : "",
      ...receiptSignals,
      receiptAssessment === "NO_OBVIOUS_ISSUES"
        ? "No obvious visual or arithmetic issues were detected by AI checks. This is not proof of authenticity; confirm against issuer or payment records."
        : "",
      result.warning
    ].filter(Boolean).join(" ");

    const claim = await prisma.$transaction(async (transaction) => {
      const createdClaim = await transaction.claim.create({
      data: {
        employeeId,
        merchant,
        amountPaise,
        category: category.toLowerCase(),
        expenseDate: date,
        purpose: encodeDatabaseText(purpose),
        clientName: typeof clientName === "string" ? encodeDatabaseText(clientName) : null,
        attendees: typeof attendees === "string" ? encodeDatabaseText(attendees) : null,
        tripReference: typeof tripReference === "string" ? encodeDatabaseText(tripReference) : null,
        transactionReference: typeof transactionReference === "string" && transactionReference.trim()
          ? encodeDatabaseText(transactionReference.trim())
          : null,
        tripDate: typeof tripDate === "string" && tripDate ? parseDateOnly(tripDate) : null,
        receiptHash: typeof receiptHash === "string" ? receiptHash : null,
        perceptualHash: typeof perceptualHash === "string" && perceptualHash ? perceptualHash.toLowerCase() : null,
        lostReceiptDeclaration: !receiptHash ? encodeDatabaseText(lostReceiptDeclaration.trim()) : null,
        evidenceId: evidenceId || null,
        evidenceName: evidenceId ? encodeDatabaseText(evidenceName) : null,
        evidenceMimeType: evidenceMimeType || null,
        lineItemsJson: encodeDatabaseText(JSON.stringify(lineItemsInRupees)),
        taxPaise: Math.round(tax * fxQuote.rate * 100),
        tipPaise: Math.round(tip * fxQuote.rate * 100),
        discountPaise: Math.round(discount * fxQuote.rate * 100),
        originalAmountPaise,
        originalCurrency: currency,
        exchangeRate: fxQuote.rate,
        exchangeRateDate: fxQuote.rateDate,
        receiptAssessment,
        receiptSignalsJson: encodeDatabaseText(JSON.stringify(receiptSignals)),
        extractedReceiptJson: encodeDatabaseText(JSON.stringify({
          ...(extractedReceipt || {}),
          verification: {
            documentAssessment: extractedReceipt?.documentAssessment ?? "unavailable",
            visualAssessment: receiptAnalysis?.visualAssessment ?? "unavailable",
            arithmeticAssessment: receiptAnalysis?.arithmeticAssessment ?? "unavailable",
            signals: receiptAnalysis
              ? JSON.parse(decodeDatabaseText(receiptAnalysis.visualSignalsJson) || "[]")
              : []
          },
          submittedParameters: {
            employeeId: employeeId.trim(),
            merchant: merchant.trim(),
            amountRupees,
            originalAmount: originalValue,
            originalCurrency: currency,
            category: category.toLowerCase(),
            expenseDate,
            purpose: purpose.trim(),
            clientName: typeof clientName === "string" ? clientName.trim() : "",
            attendees: typeof attendees === "string" ? attendees.trim() : "",
            tripReference: typeof tripReference === "string" ? tripReference.trim() : "",
            transactionReference: typeof transactionReference === "string" ? transactionReference.trim() : "",
            tripDate: typeof tripDate === "string" ? tripDate : "",
            lostReceiptDeclaration: !receiptHash ? lostReceiptDeclaration.trim() : "",
            evidenceName: evidenceId ? evidenceName : "",
            tax,
            tip,
            discount,
            lineItems
          }
        })),
        status,
        warning: encodeDatabaseText(warning),
        eligiblePaise: result.eligiblePaise
      }
      });
      if (duplicate) {
        await transaction.claim.update({
          where: { id: duplicate.id },
          data: {
            status: "POSSIBLE_DUPLICATE",
            warning: encodeDatabaseText(`${decodeDatabaseText(duplicate.warning) || ""} A newer claim #${createdClaim.id} appears to match this claim; review both submissions.`.trim())
          }
        });
      }
      return createdClaim;
    });

    res.status(201).json(decodeClaim(claim));
  } catch (error) {
    console.error("Claim submission failed:", error);
    res.status(500).json({ error: "Could not save the claim." });
  }
});

app.get("/api/claims/:id/evidence", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    res.status(400).json({ error: "Provide a valid claim ID." });
    return;
  }
  try {
    const claim = await prisma.claim.findUnique({ where: { id } });
    if (!claim?.evidenceId || !claim.evidenceName) {
      res.status(404).json({ error: "No supporting evidence is attached to this claim." });
      return;
    }
    res.download(
      path.join(evidenceDirectory, claim.evidenceId),
      path.basename(decodeDatabaseText(claim.evidenceName) || "supporting-evidence"),
      (error) => {
        if (error) {
          console.error("Supporting evidence download failed:", error);
          if (!res.headersSent) res.status(404).json({ error: "Supporting evidence is unavailable." });
        }
      }
    );
  } catch (error) {
    console.error("Supporting evidence lookup failed:", error);
    res.status(500).json({ error: "Could not load supporting evidence." });
  }
});

app.patch("/api/claims/:id/reimbursement", async (req, res) => {
  const id = Number(req.params.id);
  const reimbursedAt = req.body?.reimbursedAt;
  if (!Number.isSafeInteger(id) || id <= 0 ||
      (reimbursedAt !== null && (typeof reimbursedAt !== "string" || !parseDateOnly(reimbursedAt)))) {
    res.status(400).json({ error: "Provide a valid claim ID and reimbursement date, or null to clear it." });
    return;
  }

  try {
    const existingClaim = await prisma.claim.findUnique({ where: { id } });
    if (!existingClaim) {
      res.status(404).json({ error: "Could not find that claim to update." });
      return;
    }
    const claim = await prisma.claim.update({
      where: { id },
      data: { reimbursedAt: reimbursedAt === null ? null : parseDateOnly(reimbursedAt) }
    });
    res.json(decodeClaim(claim));
  } catch (error) {
    console.error("Reimbursement date update failed:", error);
    res.status(500).json({ error: "Could not save the reimbursement date." });
  }
});

const requestErrorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  console.error("Request failed:", error);

  if (error instanceof InvalidUploadError) {
    res.status(400).json({ error: error.message });
    return;
  }

  if (error instanceof multer.MulterError) {
    const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    const sizeMessage = req.path === "/api/evidence-upload"
      ? "Supporting evidence files must be 10 MB or smaller."
      : "Receipt images must be 5 MB or smaller.";
    res.status(status).json({
      error: error.code === "LIMIT_FILE_SIZE"
        ? sizeMessage
        : "Could not process the receipt upload."
    });
    return;
  }

  const requestError = error as NodeJS.ErrnoException & { status?: number };
  if (requestError.status === 400) {
    res.status(400).json({ error: "The request body is invalid." });
    return;
  }

  res.status(500).json({ error: "The request could not be completed." });
};

app.use(requestErrorHandler);

async function main() {
  prisma = await startDatabase();
  server = app.listen(PORT, "0.0.0.0");
  await new Promise<void>((resolve, reject) => {
    server?.once("listening", resolve);
    server?.once("error", reject);
  });
  console.log(`ExpenseIQ is running at http://localhost:${PORT}`);
}

async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`${signal} received; shutting down ExpenseIQ.`);

  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => error ? reject(error) : resolve());
    });
  }

  await stopDatabase();
}

main().catch(async (error) => {
  console.error("Could not start ExpenseIQ:", error);
  try {
    await stopDatabase();
  } catch (shutdownError) {
    console.error("Could not cleanly stop ExpenseIQ after startup failure:", shutdownError);
  }
  process.exitCode = 1;
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shutdown(signal).catch((error) => {
      console.error("Could not cleanly stop ExpenseIQ:", error);
      process.exitCode = 1;
    });
  });
}