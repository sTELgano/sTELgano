# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Repo.Migrations.CreateCountryMetrics do
  @moduledoc """
  Aggregate-counters-only table for per-country telemetry.

  ## Privacy model

  This table holds **one row per ISO-3166 alpha-2 country code** and
  **two monotonic counters** (`free_rooms_count`, `paid_rooms_count`).
  There is no per-room record; nothing in this table can be joined back
  to an individual `room_hash`, `token_hash`, or `phone`. A DB dump
  answers "how many rooms were created from Kenya?" but never "which
  rooms came from Kenya?".

  This is the privacy-preserving replacement for third-party analytics
  (Google Analytics, etc.) and for the naive alternative of adding a
  `country_code` column to the `rooms` or `extension_tokens` tables —
  both of which would leak per-room country metadata into a DB dump
  and undermine server-blindness.

  ## Schema

      country_code  varchar(2)  primary key   — ISO 3166-1 alpha-2, uppercase
      free_rooms    integer     not null, default 0
      paid_rooms    integer     not null, default 0
      updated_at    utc_datetime not null

  Both counters are lifetime-cumulative: they are incremented on create
  (free) and on paid-upgrade (paid), never decremented. Country codes
  are uppercased at insert time.
  """

  use Ecto.Migration

  def change do
    create table(:country_metrics, primary_key: false) do
      add :country_code, :string, size: 2, primary_key: true, null: false
      add :free_rooms, :integer, null: false, default: 0
      add :paid_rooms, :integer, null: false, default: 0
      timestamps(type: :utc_datetime, inserted_at: false)
    end
  end
end
