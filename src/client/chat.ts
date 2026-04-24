// SPDX-License-Identifier: AGPL-3.0-only
//
// Chat client entry point.
//
// Instantiates the ChatState machine and renders a different DOM
// subtree for each state into #chat-root. Event delegation via
// data-action attributes keeps listener management to a single
// root-level capture per event type — no per-render re-binding.
//
// The render functions here are deliberately minimal UI — enough to
// exercise every state transition from the v1 state machine. Visual
// polish (animations, header controls, generator drawer, payment
// flow) lands in subsequent phases (5e / 6 / 7).

import { ChatState, type State, type PlainMessage } from "./state";

const root = document.getElementById("chat-root");
if (!root) {
  throw new Error("chat-root element missing");
}

const state = new ChatState();

// Re-render the whole subtree on every state change. Cheap for a
// single-surface app; the O(1) pending message + two-form UI doesn't
// benefit from diffing.
state.onStateChange((s) => {
  root.innerHTML = render(s);
  focusFirstField();
});

// -----------------------------------------------------------------------------
// Event delegation
// -----------------------------------------------------------------------------

root.addEventListener("submit", (e) => {
  const target = e.target as HTMLElement;
  if (!(target instanceof HTMLFormElement)) return;
  const action = target.dataset.action;
  if (!action) return;
  e.preventDefault();
  const form = new FormData(target);

  if (action === "submit-entry") {
    const phone = String(form.get("phone") ?? "");
    const pin = String(form.get("pin") ?? "");
    void state.submit(phone, pin);
  } else if (action === "submit-locked") {
    const pin = String(form.get("pin") ?? "");
    void state.reauthenticate(pin);
  } else if (action === "submit-message") {
    const text = String(form.get("text") ?? "");
    if (text.trim()) {
      void state.sendMessage(text);
      target.reset();
    }
  } else if (action === "submit-edit") {
    const text = String(form.get("text") ?? "");
    void state.editCurrent(text);
  }
});

root.addEventListener("click", (e) => {
  const target = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (!action) return;

  if (action === "continue-free") {
    void state.continueFree();
  } else if (action === "logout") {
    state.logout();
  } else if (action === "expire-room") {
    if (confirm("End this conversation? The current message will be destroyed.")) {
      void state.expireRoom();
    }
  } else if (action === "mark-read") {
    state.markCurrentRead();
  } else if (action === "delete-message") {
    void state.deleteCurrent();
  } else if (action === "toggle-edit") {
    // Phase 5d doesn't polish this — just toggle a css class on the
    // container. A richer edit flow is a future polish.
    const container = root.querySelector("#current-message-container");
    container?.classList.toggle("is-editing");
  } else if (action === "restart") {
    // From :expired — route back to entry via full reload so session
    // and any stale WS state is fully flushed.
    location.reload();
  }
});

// Typing: emit on each input keystroke in the message field.
// Throttle on the server side of things isn't needed; the DO broadcasts
// to both sockets and the opposite side auto-clears after 3s.
root.addEventListener(
  "input",
  (e) => {
    const target = e.target as HTMLInputElement;
    if (target?.dataset.field === "message-text") {
      state.typing();
    }
  },
  true,
);

// When a received message scrolls into view, mark it read. We use an
// IntersectionObserver so reads are fired exactly once per bubble.
let ioObserver: IntersectionObserver | null = null;
function armReadObserver() {
  ioObserver?.disconnect();
  const el = root?.querySelector<HTMLElement>("[data-received-message]");
  if (!el) return;
  ioObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          state.markCurrentRead();
          ioObserver?.disconnect();
          ioObserver = null;
        }
      }
    },
    { threshold: 0.5 },
  );
  ioObserver.observe(el);
}

// Re-arm after every render.
state.onStateChange(() => armReadObserver());

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

