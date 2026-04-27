// SPDX-License-Identifier: AGPL-3.0-only
//
// Chat client entry point — faithful port of the v1 chat_live.ex
// render functions.
//
// Instantiates the ChatState machine and renders one render_* block
// per state into #chat-root. Event delegation via data-action
// attributes dispatches UI events to ChatState methods; single
// root-level listener per event type, no per-render re-binding.
//
// Generator drawer is a separate Phase 6 port and NOT rendered here
// (v1 wraps render_generator_drawer in the chat shell too — that's
// deferred).
//
// Visual parity target: the classes, copy, and icons in this file
// are intentionally verbatim from
// elixir/lib/stelgano_web/live/chat_live.ex so that nothing in the
// shipped HTML drifts from what designers signed off on in v1.

import { AsYouType, parsePhoneNumberFromString } from "libphonenumber-js";
import { CountryNames, generatePhoneNumber } from "phone-number-generator-js";

import {
  ChatState,
  type Config,
  type GeneratorState,
  type PlainMessage,
  type State,
} from "./state";

// Adapter from CountryNames enum to the value the generator
// expects. The enum keys are snake_cased versions of the values
// (values have spaces). Building the list once at module load
// avoids per-render enumeration.
const COUNTRY_LIST: Array<{ name: string; iso: string }> = Object.values(CountryNames)
  // De-dupe — the enum has a couple of aliases (e.g. DR_Congo /
  // The_Democratic_Republic_Of_The_Congo both map to "DR Congo").
  .filter((v, i, a) => a.indexOf(v) === i)
  .map((v) => ({ name: v, iso: "" }))
  .sort((a, b) => a.name.localeCompare(b.name));

async function generateFor(countryName: string): Promise<string> {
  return generatePhoneNumber({ countryName: countryName as CountryNames });
}

const root = document.getElementById("chat-root");
if (!root) throw new Error("chat-root element missing");

const state = new ChatState();

// Fetch server-side config and apply it to the state machine.
// Failure is soft — defaults in DEFAULT_CONFIG are safe.
let serverConfig: Config = {
  monetizationEnabled: false,
  freeTtlDays: 7,
  paidTtlDays: 365,
  priceCents: 200,
  currency: "USD",
};
fetch("/api/config")
  .then((r) => r.json())
  .then((c) => {
    const raw = c as Record<string, unknown>;
    serverConfig = {
      monetizationEnabled: raw.monetization_enabled === true,
      freeTtlDays: typeof raw.free_ttl_days === "number" ? raw.free_ttl_days : 7,
      paidTtlDays: typeof raw.paid_ttl_days === "number" ? raw.paid_ttl_days : 365,
      priceCents: typeof raw.price_cents === "number" ? raw.price_cents : 200,
      currency: typeof raw.currency === "string" ? raw.currency : "USD",
    };
    state.updateConfig(serverConfig);
  })
  .catch(() => {});

// Last country inferred from the phone input — preserved across re-renders
// (e.g. visibility toggle) so the country badge doesn't flash away.
let lastInferredCountry: string | null = null;

// Track the previous state kind so entrance animations only fire when
// transitioning between states, not on intra-state updates (e.g. eye
// toggle, typing indicator, copiedNumber). Without this every
// root.innerHTML swap restarts all animate-in CSS animations and looks
// like a full page reload to the user.
let prevKind: string | null = null;
let prevState: State | null = null;

state.onStateChange((s) => {
  // Fast path: if only the generator dropdown/search query changed on the entry screen,
  // do an in-place update of the dropdown container instead of wiping root.innerHTML.
  // This solves backwards typing bugs caused by destroying the <input> mid-keystroke.
  if (prevState && prevState.kind === "entry" && s.kind === "entry") {
    const aStrip = { ...prevState, generator: { ...prevState.generator, searchQuery: "", showCountries: false } };
    const bStrip = { ...s, generator: { ...s.generator, searchQuery: "", showCountries: false } };
    if (JSON.stringify(aStrip) === JSON.stringify(bStrip)) {
      const container = document.getElementById("drawer-country-dropdown-container");
      if (container) {
        container.innerHTML = renderGeneratorDropdown(s.generator);
      }
      const input = document.getElementById("drawer-country-input") as HTMLInputElement;
      if (input && input.value !== s.generator.searchQuery) {
        input.value = s.generator.searchQuery;
      }
      prevState = JSON.parse(JSON.stringify(s)) as State;
      return;
    }
  }

  const active = document.activeElement;
  const activeId = active?.id;
  const activeName = active instanceof HTMLInputElement ? active.name : null;
  let activeStart: number | null = null;
  let activeEnd: number | null = null;

  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    try {
      if (typeof active.selectionStart === "number") {
        activeStart = active.selectionStart;
        activeEnd = active.selectionEnd;
      }
    } catch (e) {}
  }

  const kindsChanged = s.kind !== prevKind;
  prevKind = s.kind;
  prevState = JSON.parse(JSON.stringify(s)) as State;
  root.innerHTML = render(s, kindsChanged);

  let focusRestored = false;
  let elToFocus: HTMLElement | null = null;
  if (activeId) elToFocus = root.querySelector(`#${activeId}`);
  else if (activeName) elToFocus = root.querySelector(`[name="${activeName}"]`);

  if (elToFocus) {
    if ((elToFocus instanceof HTMLInputElement || elToFocus instanceof HTMLTextAreaElement) && activeStart !== null && activeEnd !== null) {
      try { elToFocus.setSelectionRange(activeStart, activeEnd); } catch (e) {}
    }
    
    elToFocus.focus();
    
    if ((elToFocus instanceof HTMLInputElement || elToFocus instanceof HTMLTextAreaElement) && activeStart !== null && activeEnd !== null) {
      const s = activeStart;
      const e = activeEnd;
      requestAnimationFrame(() => {
        if (document.activeElement === elToFocus) {
          try { elToFocus.setSelectionRange(s, e); } catch (err) {}
        }
      });
    }
    focusRestored = true;
  }

  if (!focusRestored) {
    focusFirstField();
  }

  // After any re-render of the entry screen, re-apply phone formatting so
  // the country display and AsYouType formatting survive the innerHTML swap.
  if (s.kind === "entry") {
    const phoneInput = root.querySelector<HTMLInputElement>('input[name="s_num"]');
    if (phoneInput?.value) {
      formatPhoneInput(phoneInput);
    } else {
      updatePhoneCountry(lastInferredCountry);
    }
  }
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
    const phone = String(form.get("s_num") ?? "");
    const pin = String(form.get("s_key") ?? "");
    if (!parsePhoneNumberFromString(phone)?.isValid()) {
      state.setEntryError(
        "That doesn't look like a valid steg number. Use the generator drawer to make one.",
      );
      return;
    }
    if (!pin) {
      state.setEntryError("Enter your PIN.");
      return;
    }
    void state.submit(phone, pin);
  } else if (action === "submit-locked") {
    const pin = String(form.get("s_key") ?? "");
    void state.reauthenticate(pin);
  }
});

