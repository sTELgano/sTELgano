# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Jobs.ExpireUnredeemedTokens do
  @moduledoc """
  Oban job that expires extension tokens past their `expires_at` deadline.

  Handles two cases:
  - `pending` tokens that were never paid (abandoned payment flows).
  - `paid` tokens that were never redeemed (user paid but never activated).

  Runs daily. Tokens that are already `redeemed` or `expired` are untouched.

  ## Schedule

  Configured in `config/config.exs` as `{"0 3 * * *", Stelgano.Jobs.ExpireUnredeemedTokens}`.
  """

  use Oban.Worker, queue: :maintenance, max_attempts: 3

  alias Stelgano.Monetization

  require Logger

  @impl Oban.Worker
  def perform(%Oban.Job{}) do
    if Monetization.enabled?() do
      count = Monetization.expire_stale_tokens()
      Logger.info("ExpireUnredeemedTokens: expired #{count} token(s)")
    else
      Logger.debug("ExpireUnredeemedTokens: monetization disabled, skipping")
    end

    :ok
  end
end
