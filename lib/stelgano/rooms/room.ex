# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Rooms.Room do
  @moduledoc """
  Ecto schema for the `rooms` table.

  A room is identified by its `room_hash` — a SHA-256 hex digest of the
  normalised phone number concatenated with the ROOM_SALT.  The phone number
  itself never reaches the server.

  ## Fields

  - `id` — server-generated UUID; returned to authenticated clients as the
    stable room identifier used in PBKDF2 key derivation.
  - `room_hash` — 64-character hex string; the only identifier the server
    receives from the client.  Unique and indexed.
  - `is_active` — soft-disable flag; set to `false` when a room is expired.
  - `ttl_expires_at` — optional wall-clock expiry; `nil` means no expiry.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @type t :: %__MODULE__{
          id: Ecto.UUID.t() | nil,
          room_hash: String.t() | nil,
          is_active: boolean(),
          tier: String.t(),
          ttl_expires_at: DateTime.t() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "rooms" do
    field :room_hash, :string
    field :is_active, :boolean, default: true
    field :tier, :string, default: "free"
    field :ttl_expires_at, :utc_datetime

    has_many :messages, Stelgano.Rooms.Message

    timestamps(type: :utc_datetime)
  end

  @doc """
  Changeset for creating a new room.

  Only `room_hash` is required; `ttl_expires_at` is optional.
  `is_active` defaults to `true` via the schema default.
  """
  @spec create_changeset(map()) :: Ecto.Changeset.t()
  def create_changeset(attrs) do
    %__MODULE__{}
    |> cast(attrs, [:room_hash, :ttl_expires_at, :tier])
    |> validate_required([:room_hash])
    |> validate_inclusion(:tier, ~w(free paid))
    |> validate_length(:room_hash, is: 64)
    |> validate_format(:room_hash, ~r/\A[0-9a-f]{64}\z/,
      message: "must be a lowercase hex SHA-256 digest"
    )
    |> unique_constraint(:room_hash)
  end

  @doc """
  Changeset for expiring a room — sets `is_active` to `false`.
  """
  @spec expire_changeset(t()) :: Ecto.Changeset.t()
  def expire_changeset(%__MODULE__{} = room) do
    change(room, is_active: false)
  end
end
