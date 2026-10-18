export type ExpenseInput = {
  employeeId: string;
  merchant: string;
  amountPaise: number;
  category: string;
  expenseDate: Date;
  purpose?: string;
  clientName?: string;
};

export type PolicyResult = {
  status: string;
  warning: string;
  eligiblePaise: number;
};

const DAILY_MEAL_LIMIT_PAISE = 200000; // ₹2,000
const SPLIT_APPROVAL_THRESHOLD_PAISE = 500000; // ₹5,000
const SUBMISSION_DEADLINE_DAYS = 60;
const MAX_MEAL_TIP_RATE = 0.1;
const POLICY_TIMEZONE_OFFSET_MINUTES = 330;

export type ExpenseLineItem = {
  description: string;
  amountPaise: number;
  kind: string;
};

export type ItemEligibility = {
  eligiblePaise: number;
  warnings: string[];
};

const REIMBURSABLE_ITEM_KINDS = new Set([
  "meal",
  "beverage",
  "travel",
  "lodging",
  "business"
]);

const NON_REIMBURSABLE_ITEM_KINDS = new Set([
  "alcohol",
  "personal",
  "tobacco",
  "entertainment",
  "souvenir"
]);

export function calculateItemEligibility(
  amountPaise: number,
  lineItems: ExpenseLineItem[],
  taxPaise: number,
  tipPaise: number,
  discountPaise: number
): ItemEligibility {
  const warnings: string[] = [];
  if (lineItems.length === 0) {
    return {
      eligiblePaise: 0,
      warnings: ["No itemized receipt breakdown was provided; reimbursement eligibility needs review."]
    };
  }

  const subtotalPaise = lineItems.reduce((total, item) => total + item.amountPaise, 0);
  if (subtotalPaise <= 0) {
    return {
      eligiblePaise: 0,
      warnings: ["Receipt line items do not have a valid subtotal."]
    };
  }

  const reimbursableSubtotal = lineItems.reduce((total, item) => {
    if (REIMBURSABLE_ITEM_KINDS.has(item.kind)) {
      return total + item.amountPaise;
    }
    if (!NON_REIMBURSABLE_ITEM_KINDS.has(item.kind)) {
      warnings.push(`The item "${item.description}" has an unclassified reimbursement type.`);
    }
    return total;
  }, 0);

  const eligibleShare = reimbursableSubtotal / subtotalPaise;
  const eligibleDiscount = Math.round(discountPaise * eligibleShare);
  const eligibleTax = Math.round(taxPaise * eligibleShare);
  const eligibleTip = Math.min(
    tipPaise,
    Math.round(reimbursableSubtotal * MAX_MEAL_TIP_RATE)
  );
  const eligiblePaise = Math.max(
    0,
    Math.min(
      amountPaise,
      reimbursableSubtotal - eligibleDiscount + eligibleTax + eligibleTip
    )
  );

  const receiptTotalPaise = subtotalPaise + taxPaise + tipPaise - discountPaise;
  if (Math.abs(receiptTotalPaise - amountPaise) > Math.max(100, Math.round(amountPaise * 0.02))) {
    warnings.push("Receipt line items, taxes, discounts, and tips do not reconcile with the claimed total.");
  }
  if (reimbursableSubtotal < subtotalPaise) {
    warnings.push("Personal or otherwise non-reimbursable receipt items were excluded from the eligible amount.");
  }
  if (tipPaise > eligibleTip) {
    warnings.push("Tip exceeds the demo policy limit of 10% of reimbursable items.");
  }

  return { eligiblePaise, warnings };
}

export function normalizeMerchant(value: string): string {
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function merchantsLikelyMatch(first: string, second: string): boolean {
  const left = normalizeMerchant(first);
  const right = normalizeMerchant(second);
  if (!left || !right) {
    return false;
  }
  if (left === right || left.includes(right) || right.includes(left)) {
    return true;
  }
  if (Math.min(left.length, right.length) < 5) {
    return false;
  }

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }

  return previous[right.length] <= Math.max(1, Math.floor(Math.min(left.length, right.length) * 0.15));
}

export function amountsLikelyMatch(firstPaise: number, secondPaise: number): boolean {
  return Math.abs(firstPaise - secondPaise) <= Math.max(10000, Math.round(Math.max(firstPaise, secondPaise) * 0.05));
}

export function checkExpense(
  expense: ExpenseInput,
  previousMealPaise: number,
  eligiblePaise = expense.amountPaise,
  extraWarnings: string[] = []
): PolicyResult {
  const warnings: string[] = [...extraWarnings];

  if (expense.amountPaise <= 0) {
    return {
      status: "NEEDS_REVIEW",
      warning: "Expense amount must be greater than zero.",
      eligiblePaise: 0
    };
  }

  if (!expense.merchant.trim()) {
    warnings.push("Merchant name is missing.");
  }

  if (!expense.employeeId.trim()) {
    warnings.push("Employee ID is missing.");
  }

  if (!expense.purpose?.trim()) {
    warnings.push("Business purpose is missing.");
  }

  if (expense.category.toLowerCase() === "meal") {
    const remainingLimit = Math.max(
      0,
      DAILY_MEAL_LIMIT_PAISE - previousMealPaise
    );

    const combinedTotal = previousMealPaise + expense.amountPaise;

    if (combinedTotal > DAILY_MEAL_LIMIT_PAISE) {
      warnings.push(
        `Daily meal spending is ₹${(combinedTotal / 100).toFixed(2)}, above the ₹2,000 limit.`
      );

      eligiblePaise = Math.min(eligiblePaise, remainingLimit);
    }
  }

  const nowInPolicyTimezone = new Date(Date.now() + POLICY_TIMEZONE_OFFSET_MINUTES * 60000);
  const todayInPolicyTimezone = Date.UTC(
    nowInPolicyTimezone.getUTCFullYear(),
    nowInPolicyTimezone.getUTCMonth(),
    nowInPolicyTimezone.getUTCDate()
  );
  const expenseDay = Date.UTC(
    expense.expenseDate.getUTCFullYear(),
    expense.expenseDate.getUTCMonth(),
    expense.expenseDate.getUTCDate()
  );
  const ageDays = Math.round((todayInPolicyTimezone - expenseDay) / 86400000);
  if (ageDays > SUBMISSION_DEADLINE_DAYS) {
    warnings.push(`Claim was submitted ${ageDays} days after the expense date; the demo reporting deadline is 60 days.`);
  } else if (ageDays < 0) {
    warnings.push("Expense date is in the future.");
  }

  return {
    status: warnings.length > 0 ? "NEEDS_REVIEW" : "COMPLIANT",
    warning: warnings.length > 0 ? warnings.join(" ") : "No issues found by the configured checks.",
    eligiblePaise
  };
}