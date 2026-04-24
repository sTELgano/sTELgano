# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.DailyMetrics do
  @moduledoc """
  Per-day global counters for operational telemetry.

  One row per calendar day (UTC), carrying four monotonic counters:

    * `free_new` — free-tier rooms created that day
    * `paid_new` — paid-tier upgrades that day
    * `free_expired` — free-tier rooms that TTL-expired that day
    * `paid_expired` — paid-tier rooms that TTL-expired that day

  ## Why no country dimension

  Expiry events fire from `Stelgano.Jobs.ExpireTtlRooms`, which does not
  know the country of each expiring room because `rooms` carries no
  `country_code`. Rather than making the "new" events per-country and
  the "expired" events global (asymmetric), all four counters are
  reported globally here. Country-scoped lifetime totals live in
  `Stelgano.CountryMetrics`.

  ## Intent

  A self-hosted operator gets a trend of product usage without shipping
  third-party analytics and without linking any DB row back to a
  specific room. A DB dump answers "how many rooms were created on
  2026-04-10?" but nothing more identifying.
  """

  import Ecto.Query, warn: false

  alias Stelgano.DailyMetrics.Record
  alias Stelgano.Repo

  @doc "Bumps today's `free_new` counter by 1."
  @spec increment_free_new() :: :ok
  def increment_free_new, do: bump(:free_new, 1)

  @doc "Bumps today's `paid_new` counter by 1."
  @spec increment_paid_new() :: :ok
  def increment_paid_new, do: bump(:paid_new, 1)

  @doc "Bumps today's `free_expired` counter by `count`."
  @spec increment_free_expired(non_neg_integer()) :: :ok
  def increment_free_expired(count \\ 1) when is_integer(count) and count >= 0,
    do: bump(:free_expired, count)

  @doc "Bumps today's `paid_expired` counter by `count`."
  @spec increment_paid_expired(non_neg_integer()) :: :ok
  def increment_paid_expired(count \\ 1) when is_integer(count) and count >= 0,
    do: bump(:paid_expired, count)

  @doc """
  Returns the last `days` rows, most-recent first. Missing days are NOT
  filled in — the admin UI can decide whether to zero-pad.
  """
  @spec list_recent(pos_integer()) :: [
          %{
            day: Date.t(),
            free_new: integer(),
            paid_new: integer(),
            free_expired: integer(),
            paid_expired: integer()
          }
        ]
  def list_recent(days \\ 30) when is_integer(days) and days > 0 do
    cutoff = Date.add(Date.utc_today(), -days + 1)

    Record
    |> where([r], r.day >= ^cutoff)
    |> order_by([r], desc: r.day)
    |> select([r], %{
      day: r.day,
      free_new: r.free_new,
      paid_new: r.paid_new,
      free_expired: r.free_expired,
      paid_expired: r.paid_expired
    })
    |> Repo.all()
  end

  @spec bump(atom(), non_neg_integer()) :: :ok
  defp bump(_column, 0), do: :ok

  defp bump(column, count) do
    today = Date.utc_today()
    now = DateTime.truncate(DateTime.utc_now(), :second)

    row =
      Map.put(
        %{
          day: today,
          free_new: 0,
          paid_new: 0,
          free_expired: 0,
          paid_expired: 0,
          updated_at: now
        },
        column,
        count
      )

    Repo.insert_all(
      Record,
      [row],
      on_conflict: [inc: [{column, count}], set: [updated_at: now]],
      conflict_target: :day
    )

    :ok
  end
end
