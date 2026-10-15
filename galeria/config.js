// After deploying the Worker, paste its public HTTPS URL here (never a token).
export const API_URL = ["localhost", "127.0.0.1"].includes(location.hostname)
  ? "http://127.0.0.1:8787"
  : "https://rys-gallery.subzeta.workers.dev";