root.addEventListener("click", (e) => {
  const target = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (!action) return;

  switch (action) {
    case "toggle-phone-visibility": {
      const phoneInput = root.querySelector<HTMLInputElement>('input[name="s_num"]');
      state.togglePhoneVisibility(phoneInput?.value);
      break;
    }
    case "open-generator":
      state.openGenerator();
      break;
    case "close-generator":
      state.closeGenerator();
      break;
    case "select-country": {
      const country = target.dataset.country ?? "";
      if (country) void state.selectCountry(country, generateFor);
      break;
    }
    case "regenerate":
      void state.regenerate(generateFor);
      break;
    case "copy-generated": {
      const number = target.dataset.number ?? "";
      if (number) {
        navigator.clipboard.writeText(number).catch(() => {});
      }
      break;
    }
    case "apply-generated":
      state.applyGenerated();
      break;
    case "close-countries":
      state.closeCountries();
      break;
    case "continue-free":
      void state.continueFree();
      break;
    case "initiate-payment":
      void state.initiatePayment();
      break;
    case "send-message": {
      const ta = root.querySelector<HTMLTextAreaElement>("#chat-textarea");
      if (ta?.value.trim()) {
        void state.sendMessage(ta.value);
        ta.value = "";
        updateCharCount(0);
      }
      break;
    }
    case "start-edit":
      state.startEdit();
      break;
    case "cancel-edit":
      state.cancelEdit();
      break;
    case "save-edit": {
      const ta = root.querySelector<HTMLTextAreaElement>("#chat-textarea");
      if (ta) void state.saveEdit(ta.value);
      break;
    }
    case "delete-mine":
      void state.deleteCurrent();
      break;
    case "lock-chat":
      state.lockChat();
      break;
    case "leave-chat":
      state.logout();
      break;
    case "confirm-expire":
      state.confirmExpireShow();
      break;
    case "cancel-expire":
      state.confirmExpireHide();
      break;
    case "expire-room":
      void state.expireRoom();
      break;
    case "clear-session":
      state.clearSession();
      break;
    case "back-to-entry":
      state.logout();
      break;
    case "extend-room":
      void state.initiatePayment();
      break;
  }
});

// Textarea char counter + typing indicator + auto-resize. We update
// these in-place (no re-render) so focus stays on the textarea.
// The country search input triggers a re-render to filter the
// dropdown; input loses focus but re-focuses via [data-autofocus].
root.addEventListener(
  "input",
  (e) => {
    const target = e.target as HTMLElement;
    if (target instanceof HTMLTextAreaElement && target.id === "chat-textarea") {
      state.typing();
      updateCharCount(target.value.length);
      autoResize(target);
    } else if (target instanceof HTMLInputElement && target.name === "s_num") {
      formatPhoneInput(target);
    } else if (target instanceof HTMLInputElement && target.id === "drawer-country-input") {
      state.setCountrySearch(target.value, true);
    }
  },
  true,
);

// Open country dropdown when the search input is focused (e.g. tab in).
root.addEventListener(
  "focus",
  (e) => {
    const target = e.target as HTMLElement;
    if (target instanceof HTMLInputElement && target.id === "drawer-country-input") {
      const s = state.getState();
      if (s.kind === "entry" && !s.generator.showCountries) {
        state.setCountrySearch(target.value, true);
      }
    }
  },
  true,
);

// Close country dropdown on Escape; also cancel chat edits.
root.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement;
  if (target instanceof HTMLInputElement && target.id === "drawer-country-input") {
    if (e.key === "Escape") {
      state.closeCountries();
      e.preventDefault();
    }
    return;
  }

  if (!(target instanceof HTMLTextAreaElement) || target.id !== "chat-textarea") return;
  if (e.key === "Escape") {
    const s = state.getState();
    if (s.kind === "chat" && s.editing) state.cancelEdit();
  }
});

// Close country dropdown when clicking outside the search input + dropdown.
document.addEventListener("click", (e) => {
  const s = state.getState();
  if (s.kind !== "entry" || !s.generator.showCountries) return;
  const clicked = e.target as HTMLElement;
  if (
    !clicked.closest("#drawer-country-input") &&
    !clicked.closest("[data-action='select-country']")
  ) {
    state.closeCountries();
  }
});

// IntersectionObserver: fire markCurrentRead() when the received
// bubble is visible. Re-armed on every render.
let ioObserver: IntersectionObserver | null = null;
function armReadObserver() {
  ioObserver?.disconnect();
  const el = root?.querySelector<HTMLElement>("[data-received-message]");
  if (!el) return;
  ioObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          setTimeout(() => {
            state.markCurrentRead();
            ioObserver?.disconnect();
            ioObserver = null;
          }, 500);
        }
      }
    },
    { threshold: 0.8 },
  );
  ioObserver.observe(el);
}

state.onStateChange(() => armReadObserver());

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const MAX_CHARS = 4000;
const COUNTER_WARN_AT = 3500;
const COUNTER_DANGER_AT = 3900;

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

function updateCharCount(n: number) {
  const el = root?.querySelector<HTMLElement>("#char-counter");
  if (!el) return;
  if (n < COUNTER_WARN_AT) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  const colour = n >= COUNTER_DANGER_AT ? "text-danger" : "text-warning";
  el.className = `hidden sm:flex flex-col items-end mr-2 ${colour}`;
  el.innerHTML = `<span class="text-[10px] font-mono font-bold tracking-widest">${n}<span class="text-slate-600">/</span>${MAX_CHARS}</span>`;
}

function autoResize(ta: HTMLTextAreaElement) {
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
}

function formatPhoneInput(input: HTMLInputElement): void {
  let val = input.value;
  if (val.length > 0 && !val.startsWith("+")) {
    val = `+${val.replace(/\D/g, "")}`;
  }
  const formatter = new AsYouType();
  const formatted = formatter.input(val);
  if (formatted !== input.value) input.value = formatted;
  const country = formatter.getCountry() ?? null;
  lastInferredCountry = country;
  updatePhoneCountry(country);
}

function updatePhoneCountry(country: string | null): void {
  const el = document.getElementById("phone-country-display");
  if (!el) return;
  if (!country) {
    el.textContent = "";
    return;
  }
  el.textContent = `(${country})`;
}

// -----------------------------------------------------------------------------
// Render — one function per state kind
// -----------------------------------------------------------------------------

function render(s: State, animate: boolean): string {
  switch (s.kind) {
    case "entry":
      return renderEntry(s, animate);
    case "deriving":
      return renderDeriving(s);
    case "new_channel":
      return renderNewChannel(s);
    case "connecting":
      return renderConnecting();
    case "chat":
      return renderChat(s);
    case "locked":
      return renderLocked(s);
    case "expired":
      return renderExpired();
  }
}

// -------------------------------- :entry --------------------------------

