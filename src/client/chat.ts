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

import { ChatState, COUNTRY_DATA, type Config, type PlainMessage, type State } from "./state";

const root = document.getElementById("chat-root")!;

function renderWordmark(): string {
  return `
    <div class="wordmark text-lg sm:text-2xl leading-tight group">
      <span class="wm-symbol">s</span><span class="wm-accent">TEL</span><span class="text-white">gano</span>
    </div>
  `;
}
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

// Track the previous state kind so entrance animations only fire when
// transitioning between states, not on intra-state updates (e.g. eye
// toggle, typing indicator, copiedNumber). Without this every
// root.innerHTML swap restarts all animate-in CSS animations and looks
// like a full page reload to the user.
let prevKind: string | null = null;
let prevState: State | null = null;

state.onStateChange((s) => {
  // 1. THE FAST PATHS — surgical DOM updates to avoid blinking on minor changes
  if (prevState) {
    // Global: surgical overlay updates (Terms, etc)
    if (JSON.stringify(s.overlay) !== JSON.stringify(prevState.overlay)) {
      const existing = document.getElementById("info-overlay");
      if (s.overlay) {
        if (existing) {
          const content = existing.querySelector(".custom-scrollbar");
          if (content) {
            content.innerHTML = s.overlay.loading
              ? `<div class="flex flex-col items-center justify-center h-64 space-y-4">
                  <div class="size-12 rounded-full border-2 border-primary/10 border-t-primary animate-spin"></div>
                  <p class="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">Loading Protocol...</p>
                </div>`
              : `<div class="informational-content">${s.overlay.html}</div>`;
          }
          const title = existing.querySelector("h3");
          if (title) title.textContent = s.overlay.title;
        } else {
          root.insertAdjacentHTML("beforeend", renderOverlay(s));
        }
      } else if (existing) {
        existing.remove();
      }

      // If ONLY the overlay changed and it's not a kind transition, we can skip the rest
      if (
        s.kind === prevState.kind &&
        JSON.stringify({ ...s, overlay: null }) === JSON.stringify({ ...prevState, overlay: null })
      ) {
        prevState = JSON.parse(JSON.stringify(s)) as State;
        return;
      }
    }
  }

  if (prevState && prevState.kind === s.kind) {
    // ENTRY: surgical updates
    if (s.kind === "entry") {
      const ps = prevState as Extract<State, { kind: "entry" }>;

      // Update phone visibility (eye toggle)
      if (s.phoneVisible !== ps.phoneVisible) {
        const input = document.getElementById("phone-input") as HTMLInputElement;
        if (input) {
          input.type = s.phoneVisible ? "text" : "password";
          if (s.phoneVisible) {
            input.classList.remove("tracking-widest");
            input.classList.add("tracking-wider");
          } else {
            input.classList.remove("tracking-wider");
            input.classList.add("tracking-widest");
          }
        }
        const btn = document.getElementById("phone-toggle-btn");
        if (btn) btn.innerHTML = icon(s.phoneVisible ? "eye_off" : "eye", "size-5 sm:size-6");
      }

      // Update Error container
      if (s.error !== ps.error || s.attemptsRemaining !== ps.attemptsRemaining) {
        const container = document.getElementById("entry-error-container");
        if (container) {
          container.innerHTML = s.error ? renderEntryErrorBlock(s) : "";
        }
      }

      // Update Submit Button State
      const canSubmit = s.phoneValid && s.pin.length >= 4;
      const prevCanSubmit = ps.phoneValid && ps.pin.length >= 4;
      if (canSubmit !== prevCanSubmit) {
        const btn = root.querySelector("button[type='submit']") as HTMLButtonElement;
        if (btn) btn.disabled = !canSubmit;
      }

      // Surgical updates for country picker and search
      if (
        s.showCountries !== ps.showCountries ||
        s.searchQuery !== ps.searchQuery ||
        s.countryIso !== ps.countryIso
      ) {
        const wrapper = document.getElementById("country-dropdown-wrapper");
        if (wrapper) wrapper.innerHTML = renderCountryPicker(s);

        const trigger = document.getElementById("country-search-trigger") as HTMLInputElement;
        if (trigger) {
          const currentCountry =
            COUNTRY_DATA.find((c) => c.iso === s.countryIso) ?? COUNTRY_DATA[0]!;
          // Use value instead of innerText, avoids selection loss
          if (trigger.value !== (s.showCountries ? s.searchQuery : currentCountry.name)) {
            trigger.value = s.showCountries ? s.searchQuery : currentCountry.name;
          }

          const flagEl = document.getElementById("country-picker-flag");
          if (flagEl && flagEl.innerHTML !== currentCountry.flag) {
            flagEl.innerHTML = currentCountry.flag;
          }
        }
      }

      // Update phone field (formatting + validation feedback)
      if (s.phone !== ps.phone || s.phoneValid !== ps.phoneValid) {
        const input = document.getElementById("phone-input") as HTMLInputElement;
        if (input) {
          if (input.value !== s.phone) {
            const start = input.selectionStart;
            const end = input.selectionEnd;
            const oldVal = input.value;
            input.value = s.phone;
            if (start !== null && end !== null) {
              try {
                const newStart = getAdjustedCursor(oldVal, s.phone, start);
                const newEnd = getAdjustedCursor(oldVal, s.phone, end);
                input.setSelectionRange(newStart, newEnd);
              } catch (_e) {}
            }
          }
          if (s.phoneValid) {
            input.classList.remove("border-white/10", "focus:border-primary/50");
            input.classList.add("border-primary/50", "ring-1", "ring-primary/20");
          } else if (s.phone.length > 5) {
            input.classList.remove("border-primary/50", "ring-1", "ring-primary/20");
            input.classList.add("border-white/10", "focus:border-primary/50");
          }
        }
      }

      // Update PIN fields surgically if they differ from DOM (prevents wiping)
      if (s.pin !== ps.pin) {
        const input = root.querySelector<HTMLInputElement>("input[name='s_key']");
        if (input && input.value !== s.pin) input.value = s.pin;
      }
      // Update phone visibility (eye toggle)
      if (s.phoneVisible !== ps.phoneVisible) {
        const input = document.getElementById("phone-input") as HTMLInputElement;
        if (input) {
          input.type = s.phoneVisible ? "text" : "password";
        }
        const eyeBtn = root.querySelector("button[data-action='toggle-phone-visibility']");
        if (eyeBtn) {
          eyeBtn.innerHTML = icon(s.phoneVisible ? "eye_off" : "eye", "size-5");
        }
      }

      // Update generation state (spinning icon)
      if (s.generating !== ps.generating) {
        const genBtn = root.querySelector(
          "button[data-action='generate-new']",
        ) as HTMLButtonElement | null;
        if (genBtn) {
          genBtn.disabled = s.generating;
          genBtn.innerHTML = icon("refresh_cw", `size-5 ${s.generating ? "animate-spin" : ""}`);
          genBtn.classList.toggle("opacity-20", s.generating);
        }
      }

      const entriesMatch =
        s.phoneLocked === ps.phoneLocked && s.onboardingStep === ps.onboardingStep;

      if (entriesMatch) {
        prevState = JSON.parse(JSON.stringify(s)) as State;
        return;
      }
    }

    // NEW_CHANNEL: surgical update
    if (s.kind === "new_channel") {
      const ps = prevState as Extract<State, { kind: "new_channel" }>;

      // Update Confirm PIN field
      if (s.confirmPin !== ps.confirmPin) {
        const input = root.querySelector<HTMLInputElement>("input[name='nc_key_confirm']");
        if (input && input.value !== s.confirmPin) input.value = s.confirmPin;
      }

      // Update checkboxes
      if (s.acceptedTerms !== ps.acceptedTerms) {
        const cb = root.querySelector<HTMLInputElement>("input[name='nc_accept_terms']");
        if (cb) cb.checked = s.acceptedTerms;
      }
      if (s.confirmedSaved !== ps.confirmedSaved) {
        const cb = root.querySelector<HTMLInputElement>("input[name='nc_confirm_saved']");
        if (cb) cb.checked = s.confirmedSaved;
      }

      // Update submit button disabled status
      const canSubmit =
        s.confirmPin.length >= 4 && s.pin === s.confirmPin && s.acceptedTerms && s.confirmedSaved;
      const prevCanSubmit =
        ps.confirmPin.length >= 4 &&
        ps.pin === ps.confirmPin &&
        ps.acceptedTerms &&
        ps.confirmedSaved;
      if (canSubmit !== prevCanSubmit) {
        const btn = root.querySelector(
          "button[data-action='continue-free']",
        ) as HTMLButtonElement | null;
        if (btn) btn.disabled = !canSubmit;
      }

      // Only re-render if major UI structural states changed
      if (s.paymentError === ps.paymentError && s.paymentLoading === ps.paymentLoading) {
        prevState = JSON.parse(JSON.stringify(s)) as State;
        return;
      }
    }

    // DERIVING: surgical update of percentage
    if (s.kind === "deriving") {
      const pctEl = document.getElementById("derivation-progress");
      if (pctEl) {
        pctEl.textContent = `${Math.round(s.progress)}%`;
        prevState = JSON.parse(JSON.stringify(s)) as State;
        return;
      }
    }

    // CHAT: surgical updates
    if (s.kind === "chat") {
      const ps = prevState as Extract<State, { kind: "chat" }>;

      // Update message buffer (if new message or edit)
      if (JSON.stringify(s.current) !== JSON.stringify(ps.current)) {
        const buffer = document.getElementById("message-buffer");
        if (buffer) {
          buffer.innerHTML = s.current
            ? renderMessageBubble(s.current, s.senderHash)
            : renderEmptyBuffer();
          // Scroll to bottom if it's a new message
          if (!ps.current || s.current?.id !== ps.current.id) {
            requestAnimationFrame(() => {
              buffer.scrollTop = buffer.scrollHeight;
            });
          }
        }
      }

      // Update interaction zone (input vs waiting area vs typing)
      const inputChanged =
        s.editing !== ps.editing ||
        s.counterpartyTyping !== ps.counterpartyTyping ||
        s.current?.senderHash !== ps.current?.senderHash ||
        s.current?.readAt !== ps.current?.readAt;

      if (inputChanged) {
        const zone = document.getElementById("interaction-zone");
        if (zone) {
          const canType = !s.current || s.current.senderHash !== s.senderHash;
          const html = s.editing
            ? renderInputArea({ editing: true, value: s.current?.plaintext ?? "" })
            : canType
              ? renderInputArea({ editing: false, value: "" })
              : renderWaitingArea(s.current, s.senderHash, s.counterpartyTyping);

          if (zone.innerHTML !== html) {
            zone.innerHTML = html;
          }
        }
      }

      // Check if any "Slow Path" properties changed. If they did, we fall through
      // to the full innerHTML wipe to ensure overlays (modals, errors) render.
      const needsSlowPath =
        s.paymentError !== ps.paymentError ||
        s.paymentLoading !== ps.paymentLoading ||
        s.ttlExpiresAt !== ps.ttlExpiresAt;

      // Surgical modal toggling
      if (s.confirmExpire !== ps.confirmExpire) {
        const modal = document.getElementById("destruction-modal");
        if (s.confirmExpire && !modal) {
          root.insertAdjacentHTML("beforeend", renderDestructionModal());
        } else if (!s.confirmExpire && modal) {
          modal.remove();
        }
      }

      if (!needsSlowPath) {
        prevState = JSON.parse(JSON.stringify(s)) as State;
        return;
      }
    }
  }

  // 2. THE SLOW PATH — full re-render when switching kinds or unhandled intra-state change

  const active = document.activeElement;
  const activeId = active?.id;
  const activeName = active instanceof HTMLInputElement ? active.name : null;
  let activeStart: number | null = null;
  let activeEnd: number | null = null;
  let oldActiveValue: string | null = null;

  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    try {
      if (typeof active.selectionStart === "number") {
        activeStart = active.selectionStart;
        activeEnd = active.selectionEnd;
        oldActiveValue = active.value;
      }
    } catch (_e) {}
  }

  const kindsChanged = !prevKind || s.kind !== prevKind;
  prevKind = s.kind;
  const oldPrevState = prevState;
  prevState = JSON.parse(JSON.stringify(s)) as State;

  // Fast-path: Entry state intra-updates (search filtering, etc)
  if (
    oldPrevState &&
    oldPrevState.kind === "entry" &&
    s.kind === "entry" &&
    s.showCountries === oldPrevState.showCountries
  ) {
    // Only search query changed? Update the list surgically.
    if (s.searchQuery !== oldPrevState.searchQuery) {
      const listContainer = root.querySelector("#country-list-container");
      if (listContainer) {
        console.log("[UI] Fast-path update: country-list");
        listContainer.innerHTML = renderCountryListItems(s);
        return;
      }
    }
  }

  console.log("[UI] Slow-path: Full render");
  root.innerHTML = render(s, kindsChanged);

  let focusRestored = false;
  let elToFocus: HTMLElement | null = null;
  if (activeId) elToFocus = root.querySelector(`#${activeId}`);
  else if (activeName) elToFocus = root.querySelector(`[name="${activeName}"]`);

  if (elToFocus) {
    if (
      (elToFocus instanceof HTMLInputElement || elToFocus instanceof HTMLTextAreaElement) &&
      activeStart !== null &&
      activeEnd !== null &&
      oldActiveValue !== null
    ) {
      let sStart = activeStart;
      let sEnd = activeEnd;
      if (elToFocus.value !== oldActiveValue && elToFocus.id === "phone-input") {
        sStart = getAdjustedCursor(oldActiveValue, elToFocus.value, activeStart);
        sEnd = getAdjustedCursor(oldActiveValue, elToFocus.value, activeEnd);
      }
      try {
        elToFocus.setSelectionRange(sStart, sEnd);
      } catch (_e) {}
    }

    elToFocus.focus();

    if (
      (elToFocus instanceof HTMLInputElement || elToFocus instanceof HTMLTextAreaElement) &&
      activeStart !== null &&
      activeEnd !== null &&
      oldActiveValue !== null
    ) {
      let sStart = activeStart;
      let sEnd = activeEnd;
      if (elToFocus.value !== oldActiveValue && elToFocus.id === "phone-input") {
        sStart = getAdjustedCursor(oldActiveValue, elToFocus.value, activeStart);
        sEnd = getAdjustedCursor(oldActiveValue, elToFocus.value, activeEnd);
      }
      requestAnimationFrame(() => {
        if (document.activeElement === elToFocus) {
          try {
            elToFocus.setSelectionRange(sStart, sEnd);
          } catch (_err) {}
        }
      });
    }
    focusRestored = true;
  }

  if (!focusRestored) {
    focusFirstField();
  }

  // Auto-focus logic: if showCountries just flipped true, make sure the input is focused
  if (s.kind === "entry" && s.showCountries) {
    const searchInput = root.querySelector<HTMLInputElement>("#country-search-trigger");
    if (searchInput && document.activeElement !== searchInput) {
      searchInput.focus();
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
    void state.submit();
  } else if (action === "submit-locked") {
    const pin = String(form.get("s_key") ?? "");
    void state.reauthenticate(pin);
  }
});

