# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Repo.Migrations.CreateDailyMetrics do
  @moduledoc """
  Daily global counters for operational telemetry.

  Complements `country_metrics` (lifetime per-country totals) with a
  **per-day, global** view: how many free-tier rooms were created today,
  how many paid upgrades happened, how many rooms expired off each tier.

  ## Why no country dimension here

  The per-country dimension is deliberately **not** on this table. Expiry
  events fire from `ExpireTtlRooms` (an Oban job), which iterates rows
  in the `rooms` table. The rooms table has no `country_code` column and
  will never get one — storing country per room would undo the
  server-blindness invariant. The job therefore cannot bucket expiries by
  country. Rather than adding country only for creation events (asymmetric
  / confusing), this table reports all four daily counters globally.

  Country-scoped lifetime totals still live in `country_metrics` — sum
  them for a per-country view; use this table for a daily trend.
  """

  use Ecto.Migration

  def change do
    create table(:daily_metrics, primary_key: false) do
      add :day, :date, primary_key: true, null: false
      add :free_new, :integer, null: false, default: 0
      add :paid_new, :integer, null: false, default: 0
      add :free_expired, :integer, null: false, default: 0
      add :paid_expired, :integer, null: false, default: 0
      timestamps(type: :utc_datetime, inserted_at: false)
    end
  end
end