function renderEntry(s: Extract<State, { kind: "entry" }>, animate: boolean): string {
  const a = animate ? " animate-in" : "";
  const phoneType = s.phoneVisible ? "text" : "password";
  const phoneTrackClass = s.phoneVisible ? "tracking-wider" : "tracking-widest";
  const phoneLockedOpacity = s.phoneLocked ? "opacity-80" : "";
  const phoneReadonly = s.phoneLocked ? "readonly" : "";
  const phoneAutofocus = !s.phoneLocked ? "data-autofocus" : "";
  const pinAutofocus = s.phoneLocked ? "data-autofocus" : "";

  const errorBanner = s.error
    ? `
      <div class="p-5 rounded-2xl bg-danger/5 border border-danger/20 flex gap-4 animate-in">
        ${icon("alert_circle", "size-6 text-danger shrink-0")}
        <div class="space-y-1">
          <p class="text-sm font-bold text-danger">${escapeHtml(s.error)}</p>
          ${
            s.attemptsRemaining !== null && s.attemptsRemaining !== undefined
              ? `<p class="text-[10px] text-danger/60 font-mono uppercase tracking-widest font-black">
                   Security Lock: ${s.attemptsRemaining} ${s.attemptsRemaining === 1 ? "attempt" : "attempts"} remaining
                 </p>`
              : ""
          }
        </div>
      </div>
    `
    : "";

  const lockedBadge = s.phoneLocked
    ? `<span class="text-[10px] font-mono text-primary font-bold">LOCKED</span>`
    : "";

  return `
    <div class="flex flex-col items-center justify-center min-h-[calc(100vh-120px)]${a}">
      <div class="w-full max-w-xl space-y-12">
        <!-- Branding -->
        <div class="text-center space-y-4">
          <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-[10px] font-bold uppercase tracking-[0.2em] mb-4 shadow-[0_0_15px_rgba(0,255,163,0.1)]">
            ${icon("ban", "size-3")} Secure Chat Session
          </div>
          <h1 class="text-4xl sm:text-6xl font-extrabold tracking-tighter text-white font-display leading-[0.9]">
            Open <span class="text-gradient">Chat.</span>
          </h1>
          <p class="text-slate-500 font-medium text-base sm:text-lg leading-relaxed px-4">
            Enter your details below to secure your connection.
          </p>
          <div class="flex items-center justify-center gap-2 text-[10px] font-bold text-primary/60 uppercase tracking-widest">
            ${icon("eye_off", "size-4 text-primary")} Incognito Mode recommended
          </div>
        </div>

        <div class="glass-card-premium p-8 sm:p-10${a} overflow-hidden">
          <div class="p-5 sm:p-10 space-y-10">
            ${errorBanner}

            <form data-action="submit-entry" autocomplete="off" class="space-y-8 sm:space-y-10">
              <!-- Phone Field -->
              <div class="space-y-4">
                <div class="flex items-center justify-between px-1">
                  <label class="text-[9px] sm:text-[10px] font-bold uppercase tracking-widest sm:tracking-[0.3em] text-slate-500">
                    Secret Number <span id="phone-country-display" class="text-primary/60 normal-case tracking-normal font-normal" aria-live="polite"></span>
                  </label>
                  ${lockedBadge}
                </div>
                <div class="relative group">
                  <input
                    name="s_num"
                    type="${phoneType}"
                    class="glass-input w-full pr-14 font-mono text-lg sm:text-xl font-bold bg-slate-950/40 ${phoneLockedOpacity} ${phoneTrackClass}"
                    value="${escapeHtml(s.phone)}"
                    ${phoneReadonly}
                    placeholder="e.g. +254..."
                    inputmode="tel"
                    autocomplete="off"
                    autocorrect="off"
                    autocapitalize="off"
                    spellcheck="false"
                    ${phoneAutofocus}
                  >
                  <button
                    type="button"
                    data-action="toggle-phone-visibility"
                    class="absolute right-4 top-1/2 -translate-y-1/2 p-2 rounded-xl text-slate-500 hover:text-white hover:bg-white/5 transition-all"
                    tabindex="-1"
                  >
                    ${icon(s.phoneVisible ? "eye_off" : "eye", "size-5 sm:size-6")}
                  </button>
                </div>
              </div>

              <!-- PIN Input -->
              <div class="space-y-4">
                <div class="flex items-center justify-between px-1">
                  <label class="text-[9px] sm:text-[10px] font-bold uppercase tracking-widest sm:tracking-[0.3em] text-slate-500">
                    Private PIN
                  </label>
                  <span class="text-[9px] sm:text-[10px] font-mono text-slate-500 font-bold whitespace-nowrap">
                    SECURED LOCALLY
                  </span>
                </div>
                <input
                  name="s_key"
                  type="password"
                  inputmode="numeric"
                  pattern="[0-9]*"
                  placeholder="Secret PIN"
                  autocomplete="one-time-code"
                  autocorrect="off"
                  autocapitalize="off"
                  spellcheck="false"
                  class="glass-input w-full text-center text-xl sm:text-4xl tracking-[0.2em] sm:tracking-[0.6em] font-mono py-4 sm:py-6 bg-slate-950/40 border-white/10"
                  ${pinAutofocus}
                >
              </div>

              <button
                type="submit"
                class="btn-primary w-full py-4 sm:py-5 text-lg sm:text-xl group shadow-[0_20px_40px_-10px_rgba(0,255,163,0.3)]"
              >
                Open Chat
                ${icon("zap", "size-5 sm:size-6 group-hover:scale-125 transition-transform")}
              </button>
            </form>

            <div class="pt-8 border-t border-white/5 flex flex-col items-center gap-5 text-center">
              <p class="text-slate-400 text-sm font-medium">
                Don't have a secret number yet?
              </p>
              <button
                type="button"
                data-action="open-generator"
                class="btn-secondary w-full py-4 sm:py-5 text-lg sm:text-xl inline-flex items-center justify-center gap-2 group"
              >
                ${icon("sparkles", "size-5 text-primary group-hover:rotate-12 transition-transform")}
                Generate New Number
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
    ${renderGeneratorDrawer(s.generator)}
  `;
}

// -------------------------- generator drawer --------------------------

function renderGeneratorDropdown(g: GeneratorState): string {
  const q = g.searchQuery.toLowerCase();
  const filtered = q
    ? COUNTRY_LIST.filter((c) => c.name.toLowerCase().includes(q)).sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(q);
        const bStarts = b.name.toLowerCase().startsWith(q);
        if (aStarts !== bStarts) return aStarts ? -1 : 1;
        return 0;
      })
    : COUNTRY_LIST;
  const countriesToShow = filtered.slice(0, 60);

  if (!g.showCountries || countriesToShow.length === 0) return "";

  return `
    <div class="absolute z-100 w-full mt-2 bg-slate-800 border border-white/10 rounded-2xl shadow-2xl overflow-hidden max-h-48 overflow-y-auto animate-in fade-in slide-in-from-top-2">
      ${countriesToShow
        .map(
          (c) => `
            <button
              type="button"
              data-action="select-country"
              data-country="${escapeHtml(c.name)}"
              class="w-full px-6 py-4 text-left hover:bg-white/5 text-slate-300 hover:text-white transition-all border-b border-white/5 last:border-0 flex items-center justify-between group"
            >
              <span class="font-bold tracking-wide text-sm">${escapeHtml(c.name)}</span>
              ${icon("chevron_right", "size-4 opacity-0 group-hover:opacity-100 transition-opacity")}
            </button>`,
        )
        .join("")}
    </div>`;
}

