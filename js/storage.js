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

async function getAllPayments() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const payments = request.result
        .map(normalizePayment)
        .sort((a, b) => new Date(a.datePaid) - new Date(b.datePaid));
      resolve(payments);
    };
  });
}

async function addPayment(payment) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.add(normalizePayment(payment));

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function updatePayment(payment) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(normalizePayment(payment));

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function getPaymentById(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(id);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const payment = request.result;
      resolve(payment ? normalizePayment(payment) : null);
    };
  });
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

async function deletePhotoFromPayment(paymentId, photoId) {
  const payment = await getPaymentById(paymentId);
  if (!payment) return false;

  payment.screenshots = payment.screenshots.filter((photo) => photo.id !== photoId);
  await updatePayment(payment);
  return true;
}

function createPhotoId() {
  return crypto.randomUUID();
}

async function getTotalPaid() {
  const payments = await getAllPayments();
  return payments.reduce((sum, p) => sum + p.amountPaid, 0);
}

async function getRemainingBalance() {
  const totalPaid = await getTotalPaid();
  return Math.max(0, LOAN_CONFIG.totalOwed - totalPaid);
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

async function getPaymentScheduleStatus() {
  const payments = await getAllPayments();
  const paymentsMade = payments.length;
  const remaining = await getRemainingBalance();

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
  let remaining = LOAN_CONFIG.totalOwed;
  return payments.map((payment) => {
    remaining = Math.max(0, remaining - payment.amountPaid);
    return { ...payment, remainingAfter: remaining };
  });
}
