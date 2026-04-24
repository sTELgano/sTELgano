# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Repo do
  use Ecto.Repo,
    otp_app: :stelgano,
    adapter: Ecto.Adapters.Postgres
end
