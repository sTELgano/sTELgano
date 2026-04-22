# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Repo.Migrations.CreateRateLimitStorage do
  @moduledoc """
  Creates the ETS-backed rate limit storage used by PlugAttack.

  PlugAttack defaults to an ETS table (in-memory) so no DB table is needed
  for basic rate limiting. This migration is a placeholder that documents
  the decision and provides a hook for switching to a DB-backed store
  (e.g. for multi-node deployments on Fly.io with multiple instances).

  For single-node deployments, ETS is sufficient.
  For multi-node, consider Redis-backed rate limiting via Hammer + Redix.
  """

  use Ecto.Migration

  def change do
    # No DB schema needed for ETS-backed rate limiting.
    # This migration intentionally empty — serves as a decision record.
    :ok
  end
end
