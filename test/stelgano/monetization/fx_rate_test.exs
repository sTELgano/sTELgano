# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Monetization.FxRateTest do
  @moduledoc """
  Tests for the FxRate GenServer.

  Callbacks (`init/1`, `handle_call/3`, `handle_info/2`) are exercised
  directly — no supervised process is started, so the tests stay
  deterministic and `async: true`.
  """

  use ExUnit.Case, async: true

  alias Stelgano.Monetization.FxRate

  defp drain_refresh_mailbox do
    receive do
      :refresh -> drain_refresh_mailbox()
    after
      0 -> :ok
    end
  end

  describe "init/1" do
    test "with :fallback seeds rate and marks source :fallback" do
      assert {:ok, state} =
               FxRate.init(base: "USD", quote: "KES", fallback: Decimal.new("129.5"))

      assert state.base == "usd"
      assert state.quote == "kes"
      assert Decimal.eq?(state.rate, Decimal.new("129.5"))
      assert state.source == :fallback
      drain_refresh_mailbox()
    end

    test "without :fallback starts with rate=nil and source=:none" do
      assert {:ok, state} = FxRate.init(base: "USD", quote: "KES")

      assert state.rate == nil
      assert state.source == :none
      drain_refresh_mailbox()
    end
  end

  describe "handle_call(:current)" do
    test "returns :unavailable when rate is nil" do
      state = %{base: "usd", quote: "kes", rate: nil, fetched_at: nil, source: :none}

      assert {:reply, {:error, :unavailable}, ^state} =
               FxRate.handle_call(:current, nil, state)
    end

    test "returns the cached Decimal rate" do
      rate = Decimal.new("130.25")
      state = %{base: "usd", quote: "kes", rate: rate, fetched_at: nil, source: :fallback}

      assert {:reply, {:ok, ^rate}, ^state} = FxRate.handle_call(:current, nil, state)
    end
  end

  describe "handle_info(:refresh)" do
    test "updates state with the fetched rate on 200 response" do
      Req.Test.stub(FxRate, fn conn ->
        assert String.ends_with?(conn.request_path, "/currencies/usd.json")
        Req.Test.json(conn, %{"usd" => %{"kes" => 129.5}})
      end)

      state = %{base: "usd", quote: "kes", rate: nil, fetched_at: nil, source: :none}

      assert {:noreply, new_state} = FxRate.handle_info(:refresh, state)
      assert Decimal.eq?(new_state.rate, Decimal.new("129.5"))
      assert new_state.source == :api
      assert %DateTime{} = new_state.fetched_at
      drain_refresh_mailbox()
    end

    test "keeps existing rate on transport error" do
      Req.Test.stub(FxRate, fn conn -> Req.Test.transport_error(conn, :econnrefused) end)

      seed = Decimal.new("100")
      state = %{base: "usd", quote: "kes", rate: seed, fetched_at: nil, source: :fallback}

      assert {:noreply, new_state} = FxRate.handle_info(:refresh, state)
      assert Decimal.eq?(new_state.rate, seed)
      assert new_state.source == :fallback
      drain_refresh_mailbox()
    end

    test "keeps existing rate when quote currency missing from payload" do
      Req.Test.stub(FxRate, fn conn ->
        Req.Test.json(conn, %{"usd" => %{"eur" => 0.9}})
      end)

      seed = Decimal.new("99")
      state = %{base: "usd", quote: "kes", rate: seed, fetched_at: nil, source: :fallback}

      assert {:noreply, new_state} = FxRate.handle_info(:refresh, state)
      assert Decimal.eq?(new_state.rate, seed)
      drain_refresh_mailbox()
    end
  end
end
