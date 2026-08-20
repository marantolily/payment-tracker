const AUTH_KEY = "loanTrackerAuth";
const SITE_PASSWORD = "8926";

function isAuthenticated() {
  return sessionStorage.getItem(AUTH_KEY) === "true";
}

function requireAuth() {
  if (!isAuthenticated()) {
    const page = window.location.pathname.split("/").pop() || "index.html";
    window.location.replace(`login.html?return=${encodeURIComponent(page)}`);
  }
}

function login(password) {
  if (password === SITE_PASSWORD) {
    sessionStorage.setItem(AUTH_KEY, "true");
    return true;
  }
  return false;
}

function getReturnPage() {
  const params = new URLSearchParams(window.location.search);
  const returnPage = params.get("return") || "index.html";
  const allowed = ["index.html", "add-payment.html", "track-payments.html"];
  return allowed.includes(returnPage) ? returnPage : "index.html";
}
