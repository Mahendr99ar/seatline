const view = document.getElementById("view");
const nav = document.getElementById("nav");

// ---------- session and API ----------

const store = {
  get(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  },
  set(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch { /* private mode: the session just won't survive a reload */ }
  },
};
let session = store.get("seatline.session");

async function api(method, path, body, headers = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined && { "content-type": "application/json" }),
      ...(session && { authorization: `Bearer ${session.token}` }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 401 && session) {
    signOut();
    location.hash = `#/login?next=${encodeURIComponent(location.hash)}`;
  }
  if (!res.ok) {
    const err = new Error(data?.message ?? `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data?.error;
    err.details = data?.details;
    throw err;
  }
  return { status: res.status, data };
}

function signOut() {
  session = null;
  store.set("seatline.session", null);
  renderNav();
}

// ---------- formatting ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const rupees = (paise) => (paise / 100).toLocaleString("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const clock = (iso) => new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });
const day = (iso) => new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" });
const stamp = (iso) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
const duration = (a, b) => {
  const m = Math.round((Date.parse(b) - Date.parse(a)) / 60000);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};
const todayIST = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const STATUS_TEXT = {
  HELD: "Seats held",
  PAYING: "Payment processing",
  CONFIRMED: "Confirmed",
  EXPIRED: "Hold expired",
  PAYMENT_FAILED: "Payment declined",
  FAILED: "Failed, refunded",
  CANCELLED: "Cancelled, refunded",
  CANCELLED_BY_AIRLINE: "Flight cancelled, refunded",
};

function notice(message, ok = false) {
  return `<p class="notice${ok ? " ok" : ""}" role="${ok ? "status" : "alert"}">${esc(message)}</p>`;
}

// ---------- pages ----------

let cleanup = () => {};

const routes = [
  [/^#\/?$/, searchPage],
  [/^#\/flight\/([\w-]+)$/, flightPage],
  [/^#\/booking\/([\w-]+)$/, bookingPage],
  [/^#\/trips$/, tripsPage],
  [/^#\/login/, () => authPage("login")],
  [/^#\/register/, () => authPage("register")],
  [/^#\/admin$/, adminPage],
];

async function route() {
  cleanup();
  cleanup = () => {};
  const hash = location.hash || "#/";
  for (const [pattern, page] of routes) {
    const m = hash.match(pattern);
    if (m) {
      try {
        await page(...m.slice(1));
      } catch (err) {
        view.innerHTML = notice(err.message);
      }
      view.focus({ preventScroll: true });
      window.scrollTo(0, 0);
      return;
    }
  }
  view.innerHTML = `<h1>Page not found</h1><p><a href="#/">Search flights</a></p>`;
}

function renderNav() {
  nav.innerHTML = session
    ? `<a href="#/trips">My trips</a>${session.user.role === "admin" ? `<a href="#/admin">Admin</a>` : ""}<button id="signout">Sign out</button>`
    : `<a href="#/login">Sign in</a><a href="#/register">Create account</a>`;
  document.getElementById("signout")?.addEventListener("click", () => {
    signOut();
    location.hash = "#/";
  });
}

function requireSession() {
  if (session) return true;
  location.hash = `#/login?next=${encodeURIComponent(location.hash)}`;
  return false;
}

async function searchPage() {
  const airports = (await api("GET", "/api/airports")).data;
  const last = store.get("seatline.search") ?? { from: "DEL", to: "BOM", date: todayIST() };
  if (last.date < todayIST()) last.date = todayIST();
  const options = (selected) =>
    airports.map((a) => `<option value="${a.code}"${a.code === selected ? " selected" : ""}>${esc(a.city)} (${a.code})</option>`).join("");

  view.innerHTML = `
    <h1>Where to?</h1>
    <p class="muted">Domestic flights across India. Fares are per seat and include taxes.</p>
    <form class="search" id="search">
      <label>From<select name="from">${options(last.from)}</select></label>
      <label>To<select name="to">${options(last.to)}</select></label>
      <label>Date<input type="date" name="date" value="${last.date}" min="${todayIST()}" required></label>
      <button class="primary">Search</button>
    </form>
    <div id="results"></div>`;

  const form = document.getElementById("search");
  const results = document.getElementById("results");
  async function run() {
    const q = Object.fromEntries(new FormData(form));
    store.set("seatline.search", q);
    if (q.from === q.to) {
      results.innerHTML = notice("Pick two different cities.");
      return;
    }
    const flights = (await api("GET", `/api/flights?${new URLSearchParams(q)}`)).data;
    results.innerHTML = flights.length
      ? `<ul class="flights">${flights.map(flightRow).join("")}</ul>`
      : `<p class="muted">No flights left on ${esc(day(q.date))} for this route. Try the next day.</p>`;
  }
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    run().catch((err) => (results.innerHTML = notice(err.message)));
  });
  await run();
}