function renderGeneratorDrawer(g: GeneratorState): string {
  const containerVis = g.open ? "visible" : "invisible pointer-events-none";
  const backdropOp = g.open ? "opacity-100" : "opacity-0";
  const drawerSlide = g.open ? "translate-x-0" : "translate-x-full";

  const inputRightIcon = g.selectedCountry
    ? icon("badge_check", "size-5 text-emerald-400")
    : icon("search", "size-5");

  const generatorPanel = g.generatedNumber
    ? `
      <div class="space-y-8 animate-in scale-in">
        <div class="relative py-12 px-6 rounded-4xl bg-slate-950/50 border border-white/5 group">
          <div class="absolute inset-0 bg-linear-to-br from-primary/5 to-transparent"></div>
          <div class="relative z-10 space-y-6 text-center">
            <button
              type="button"
              data-action="copy-generated"
              data-number="${escapeHtml(g.generatedNumber)}"
              class="font-mono font-black text-white tracking-widest text-4xl drop-shadow-[0_0_20px_rgba(0,255,163,0.3)] break-all px-2 block w-full hover:scale-105 transition-transform"
              title="Copy to clipboard"
            >
              ${escapeHtml(new AsYouType().input(g.generatedNumber))}
            </button>

            <div class="flex flex-col items-center gap-3">
              <div class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-[10px] font-black uppercase tracking-widest text-emerald-400">
                ${
                  g.copiedNumber
                    ? `${icon("check", "size-3")} Copied to Clipboard`
                    : `${icon("sparkles", "size-3")} Identity Ready`
                }
              </div>
              <button
                type="button"
                data-action="regenerate"
                ${g.generating ? "disabled" : ""}
                class="text-[9px] font-black uppercase tracking-[0.3em] text-slate-600 hover:text-primary transition-colors flex items-center justify-center gap-1.5 mx-auto mt-4 ${g.generating ? "opacity-20 pointer-events-none" : ""}"
              >
                ${icon("refresh_cw", `size-3 ${g.generating ? "animate-spin" : ""}`)}
                ${g.generating ? "Generating..." : "Re-Generate"}
              </button>
            </div>
          </div>
        </div>
      </div>`
    : `
      <div class="flex flex-col items-center gap-6 py-12 text-center">
        <div class="size-20 rounded-full bg-white/5 border border-white/10 flex items-center justify-center">
          ${icon("globe", "size-9 text-slate-500")}
        </div>
        <p class="text-[10px] font-black uppercase tracking-[0.3em] text-slate-500 max-w-60">
          Select a country above to generate a targeted identity
        </p>
      </div>`;

  const applyBtn = g.generatedNumber
    ? `
      <button
        type="button"
        data-action="apply-generated"
        class="btn-primary w-full py-4 uppercase tracking-widest text-sm"
      >
        Apply to Workspace ${icon("arrow_right", "size-4")}
      </button>`
    : `
      <button
        type="button"
        disabled
        class="w-full py-4 rounded-2xl bg-white/5 border border-white/5 text-slate-600 font-bold uppercase tracking-widest text-sm cursor-not-allowed italic"
      >
        Select Country First
      </button>`;

  const placeholder = g.selectedCountry ?? "Search country...";

  return `
    <div class="fixed inset-0 z-50 transition-all duration-500 ${containerVis}">
      <!-- Backdrop -->
      <div
        data-action="close-generator"
        class="absolute inset-0 bg-slate-950/80 backdrop-blur-md transition-opacity duration-500 ${backdropOp}"
      ></div>

      <!-- Drawer Content -->
      <div class="absolute right-0 top-0 bottom-0 w-full max-w-md bg-slate-900 border-l border-white/10 shadow-2xl flex flex-col transition-transform duration-500 ease-out ${drawerSlide} sm:h-full max-sm:top-auto max-sm:h-[85dvh] max-sm:rounded-t-[2.5rem] max-sm:border-l-0 max-sm:border-t">

        <!-- Header -->
        <div class="p-6 border-b border-white/5 flex items-center justify-between">
          <div class="flex items-center gap-3">
            <div class="size-10 rounded-xl bg-primary/10 flex items-center justify-center border border-primary/20">
              ${icon("sparkles", "size-5 text-primary")}
            </div>
            <div>
              <h3 class="text-white font-bold tracking-tight uppercase text-sm">
                Identity Generator
              </h3>
              <p class="text-[10px] text-slate-500 font-medium uppercase tracking-widest">
                Derive a new steg number
              </p>
            </div>
          </div>
          <button
            type="button"
            data-action="close-generator"
            class="size-10 rounded-xl hover:bg-white/5 flex items-center justify-center text-slate-500 hover:text-white transition-all"
          >
            ${icon("x", "size-6")}
          </button>
        </div>

        <!-- Content -->
        <div class="flex-1 overflow-y-auto p-6 sm:p-8 space-y-10 scrollbar-hide">

          <!-- Country Selector -->
          <div class="space-y-4">
            <label class="text-[10px] font-black uppercase tracking-[0.3em] text-slate-500 ml-1">
              Select Preferred Country
            </label>

            <div class="relative group">
              <div class="relative">
                <input
                  type="text"
                  id="drawer-country-input"
                  placeholder="${escapeHtml(placeholder)}"
                  value="${escapeHtml(g.searchQuery)}"
                  class="glass-input w-full bg-slate-950/40 border-white/10 text-white font-bold text-lg focus:border-primary/40 py-4 px-6 rounded-2xl pr-12 transition-all tracking-wider"
                  autocomplete="off"
                >
                <div class="absolute right-5 top-1/2 -translate-y-1/2 text-slate-500">
                  ${inputRightIcon}
                </div>
              </div>
              <div id="drawer-country-dropdown-container">
                ${renderGeneratorDropdown(g)}
              </div>
            </div>
          </div>

          <!-- Generator output -->
          <div class="w-full">
            ${generatorPanel}
          </div>

          <!-- Forensic Safety -->
          <div class="p-6 rounded-3xl bg-white/5 border border-white/5 space-y-4 text-left w-full max-w-sm mx-auto">
            <div class="flex items-center gap-3">
              <div class="size-8 rounded-xl bg-white/5 flex items-center justify-center border border-white/5">
                ${icon("shield_check", "size-4 text-slate-400")}
              </div>
              <h4 class="text-xs font-black uppercase tracking-widest text-white">Forensic Safety</h4>
            </div>
            <p class="text-[11px] text-slate-400 leading-relaxed font-medium">
              Identities are <span class="text-white font-bold">volatile</span>. Share immediately. Closing this drawer after applying does not save the number to history.
            </p>
          </div>

          <!-- Onboarding Instructions -->
          <div class="space-y-8 pt-10">
            <h3 class="text-[10px] font-black uppercase tracking-[0.4em] text-slate-600 text-center mb-6">
              Protocol Onboarding &amp; Guidance
            </h3>
            <div class="space-y-6">
              ${[
                {
                  icon: "user_plus",
                  title: "1. Save in Phonebook",
                  text: "Add this number to your partner's actual contact list.",
                  guidance:
                    "This camouflages the channel as a regular contact in your native address book.",
                },
                {
                  icon: "arrow_up_right",
                  title: "2. Share Channel ID",
                  text: "Give this number to your partner.",
                  guidance:
                    "Communicate this number securely. Your PIN is personal and stays on your device.",
                },
                {
                  icon: "shield_check",
                  title: "3. Establishment",
                  text: "Once both parties connect, a zero-trace link is armed.",
                  guidance: "All messages are locally encrypted and wiped atomically upon reply.",
                },
              ]
                .map(
                  (s) => `
                  <div class="glass-card p-8 flex flex-col md:flex-row gap-8 items-start relative group hover:border-white/10 transition-all duration-500">
                    <div class="size-16 rounded-2xl bg-white/5 flex items-center justify-center text-primary border border-white/5 shadow-inner group-hover:scale-110 transition-transform duration-500">
                      ${icon(s.icon, "size-8")}
                    </div>
                    <div class="flex-1 space-y-4">
                      <div class="space-y-1">
                        <h4 class="font-bold text-white text-xl font-display tracking-tight">${s.title}</h4>
                        <p class="text-slate-400 leading-relaxed font-medium">${s.text}</p>
                      </div>
                      <div class="p-4 rounded-xl bg-slate-900/50 border border-white/5 text-xs text-slate-500 leading-relaxed italic">
                        ${s.guidance}
                      </div>
                    </div>
                  </div>`,
                )
                .join("")}
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="p-6 border-t border-white/5 bg-slate-900/50">
          ${applyBtn}
        </div>
      </div>
    </div>
  `;
}

