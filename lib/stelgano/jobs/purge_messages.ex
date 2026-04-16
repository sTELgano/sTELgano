# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Jobs.PurgeMessages do
  @moduledoc """
  Oban job that hard-deletes soft-deleted messages older than 24 hours.

  Soft-deleted messages (`deleted_at IS NOT NULL`) are retained briefly so
  that in-flight channel broadcasts referencing their IDs can complete cleanly.
  After 24 hours they serve no purpose and are permanently removed.

  ## Schedule

  Runs daily at 03:00 UTC via the Oban cron configuration in `config.exs`.

  ## What it does

  Calls `Stelgano.Rooms.purge_deleted_messages/1` with a 24-hour cutoff.
  Logs the count of purged rows for server-side aggregate metrics.

  ## What it never does

  This job has no access to message plaintext — it only operates on rows
  where `deleted_at IS NOT NULL`. The ciphertext in those rows was never
  readable by the server.
  """

  use Oban.Worker, queue: :maintenance, max_attempts: 3

  alias Stelgano.Rooms

  require Logger

  @twenty_four_hours 86_400

  @impl Oban.Worker
  def perform(%Oban.Job{}) do
    count = Rooms.purge_deleted_messages(@twenty_four_hours)

    Logger.info("PurgeMessages: hard-deleted #{count} soft-deleted message(s)")

    :ok
  end
end
