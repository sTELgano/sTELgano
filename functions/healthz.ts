// SPDX-License-Identifier: AGPL-3.0-only
//
// GET /healthz — used by deploy smoke tests, not by users.

import type { Env } from "../src/env";

export const onRequestGet: PagesFunction<Env> = () => {
  return new Response("ok", { headers: { "content-type": "text/plain" } });
};