// ------------------------------ :deriving -------------------------------

function renderDeriving(s: Extract<State, { kind: "deriving" }>): string {
  const pct = Math.round(s.progress);
  return `
    <div class="flex flex-col items-center justify-center min-h-[calc(100vh-120px)] p-6 animate-in">
      <div class="w-full max-w-sm text-center space-y-16">
        <div class="relative size-48 mx-auto">
          <div class="absolute inset-0 rounded-full border-2 border-primary/5 border-t-primary animate-spin duration-1000"></div>
          <div class="absolute inset-4 rounded-full border-2 border-primary/5 border-r-primary animate-spin-reverse duration-2000"></div>
          <div class="absolute inset-8 rounded-full border-2 border-primary/5 border-l-primary animate-spin duration-3000"></div>
          <div class="absolute inset-0 flex items-center justify-center">
            <div class="size-24 rounded-full bg-slate-900 border border-white/5 flex items-center justify-center shadow-2xl">
              ${
                pct > 0
                  ? `<span class="font-mono font-black text-primary text-xl">${pct}%</span>`
                  : icon(
                      "cpu",
                      "size-12 text-primary animate-pulse drop-shadow-[0_0_15px_var(--color-primary-glow)]",
                    )
              }
            </div>
          </div>
        </div>

        <div class="space-y-6">
          <h3 class="text-4xl font-extrabold text-white font-display tracking-tight uppercase">
            Securing <span class="text-gradient">Chat.</span>
          </h3>
          <p class="text-slate-500 font-medium leading-relaxed">
            Your browser is securing your private connection.
          </p>
        </div>

        <div class="flex justify-center items-center gap-3">
          <div class="size-1.5 rounded-full bg-primary animate-ping"></div>
          <div class="size-1.5 rounded-full bg-primary animate-ping [animation-delay:0.3s]"></div>
          <div class="size-1.5 rounded-full bg-primary animate-ping [animation-delay:0.6s]"></div>
        </div>
      </div>
    </div>
  `;
}

// ----------------------------- :new_channel -----------------------------

function renderNewChannel(s: Extract<State, { kind: "new_channel" }>): string {
  const paidDisabled = s.paymentLoading ? "disabled" : "";
  const paidClass = s.paymentLoading ? "opacity-50 cursor-not-allowed" : "";
  const paidLabel = s.paymentLoading ? "Opening checkout…" : "Dedicated Tier";
  const priceDisplay = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: s.currency,
  }).format(s.priceCents / 100);

  const errorBanner = s.paymentError
    ? `
      <div class="p-4 rounded-2xl bg-danger/5 border border-danger/20 flex gap-3 items-start animate-in max-w-sm mx-auto">
        ${icon("alert_circle", "size-5 text-danger shrink-0 mt-0.5")}
        <p class="text-sm font-medium text-danger">${escapeHtml(s.paymentError)}</p>
      </div>`
    : "";

  return `
    <div class="flex flex-col items-center justify-center min-h-[calc(100vh-120px)] p-6 animate-in">
      <div class="w-full max-w-lg space-y-10">
        <div class="text-center space-y-4">
          <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-[10px] font-bold uppercase tracking-[0.2em] shadow-[0_0_15px_rgba(0,255,163,0.1)]">
            ${icon("sparkles", "size-3")} New Channel Detected
          </div>
          <h2 class="text-3xl sm:text-4xl font-extrabold text-white font-display tracking-tight">
            This is a new channel.
          </h2>
          <p class="text-slate-400 font-medium leading-relaxed max-w-sm mx-auto">
            Choose how long you want to keep this number active.
          </p>
        </div>

        ${errorBanner}

        <div class="space-y-4 max-w-sm mx-auto">
          <!-- Free tier -->
          <button
            data-action="continue-free"
            class="w-full p-5 rounded-2xl bg-white/5 border border-white/10 hover:border-white/30 hover:bg-white/10 text-left transition-all group flex items-center justify-between"
          >
            <div class="flex items-center gap-4">
              <div class="size-10 rounded-xl bg-white/10 flex items-center justify-center border border-white/5 group-hover:scale-110 transition-transform">
                ${icon("clock", "size-5 text-slate-300 group-hover:text-white transition-colors")}
              </div>
              <div>
                <h3 class="text-white font-bold text-sm">Temporary (Free)</h3>
                <p class="text-slate-400 text-[10px] uppercase tracking-widest mt-0.5 font-bold">
                  Expires in ${s.freeTtlDays} days
                </p>
              </div>
            </div>
            ${icon("arrow_right", "size-4 text-slate-500 group-hover:translate-x-1 group-hover:text-white transition-all")}
          </button>

          <!-- Paid tier — POSTs to /api/payment/initiate which returns
               a Paystack checkout URL once Phase 7 wires the adapter. -->
          <button
            type="button"
            data-action="initiate-payment"
            ${paidDisabled}
            class="w-full p-5 rounded-2xl bg-primary/10 border border-primary/20 hover:border-primary/40 hover:bg-primary/20 text-left transition-all group flex items-center justify-between shadow-[0_0_20px_rgba(0,255,163,0.1)] ${paidClass}"
          >
            <div class="flex items-center gap-4">
              <div class="size-10 rounded-xl bg-primary/20 flex items-center justify-center border border-primary/30 group-hover:scale-110 transition-transform">
                ${icon("shield_check", "size-5 text-primary")}
              </div>
              <div>
                <h3 class="text-primary font-bold text-sm">${escapeHtml(paidLabel)}</h3>
                <p class="text-primary/80 text-[10px] uppercase tracking-widest mt-0.5 font-bold">
                  1 Year &mdash; ${escapeHtml(priceDisplay)}
                </p>
              </div>
            </div>
            ${icon("arrow_right", "size-4 text-primary group-hover:translate-x-1 transition-transform")}
          </button>
        </div>

        <p class="text-center text-slate-500 text-[10px] uppercase tracking-widest font-bold">
          You can upgrade to dedicated anytime.
        </p>
      </div>
    </div>
  `;
}

// ----------------------------- :connecting ------------------------------

