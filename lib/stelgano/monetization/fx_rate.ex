# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Monetization.FxRate do
  @moduledoc """
  Caches a single `base -> quote` exchange rate in memory.

  Used by payment-provider adapters whose merchant account settles in a
  currency other than the one shown to the user (e.g. show USD $5.00 in
  the UI, settle with Paystack in KES). The adapter calls `current/1`
  at payment-initialize time, applies a configurable safety buffer, and
  converts the amount before calling the provider.

  ## Boot + refresh

  On start, the process fetches the rate from Fawazahmed0's
  currency-api (a free, keyless, CDN-served dataset) and then refreshes
  every 24h. If the boot fetch fails, the `:fallback` option seeds the
  rate so payments still work — the operator controls this via
  `PAYMENT_FX_FALLBACK_RATE`.

  ## Privacy

  The only outbound call is a public, static JSON file on a CDN. No
  user data leaves the server — only `GET /currencies/<base>.json`.

  ## Supervision

  This process is started conditionally from `Stelgano.Application` via
  the provider's `child_specs/0`. When the display currency already
  matches the provider's settlement currency, the process is not
  started at all.
  """

  use GenServer
  require Logger

  @refresh_ms 24 * 60 * 60 * 1_000
  @api_base "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies"

  @type state :: %{
          base: String.t(),
          quote: String.t(),
          rate: Decimal.t() | nil,
          fetched_at: DateTime.t() | nil,
          source: :api | :fallback | :none
        }

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  @doc """
  Starts the process.

  ## Options
    * `:base` — ISO 4217 code of the display currency (required)
    * `:quote` — ISO 4217 code of the settlement currency (required)
    * `:fallback` — `Decimal.t()` used if the boot fetch fails (optional)
    * `:autofetch` — whether `init/1` triggers a refresh on boot. Default
      `true`. Set to `false` in tests to keep state deterministic.
    * `:name` — registered name (default: `#{inspect(__MODULE__)}`)
  """
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc """
  Returns the currently cached rate as `Decimal`, or `{:error, :unavailable}`
  if neither the API fetch nor the fallback has produced one.
  """
  @spec current(GenServer.server()) :: {:ok, Decimal.t()} | {:error, :unavailable}
  def current(server \\ __MODULE__) do
    GenServer.call(server, :current)
  end

  @doc "Forces an immediate refresh from the API."
  @spec refresh(GenServer.server()) :: :ok
  def refresh(server \\ __MODULE__) do
    GenServer.cast(server, :refresh)
  end

  # ---------------------------------------------------------------------------
  # GenServer callbacks
  # ---------------------------------------------------------------------------

  @impl GenServer
  def init(opts) do
    base = opts |> Keyword.fetch!(:base) |> String.downcase()
    quote_ = opts |> Keyword.fetch!(:quote) |> String.downcase()
    fallback = Keyword.get(opts, :fallback)

    state = %{
      base: base,
      quote: quote_,
      rate: fallback,
      fetched_at: nil,
      source: if(fallback, do: :fallback, else: :none)
    }

    if Keyword.get(opts, :autofetch, true) do
      # Trigger the boot fetch asynchronously so init/1 returns quickly.
      send(self(), :refresh)
      schedule_refresh()
    end

    {:ok, state}
  end

  @impl GenServer
  def handle_call(:current, _from, %{rate: nil} = state) do
    {:reply, {:error, :unavailable}, state}
  end

  def handle_call(:current, _from, %{rate: rate} = state) do
    {:reply, {:ok, rate}, state}
  end

  @impl GenServer
  def handle_cast(:refresh, state), do: {:noreply, fetch_and_update(state)}

  @impl GenServer
  def handle_info(:refresh, state) do
    schedule_refresh()
    {:noreply, fetch_and_update(state)}
  end

  # ---------------------------------------------------------------------------
  # Private
  # ---------------------------------------------------------------------------

  defp schedule_refresh do
    Process.send_after(self(), :refresh, @refresh_ms)
  end

  defp fetch_and_update(%{base: base, quote: quote_} = state) do
    case fetch_rate(base, quote_) do
      {:ok, rate} ->
        Logger.info("FxRate: refreshed #{String.upcase(base)}->#{String.upcase(quote_)}=#{rate}")
        %{state | rate: rate, fetched_at: DateTime.utc_now(), source: :api}

      {:error, reason} ->
        Logger.warning(
          "FxRate: refresh failed (#{inspect(reason)}); keeping rate=#{inspect(state.rate)} source=#{state.source}"
        )

        state
    end
  end

  defp fetch_rate(base, quote_) do
    url = "#{@api_base}/#{base}.json"
    req = build_req()

    case Req.get(req, url: url) do
      {:ok, %{status: 200, body: body}} ->
        extract_rate(body, base, quote_)

      {:ok, %{status: status}} ->
        {:error, {:http, status}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp extract_rate(body, base, quote_) do
    with %{^base => %{^quote_ => raw}} <- body,
         {:ok, decimal} <- to_decimal(raw) do
      {:ok, decimal}
    else
      _other -> {:error, :quote_not_found}
    end
  end

  defp to_decimal(value) when is_float(value) do
    # Round via string to preserve precision with the 8-decimal DB shape.
    {:ok, value |> Float.to_string() |> Decimal.new()}
  end

  defp to_decimal(value) when is_integer(value), do: {:ok, Decimal.new(value)}
  defp to_decimal(value) when is_binary(value), do: {:ok, Decimal.new(value)}
  defp to_decimal(_other), do: :error

  defp build_req do
    req = Req.new(retry: :transient)

    if Application.get_env(:stelgano, :req_test_enabled, false) do
      Req.merge(req, plug: {Req.Test, __MODULE__}, retry: false)
    else
      req
    end
  end
end
