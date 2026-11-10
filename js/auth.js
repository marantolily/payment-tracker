function goToLogin() {
  const page = window.location.pathname.split("/").pop() || "index.html";
  window.location.replace(`login.html?return=${encodeURIComponent(page)}`);
}

async function requireAuth() {
  const response = await fetch("/api/payments?session=1");
  if (response.status === 401) goToLogin();
}

async function login(password) {
  const response = await fetch("/api/payments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "login", password }),
  });
  if (response.status === 401) return false;
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Login is unavailable. Try again.");
  }
  return true;
}

function getReturnPage() {
  const params = new URLSearchParams(window.location.search);
  const returnPage = params.get("return") || "index.html";
  const allowed = ["index.html", "add-payment.html", "track-payments.html"];
  return allowed.includes(returnPage) ? returnPage : "index.html";
}