function flightRow(f) {
  const soldOut = f.seatsLeft === 0;
  return `<li><a class="flight" href="#/flight/${f.id}">
    <div>
      <div class="leg">
        <span class="time num">${clock(f.departsAt)}</span>
        <span class="line"><div class="dur">${duration(f.departsAt, f.arrivesAt)}</div></span>
        <span class="time num">${clock(f.arrivesAt)}</span>
      </div>
      <div class="muted">${esc(f.number)} &middot; ${esc(f.origin)} to ${esc(f.destination)}</div>
    </div>
    <div class="price">
      ${soldOut ? "<strong>Sold out</strong>" : `<span class="muted">from</span><strong class="num">${rupees(f.fromPaise)}</strong>`}
      <span class="muted">${soldOut ? "" : `${f.seatsLeft} seats left`}</span>
    </div>
  </a></li>`;
}

async function flightPage(id) {
  const f = (await api("GET", `/api/flights/${id}`)).data;
  const picked = new Map(); // seat -> seat info
  // One key per visit to this page: a double click or a retry after a
  // network error reuses it, so the server creates one booking, not two.
  let idempotencyKey = crypto.randomUUID();

  const rows = new Map();
  for (const s of f.seats) {
    const n = parseInt(s.seat, 10);
    if (!rows.has(n)) rows.set(n, []);
    rows.get(n).push(s);
  }
  const seatButton = (s) =>
    `<button type="button" class="seat" data-seat="${s.seat}" aria-pressed="false" ${s.available ? "" : "disabled"}
      aria-label="Seat ${s.seat}, ${s.cabin}, ${rupees(s.pricePaise)}${s.available ? "" : ", taken"}">${s.seat.replace(/^\d+/, "")}</button>`;
  const rowHtml = [...rows.entries()]
    .map(([n, seats]) => `<div class="row ${seats[0].cabin}">${seats.slice(0, 3).map(seatButton).join("")}<span class="rowno">${n}</span>${seats.slice(3).map(seatButton).join("")}</div>`)
    .join("");
  const cancelled = f.status === "cancelled";

  view.innerHTML = `
    <p><a href="#/">Back to results</a></p>
    <h1>${esc(f.origin)} to ${esc(f.destination)}</h1>
    <p class="muted">${esc(f.number)} &middot; ${day(f.departsAt)} &middot; departs ${clock(f.departsAt)}, arrives ${clock(f.arrivesAt)} IST</p>
    ${cancelled ? notice("This flight has been cancelled.") : ""}
    <div class="cabin-layout">
      <div>
        <div class="legend"><span>Free</span><span class="picked">Your pick</span><span class="taken">Taken</span></div>
        <div class="fuselage" id="map">${rowHtml}</div>
      </div>
      <form id="book">
        <h2 style="margin-top:0">Passengers</h2>
        <p class="muted" id="hint">Pick up to 9 seats. Rows 1 and 2 are business class.</p>
        <div class="passengers" id="pax"></div>
        <div class="total"><span>Total</span><strong class="num" id="total">${rupees(0)}</strong></div>
        <div id="msg"></div>
        <button class="primary" id="hold" disabled>Hold these seats for 10 minutes</button>
        ${session?.user.role === "admin" && !cancelled ? `<h2>Operations</h2><button type="button" class="danger" id="cancel-flight">Cancel this flight and refund everyone</button>` : ""}
      </form>
    </div>`;

  const pax = document.getElementById("pax");
  const holdBtn = document.getElementById("hold");
  const msg = document.getElementById("msg");

  function renderPassengers() {
    // Keep what was typed when seats are added or removed.
    const typed = Object.fromEntries([...pax.querySelectorAll("[data-for]")].map((el) => [el.dataset.for + el.name, el.value]));
    pax.innerHTML = [...picked.values()].map((s) => `
      <div class="passenger">
        <span class="tag">${s.seat}</span>
        <label>Full name<input data-for="${s.seat}" name="name" required minlength="2" maxlength="60" value="${esc(typed[s.seat + "name"] ?? "")}" autocomplete="${picked.size === 1 ? "name" : "off"}"></label>
        <label>Age<input data-for="${s.seat}" name="age" type="number" min="0" max="120" required value="${esc(typed[s.seat + "age"] ?? "")}"></label>
      </div>`).join("");
    const total = [...picked.values()].reduce((sum, s) => sum + s.pricePaise, 0);
    document.getElementById("total").textContent = rupees(total);
    holdBtn.disabled = picked.size === 0 || cancelled;
    idempotencyKey = crypto.randomUUID();
  }

  document.getElementById("map").addEventListener("click", (e) => {
    const btn = e.target.closest(".seat");
    if (!btn || btn.disabled) return;
    const seat = f.seats.find((s) => s.seat === btn.dataset.seat);
    if (picked.has(seat.seat)) picked.delete(seat.seat);
    else if (picked.size < 9) picked.set(seat.seat, seat);
    btn.setAttribute("aria-pressed", String(picked.has(seat.seat)));
    renderPassengers();
  });

  document.getElementById("book").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!requireSession()) return;
    const passengers = [...picked.keys()].map((seat) => ({
      seat,
      name: pax.querySelector(`[data-for="${seat}"][name=name]`).value.trim(),
      age: Number(pax.querySelector(`[data-for="${seat}"][name=age]`).value),
    }));
    holdBtn.disabled = true;
    msg.innerHTML = "";
    try {
      const { data } = await api("POST", "/api/bookings", { flightId: f.id, passengers }, { "idempotency-key": idempotencyKey });
      location.hash = `#/booking/${data.id}`;
    } catch (err) {
      holdBtn.disabled = false;
      if (err.code === "seats_taken") {
        msg.innerHTML = notice(`Someone just took ${err.details.seats.join(", ")}. Pick other seats.`);
        for (const s of err.details.seats) {
          picked.delete(s);
          const b = document.querySelector(`[data-seat="${s}"]`);
          b.disabled = true;
          b.setAttribute("aria-pressed", "false");
        }
        renderPassengers();
      } else if (err.details?.length) {
        msg.innerHTML = notice(err.details.map((d) => d.message).join(". "));
      } else {
        msg.innerHTML = notice(err.message);
      }
    }
  });

  document.getElementById("cancel-flight")?.addEventListener("click", async () => {
    if (!confirm(`Cancel ${f.number} on ${day(f.departsAt)}? Every passenger is refunded. This cannot be undone.`)) return;
    await api("POST", `/api/flights/${f.id}/cancel`);
    route();
  });
}

