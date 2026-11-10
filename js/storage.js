const LOAN_CONFIG = {
  totalOwed: 22012.32,
  monthlyPayment: 458.59,
  dueDay: 6,
  firstPaymentDueDate: "2026-08-06",
};

const DB_NAME = "loanPayments";
const STORE_NAME = "payments";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: "id",
          autoIncrement: true,
        });
        store.createIndex("datePaid", "datePaid", { unique: false });
      }
    };
  });
}

async function paymentRequest(method = "GET", query = "", payment) {
  const body = payment && JSON.stringify(payment);
  if (body && body.length > 4_000_000) throw new Error("Too many photos for one payment upload.");
  const response = await fetch("/api/payments" + query, {
    method,
    ...(body && { headers: { "Content-Type": "application/json" }, body }),
  });
  if (response.status === 401) goToLogin();
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Could not sync payments. Please try again.");
  }
  return response.json();
}

async function getAllPayments() {
  const payments = await paymentRequest();
  return payments.sort((a, b) =>
    a.datePaid.localeCompare(b.datePaid) || a.id.localeCompare(b.id));
}

function addPayment(payment) {
  return paymentRequest("POST", "", payment);
}

async function getLocalPayments() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  }).finally(() => db.close());
}

async function importLocalPayments() {
  const payments = await getLocalPayments();
  const key = "loanTrackerImportSource";
  const source = localStorage.getItem(key) || crypto.randomUUID();
  localStorage.setItem(key, source);
  const imported = new Set((await getAllPayments()).map((payment) => payment.id));
  let count = 0;
  for (const payment of payments) {
    const id = "legacy-" + source + "-" + payment.id;
    if (imported.has(id)) continue;
    await addPayment({ ...normalizePayment(payment), id });
    count++;
  }
  return count;
}

function normalizeScreenshots(payment) {
  if (Array.isArray(payment.screenshots) && payment.screenshots.length > 0) {
    return payment.screenshots.map((photo) => ({
      id: photo.id || createPhotoId(),
      data: photo.data,
    }));
  }

  if (payment.screenshot) {
    return [{ id: createPhotoId(), data: payment.screenshot }];
  }

  return [];
}

function normalizePayment(payment) {
  const normalized = { ...payment };
  normalized.screenshots = normalizeScreenshots(payment);
  delete normalized.screenshot;
  return normalized;
}

function deletePhotoFromPayment(paymentId, photoId) {
  return paymentRequest("DELETE", "?" + new URLSearchParams({ id: paymentId, photo: photoId }));
}

function createPhotoId() {
  return crypto.randomUUID();
}

function getTotalPaid(payments) {
  return payments.reduce((sum, payment) => sum + Math.round(payment.amountPaid * 100), 0) / 100;
}

function getRemainingBalance(payments) {
  return Math.max(0, LOAN_CONFIG.totalOwed - getTotalPaid(payments));
}

function formatCurrency(amount) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

function formatDate(dateStr) {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseDate(dateStr) {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function addMonthsToDate(dateStr, months) {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(year, month - 1 + months, day);
}

function getDueDateForPeriod(periodIndex) {
  return addMonthsToDate(LOAN_CONFIG.firstPaymentDueDate, periodIndex);
}

function formatDateLong(date) {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function getPaymentScheduleStatus(payments) {
  const paymentsMade = payments.length;
  const remaining = getRemainingBalance(payments);

  if (remaining <= 0) {
    return { status: "paid_off", paymentsMade };
  }

  const periodIndex = paymentsMade;
  const dueDate = getDueDateForPeriod(periodIndex);
  const today = startOfDay(new Date());
  const due = startOfDay(dueDate);
  if (today > due) {
    return {
      status: "missed",
      dueDate,
      dueDateFormatted: formatDateLong(dueDate),
      paymentsMade,
    };
  }

  if (today.getTime() === due.getTime()) {
    return {
      status: "due_today",
      dueDate,
      dueDateFormatted: formatDateLong(dueDate),
      paymentsMade,
    };
  }

  return {
    status: "upcoming",
    dueDate,
    dueDateFormatted: formatDateLong(dueDate),
    paymentsMade,
  };
}

function computeRunningBalances(payments) {
  let remainingCents = Math.round(LOAN_CONFIG.totalOwed * 100);
  return payments.map((payment) => {
    remainingCents = Math.max(0, remainingCents - Math.round(payment.amountPaid * 100));
    return { ...payment, remainingAfter: remainingCents / 100 };
  });
}
