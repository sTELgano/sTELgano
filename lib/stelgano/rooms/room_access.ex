# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Rooms.RoomAccess do
  @moduledoc """
  Ecto schema for the `room_access` table.

  Each row represents one user's access credential for a room.  A room can
  have at most two access records (one per party in the two-party channel).

  ## Security properties

  - `access_hash` = SHA-256(phone + ":" + PIN + ":" + ACCESS_SALT) —
    computed client-side; the PIN never reaches the server.
  - Brute-force protection: `failed_attempts` is incremented on every
    failed join attempt; `locked_until` is set after 10 failures.
  - The lockout is scoped to (room_hash, access_hash) — it does not affect
    the other party's access record.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @max_attempts 10
  @lockout_minutes 30

  @type t :: %__MODULE__{
          id: Ecto.UUID.t() | nil,
          room_hash: String.t() | nil,
          access_hash: String.t() | nil,
          failed_attempts: integer(),
          locked_until: DateTime.t() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "room_access" do
    field :room_hash, :string
    field :access_hash, :string
    field :failed_attempts, :integer, default: 0
    field :locked_until, :utc_datetime

    timestamps(type: :utc_datetime)
  end

  @doc "Maximum failed attempts before lockout."
  @spec max_attempts() :: integer()
  def max_attempts, do: @max_attempts

  @doc "Minutes the lockout lasts."
  @spec lockout_minutes() :: integer()
  def lockout_minutes, do: @lockout_minutes

  @doc """
  Changeset for creating a new access record.
  """
  @spec create_changeset(map()) :: Ecto.Changeset.t()
  def create_changeset(attrs) do
    %__MODULE__{}
    |> cast(attrs, [:room_hash, :access_hash])
    |> validate_required([:room_hash, :access_hash])
    |> validate_length(:room_hash, is: 64)
    |> validate_length(:access_hash, is: 64)
    |> validate_format(:room_hash, ~r/\A[0-9a-f]{64}\z/)
    |> validate_format(:access_hash, ~r/\A[0-9a-f]{64}\z/)
    |> unique_constraint([:room_hash, :access_hash])
  end

  @doc """
  Changeset to record a failed attempt and optionally apply a lockout.
  """
  @spec failed_attempt_changeset(t()) :: Ecto.Changeset.t()
  def failed_attempt_changeset(%__MODULE__{} = access) do
    new_count = access.failed_attempts + 1

    locked_until =
      if new_count >= @max_attempts do
        DateTime.add(DateTime.utc_now(), @lockout_minutes * 60, :second)
        |> DateTime.truncate(:second)
      else
        access.locked_until
      end

    access
    |> change(failed_attempts: new_count, locked_until: locked_until)
  end

  @doc """
  Changeset to reset the failed-attempt counter after a successful join.
  """
  @spec reset_attempts_changeset(t()) :: Ecto.Changeset.t()
  def reset_attempts_changeset(%__MODULE__{} = access) do
    change(access, failed_attempts: 0, locked_until: nil)
  end

  @doc """
  Returns `true` if the access record is currently locked out.
  """
  @spec locked?(t()) :: boolean()
  def locked?(%__MODULE__{locked_until: nil}), do: false

  def locked?(%__MODULE__{locked_until: locked_until}) do
    DateTime.compare(locked_until, DateTime.utc_now()) == :gt
  end
end
