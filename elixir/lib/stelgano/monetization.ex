# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Monetization do
  @moduledoc """
  Monetization configuration and token redemption logic.

  ## Design

  Monetization is fully optional. When `enabled: false` (the default),
  rooms have unlimited TTL and no payment infrastructure is loaded.
  Self-hosters can run sTELgano without monetization by leaving the
  default config unchanged.

  When enabled, steg numbers (rooms) have a configurable free TTL
  (default 7 days). Users can purchase an extension token to extend
  their room to a paid TTL (default 365 days).

  ## Privacy guarantee

  The `extension_tokens` table has **no room_id or room_hash column**.
  The payment provider knows only that someone paid — not which room
  the payment is for. The correlation between token and room exists
  only ephemerally in memory during the channel redemption event.

  ## Payment providers

  The payment provider is configurable via the `:provider` key.
  Implement the `Stelgano.Monetization.PaymentProvider` behaviour
  to add support for new payment gateways.
  """

  import Ecto.Query, warn: false

  alias Stelgano.Monetization.ExtensionToken
  alias Stelgano.Repo
  alias Stelgano.Rooms.Room

  # ---------------------------------------------------------------------------
  # Configuration accessors
  # ---------------------------------------------------------------------------

  @doc "Returns `true` if monetization is enabled."
  @spec enabled?() :: boolean()
  def enabled? do
    config(:enabled, false)
  end

  @doc "Free tier TTL in days."
  @spec free_ttl_days() :: pos_integer() | :unlimited
  def free_ttl_days do
    config(:free_ttl_days, 7)
  end

  @doc "Paid tier TTL in days."
  @spec paid_ttl_days() :: pos_integer()
  def paid_ttl_days do
    config(:paid_ttl_days, 365)
  end

  @doc "Price in the smallest currency unit (e.g. cents)."
  @spec price_cents() :: pos_integer()
  def price_cents do
    config(:price_cents, 200)
  end

  @doc "ISO 4217 currency code."
  @spec currency() :: String.t()
  def currency do
    config(:currency, "USD")
  end

  @doc "The configured payment provider module."
  @spec provider() :: module() | nil
  def provider do
    config(:provider, nil)
  end

  # ---------------------------------------------------------------------------
  # Token lifecycle
  # ---------------------------------------------------------------------------

  @doc """
  Creates a pending extension token.

  The `token_hash` is a SHA-256 hex digest of a client-generated random
  secret. The client holds the secret; we store only the hash.

  Returns `{:ok, token}` or `{:error, changeset}`.
  """
  @spec create_token(String.t()) :: {:ok, ExtensionToken.t()} | {:error, Ecto.Changeset.t()}
  def create_token(token_hash) when is_binary(token_hash) do
    # Tokens expire if not redeemed within 30 days
    expires_at = DateTime.add(DateTime.utc_now(), 30 * 86_400, :second)

    %{
      token_hash: token_hash,
      amount_cents: price_cents(),
      currency: currency(),
      expires_at: DateTime.truncate(expires_at, :second)
    }
    |> ExtensionToken.create_changeset()
    |> Repo.insert()
  end

  @doc """
  Marks a token as paid. Called by the webhook controller after payment
  provider verification succeeds.

  Uses optimistic locking (`WHERE status = 'pending'`) to prevent
  double-processing of duplicate webhooks.
  """
  @spec mark_paid(String.t(), String.t() | nil) ::
          {:ok, ExtensionToken.t()} | {:error, :not_found | :already_processed}
  def mark_paid(token_hash, provider_ref \\ nil) do
    case Repo.get_by(ExtensionToken, token_hash: token_hash, status: "pending") do
      nil ->
        # Could be already paid (idempotent) or genuinely missing
        case Repo.get_by(ExtensionToken, token_hash: token_hash) do
          %ExtensionToken{status: "paid"} -> {:error, :already_processed}
          _other -> {:error, :not_found}
        end

      %ExtensionToken{} = token ->
        token
        |> ExtensionToken.paid_changeset(%{provider_ref: provider_ref})
        |> Repo.update()
    end
  end

  @doc """
  Redeems a paid token and extends a room's TTL.

  The `extension_secret` is hashed to find the matching token. The room
  is identified by `room_id` from the channel socket assigns — **not**
  stored in the token table.

  ## Temporal-correlation mitigation

  A naive implementation would update the token and the room inside a
  single transaction with identical `updated_at` timestamps. A server
  operator cross-referencing webhook logs, token timestamps, and room
  timestamps could re-establish the payment→room linkage that the
  schema's lack of `room_id` on the token is supposed to prevent.

  Mitigations applied here:

    1. Token and room updates run in **separate transactions**.
    2. A random jitter (0 – `:redeem_token_jitter_ms`, default 5000ms)
       sleeps between them, so the two `updated_at` timestamps do not
       align on millisecond boundaries.
    3. `ttl_expires_at` is rounded to the nearest hour, so the computed
       expiry does not encode the exact redemption moment.

  This raises the cost of correlation — it does **not** eliminate it
  against a determined server operator with DB + log access. See
  [docs/security](../../lib/stelgano_web/controllers/page_html/security.html.heex)
  for the product's explicit stance on this threat.

  Returns `{:ok, new_ttl_expires_at}` or `{:error, reason}`.
  """
  @spec redeem_token(String.t(), Ecto.UUID.t()) ::
          {:ok, DateTime.t()} | {:error, atom()}
  def redeem_token(extension_secret, room_id)
      when is_binary(extension_secret) and is_binary(room_id) do
    token_hash = hash_secret(extension_secret)

    with {:ok, _token} <- mark_token_redeemed(token_hash) do
      jitter_sleep()
      extend_room_ttl(room_id)
    end
  end

  @spec mark_token_redeemed(String.t()) ::
          {:ok, ExtensionToken.t()} | {:error, :invalid_token}
  defp mark_token_redeemed(token_hash) do
    case Repo.get_by(ExtensionToken, token_hash: token_hash, status: "paid") do
      nil ->
        {:error, :invalid_token}

      %ExtensionToken{} = token ->
        {:ok, token |> ExtensionToken.redeemed_changeset() |> Repo.update!()}
    end
  end

  @spec extend_room_ttl(Ecto.UUID.t()) :: {:ok, DateTime.t()}
  defp extend_room_ttl(room_id) do
    new_ttl =
      DateTime.utc_now()
      |> DateTime.add(paid_ttl_days() * 86_400, :second)
      |> round_to_hour()

    room = Repo.get!(Room, room_id)

    room
    |> Ecto.Changeset.change(ttl_expires_at: new_ttl, tier: "paid")
    |> Repo.update!()

    {:ok, new_ttl}
  end

  # Rounds a DateTime down to the top of its hour so the exact redemption
  # moment is not encoded in `ttl_expires_at`.
  @spec round_to_hour(DateTime.t()) :: DateTime.t()
  defp round_to_hour(dt) do
    dt
    |> DateTime.truncate(:second)
    |> Map.put(:minute, 0)
    |> Map.put(:second, 0)
  end

  # Sleeps a uniform random number of ms in `[0, :redeem_token_jitter_ms]`
  # between the token and room updates, de-aligning their `updated_at`
  # timestamps. Test env sets jitter to 0 to keep the suite fast.
  @spec jitter_sleep() :: :ok
  defp jitter_sleep do
    case Application.get_env(:stelgano, :redeem_token_jitter_ms, 5_000) do
      0 ->
        :ok

      max_ms when is_integer(max_ms) and max_ms > 0 ->
        Process.sleep(:rand.uniform(max_ms + 1) - 1)
    end
  end

  @doc """
  Initializes a payment with the configured provider.

  Returns `{:ok, checkout_url}` or `{:error, reason}`.
  """
  @spec initialize_payment(String.t()) ::
          {:ok, String.t()} | {:error, term()}
  def initialize_payment(token_hash) when is_binary(token_hash) do
    provider = provider()

    if is_nil(provider) do
      {:error, :no_provider_configured}
    else
      provider.initialize(token_hash, price_cents(), currency())
    end
  end

  @doc """
  Expires unredeemed tokens that have passed their `expires_at` deadline.
  Called by the `ExpireUnredeemedTokens` Oban job.

  Returns the count of expired tokens.
  """
  @spec expire_stale_tokens() :: non_neg_integer()
  def expire_stale_tokens do
    now = DateTime.utc_now()

    {count, _nil} =
      ExtensionToken
      |> where([t], t.status in ["pending", "paid"] and t.expires_at <= ^now)
      |> Repo.update_all(set: [status: "expired", updated_at: now])

    count
  end

  @doc """
  Computes the default TTL for a newly created room.

  Returns a `DateTime` when monetization is enabled, or `nil` when disabled
  (meaning unlimited TTL).
  """
  @spec default_ttl() :: DateTime.t() | nil
  def default_ttl do
    if enabled?() do
      DateTime.utc_now()
      |> DateTime.add(free_ttl_days() * 86_400, :second)
      |> DateTime.truncate(:second)
    else
      nil
    end
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  @spec hash_secret(String.t()) :: String.t()
  defp hash_secret(secret) do
    secret
    |> then(&:crypto.hash(:sha256, &1))
    |> Base.encode16(case: :lower)
  end

  @spec config(atom(), term()) :: term()
  defp config(key, default) do
    :stelgano
    |> Application.get_env(__MODULE__, [])
    |> Keyword.get(key, default)
  end
end