async function bookingPage(id) {
  if (!requireSession()) return;
  const b = (await api("GET", `/api/bookings/${id}`)).data;
  const canCancel = b.status === "CONFIRMED" && Date.parse(b.flight.departsAt) - Date.now() > 3 * 3600_000;

  view.innerHTML = `
    <p><a href="#/trips">My trips</a></p>
    <article class="ticket">
      <div class="main">
        <span class="status ${b.status}">${STATUS_TEXT[b.status] ?? b.status}</span>
        <div class="route" style="margin-top:1rem">
          <span class="code">${esc(b.flight.origin)}</span><span class="muted">to</span><span class="code">${esc(b.flight.destination)}</span>
        </div>
        <p class="muted">${esc(b.flight.number)} &middot; ${day(b.flight.departsAt)}, ${clock(b.flight.departsAt)} IST</p>
        <table class="pax">
          <thead><tr><th>Passenger</th><th>Seat</th><th>Cabin</th><th class="num">Fare</th></tr></thead>
          <tbody>${b.passengers.map((p) => `<tr><td>${esc(p.name)}, ${p.age}</td><td>${p.seat}</td><td>${p.cabin}</td><td class="num">${rupees(p.pricePaise)}</td></tr>`).join("")}</tbody>
        </table>
        <div class="total"><span>Total</span><strong class="num">${rupees(b.totalPaise)}</strong></div>
        <div id="msg"></div>
        <div class="actions">
          ${b.status === "HELD" ? `
            <button class="primary" data-pay="mock_card">Pay ${rupees(b.totalPaise)} with the test card</button>
            <button class="plain" data-pay="mock_card_declined">Try a card that gets declined</button>` : ""}
          ${canCancel ? `<button class="danger" id="cancel">Cancel and refund</button>` : ""}
        </div>
      </div>
      <aside class="stub">
        ${b.status === "HELD" ? `<div class="muted">Hold ends in</div><div class="countdown" id="countdown"></div>` : ""}
        ${b.status === "PAYING" ? `<p>We have your payment and are confirming the seats. This page will update.</p>` : ""}
        <div class="muted" style="margin-top:1rem">Booking</div>
        <div class="num" style="word-break:break-all">${b.id}</div>
        ${b.paymentId ? `<div class="muted" style="margin-top:0.75rem">Payment</div><div>${esc(b.paymentId)}</div>` : ""}
        ${b.refundId ? `<div class="muted" style="margin-top:0.75rem">Refund</div><div>${esc(b.refundId)}</div>` : ""}
      </aside>
    </article>
    <h2>What happened</h2>
    <ol class="history">${b.history.map((h) => `<li>${esc(h.note)}<time datetime="${h.at}">${stamp(h.at)}</time></li>`).join("")}</ol>`;

  const msg = document.getElementById("msg");
  const timers = [];
  cleanup = () => timers.forEach(clearInterval);

  if (b.status === "HELD") {
    const el = document.getElementById("countdown");
    const tick = () => {
      const left = Math.max(0, Date.parse(b.expiresAt) - Date.now());
      el.textContent = `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}`;
      if (left === 0) setTimeout(route, 6000);
    };
    tick();
    timers.push(setInterval(tick, 1000));
  }
  if (b.status === "PAYING") timers.push(setInterval(route, 3000));

  view.querySelectorAll("[data-pay]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      view.querySelectorAll("[data-pay]").forEach((x) => (x.disabled = true));
      try {
        await api("POST", `/api/bookings/${id}/pay`, { method: btn.dataset.pay });
        route();
      } catch (err) {
        msg.innerHTML = notice(err.message);
      }
    }),
  );
  document.getElementById("cancel")?.addEventListener("click", async () => {
    if (!confirm("Cancel this booking? The full fare is refunded.")) return;
    try {
      await api("POST", `/api/bookings/${id}/cancel`);
      route();
    } catch (err) {
      msg.innerHTML = notice(err.message);
    }
  });
}

