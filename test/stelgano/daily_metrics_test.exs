# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.DailyMetricsTest do
  @moduledoc """
  Tests for the per-day global DailyMetrics counters.

  Asserts the three invariants:

    * counters accumulate across calls (monotonic)
    * increments with `count == 0` are no-ops (no empty row created)
    * `list_recent/1` returns the last N days in descending order
  """

  use Stelgano.DataCase, async: true

  alias Stelgano.DailyMetrics

  describe "increment_free_new/0" do
    test "creates a row for today and bumps by 1" do
      DailyMetrics.increment_free_new()
      assert [%{free_new: 1}] = DailyMetrics.list_recent(1)
    end

    test "accumulates across calls" do
      Enum.each(1..4, fn _i -> DailyMetrics.increment_free_new() end)
      assert [%{free_new: 4}] = DailyMetrics.list_recent(1)
    end
  end

  describe "increment_paid_new/0" do
    test "bumps paid_new independently" do
      DailyMetrics.increment_free_new()
      DailyMetrics.increment_paid_new()
      DailyMetrics.increment_paid_new()
      assert [%{free_new: 1, paid_new: 2}] = DailyMetrics.list_recent(1)
    end
  end

  describe "increment_*_expired/1" do
    test "accepts a count and no-ops on zero" do
      DailyMetrics.increment_free_expired(3)
      DailyMetrics.increment_paid_expired(0)
      assert [%{free_expired: 3, paid_expired: 0}] = DailyMetrics.list_recent(1)
    end

    test "no row is created when all bumps are zero" do
      DailyMetrics.increment_free_expired(0)
      DailyMetrics.increment_paid_expired(0)
      assert [] = DailyMetrics.list_recent(1)
    end
  end

  describe "list_recent/1" do
    test "returns an empty list when nothing has been written" do
      assert [] == DailyMetrics.list_recent(30)
    end

    test "returns most-recent first" do
      DailyMetrics.increment_free_new()
      assert [%{day: today}] = DailyMetrics.list_recent(7)
      assert today == Date.utc_today()
    end
  end

  describe "privacy invariant" do
    test "schema has no country or room-linking columns" do
      alias Stelgano.DailyMetrics.Record
      fields = Record.__schema__(:fields)
      refute Enum.any?(fields, &(&1 in [:country_code, :room_id, :room_hash, :token_hash]))
    end
  end
end
