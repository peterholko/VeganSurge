export function fmtPrice(v) {
  if (v == null || !isFinite(v)) return "—";
  if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return v.toFixed(2);
}

export function fmtNum(v, digits = 1) {
  if (v == null || !isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(digits) + "T";
  if (a >= 1e9) return (v / 1e9).toFixed(digits) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(digits) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(digits) + "K";
  return String(Math.round(v));
}

export function fmtPct(v, signed = true) {
  if (v == null || !isFinite(v)) return "—";
  const s = signed && v > 0 ? "+" : "";
  return s + v.toFixed(2) + "%";
}

export function fmtChange(v) {
  if (v == null || !isFinite(v)) return "—";
  return (v > 0 ? "+" : "") + v.toFixed(2);
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export function fmtDate(tsSec, withYear = true) {
  const d = new Date(tsSec * 1000);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}` + (withYear ? ` '${String(d.getFullYear()).slice(2)}` : "");
}

export function fmtDateTime(tsSec) {
  const d = new Date(tsSec * 1000);
  let h = d.getHours(), m = String(d.getMinutes()).padStart(2, "0");
  const ap = h >= 12 ? "p" : "a";
  h = h % 12 || 12;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${h}:${m}${ap}`;
}

export function clsSign(v) {
  return v > 0 ? "pos" : v < 0 ? "neg" : "";
}

// Escape a value for safe interpolation into innerHTML (text or quoted attr).
export function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
