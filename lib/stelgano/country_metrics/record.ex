# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.CountryMetrics.Record do
  @moduledoc """
  Ecto schema for one row of the `country_metrics` table.

  The primary key is `country_code` (ISO-3166 alpha-2, uppercase). Rows
  are upserted by `Stelgano.CountryMetrics.increment_free/1` and
  `increment_paid/1` — no user-facing changeset is necessary since this
  table is writable only by server-side code.
  """

  use Ecto.Schema

  @type t :: %__MODULE__{
          country_code: String.t() | nil,
          free_rooms: integer() | nil,
          paid_rooms: integer() | nil,
          updated_at: DateTime.t() | nil
        }

  @primary_key false
  schema "country_metrics" do
    field :country_code, :string, primary_key: true
    field :free_rooms, :integer, default: 0
    field :paid_rooms, :integer, default: 0
    field :updated_at, :utc_datetime
  end
end