function focusFirstField() {
  requestAnimationFrame(() => {
    const first = root?.querySelector<HTMLElement>("[data-autofocus]");
    first?.focus();
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function icon(name: string, cls = "size-4"): string {
  return `<svg class="${cls}" aria-hidden="true"><use href="/icons.svg#${name}"/></svg>`;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

// -----------------------------------------------------------------------------
// Render — one function per state kind
// -----------------------------------------------------------------------------

function render(s: State): string {
  switch (s.kind) {
    case "entry":
      return renderEntry(s.phone, s.phoneLocked);
    case "deriving":
      return renderDeriving(s.progress);
    case "new_channel":
      return renderNewChannel();
    case "connecting":
      return renderConnecting();
    case "chat":
      return renderChat(s.phone, s.senderHash, s.current, s.counterpartyTyping);
    case "locked":
      return renderLocked(s.reason, s.attemptsRemaining);
    case "expired":
      return renderExpired();
  }
}

function renderEntry(phone: string, phoneLocked: boolean): string {
  const phoneAttrs = phoneLocked
    ? `value="${escapeHtml(phone)}" readonly class="glass-input w-full font-mono opacity-70 cursor-not-allowed"`
    : `value="${escapeHtml(phone)}" class="glass-input w-full font-mono" data-autofocus`;
  return `
    <section class="max-w-md mx-auto my-24 px-6 entry-card">
      <div class="glass-card p-8 sm:p-10 space-y-6">
        <h1 class="wordmark text-3xl justify-center">
          <span class="wm-symbol">s</span><span class="wm-accent">TEL</span><span class="text-white">gano</span>
        </h1>
        <form data-action="submit-entry" class="space-y-4" autocomplete="off" spellcheck="false">
          <div class="space-y-2">
            <label for="phone" class="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">Number</label>
            <input
              id="phone"
              name="phone"
              type="tel"
              inputmode="tel"
              autocomplete="one-time-code"
              placeholder="+1 555 012 3456"
              ${phoneAttrs}
            >
          </div>
          <div class="space-y-2">
            <label for="pin" class="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">PIN</label>
            <input
              id="pin"
              name="pin"
              type="password"
              inputmode="numeric"
              autocomplete="one-time-code"
              placeholder="••••"
              class="glass-input w-full font-mono tracking-widest"
              ${phoneLocked ? 'data-autofocus' : ""}
            >
          </div>
          <button type="submit" class="btn-primary w-full py-4 text-base">
            Enter
            ${icon("arrow_right", "size-5")}
          </button>
        </form>
        <p class="text-[10px] text-slate-600 text-center leading-relaxed">
          Your number and PIN are hashed locally. They never reach the server.
        </p>
      </div>
    </section>
  `;
}

function renderDeriving(progress: number): string {
  const pct = Math.max(0, Math.min(100, Math.round(progress)));
  return `
    <section class="max-w-md mx-auto my-24 px-6">
      <div class="glass-card p-8 sm:p-10 space-y-6 text-center">
        <div class="size-14 rounded-2xl bg-primary/10 flex items-center justify-center border border-primary/20 mx-auto">
          ${icon("key_round", "size-7 text-primary")}
        </div>
        <h2 class="text-xl font-extrabold text-white font-display">Deriving encryption key…</h2>
        <p class="text-slate-400 text-sm leading-relaxed">
          600,000 PBKDF2 iterations. This takes 1–2 seconds on purpose — it's what makes your PIN unfeasible to brute force.
        </p>
        <div class="h-1.5 w-full bg-slate-950 rounded-full overflow-hidden border border-white/5">
          <div class="h-full bg-linear-to-r from-primary to-emerald-400 transition-[width] duration-100" style="width: ${pct}%"></div>
        </div>
        <p class="text-[10px] font-mono text-slate-500 tracking-widest">${pct}%</p>
      </div>
    </section>
  `;
}

function renderNewChannel(): string {
  return `
    <section class="max-w-lg mx-auto my-24 px-6">
      <div class="glass-card p-8 sm:p-10 space-y-8">
        <div class="text-center space-y-2">
          <div class="size-14 rounded-2xl bg-primary/10 flex items-center justify-center border border-primary/20 mx-auto">
            ${icon("sparkles", "size-7 text-primary")}
          </div>
          <h2 class="text-2xl font-extrabold text-white font-display">New channel</h2>
          <p class="text-slate-400 text-sm leading-relaxed">
            This steg number hasn't been used before. Pick how long it lives.
          </p>
        </div>
        <div class="grid grid-cols-1 gap-4">
          <button data-action="continue-free" class="glass-card p-6 text-left space-y-2 group hover:border-primary/40 transition-all">
            <div class="flex items-center justify-between">
              <span class="text-lg font-extrabold text-white font-display">Free</span>
              <span class="text-[10px] font-bold uppercase tracking-wider text-slate-500">7 days</span>
            </div>
            <p class="text-sm text-slate-400 leading-relaxed">Same encryption. Temporary number. Great for a one-off conversation.</p>
          </button>
          <button disabled class="glass-card p-6 text-left space-y-2 opacity-50 cursor-not-allowed">
            <div class="flex items-center justify-between">
              <span class="text-lg font-extrabold text-white font-display">Paid — $2/year</span>
              <span class="text-[10px] font-bold uppercase tracking-wider text-slate-500">365 days</span>
            </div>
            <p class="text-sm text-slate-400 leading-relaxed">(Not yet wired in the v2 rewrite — Phase 7.)</p>
          </button>
        </div>
      </div>
    </section>
  `;
}

function renderConnecting(): string {
  return `
    <section class="max-w-md mx-auto my-24 px-6">
      <div class="glass-card p-8 sm:p-10 space-y-6 text-center">
        <div class="size-14 rounded-2xl bg-primary/10 flex items-center justify-center border border-primary/20 mx-auto animate-pulse-glow">
          ${icon("radio", "size-7 text-primary")}
        </div>
        <h2 class="text-xl font-extrabold text-white font-display">Connecting…</h2>
        <p class="text-slate-400 text-sm leading-relaxed">
          Opening the channel.
        </p>
      </div>
    </section>
  `;
}

function renderChat(
  _phone: string,
  senderHash: string,
  current: PlainMessage | null,
  counterpartyTyping: boolean,
): string {
  const canType = !current || current.senderHash !== senderHash;
  const bubble = current ? renderBubble(current, senderHash) : renderEmpty();
  const typingIndicator = counterpartyTyping
    ? `<div class="px-6 py-2 text-[10px] font-mono text-slate-500 uppercase tracking-widest animate-in">they're typing…</div>`
    : "";

  return `
    <div class="chat-layout flex-1 flex flex-col min-h-0">
      <header class="px-6 py-4 border-b border-white/5 backdrop-blur-xl bg-slate-950/40 flex items-center justify-between">
        <span class="text-[10px] font-bold uppercase tracking-[0.3em] text-primary">Channel active</span>
        <div class="flex items-center gap-2">
          <button data-action="expire-room" class="btn-icon" title="End conversation" aria-label="End conversation">
            ${icon("trash_2", "size-4")}
          </button>
          <button data-action="logout" class="btn-icon" title="Logout" aria-label="Logout">
            ${icon("power", "size-4")}
          </button>
        </div>
      </header>

      <div class="flex-1 overflow-y-auto flex flex-col justify-end px-4 py-6">
        <div id="current-message-container" class="flex flex-col gap-3">
          ${bubble}
        </div>
        ${typingIndicator}
      </div>

      <form data-action="submit-message" class="command-bar" autocomplete="off">
        <input
          name="text"
          type="text"
          data-field="message-text"
          data-autofocus
          placeholder="${canType ? "Type a message…" : "Their turn."}"
          class="glass-input flex-1 font-sans"
          ${canType ? "" : "disabled"}
          maxlength="4000"
        >
        <button type="submit" class="btn-primary py-3 px-5" ${canType ? "" : "disabled"}>
          ${icon("arrow_right", "size-5")}
        </button>
      </form>
    </div>
  `;
}

function renderBubble(m: PlainMessage, senderHash: string): string {
  const sent = m.senderHash === senderHash;
  const sideClass = sent ? "bubble sent" : "bubble received";
  const dataAttr = sent ? "" : "data-received-message";
  const readIndicator =
    sent && m.readAt
      ? `<span class="text-[10px] text-slate-400/60">read ${formatTime(m.readAt)}</span>`
      : "";
  const ownerControls = sent && !m.readAt
    ? `<div class="flex items-center gap-2 mt-2">
        <button data-action="delete-message" class="text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-danger transition-colors">Unsend</button>
      </div>`
    : "";
  return `
    <div class="chat-bubble ${sideClass}" ${dataAttr}>
      <p class="whitespace-pre-wrap break-words">${escapeHtml(m.plaintext)}</p>
      <div class="flex items-center justify-end gap-2 mt-2">
        <span class="text-[10px] text-slate-400/60">${formatTime(m.insertedAt)}</span>
        ${readIndicator}
      </div>
      ${ownerControls}
    </div>
  `;
}

function renderEmpty(): string {
  return `
    <div class="text-center px-6 py-16 space-y-4">
      <div class="size-12 rounded-2xl bg-white/5 flex items-center justify-center border border-white/10 mx-auto">
        ${icon("message_circle", "size-6 text-slate-500")}
      </div>
      <p class="text-slate-500 text-sm font-medium">Channel is open. Send the first message.</p>
    </div>
  `;
}

function renderLocked(reason: "unauthorized" | "locked", attemptsRemaining?: number): string {
  const headline = reason === "locked" ? "Locked" : "Wrong PIN";
  const message =
    reason === "locked"
      ? "Too many failed attempts. Try again in 30 minutes."
      : attemptsRemaining !== undefined
        ? `${attemptsRemaining} attempt${attemptsRemaining === 1 ? "" : "s"} remaining before a 30-minute lockout.`
        : "The PIN didn't match. Try again.";
  const formDisabled = reason === "locked" ? "disabled" : "";

  return `
    <section class="max-w-md mx-auto my-24 px-6">
      <div class="lock-overlay glass-card p-8 sm:p-10 space-y-6">
        <div class="text-center space-y-3">
          <div class="size-14 rounded-2xl bg-danger/10 flex items-center justify-center border border-danger/20 mx-auto">
            ${icon("lock", "size-7 text-danger")}
          </div>
          <h2 class="text-2xl font-extrabold text-white font-display">${headline}</h2>
          <p class="text-slate-400 text-sm leading-relaxed">${message}</p>
        </div>
        <form data-action="submit-locked" class="space-y-4" autocomplete="off" spellcheck="false">
          <div class="space-y-2">
            <label for="pin" class="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">PIN</label>
            <input
              id="pin"
              name="pin"
              type="password"
              inputmode="numeric"
              autocomplete="one-time-code"
              placeholder="••••"
              class="glass-input w-full font-mono tracking-widest"
              ${formDisabled}
              ${formDisabled ? "" : "data-autofocus"}
            >
          </div>
          <button type="submit" class="btn-primary w-full py-4 text-base" ${formDisabled}>
            Retry
          </button>
        </form>
        <button data-action="logout" class="btn-ghost w-full py-3 text-xs">
          Back to start
        </button>
      </div>
    </section>
  `;
}

function renderExpired(): string {
  return `
    <section class="max-w-md mx-auto my-24 px-6">
      <div class="glass-card p-8 sm:p-10 space-y-6 text-center">
        <div class="size-14 rounded-2xl bg-white/5 flex items-center justify-center border border-white/10 mx-auto">
          ${icon("timer", "size-7 text-slate-500")}
        </div>
        <h2 class="text-2xl font-extrabold text-white font-display">Channel expired</h2>
        <p class="text-slate-400 text-sm leading-relaxed">
          This conversation has ended. Nothing was stored.
        </p>
        <button data-action="restart" class="btn-primary w-full py-4 text-base">
          Start a new one
        </button>
      </div>
    </section>
  `;
}
