// SPDX-FileCopyrightText: 2026 sTELgano Contributors
// SPDX-License-Identifier: AGPL-3.0-only

// sTELgano app.js — LiveSocket bootstrap
// All chat crypto and hooks are in assets/js/hooks/chat.js

import "phoenix_html"
import { Socket } from "phoenix"
import { LiveSocket } from "phoenix_live_view"
import { hooks as colocatedHooks } from "phoenix-colocated/stelgano"
import topbar from "../vendor/topbar"

import {
  AnonChat,
  AutoResize,
  IntersectionReader,
  ThemeToggle,
  PhoneGenerator,
} from "./hooks/chat.js"

const csrfToken = document.querySelector("meta[name='csrf-token']").getAttribute("content")

const liveSocket = new LiveSocket("/live", Socket, {
  longPollFallbackMs: 2500,
  params: { _csrf_token: csrfToken },
  hooks: {
    ...colocatedHooks,
    AnonChat,
    AutoResize,
    IntersectionReader,
    ThemeToggle,
    PhoneGenerator,
  },
})

topbar.config({ barColors: { 0: "#10B981" }, shadowColor: "rgba(0, 0, 0, .3)" })
window.addEventListener("phx:page-loading-start", _info => topbar.show(300))
window.addEventListener("phx:page-loading-stop", _info => topbar.hide())

liveSocket.connect()
window.liveSocket = liveSocket

if (process.env.NODE_ENV === "development") {
  window.addEventListener("phx:live_reload:attached", ({ detail: reloader }) => {
    reloader.enableServerLogs()
    let keyDown
    window.addEventListener("keydown", e => keyDown = e.key)
    window.addEventListener("keyup", _e => keyDown = null)
    window.addEventListener("click", e => {
      if (keyDown === "c") {
        e.preventDefault()
        e.stopImmediatePropagation()
        reloader.openEditorAtCaller(e.target)
      } else if (keyDown === "d") {
        e.preventDefault()
        e.stopImmediatePropagation()
        reloader.openEditorAtDef(e.target)
      }
    }, true)
    window.liveReloader = reloader
  })
}