root.addEventListener("click", (e) => {
  // Hijack internal links to informational pages to prevent full page reloads.
  const anchor = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
  if (anchor && anchor.origin === window.location.origin && !anchor.hasAttribute("data-action")) {
    const path = anchor.getAttribute("href") || "";
    const infoPaths = ["/", "/terms", "/privacy", "/security", "/spec", "/pricing", "/blog"];
    if (infoPaths.includes(path)) {
      e.preventDefault();
      // Logo/Home click returns to entry without reload
      if (path === "/" && state.getState().kind !== "entry") {
        state.logout();
      } else {
        void state.openOverlay(path);
      }
      return;
    }
  }

  const target = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (!action) return;

  switch (action) {
    case "continue-free":
      void state.continueFree();
      break;
    case "close-overlay":
      state.closeOverlay();
      break;
    case "generate-new":
      console.log("[UI] Generate new number");
      void state.generateNewNumber();
      break;
    case "copy-phone": {
      const input = document.getElementById("phone-input") as HTMLInputElement;
      if (input) {
        void navigator.clipboard.writeText(input.value);
        target.innerHTML = icon("check", "size-5 text-primary");
        setTimeout(() => {
          target.innerHTML = icon("copy", "size-5");
        }, 2000);
      }
      break;
    }
    case "copy-phone-nc": {
      const s = state.getState();
      if (s.kind === "new_channel") {
        void navigator.clipboard.writeText(s.phone);
        target.innerHTML = icon("check", "size-6 text-primary");
        setTimeout(() => {
          target.innerHTML = icon("copy", "size-6");
        }, 2000);
      }
      break;
    }
    case "clear-session":
      console.log("[UI] Clear session");
      state.clearSession();
      break;
    case "toggle-countries":
      console.log("[UI] Toggle countries picker");
      state.toggleCountries();
      break;
    case "select-country": {
      const iso = target.dataset.iso;
      console.log("[UI] Select country:", iso);
      if (iso) state.setCountry(iso);
      break;
    }
    case "toggle-phone-visibility":
      state.togglePhoneVisible();
      break;
    case "onboarding-next": {
      const s = state.getState();
      if (s.kind === "entry") {
        const step = s.onboardingStep ?? 0;
        state.setOnboardingStep(step >= 2 ? null : step + 1);
      }
      break;
    }
    case "onboarding-skip":
      state.setOnboardingStep(null);
      break;
    case "go-home":
      if (state.getState().kind !== "entry") {
        state.logout();
      } else {
        void state.openOverlay("/");
      }
      break;
    case "open-terms":
      void state.openOverlay("/terms");
      break;
    case "open-privacy":
      void state.openOverlay("/privacy");
      break;
    case "open-spec":
      void state.openOverlay("/spec");
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
    case "back-to-entry":
      state.logout();
      break;
    case "extend-room":
      void state.initiatePayment();
      break;
  }
});