function renderConnecting(): string {
  return `
    <div class="flex flex-col items-center justify-center min-h-[calc(100vh-120px)] p-6">
      <div class="w-full max-w-sm text-center space-y-10 animate-in">
        <div class="size-24 rounded-[2.5rem] bg-primary/5 flex items-center justify-center mx-auto shadow-inner ring-1 ring-primary/20 animate-pulse">
          ${icon("globe", "size-12 text-primary")}
        </div>

        <div class="space-y-3">
          <h3 class="text-2xl font-bold text-white font-display">Connecting</h3>
          <p class="text-slate-400 font-medium">Joining your encrypted channel…</p>
        </div>

        <div class="px-6 py-3 rounded-2xl bg-slate-950/60 border border-white/5 font-mono text-[10px] text-slate-500 font-bold uppercase tracking-[0.3em] flex items-center justify-center gap-2">
          <span>PBKDF2 · 600k iter · OK</span>
        </div>
      </div>
    </div>
  `;
}

// -------------------------------- :chat ---------------------------------

function renderTtlWarning(ttlExpiresAt: string | null, monetizationEnabled: boolean): string {
  if (!ttlExpiresAt) return "";
  const remainingMs = new Date(ttlExpiresAt).getTime() - Date.now();
  if (remainingMs <= 0) return "";
  const remainingHours = remainingMs / 3_600_000;
  if (remainingHours > 48) return "";

  const isDanger = remainingHours <= 12;
  const colorClass = isDanger
    ? "bg-danger/10 border-b border-danger/20 text-danger"
    : "bg-amber-500/10 border-b border-amber-500/20 text-amber-400";

  const hrs = Math.floor(remainingHours);
  const mins = Math.floor((remainingMs % 3_600_000) / 60_000);
  const countdown = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

  const extendBtn = monetizationEnabled
    ? `<button data-action="extend-room" class="ml-3 text-[10px] font-bold uppercase tracking-widest underline hover:no-underline">Extend</button>`
    : "";

  return `
    <div class="px-4 sm:px-6 py-2 flex items-center gap-3 text-xs font-bold ${colorClass}">
      ${icon("alert_triangle", "size-4 shrink-0")}
      <span>Channel expires in ${countdown}</span>
      ${extendBtn}
    </div>
  `;
}

function renderChat(s: Extract<State, { kind: "chat" }>): string {
  const canType = !s.current || s.current.senderHash !== s.senderHash;
  const msgArea = s.current ? renderMessageBubble(s.current, s.senderHash) : renderEmptyBuffer();

  const interactionZone = s.editing
    ? renderInputArea({ editing: true, value: s.current?.plaintext ?? "" })
    : canType
      ? renderInputArea({ editing: false, value: "" })
      : renderWaitingArea(s.current, s.senderHash, s.counterpartyTyping);

  const destructionModal = s.confirmExpire ? renderDestructionModal() : "";

  return `
    <div class="h-full w-full flex flex-col">
      <!-- Navigation Header -->
      <div class="px-4 sm:px-6 py-3 sm:py-5 flex items-center justify-between border-b border-white/10 bg-slate-900/80 backdrop-blur-3xl sticky top-0 z-50">
        <div class="flex items-center gap-3 sm:gap-4">
          <a href="/" class="wordmark text-lg sm:text-2xl leading-tight group">
            <span class="wm-symbol">s</span><span class="wm-accent">TEL</span><span class="text-white">gano</span>
          </a>
          <div class="hidden sm:block h-6 w-px bg-white/20"></div>
          <span class="hidden lg:inline text-[9px] font-bold uppercase tracking-[0.3em] text-primary">
            WORKSPACE SECURED
          </span>
        </div>

        <!-- Session Controls -->
        <div class="flex items-center gap-1.5 sm:gap-4">
          <button
            data-action="lock-chat"
            title="Lock session"
            class="p-2 sm:p-3 rounded-xl sm:rounded-2xl bg-white/5 hover:bg-white/10 text-white transition-all flex items-center justify-center border border-white/5 shadow-lg"
          >
            ${icon("lock", "size-5 sm:size-6")}
          </button>
          <button
            data-action="confirm-expire"
            title="Erase all"
            class="p-2 sm:p-3 rounded-xl sm:rounded-2xl bg-danger/10 hover:bg-danger/20 text-danger transition-all flex items-center justify-center border border-danger/20 shadow-lg shadow-danger/5"
          >
            ${icon("flame", "size-5 sm:size-6")}
          </button>
          <div class="w-px h-6 bg-white/20 mx-0.5 sm:mx-1"></div>
          <button
            data-action="leave-chat"
            title="Exit Chat"
            class="p-2 sm:p-3 rounded-xl sm:rounded-2xl bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white transition-all flex items-center justify-center border border-white/5 shadow-lg"
          >
            ${icon("power", "size-5 sm:size-6 text-danger")}
          </button>
        </div>
      </div>

      <!-- TTL (Session Entropy) Bar -->
      <div class="h-1 w-full bg-slate-900 border-b border-white/5 overflow-hidden">
        <div
          class="h-full bg-linear-to-r from-primary via-emerald-400 to-primary/40 transition-all duration-1000 ease-linear shadow-[0_0_10px_rgba(0,255,163,0.5)]"
          style="width: 100%;"
        ></div>
      </div>

      <!-- TTL expiry warning (amber < 48h, danger < 12h) -->
      ${renderTtlWarning(s.ttlExpiresAt, serverConfig.monetizationEnabled)}

      <!-- Payment error banner (extend button errors) -->
      ${
        s.paymentError
          ? `
      <div class="px-4 sm:px-6 py-2 flex items-center gap-3 text-xs font-bold bg-danger/10 border-b border-danger/20 text-danger">
        ${icon("alert_circle", "size-4 shrink-0")}
        <span>${escapeHtml(s.paymentError)}</span>
      </div>`
          : ""
      }

      <!-- Workspace Message Area -->
      <div
        class="flex-1 overflow-y-auto px-4 sm:px-6 py-6 sm:py-10 space-y-6 sm:space-y-10 scrollbar-hide"
        role="log"
        aria-live="polite"
      >
        ${msgArea}
      </div>

      <!-- User Interaction Zone -->
      <div class="p-4 sm:p-8 pb-10">
        ${interactionZone}
      </div>

      ${destructionModal}
    </div>
  `;
}

