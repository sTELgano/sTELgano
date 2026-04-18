# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Rooms.Message do
  @moduledoc """
  Ecto schema for the `messages` table.

  The server stores only opaque binary blobs:
  - `ciphertext` — AES-256-GCM encrypted plaintext (server is blind)
  - `iv` — 96-bit GCM nonce (must be unique per message; generated client-side)
  - `sender_hash` — identifies the sender's side for bubble rendering without
    linking to a real identity

  ## N=1 invariant

  At most one non-deleted message exists per room at any time.  This is
  enforced atomically in `Stelgano.Rooms` via database transactions.

  ## Immediate hard delete

  When a reply arrives, the previous message is hard-deleted from the database
  in the same transaction that inserts the new message. No soft-delete, no
  deferred purge — the old row is gone immediately. This maximises privacy by
  ensuring discarded messages spend zero time on disk after replacement.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @type t :: %__MODULE__{
          id: Ecto.UUID.t() | nil,
          room_id: Ecto.UUID.t() | nil,
          sender_hash: String.t() | nil,
          ciphertext: binary() | nil,
          iv: binary() | nil,
          read_at: DateTime.t() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "messages" do
    field :sender_hash, :string
    field :ciphertext, :binary
    field :iv, :binary
    field :read_at, :utc_datetime

    belongs_to :room, Stelgano.Rooms.Room

    timestamps(type: :utc_datetime)
  end

  @doc """
  Changeset for creating a new message.

  `room_id` must be set programmatically (never from user input).
  `sender_hash`, `ciphertext`, and `iv` are required.
  """
  @spec create_changeset(map()) :: Ecto.Changeset.t()
  def create_changeset(attrs) do
    %__MODULE__{}
    |> cast(attrs, [:sender_hash, :ciphertext, :iv])
    |> validate_required([:sender_hash, :ciphertext, :iv])
    |> validate_length(:sender_hash, is: 64)
    |> validate_format(:sender_hash, ~r/\A[0-9a-f]{64}\z/)
    # IV must be exactly 12 bytes (96 bits) for AES-GCM
    |> validate_iv_length()
    # DB-level N=1 enforcement: translate the unique-index race into a
    # changeset error rather than an Ecto.ConstraintError exception.
    |> unique_constraint(:room_id, name: :messages_room_id_index)
  end

  @doc """
  Changeset to mark a message as read.
  """
  @spec mark_read_changeset(t()) :: Ecto.Changeset.t()
  def mark_read_changeset(%__MODULE__{} = message) do
    change(message, read_at: DateTime.truncate(DateTime.utc_now(), :second))
  end

  @doc """
  Changeset for editing a message (replace ciphertext + iv before read).
  """
  @spec edit_changeset(t(), map()) :: Ecto.Changeset.t()
  def edit_changeset(%__MODULE__{} = message, attrs) do
    message
    |> cast(attrs, [:ciphertext, :iv])
    |> validate_required([:ciphertext, :iv])
    |> validate_iv_length()
  end

  # Validates that the IV is exactly 12 bytes (96 bits) for AES-256-GCM.
  @spec validate_iv_length(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp validate_iv_length(changeset) do
    validate_change(changeset, :iv, fn :iv, iv ->
      if byte_size(iv) == 12 do
        []
      else
        [iv: "must be exactly 12 bytes (96-bit AES-GCM nonce)"]
      end
    end)
  end
end
