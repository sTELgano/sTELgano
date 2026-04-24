# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Monetization.ExtensionToken do
  @moduledoc """
  Ecto schema for the `extension_tokens` table.

  Represents a privacy-preserving payment token for extending room TTL.

  ## Privacy guarantee

  This schema intentionally has **no association to rooms**. There is no
  `room_id`, `room_hash`, or `access_hash` field. The server cannot link
  a payment to a specific room by inspecting this table.

  ## Lifecycle

      pending → paid → redeemed
                  ↘         ↘
                expired   expired
  """

  use Ecto.Schema
  import Ecto.Changeset

  @type t :: %__MODULE__{
          id: Ecto.UUID.t() | nil,
          token_hash: String.t() | nil,
          status: String.t(),
          amount_cents: integer(),
          currency: String.t(),
          provider_ref: String.t() | nil,
          paid_at: DateTime.t() | nil,
          redeemed_at: DateTime.t() | nil,
          expires_at: DateTime.t() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "extension_tokens" do
    field :token_hash, :string
    field :status, :string, default: "pending"
    field :amount_cents, :integer
    field :currency, :string, default: "USD"
    field :provider_ref, :string
    field :paid_at, :utc_datetime
    field :redeemed_at, :utc_datetime
    field :expires_at, :utc_datetime

    timestamps(type: :utc_datetime)
  end

  @doc "Changeset for creating a new pending token."
  @spec create_changeset(map()) :: Ecto.Changeset.t()
  def create_changeset(attrs) do
    %__MODULE__{}
    |> cast(attrs, [:token_hash, :amount_cents, :currency, :expires_at])
    |> validate_required([:token_hash, :amount_cents, :currency, :expires_at])
    |> validate_length(:token_hash, is: 64)
    |> validate_format(:token_hash, ~r/\A[0-9a-f]{64}\z/,
      message: "must be a lowercase hex SHA-256 digest"
    )
    |> validate_inclusion(:currency, ~w(USD KES NGN GHS ZAR EUR GBP))
    |> validate_number(:amount_cents, greater_than: 0)
    |> unique_constraint(:token_hash)
  end

  @doc "Changeset for marking a token as paid."
  @spec paid_changeset(t(), map()) :: Ecto.Changeset.t()
  def paid_changeset(%__MODULE__{} = token, attrs \\ %{}) do
    token
    |> cast(attrs, [:provider_ref])
    |> put_change(:status, "paid")
    |> put_change(:paid_at, DateTime.truncate(DateTime.utc_now(), :second))
  end

  @doc "Changeset for marking a token as redeemed."
  @spec redeemed_changeset(t()) :: Ecto.Changeset.t()
  def redeemed_changeset(%__MODULE__{} = token) do
    token
    |> change(status: "redeemed")
    |> put_change(:redeemed_at, DateTime.truncate(DateTime.utc_now(), :second))
  end
end