function renderMessageBubble(msg: PlainMessage, senderHash: string): string {
  const isMine = msg.senderHash === senderHash;
  const justify = isMine ? "justify-end" : "justify-start";
  const flex = isMine ? "flex flex-col items-end" : "flex flex-col items-start";
  const bubbleStyle = isMine
    ? "bg-linear-to-br from-primary/10 to-emerald-500/5 border-primary/20 rounded-tr-none text-white shadow-[0_10px_30px_-10px_rgba(0,255,163,0.1)]"
    : "bg-slate-900/50 backdrop-blur-xl border-white/5 rounded-tl-none text-slate-200 shadow-inner";
  const dataAttr = !isMine && !msg.readAt ? "data-received-message" : "";

  const readBadge = isMine
    ? msg.readAt
      ? `
        <span class="flex items-center gap-1 py-0.5 px-1.5 rounded-md bg-primary/5 border border-primary/10">
          ${icon("badge_check", "size-2.5 text-primary")}
          <span class="text-[8px] font-black uppercase tracking-widest text-primary/80">Read</span>
        </span>`
      : `
        <span class="flex items-center gap-1 py-0.5 px-1.5 rounded-md bg-white/5 border border-white/5">
          <div class="size-1 rounded-full bg-slate-600 animate-pulse"></div>
          <span class="text-[8px] font-black uppercase tracking-widest text-slate-500">Delivered</span>
        </span>`
    : "";

  const editedBadge = msg.edited
    ? `<span class="flex items-center gap-1 py-0.5 px-1.5 rounded-md bg-white/5 border border-white/5">
        <span class="text-[8px] font-black uppercase tracking-widest text-slate-500">Edited</span>
      </span>`
    : "";

  return `
    <div class="flex w-full animate-in ${justify}" ${dataAttr}>
      <div class="max-w-[85%] sm:max-w-[80%] group space-y-3 ${flex}">
        <div class="relative p-4 sm:p-8 rounded-2xl sm:rounded-4xl transition-all duration-500 border overflow-hidden ${bubbleStyle}">
          <p class="relative z-10 whitespace-pre-wrap text-sm sm:text-lg leading-relaxed font-medium tracking-tight">${escapeHtml(msg.plaintext)}</p>
        </div>
        <div class="flex items-center gap-4 px-2 mt-1">
          ${isMine ? `<div class="flex items-center gap-2">${readBadge}${editedBadge}</div>` : editedBadge}
        </div>
      </div>
    </div>
  `;
}

function renderEmptyBuffer(): string {
  return `
    <div class="flex flex-col items-center justify-center h-full text-center max-w-sm mx-auto animate-in space-y-8">
      <div class="relative size-24">
        <div class="absolute inset-0 rounded-3xl bg-white/2 border border-white/5 rotate-6"></div>
        <div class="absolute inset-0 rounded-3xl bg-white/2 border border-white/5 -rotate-3"></div>
        <div class="absolute inset-0 rounded-3xl bg-slate-900 border border-white/10 flex items-center justify-center">
          ${icon("shield_check", "size-12 text-slate-700")}
        </div>
      </div>
      <div class="space-y-3">
        <h4 class="text-2xl font-bold text-white font-display">Zero Trace Channel</h4>
        <p class="text-slate-500 font-medium leading-relaxed">
          The buffer is currently empty. This workspace adheres to a strict single-message protocol for maximum plausible deniability.
        </p>
      </div>
    </div>
  `;
}

function renderInputArea(opts: { editing: boolean; value: string }): string {
  const glowClass = opts.editing
    ? "bg-linear-to-r from-amber-500/20 via-orange-400/20 to-amber-500/20"
    : "bg-linear-to-r from-primary/20 via-emerald-400/20 to-primary/20";
  const borderClass = opts.editing
    ? "border-amber-500/30 group-focus-within:border-amber-500/50"
    : "border-white/10 group-focus-within:border-primary/50 group-focus-within:bg-slate-950";
  const placeholder = opts.editing ? "Revise message..." : "Construct secure message…";

  const actionButtons = opts.editing
    ? `
      <button
        data-action="cancel-edit"
        aria-label="Cancel Edit"
        class="size-12 sm:size-16 rounded-xl sm:rounded-[1.75rem] bg-white/5 text-slate-400 flex items-center justify-center hover:bg-white/10 transition-all border border-white/10"
      >
        ${icon("x", "size-5 sm:size-6")}
      </button>
      <button
        data-action="save-edit"
        aria-label="Update Message"
        class="size-12 sm:size-16 rounded-xl sm:rounded-[1.75rem] bg-amber-500 text-slate-950 flex items-center justify-center shadow-[0_0_30px_rgba(245,158,11,0.3)] hover:scale-110 active:scale-95 transition-all"
      >
        ${icon("check", "size-6 sm:size-8 text-slate-950")}
      </button>`
    : `
      <button
        data-action="send-message"
        aria-label="Encrypt &amp; Broadcast"
        class="size-12 sm:size-16 rounded-xl sm:rounded-[1.75rem] bg-primary text-slate-950 flex items-center justify-center shadow-[0_0_30px_rgba(0,255,163,0.3)] hover:scale-110 active:scale-95 transition-all group"
      >
        ${icon("arrow_right", "size-6 sm:size-8 -rotate-12 group-hover:rotate-0 transition-transform text-slate-950")}
      </button>`;

  return `
    <div class="relative group">
      <!-- Glow focus effect -->
      <div class="absolute -inset-1 rounded-[2.5rem] blur-xl opacity-0 group-focus-within:opacity-100 transition-opacity duration-700 ${glowClass}"></div>

      <div class="relative flex items-end gap-2 sm:gap-3 p-2 sm:p-5 rounded-2xl sm:rounded-4xl bg-slate-900 border-2 transition-all duration-300 shadow-2xl z-50 ${borderClass}">
        <textarea
          id="chat-textarea"
          data-autofocus
          class="flex-1 bg-transparent border-none text-white placeholder-slate-500 focus:ring-0 focus:outline-none py-2 sm:py-4 px-2 resize-none max-h-36 min-h-12 sm:min-h-14 scrollbar-hide text-base sm:text-lg leading-relaxed font-medium"
          placeholder="${placeholder}"
          rows="1"
          maxlength="${MAX_CHARS}"
        >${escapeHtml(opts.value)}</textarea>

        <div class="flex items-center gap-2 sm:gap-4 pr-1 pb-1">
          <div id="char-counter" class="hidden sm:flex flex-col items-end mr-2"></div>
          ${actionButtons}
        </div>
      </div>
    </div>
  `;
}

