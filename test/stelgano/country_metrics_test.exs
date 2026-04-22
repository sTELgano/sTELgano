# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.CountryMetricsTest do
  @moduledoc """
  Tests for the aggregate-counter CountryMetrics context.

  These tests assert the two invariants that make this feature
  privacy-preserving:

    * counters accumulate across calls (monotonic, never decrement)
    * invalid ISO codes are silently ignored (never produce a DB row)

  They also cover the input-normalisation contract (uppercase, exactly
  two letters).
  """

  use Stelgano.DataCase, async: true

  alias Stelgano.CountryMetrics

  describe "increment_free/1" do
    test "creates a row for a new country" do
      CountryMetrics.increment_free("KE")
      assert [%{country_code: "KE", free_rooms: 1, paid_rooms: 0}] = CountryMetrics.list()
    end

    test "increments an existing country monotonically" do
      Enum.each(1..3, fn _i -> CountryMetrics.increment_free("KE") end)
      assert [%{country_code: "KE", free_rooms: 3, paid_rooms: 0}] = CountryMetrics.list()
    end

    test "uppercases lowercase input" do
      CountryMetrics.increment_free("ke")
      assert [%{country_code: "KE", free_rooms: 1}] = CountryMetrics.list()
    end

    test "ignores invalid length" do
      CountryMetrics.increment_free("KEN")
      CountryMetrics.increment_free("K")
      CountryMetrics.increment_free("")
      assert [] = CountryMetrics.list()
    end

    test "ignores non-letter characters" do
      CountryMetrics.increment_free("K1")
      CountryMetrics.increment_free("--")
      assert [] = CountryMetrics.list()
    end

    test "ignores non-binary input" do
      CountryMetrics.increment_free(nil)
      CountryMetrics.increment_free(123)
      assert [] = CountryMetrics.list()
    end
  end

  describe "increment_paid/1" do
    test "creates a row with only paid_rooms incremented" do
      CountryMetrics.increment_paid("US")
      assert [%{country_code: "US", free_rooms: 0, paid_rooms: 1}] = CountryMetrics.list()
    end

    test "paid does not affect existing free counter" do
      CountryMetrics.increment_free("KE")
      CountryMetrics.increment_free("KE")
      CountryMetrics.increment_paid("KE")
      assert [%{country_code: "KE", free_rooms: 2, paid_rooms: 1}] = CountryMetrics.list()
    end
  end

  describe "list/0" do
    test "returns an empty list when no rows exist" do
      assert [] == CountryMetrics.list()
    end

    test "sorts by total count descending" do
      CountryMetrics.increment_free("KE")
      for _i <- 1..5, do: CountryMetrics.increment_free("US")
      for _i <- 1..2, do: CountryMetrics.increment_paid("GB")

      assert [
               %{country_code: "US", free_rooms: 5},
               %{country_code: "GB", paid_rooms: 2},
               %{country_code: "KE", free_rooms: 1}
             ] = CountryMetrics.list()
    end
  end

  describe "privacy invariant" do
    test "table schema carries no room or token identifiers" do
      # Belt-and-braces: confirm the actual DB columns don't include any
      # field that could link a country back to a specific room or token.
      alias Stelgano.CountryMetrics.Record
      fields = Record.__schema__(:fields)
      refute Enum.any?(fields, &(&1 in [:room_id, :room_hash, :token_hash, :sender_hash]))
    end
  end
end