async function tripsPage() {
  if (!requireSession()) return;
  const trips = (await api("GET", "/api/bookings")).data;
  view.innerHTML = `
    <h1>My trips</h1>
    ${trips.length ? `<ul class="trips">${trips.map((b) => `
      <li><a class="trip" href="#/booking/${b.id}">
        <span><strong>${esc(b.flight.origin)} to ${esc(b.flight.destination)}</strong>
          <span class="muted"> &middot; ${esc(b.flight.number)}, ${day(b.flight.departsAt)} ${clock(b.flight.departsAt)}</span></span>
        <span class="status ${b.status}">${STATUS_TEXT[b.status] ?? b.status}</span>
      </a></li>`).join("")}</ul>` : `<p class="muted">No bookings yet. <a href="#/">Search flights</a></p>`}`;
}

function authPage(mode) {
  const next = new URLSearchParams(location.hash.split("?")[1]).get("next") || "#/";
  const register = mode === "register";
  view.innerHTML = `
    <h1>${register ? "Create an account" : "Sign in"}</h1>
    <form class="auth" id="auth">
      ${register ? `<label>Full name<input name="name" required minlength="2" maxlength="60" autocomplete="name"></label>` : ""}
      <label>Email<input name="email" type="email" required autocomplete="email"></label>
      <label>Password<input name="password" type="password" required ${register ? `minlength="10" autocomplete="new-password"` : `autocomplete="current-password"`}></label>
      <div id="msg"></div>
      <button class="primary">${register ? "Create account" : "Sign in"}</button>
      <p class="muted">${register ? `Have an account? <a href="#/login">Sign in</a>` : `New here? <a href="#/register">Create an account</a>`}</p>
    </form>`;
  document.getElementById("auth").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const { data } = await api("POST", `/api/auth/${mode}`, Object.fromEntries(new FormData(e.target)));
      session = data;
      store.set("seatline.session", data);
      renderNav();
      location.hash = next;
    } catch (err) {
      document.getElementById("msg").innerHTML = notice(err.details?.map((d) => `${d.path}: ${d.message}`).join(". ") || err.message);
    }
  });
}

