# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.CountryMetrics do
  @moduledoc """
  Aggregate counters for per-country room telemetry.

  ## Why this exists

  Self-hosted sTELgano operators want a crude read on "how is the product
  actually being used?" and "which countries are paying for dedicated
  numbers?" without shipping Google Analytics or any other third-party
  tracker — both because the CSP and the privacy stance forbid them, and
  because a page-view counter wouldn't answer the country question anyway.

  The naive alternative — adding a `country_code` column to the `rooms`
  or `extension_tokens` table — would hand a DB-dumper the answer to
  "which room is from Kenya?", undoing server-blindness for this axis.

  This module holds **one row per ISO-3166 alpha-2 country code** and
  **two monotonic counters** (`free_rooms`, `paid_rooms`). No row ever
  links to a specific `room_hash` or `token_hash`. You can answer
  "how many free-tier rooms exist from Kenya?" but never "which ones".

  ## Contract

  Both counters are **lifetime-cumulative**: `increment_free/1` bumps on
  every room creation, `increment_paid/1` bumps on every paid upgrade.
  Nothing decrements. That keeps the write path a single atomic SQL
  statement (no read-modify-write races) and matches how operators
  think about product adoption.

  ## Input normalisation

  `country_code` must be a 2-letter ISO-3166 alpha-2 string. It is
  uppercased on the way in. Invalid input is silently ignored (the
  increment is a no-op) — the channel caller has already validated
  far more sensitive fields; failing loudly here would only produce
  noisy telemetry for malformed client requests.
  """

  import Ecto.Query, warn: false

  alias Stelgano.CountryMetrics.Record
  alias Stelgano.Repo

  @type country_code :: String.t()

  @doc """
  Increments the `free_rooms` counter for the given ISO-3166 alpha-2
  country code. No-op on invalid input.
  """
  @spec increment_free(country_code()) :: :ok
  def increment_free(country_code), do: increment(:free_rooms, country_code)

  @doc """
  Increments the `paid_rooms` counter for the given ISO-3166 alpha-2
  country code. No-op on invalid input.
  """
  @spec increment_paid(country_code()) :: :ok
  def increment_paid(country_code), do: increment(:paid_rooms, country_code)

  @doc """
  Returns the full list of rows, sorted by `free_rooms + paid_rooms`
  descending. Each row is `%{country_code, free_rooms, paid_rooms}`.
  """
  @spec list() :: [%{country_code: String.t(), free_rooms: integer(), paid_rooms: integer()}]
  def list do
    Record
    |> select([r], %{
      country_code: r.country_code,
      free_rooms: r.free_rooms,
      paid_rooms: r.paid_rooms
    })
    |> Repo.all()
    |> Enum.sort_by(&(-(&1.free_rooms + &1.paid_rooms)))
  end

  @spec increment(atom(), country_code()) :: :ok
  defp increment(column, code) do
    with {:ok, normalised} <- normalise(code) do
      now = DateTime.truncate(DateTime.utc_now(), :second)

      row =
        Map.put(
          %{country_code: normalised, free_rooms: 0, paid_rooms: 0, updated_at: now},
          column,
          1
        )

      Repo.insert_all(
        Record,
        [row],
        on_conflict: [inc: [{column, 1}], set: [updated_at: now]],
        conflict_target: :country_code
      )
    end

    :ok
  end

  @spec normalise(term()) :: {:ok, String.t()} | :error
  defp normalise(code) when is_binary(code) do
    upcased = String.upcase(code)

    if String.match?(upcased, ~r/\A[A-Z]{2}\z/) do
      {:ok, upcased}
    else
      :error
    end
  end

  defp normalise(_other), do: :error
end