function renderWaitingArea(
  current: PlainMessage | null,
  senderHash: string,
  typing: boolean,
): string {
  const glowClass = typing
    ? "border-primary/40 shadow-[0_0_40px_-5px_var(--color-primary-glow)]"
    : "border-white/5";
  const primaryDot = typing ? "bg-primary" : "bg-primary/60";
  const labelTransform = typing
    ? "text-primary scale-105 origin-left"
    : "text-slate-400 group-hover:text-primary";
  const label = typing ? "Node is typing..." : "Waiting for Reply";
  const subtitle = typing ? "Processing incoming sequence..." : "Identity artifacts are locked";

  const ownerControls =
    current && current.senderHash === senderHash && !current.readAt
      ? `
        <div class="flex items-center gap-2 sm:gap-3 z-10 w-full sm:w-auto">
          <button
            data-action="start-edit"
            class="flex-1 sm:flex-none px-4 sm:px-5 py-2 sm:py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white text-[9px] sm:text-[10px] font-bold uppercase tracking-widest transition-all border border-white/5 flex items-center justify-center gap-2"
          >
            ${icon("edit_3", "size-3")} Edit
          </button>
          <button
            data-action="delete-mine"
            class="flex-1 sm:flex-none px-4 sm:px-5 py-2 sm:py-2.5 rounded-xl bg-danger/10 hover:bg-danger/20 text-danger text-[9px] sm:text-[10px] font-bold uppercase tracking-widest transition-all border border-danger/20 flex items-center justify-center gap-2"
          >
            ${icon("trash_2", "size-3")} Delete
          </button>
        </div>`
      : "";

  return `
    <div class="glass-card p-4 sm:p-6 flex flex-col sm:flex-row items-center justify-between gap-6 transition-all duration-700 animate-in relative overflow-hidden group ${glowClass}">
      <div class="absolute inset-0 bg-linear-to-r from-primary/0 via-primary/5 to-primary/0 -translate-x-full group-hover:translate-x-full transition-transform duration-2000 ease-in-out pointer-events-none"></div>

      <div class="flex items-center gap-4 sm:gap-6 z-10 w-full sm:w-auto">
        <div class="relative flex items-center justify-center size-10 sm:size-12 shrink-0">
          <div class="absolute inset-0 rounded-xl blur-lg animate-pulse ${typing ? "bg-primary/40" : "bg-primary/20"}"></div>
          <div class="relative flex gap-1.5 items-center">
            <div class="size-1.5 sm:size-2 rounded-full animate-bounce ${primaryDot}"></div>
            <div class="size-1.5 sm:size-2 rounded-full animate-bounce [animation-delay:0.2s] ${primaryDot}"></div>
            <div class="size-1.5 sm:size-2 rounded-full animate-bounce [animation-delay:0.4s] ${primaryDot}"></div>
          </div>
        </div>
        <div class="space-y-1">
          <p class="text-[10px] sm:text-xs font-black uppercase tracking-[0.25em] sm:tracking-[0.3em] transition-all duration-500 ${labelTransform}">
            ${label}
          </p>
          <p class="text-[8px] sm:text-[10px] text-slate-500 font-medium uppercase tracking-widest">
            ${subtitle}
          </p>
        </div>
      </div>

      ${ownerControls}
    </div>
  `;
}

function renderDestructionModal(): string {
  return `
    <div class="fixed inset-0 z-50 flex items-center justify-center p-6 bg-slate-950/80 backdrop-blur-3xl animate-in duration-300">
      <div class="w-full max-w-sm glass-card p-10 border-danger/40 relative overflow-hidden">
        <div class="absolute -right-10 -bottom-10 size-40 bg-danger/5 rounded-full blur-3xl"></div>

        <div class="size-20 rounded-4xl bg-danger/10 flex items-center justify-center mb-8 border border-danger/20">
          ${icon("flame", "size-10 text-danger")}
        </div>

        <h3 class="text-3xl font-extrabold text-white mb-4 font-display">Nuclear Wipe?</h3>
        <p class="text-slate-400 mb-10 leading-relaxed font-medium">
          This will permanently purge the current artifact and end the sequence for both nodes. This action is
          <span class="text-white">irreversible.</span>
        </p>

        <div class="flex flex-col gap-3">
          <button
            data-action="expire-room"
            class="w-full py-4 rounded-2xl bg-danger text-white font-black uppercase tracking-widest shadow-xl shadow-danger/20 hover:scale-[1.02] active:scale-95 transition-all"
          >
            Initialize Purge
          </button>
          <button
            data-action="cancel-expire"
            class="w-full py-4 rounded-2xl bg-white/5 text-slate-400 font-bold uppercase tracking-widest hover:bg-white/10 transition-all border border-white/5"
          >
            Abort
          </button>
        </div>
      </div>
    </div>
  `;
}

// -------------------------------- :locked --------------------------------

function renderLocked(s: Extract<State, { kind: "locked" }>): string {
  const pips = Array.from(
    { length: s.lockAttempts },
    () => `<div class="size-1 rounded-full bg-primary/40"></div>`,
  ).join("");
  const errorBlock = s.lockError
    ? `<div class="p-3 rounded-xl bg-danger/10 border border-danger/20 text-xs font-bold text-danger animate-bounce uppercase tracking-widest">${escapeHtml(s.lockError)}</div>`
    : "";

  return `
    <div class="fixed inset-0 z-100 flex items-center justify-center p-6 bg-slate-950/95 backdrop-blur-3xl animate-in">
      <div class="w-full max-w-sm text-center space-y-12">
        <div class="relative size-24 mx-auto">
          <div class="absolute -inset-4 bg-primary/10 rounded-full blur-2xl animate-pulse"></div>
          <div class="relative size-24 rounded-4xl bg-slate-900 border border-primary/20 flex items-center justify-center shadow-inner">
            ${icon("lock", "size-12 text-primary drop-shadow-[0_0_10px_var(--color-primary-glow)]")}
          </div>
        </div>

        <div class="space-y-4">
          <h1 class="text-4xl font-extrabold text-white font-display tracking-tight uppercase">
            Workspace <span class="text-gradient">Locked.</span>
          </h1>
          <p class="text-slate-500 font-medium text-sm leading-relaxed max-w-70 mx-auto">
            Encryption artifacts are suspended. Re-derive the key matrix to restore the link.
          </p>
        </div>

        <form data-action="submit-locked" autocomplete="off" class="space-y-8">
          <div class="space-y-4">
            <div class="flex items-center justify-between px-1">
              <label class="text-[10px] font-black uppercase tracking-[0.4em] text-slate-500">
                Local PIN Verification
              </label>
              <div class="flex gap-1">${pips}</div>
            </div>
            <input
              name="s_key"
              type="password"
              inputmode="numeric"
              pattern="[0-9]*"
              placeholder="Secret PIN"
              autocomplete="one-time-code"
              autocorrect="off"
              autocapitalize="off"
              spellcheck="false"
              class="glass-input w-full text-center text-4xl tracking-[0.6em] font-mono py-6 bg-slate-950/40 border-white/10 focus:border-primary/40"
              data-autofocus
            >
            ${errorBlock}
          </div>

          <button
            type="submit"
            class="btn-primary w-full py-5 text-xl shadow-[0_20px_40px_-10px_rgba(0,255,163,0.3)]"
          >
            Reconnect Chat
          </button>
        </form>

        <button
          data-action="clear-session"
          class="text-[10px] font-black uppercase tracking-[0.4em] text-slate-600 hover:text-white transition-colors flex items-center gap-2 mx-auto py-2 px-4 rounded-xl hover:bg-white/5"
        >
          ${icon("trash_2", "size-3")} Erase All Session Data
        </button>
      </div>
    </div>
  `;
}

// ------------------------------- :expired -------------------------------

function renderExpired(): string {
  return `
    <div class="fixed inset-0 z-50 flex items-center justify-center p-6 bg-slate-950/80 backdrop-blur-2xl">
      <div class="glass-card-premium max-w-md w-full text-center border-danger/20 animate-in p-8 sm:p-10">
        <div class="size-20 rounded-3xl bg-danger/10 flex items-center justify-center mx-auto mb-8 border border-danger/20">
          ${icon("trash_2", "size-10 text-danger")}
        </div>

        <h3 class="text-3xl font-extrabold text-white font-display mb-4">Chat Ended</h3>

        <p class="text-slate-400 font-medium leading-relaxed mb-10">
          The chat session has been permanently closed.
          All messages have been erased and cannot be recovered.
        </p>

        <button
          data-action="back-to-entry"
          class="btn-primary w-full py-4 text-lg"
        >
          Start New Chat
        </button>
      </div>
    </div>
  `;
}