async function adminPage() {
  if (!requireSession()) return;
  if (session.user.role !== "admin") {
    view.innerHTML = notice("Admins only.");
    return;
  }
  const airports = (await api("GET", "/api/airports")).data;
  const options = airports.map((a) => `<option value="${a.code}">${esc(a.city)} (${a.code})</option>`).join("");
  view.innerHTML = `
    <h1>Operations</h1>
    <h2>Schedule a flight</h2>
    <form id="new-flight" class="admin-grid">
      <label>Flight number<input name="number" placeholder="SL 901" required></label>
      <label>From<select name="origin">${options}</select></label>
      <label>To<select name="destination">${options}</select></label>
      <label>Departs (IST)<input name="departs" type="datetime-local" required></label>
      <label>Flight time (minutes)<input name="minutes" type="number" min="30" max="600" value="120" required></label>
      <label>Economy fare (Rs)<input name="fare" type="number" min="500" max="50000" value="5000" required></label>
      <label>Rows<input name="rows" type="number" min="4" max="40" value="20" required></label>
      <button class="primary">Schedule</button>
    </form>
    <div id="msg"></div>
    <p class="muted">To cancel a flight, open it from search and use the button under the seat map.</p>
    <h2>Recent email</h2>
    <p class="muted">Without a mail server configured, this is where confirmations and reminders end up.</p>
    <div id="mail"></div>`;

  document.getElementById("new-flight").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.target));
    const departs = new Date(`${v.departs}:00+05:30`);
    try {
      const { data } = await api("POST", "/api/flights", {
        number: v.number,
        origin: v.origin,
        destination: v.destination,
        departsAt: departs.toISOString(),
        arrivesAt: new Date(departs.getTime() + Number(v.minutes) * 60000).toISOString(),
        baseFarePaise: Number(v.fare) * 100,
        rows: Number(v.rows),
      });
      document.getElementById("msg").innerHTML = notice(`Scheduled ${data.number}.`, true) + `<p><a href="#/flight/${data.id}">Open its seat map</a></p>`;
    } catch (err) {
      document.getElementById("msg").innerHTML = notice(err.details?.map((d) => d.message).join(". ") || err.message);
    }
  });

  const mail = (await api("GET", "/api/admin/mail")).data;
  document.getElementById("mail").innerHTML = mail.length
    ? mail.map((m) => `<div class="mail"><strong>${esc(m.subject)}</strong>
        <div class="muted">${esc(m.kind)} to ${esc(m.to_address)} &middot; ${esc(m.status)}${m.status === "pending" ? `, due ${stamp(m.send_at)}` : ""}</div>
        <pre>${esc(m.body)}</pre></div>`).join("")
    : `<p class="muted">Nothing sent yet.</p>`;
}

window.addEventListener("hashchange", route);
renderNav();
route();
