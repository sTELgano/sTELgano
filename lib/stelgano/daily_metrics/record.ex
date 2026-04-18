# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.DailyMetrics.Record do
  @moduledoc """
  Ecto schema for one row of the `daily_metrics` table — one per UTC
  calendar day, with four monotonic counters.
  """

  use Ecto.Schema

  @type t :: %__MODULE__{
          day: Date.t() | nil,
          free_new: integer() | nil,
          paid_new: integer() | nil,
          free_expired: integer() | nil,
          paid_expired: integer() | nil,
          updated_at: DateTime.t() | nil
        }

  @primary_key false
  schema "daily_metrics" do
    field :day, :date, primary_key: true
    field :free_new, :integer, default: 0
    field :paid_new, :integer, default: 0
    field :free_expired, :integer, default: 0
    field :paid_expired, :integer, default: 0
    field :updated_at, :utc_datetime
  end
end