// Textarea char counter + typing indicator + auto-resize.
root.addEventListener(
  "input",
  (e) => {
    const target = e.target as HTMLElement;
    if (target instanceof HTMLTextAreaElement && target.id === "chat-textarea") {
      state.typing();
      updateCharCount(target.value.length);
      autoResize(target);
    } else if (target instanceof HTMLInputElement && target.name === "s_num") {
      state.setPhone(target.value);
    } else if (target instanceof HTMLInputElement && target.name === "s_key") {
      state.setPin(target.value);
    } else if (target instanceof HTMLInputElement && target.name === "nc_key_confirm") {
      state.setNewChannelConfirmPin(target.value);
    } else if (target instanceof HTMLInputElement && target.name === "nc_accept_terms") {
      state.setNewChannelAcceptedTerms(target.checked);
    } else if (target instanceof HTMLInputElement && target.name === "nc_confirm_saved") {
      state.setNewChannelConfirmedSaved(target.checked);
    } else if (target instanceof HTMLInputElement && target.id === "country-search-trigger") {
      state.setSearchQuery(target.value);
    }
  },
  true,
);

// Focus-based opening for the country search
root.addEventListener("focusin", (e) => {
  const target = e.target as HTMLElement;
  if (target.id === "country-search-trigger") {
    state.openCountries();
  }
});

// Click-based opening (backup for focus)
root.addEventListener("mousedown", (e) => {
  const target = e.target as HTMLElement;
  if (target.id === "country-search-trigger") {
    state.openCountries();
  }
});

// Click-outside to close custom dropdowns
document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const inDoc = document.contains(target);

  const s = state.getState();
  if (s.kind === "entry" && s.showCountries) {
    const inContainer = !!target.closest("#country-picker-container");

    if (inDoc && !inContainer) {
      state.closeCountries();
    }
  }
});

// Close modals on Escape.
root.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement;
  if (!(target instanceof HTMLTextAreaElement) || target.id !== "chat-textarea") return;
  if (e.key === "Escape") {
    const s = state.getState();
    if (s.kind === "chat" && s.editing) state.cancelEdit();
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

function getAdjustedCursor(oldVal: string, newVal: string, cursor: number): number {
  let charsBefore = 0;
  for (let i = 0; i < cursor; i++) {
    if (/\d|\+/.test(oldVal.charAt(i))) charsBefore++;
  }
  let newCursor = 0;
  let seen = 0;
  while (newCursor < newVal.length && seen < charsBefore) {
    if (/\d|\+/.test(newVal.charAt(newCursor))) seen++;
    newCursor++;
  }
  return newCursor;
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

// -----------------------------------------------------------------------------
// Render — one function per state kind
// -----------------------------------------------------------------------------

function render(s: State, animate: boolean): string {
  let html = "";
  switch (s.kind) {
    case "entry":
      html = renderEntry(s);
      break;
    case "deriving":
      html = renderDeriving(s, animate);
      break;
    case "new_channel":
      html = renderNewChannel(s);
      break;
    case "connecting":
      html = renderConnecting();
      break;
    case "chat":
      html = renderChat(s);
      break;
    case "locked":
      html = renderLocked(s);
      break;
    case "expired":
      html = renderExpired();
      break;
  }
  return html + renderOverlay(s);
}

function renderOverlay(s: State): string {
  if (!s.overlay) return "";

  const content = s.overlay.loading
    ? `
      <div class="flex flex-col items-center justify-center h-64 space-y-4">
        <div class="size-12 rounded-full border-2 border-primary/10 border-t-primary animate-spin"></div>
        <p class="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">Loading Protocol...</p>
      </div>`
    : `<div class="informational-content">${s.overlay.html}</div>`;

  return `
    <div id="info-overlay" class="fixed inset-0 z-[200] flex items-center justify-center p-4 sm:p-6 bg-slate-950/80 backdrop-blur-3xl animate-in duration-300">
      <div class="w-full max-w-4xl h-full max-h-[90vh] glass-card-premium flex flex-col overflow-hidden animate-in zoom-in-95 duration-300 shadow-[0_0_100px_rgba(0,0,0,0.8)]">
        <!-- Overlay Header -->
        <div class="flex items-center justify-between p-6 sm:px-10 border-b border-white/10 shrink-0 bg-slate-950/40">
          <div class="space-y-1">
            <h3 class="text-xl sm:text-2xl font-extrabold text-white font-display tracking-tight">${s.overlay.title}</h3>
            <p class="text-[9px] font-bold uppercase tracking-[0.3em] text-primary/60">System Information Overlay</p>
          </div>
          <button
            data-action="close-overlay"
            class="size-10 sm:size-12 rounded-xl bg-white/5 text-slate-400 hover:text-white hover:bg-white/10 transition-all flex items-center justify-center border border-white/5"
          >
            ${icon("x", "size-5 sm:size-6")}
          </button>
        </div>
        
        <!-- Overlay Content -->
        <div class="flex-1 overflow-y-auto p-6 sm:p-10 custom-scrollbar overscroll-contain">
          ${content}
        </div>
        
        <!-- Overlay Footer -->
        <div class="p-6 border-t border-white/10 text-center shrink-0 bg-slate-950/40">
           <button
            data-action="close-overlay"
            class="btn-secondary py-3 px-8 text-sm uppercase tracking-widest font-black"
          >
            Back to Channel
          </button>
        </div>
      </div>
    </div>
  `;
}

// -------------------------------- :entry --------------------------------

function renderCountryListItems(s: Extract<State, { kind: "entry" }>): string {
  const query = s.searchQuery.toLowerCase();
  const filtered = COUNTRY_DATA.filter(
    (c) =>
      c.name.toLowerCase().includes(query) ||
      c.dialCode.includes(query) ||
      c.iso.toLowerCase().includes(query),
  );

  if (filtered.length === 0) {
    return `<div class="p-8 text-center text-slate-500 text-xs font-medium">No countries found</div>`;
  }

  return filtered
    .map(
      (c) => `
      <button
        type="button"
        data-action="select-country"
        data-iso="${c.iso}"
        class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left hover:bg-primary/10 transition-colors group"
      >
        <span class="text-xl flex-none">${c.flag}</span>
        <div class="flex-1 min-w-0">
          <div class="text-xs font-bold text-white truncate group-hover:text-primary transition-colors">
            ${escapeHtml(c.name)}
          </div>
          <div class="text-[10px] text-slate-500 font-medium">
            ${c.dialCode}
          </div>
        </div>
        ${c.iso === s.countryIso ? `<div class="text-primary">${icon("check", "size-4")}</div>` : ""}
      </button>
    `,
    )
    .join("");
}

function renderCountryPicker(s: Extract<State, { kind: "entry" }>): string {
  if (!s.showCountries) return "";

  return `
    <div class="absolute top-full left-0 w-full bg-slate-900/90 backdrop-blur-3xl border border-white/10 rounded-lg shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
      <!-- Country List -->
      <div id="country-list-container" class="max-h-64 overflow-y-auto custom-scrollbar p-1">
        ${renderCountryListItems(s)}
      </div>
    </div>
  `;
}

function renderEntry(s: Extract<State, { kind: "entry" }>): string {
  if (s.onboardingStep !== null) {
    return renderOnboarding(s.onboardingStep);
  }

  const phoneType = s.phoneVisible ? "text" : "password";
  const phoneLockedOpacity = s.phoneLocked ? "opacity-60" : "";
  const phoneReadonly = s.phoneLocked ? "readonly" : "";
  const phoneAutofocus = s.phoneLocked ? "" : "data-autofocus";
  const pinAutofocus = s.phoneLocked ? "data-autofocus" : "";

  const currentCountry = COUNTRY_DATA.find((c) => c.iso === s.countryIso) ?? COUNTRY_DATA[0]!;

  return `
    <div class="flex flex-col h-full w-full overflow-hidden">
      <!-- Universal Header -->
      <div class="px-4 sm:px-6 py-3 sm:py-5 flex items-center justify-between border-b border-white/10 bg-slate-900/80 backdrop-blur-3xl shrink-0">
        <a href="/" data-action="go-home" class="group transition-transform active:scale-95">
          ${renderWordmark()}
        </a>
        <div class="flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-slate-500 text-[10px] font-bold uppercase tracking-[0.2em]">
          ${icon("lock", "size-3")} Secure Link
        </div>
      </div>

      <div class="flex-1 overflow-y-auto px-6 py-8 sm:py-16">
        <div class="w-full max-w-xl mx-auto space-y-10 sm:space-y-12">
          <!-- Branding -->
          <div class="text-center space-y-4">
            <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-[10px] font-bold uppercase tracking-[0.2em] mb-4 shadow-[0_0_15px_rgba(0,255,163,0.1)]">
              ${icon("ban", "size-3")} Private Instance
            </div>
            <h1 class="text-4xl sm:text-6xl font-extrabold tracking-tighter text-white font-display leading-[0.9]">
              Open <span class="text-gradient">Channel.</span>
            </h1>
            <p class="text-slate-500 font-medium text-base sm:text-lg leading-relaxed">
              Derive a one-time identity and join your private channel.
            </p>
          </div>

        <div class="glass-card-premium p-6 sm:p-10">
          <div class="p-4 sm:p-6 space-y-10">
            <div id="entry-error-container">
              ${s.error ? renderEntryErrorBlock(s) : ""}
            </div>

            <form data-action="submit-entry" autocomplete="off" class="space-y-8 sm:space-y-10">
              <!-- Integrated Identity Cluster -->
              <div class="space-y-4">
                <div class="flex items-center justify-between px-1">
                  <label class="text-[9px] sm:text-[10px] font-bold uppercase tracking-[0.3em] text-slate-500">
                    One-Time Identifier
                  </label>
                  <button type="button" data-action="onboarding-next" class="text-[9px] text-primary/60 hover:text-primary transition-colors font-bold uppercase tracking-widest">
                    Quick Start &rsaquo;
                  </button>
                </div>
                
                <div class="flex flex-col gap-3">
                  <!-- Searchable Country Selector -->
                  <div class="relative w-full group" id="country-picker-container" style="z-index: 50;">
                    <div id="country-picker-flag" class="absolute inset-y-0 left-4 flex items-center pointer-events-none text-lg">
                      ${currentCountry.flag}
                    </div>
                    <input
                      type="text"
                      id="country-search-trigger"
                      class="glass-input w-full !pl-12 !pr-10 font-bold bg-slate-950/40 !text-sm transition-all focus:bg-slate-900/60 !h-full ${phoneLockedOpacity}"
                      value="${s.showCountries ? s.searchQuery : currentCountry.name}"
                      placeholder="Select Region..."
                      autocomplete="off"
                      ${phoneReadonly}
                    />
                    <div class="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-slate-500 group-hover:text-primary transition-colors">
                      ${icon("chevron_down", "size-4")}
                    </div>

                    <div id="country-dropdown-wrapper" class="absolute w-full mt-2 z-[100]">
                      ${renderCountryPicker(s)}
                    </div>
                  </div>

                  <!-- Integrated Phone Input -->
                  <div class="relative flex-1 group">
                      <input
                        id="phone-input"
                        name="s_num"
                        type="${phoneType}"
                        class="glass-input w-full !pr-32 font-mono !text-lg font-bold bg-slate-950/40 ${phoneLockedOpacity} !h-full ${s.phoneValid ? "border-primary/50 ring-1 ring-primary/20" : ""}"
                        value="${escapeHtml(s.phone)}"
                        ${phoneReadonly}
                        placeholder="Enter number..."
                        inputmode="tel"
                        ${phoneAutofocus}
                      >
                    <div class="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1 z-20">
                      ${
                        s.phoneLocked
                          ? `
                      <button
                        type="button"
                        data-action="clear-session"
                        class="p-2 rounded-xl text-red-500 hover:text-red-400 focus:outline-none transition-all hover:bg-red-500/10"
                        title="Cancel Handoff and Start Over"
                      >
                        ${icon("x", "size-5")}
                      </button>
                      <button
                        type="button"
                        data-action="copy-phone"
                        class="p-2 rounded-xl text-slate-500 hover:text-white transition-all"
                        title="Copy number"
                      >
                        ${icon("copy", "size-5")}
                      </button>
                      `
                          : `
                      <button
                        type="button"
                        data-action="generate-new"
                        ${s.generating ? "disabled" : ""}
                        class="p-2 rounded-xl text-slate-500 hover:text-primary transition-all ${s.generating ? "opacity-20" : ""}"
                        title="Generate regional identity"
                      >
                        ${icon("refresh_cw", `size-5 ${s.generating ? "animate-spin" : ""}`)}
                      </button>
                      <button
                        type="button"
                        data-action="copy-phone"
                        class="p-2 rounded-xl text-slate-500 hover:text-white transition-all"
                        title="Copy number"
                      >
                        ${icon("copy", "size-5")}
                      </button>
                      `
                      }
                      <button
                        type="button"
                        data-action="toggle-phone-visibility"
                        class="p-2 rounded-xl text-slate-500 hover:text-white transition-all"
                      >
                        ${icon(s.phoneVisible ? "eye_off" : "eye", "size-5")}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <!-- PIN Input -->
              <div class="space-y-3">
                <label class="text-[9px] font-bold uppercase tracking-[0.2em] text-slate-500 ml-1">
                  Private PIN
                </label>
                <input
                  name="s_key"
                  type="password"
                  inputmode="numeric"
                  pattern="[0-9]*"
                  placeholder="Enter 4-6 digits"
                  autocomplete="current-password"
                  class="glass-input w-full text-center !text-xl tracking-[0.4em] font-mono !py-4 bg-slate-950/40"
                  value="${escapeHtml(s.pin)}"
                  ${pinAutofocus}
                >
                <p class="text-[10px] text-slate-500 text-center font-medium leading-relaxed px-2 italic">
                  PIN is never saved on servers. If forgotten, identity is lost.
                </p>
              </div>

              <button
                type="submit"
                class="btn-primary w-full py-5 text-xl group shadow-[0_20px_40px_-10px_rgba(0,255,163,0.3)]"
                ${!(s.phoneValid && s.pin.length >= 4) ? "disabled" : ""}
              >
                Open Secure Channel
                ${icon("zap", "size-6 group-hover:scale-125 transition-transform")}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderOnboarding(step: number): string {
  const steps = [
    {
      title: "Server Blindness",
      text: "sTELgano never sees your messages, PIN, or real identity. All encryption happens locally on your device.",
      icon: "shield_check",
      color: "text-primary",
    },
    {
      title: "One-Time Identification",
      text: "Your 'Secret Number' is a transient ID. Treat it like a burner phone — once you lose it, the channel is gone.",
      icon: "zap",
      color: "text-amber-400",
    },
    {
      title: "No Recovery Possible",
      text: "Because we store nothing, we cannot reset your PIN or recover your number. You are the sole custodian.",
      icon: "ban",
      color: "text-red-400",
    },
  ];

  const s = steps[step]!;

  return `
    <div class="flex flex-col items-center justify-center h-full p-6 animate-in fade-in slide-in-from-bottom-5">
      <div class="w-full max-w-sm text-center space-y-12">
        <div class="size-24 sm:size-32 rounded-3xl bg-white/5 border border-white/10 mx-auto flex items-center justify-center glow-primary">
          ${icon(s.icon, `size-12 sm:size-16 ${s.color}`)}
        </div>
        
        <div class="space-y-4">
          <h2 class="text-3xl sm:text-4xl font-black tracking-tight text-white font-display">${s.title}</h2>
          <p class="text-slate-400 text-base sm:text-lg leading-relaxed font-medium">
            ${s.text}
          </p>
        </div>

        <div class="flex flex-col gap-4">
          <button type="button" data-action="onboarding-next" class="btn-primary w-full py-5 text-lg">
            ${step === 2 ? "Understood, Proceed" : "Next Protocol"}
          </button>
          <button type="button" data-action="onboarding-skip" class="text-xs font-black uppercase tracking-[0.3em] text-slate-600 hover:text-white transition-colors">
            Skip Onboarding
          </button>
        </div>

        <div class="flex justify-center gap-2">
          ${[0, 1, 2].map((i) => `<div class="size-1.5 rounded-full ${i === step ? "bg-primary" : "bg-white/10"}"></div>`).join("")}
        </div>
      </div>
    </div>
  `;
}

// ------------------------------ :deriving -------------------------------

function renderDeriving(s: Extract<State, { kind: "deriving" }>, animate = true): string {
  const pct = Math.round(s.progress);
  const a = animate ? " animate-in" : "";
  return `
    <div class="flex flex-col items-center justify-center h-full p-6${a}">
      <div class="w-full max-w-sm text-center space-y-16">
        <div class="relative size-48 mx-auto">
          <div class="absolute inset-0 rounded-full border-2 border-primary/5 border-t-primary animate-spin duration-1000"></div>
          <div class="absolute inset-4 rounded-full border-2 border-primary/5 border-r-primary animate-spin-reverse duration-2000"></div>
          <div class="absolute inset-8 rounded-full border-2 border-primary/5 border-l-primary animate-spin duration-3000"></div>
          <div class="absolute inset-0 flex items-center justify-center">
            <div class="size-24 rounded-full bg-slate-900 border border-white/5 flex items-center justify-center shadow-2xl">
              <span id="derivation-progress" class="font-mono font-black text-primary text-xl">${pct}%</span>
            </div>
          </div>
        </div>

        <div class="space-y-6">
          <h3 class="text-4xl font-extrabold text-white font-display tracking-tight uppercase">
            Securing <span class="text-gradient">Channel.</span>
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
  const canSubmit =
    s.confirmPin.length >= 4 && s.pin === s.confirmPin && s.acceptedTerms && s.confirmedSaved;

  const errorBanner = s.paymentError
    ? `
      <div class="p-4 rounded-2xl bg-danger/5 border border-danger/20 flex gap-3 items-start animate-in mb-6">
        ${icon("alert_circle", "size-5 text-danger shrink-0 mt-0.5")}
        <p class="text-sm font-medium text-danger">${escapeHtml(s.paymentError)}</p>
      </div>`
    : "";

  return `
    <div class="flex flex-col h-full w-full overflow-hidden">
      <!-- Universal Header -->
      <div class="px-4 sm:px-6 py-3 sm:py-5 flex items-center justify-between border-b border-white/10 bg-slate-900/80 backdrop-blur-3xl shrink-0">
        <a href="/" data-action="go-home" class="group transition-transform active:scale-95">
          ${renderWordmark()}
        </a>
      </div>

      <div class="flex-1 overflow-y-auto px-6 py-8 sm:py-16 animate-in">
        <div class="w-full max-w-xl mx-auto space-y-10 sm:space-y-12">
          <div class="text-center space-y-4">
            <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-[10px] font-bold uppercase tracking-[0.2em] shadow-[0_0_15px_rgba(0,255,163,0.1)] mb-4">
              ${icon("sparkles", "size-3")} New Channel Detected
            </div>
            <h2 class="text-4xl sm:text-6xl font-extrabold text-white font-display tracking-tight leading-[0.9]">
              This is a <span class="text-gradient">new channel.</span>
            </h2>
            <p class="text-slate-500 font-medium text-base sm:text-lg leading-relaxed max-w-sm mx-auto">
              Please finalize setup to initialize your connection.
            </p>
          </div>

          <div class="glass-card-premium p-6 sm:p-10">
            ${errorBanner}

            <!-- PIN Confirmation + Checkboxes -->
            <div class="space-y-8 sm:space-y-10">
              <div class="space-y-4">
                <label class="text-[9px] font-bold uppercase tracking-[0.2em] text-slate-500 ml-1">
                  Confirm PIN
                </label>
                <input
                  name="nc_key_confirm"
                  type="password"
                  inputmode="numeric"
                  pattern="[0-9]*"
                  placeholder="Repeat PIN to confirm"
                  autocomplete="new-password"
                  class="glass-input w-full text-center !text-xl tracking-[0.4em] font-mono !py-4 bg-slate-950/40"
                  value="${escapeHtml(s.confirmPin)}"
                  data-autofocus
                >
              </div>

              <!-- Display Generated Number Prominently -->
              <div class="p-6 rounded-2xl bg-slate-950/60 border border-white/5 space-y-3 text-center mb-4">
                <label class="text-[9px] font-bold uppercase tracking-[0.2em] text-slate-500">
                  Your Secure Number
                </label>
                <div class="flex items-center justify-center gap-4">
                  <div class="text-3xl sm:text-4xl font-mono font-black text-white tracking-tight">
                    ${escapeHtml(s.phone)}
                  </div>
                  <button
                    type="button"
                    data-action="copy-phone-nc"
                    class="p-3 rounded-xl bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition-all border border-white/5"
                    title="Copy number"
                  >
                    ${icon("copy", "size-6")}
                  </button>
                </div>
              </div>

              <div class="space-y-4 pt-4 border-t border-white/5">
                <label class="flex items-start gap-3 cursor-pointer group">
                  <input type="checkbox" name="nc_accept_terms" class="mt-1 size-4 rounded bg-slate-950 border-white/10 text-primary focus:ring-primary/40 ring-offset-slate-900" ${s.acceptedTerms ? "checked" : ""}>
                  <span class="text-xs text-slate-400 leading-relaxed font-medium group-hover:text-slate-300 transition-colors">
                    I accept the <a data-action="open-terms" class="cursor-pointer text-primary hover:underline">Terms of Service</a> and Privacy Protocol.
                  </span>
                </label>
                <label class="flex items-start gap-3 cursor-pointer group text-left">
                  <input type="checkbox" name="nc_confirm_saved" class="mt-1 size-4 rounded bg-slate-950 border-white/10 text-primary focus:ring-primary/40 ring-offset-slate-900" ${s.confirmedSaved ? "checked" : ""}>
                  <span class="text-xs text-slate-400 leading-relaxed font-medium group-hover:text-slate-300 transition-colors">
                    I confirm that I have <span class="text-white font-bold underline decoration-primary/40">saved my number</span>. Access cannot be recovered later.
                  </span>
                </label>
              </div>

              <div class="space-y-4">
                <button
                  type="button"
                  data-action="continue-free"
                  class="btn-primary w-full py-5 text-xl group shadow-[0_20px_40px_-10px_rgba(0,255,163,0.3)]"
                  ${!canSubmit ? "disabled" : ""}
                >
                  Initialize Secure Channel
                  ${icon("arrow_right", "size-6 group-hover:translate-x-1 transition-transform")}
                </button>
                <p class="text-center text-slate-500 text-[10px] uppercase tracking-widest font-bold">
                  Channel defaults to ${s.freeTtlDays} days limit
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ----------------------------- :connecting ------------------------------

function renderConnecting(): string {
  return `
    <div class="flex flex-col items-center justify-center h-full p-6">
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

function renderTtlWarning(
  ttlExpiresAt: string | null,
  monetizationEnabled: boolean,
  paymentLoading: boolean,
): string {
  if (!ttlExpiresAt) return "";
  const remainingMs = new Date(ttlExpiresAt).getTime() - Date.now();
  if (remainingMs <= 0) return "";
  const remainingHours = remainingMs / 3_600_000;
  const days = Math.ceil(remainingHours / 24);

  const isDanger = remainingHours <= 48;
  const colorClass = isDanger
    ? "bg-danger/10 border-b border-danger/20 text-danger"
    : "bg-slate-900 border-b border-white/5 text-slate-400";

  const iconColor = isDanger ? "text-danger" : "text-primary";

  const btnText = paymentLoading ? "Redirecting..." : `Extend (+1 Year)`;
  const btnClass = paymentLoading
    ? "opacity-50 cursor-not-allowed"
    : "hover:text-white hover:bg-white/10 hover:border-white/30";

  const extendBtn = monetizationEnabled
    ? `<button data-action="extend-room" class="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-[10px] font-bold uppercase tracking-widest transition-all ${btnClass}" ${paymentLoading ? "disabled" : ""}>
         ${btnText}
       </button>`
    : "";

  return `
    <div class="px-4 sm:px-6 py-3 flex items-center justify-between text-xs font-bold ${colorClass}">
      <div class="flex items-center gap-3">
        ${icon("clock", `size-5 shrink-0 ${iconColor}`)}
        <span>${isDanger ? "Warning: " : ""}Channel expires in ${days} day${days === 1 ? "" : "s"}</span>
      </div>
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
    <div class="h-full w-full flex flex-col overflow-hidden">
      <!-- Navigation Header -->
      <div class="px-4 sm:px-6 py-3 sm:py-5 flex items-center justify-between border-b border-white/10 bg-slate-900/80 backdrop-blur-3xl sticky top-0 z-50">
        <div class="flex items-center gap-3 sm:gap-4">
          <a href="/" data-action="go-home" class="group transition-transform active:scale-95">
            ${renderWordmark()}
          </a>
          <div class="hidden sm:block h-6 w-px bg-white/20"></div>
          <span class="hidden lg:inline text-[9px] font-bold uppercase tracking-[0.3em] text-primary">
            CHANNEL SECURED
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
            title="Exit Channel"
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

      <!-- TTL expiry warning -->
      ${renderTtlWarning(s.ttlExpiresAt, serverConfig.monetizationEnabled, s.paymentLoading)}

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

      <div
        id="message-buffer"
        class="flex-1 overflow-y-auto px-4 sm:px-6 py-6 sm:py-10 space-y-6 sm:space-y-10 hide-scrollbar min-h-[150px]"
        role="log"
        aria-live="polite"
      >
        ${msgArea}
      </div>

      <!-- User Interaction Zone -->
      <div id="interaction-zone" class="p-4 sm:p-8 pb-10">
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
          class="flex-1 bg-transparent border-none text-white placeholder-slate-500 focus:ring-0 focus:outline-none py-2 sm:py-4 px-2 resize-none max-h-36 min-h-12 sm:min-h-14 hide-scrollbar text-base sm:text-lg leading-relaxed font-medium"
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
    <div id="destruction-modal" class="fixed inset-0 z-50 flex items-center justify-center p-6 bg-slate-950/80 backdrop-blur-3xl animate-in duration-300">
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
    <div class="fixed inset-0 z-100 flex flex-col items-center justify-start sm:justify-center overflow-y-auto p-6 py-12 bg-slate-950/95 backdrop-blur-3xl animate-in">
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
              type="text"
              inputmode="numeric"
              pattern="[0-9]*"
              placeholder="Secret PIN"
              autocomplete="one-time-code"
              autocorrect="off"
              autocapitalize="off"
              spellcheck="false"
              style="-webkit-text-security: disc;"
              class="glass-input w-full text-center !text-4xl tracking-[0.6em] font-mono !py-6 bg-slate-950/40 border-white/10 focus:border-primary/40"
              data-autofocus
            >
            ${errorBlock}
          </div>

          <button
            type="submit"
            class="btn-primary w-full py-5 text-xl shadow-[0_20px_40px_-10px_rgba(0,255,163,0.3)]"
          >
            Reconnect Channel
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

function renderEntryErrorBlock(s: Extract<State, { kind: "entry" }>): string {
  if (!s.error) return "";
  return `
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
  `;
}

// ------------------------------- :expired -------------------------------

function renderExpired(): string {
  return `
    <div class="fixed inset-0 z-50 flex flex-col items-center justify-start sm:justify-center overflow-y-auto p-6 py-12 bg-slate-950/80 backdrop-blur-2xl">
      <div class="glass-card-premium max-w-md w-full text-center border-danger/20 animate-in p-8 sm:p-10">
        <div class="size-20 rounded-3xl bg-danger/10 flex items-center justify-center mx-auto mb-8 border border-danger/20">
          ${icon("trash_2", "size-10 text-danger")}
        </div>

        <h3 class="text-3xl font-extrabold text-white font-display mb-4">Channel Closed</h3>

        <p class="text-slate-400 font-medium leading-relaxed mb-10">
          The secure channel has been permanently closed.
          All messages have been erased and cannot be recovered.
        </p>

        <button
          data-action="back-to-entry"
          class="btn-primary w-full py-4 text-lg"
        >
          Open Secure Channel
        </button>
      </div>
    </div>
  `;
}
