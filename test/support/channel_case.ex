# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.ChannelCase do
  @moduledoc """
  Test case template for Phoenix Channel tests.

  Sets up the Phoenix.ChannelTest infrastructure and an Ecto sandbox.
  """

  use ExUnit.CaseTemplate

  using do
    quote do
      # Import channel testing helpers from `Phoenix.ChannelTest`
      use Phoenix.ChannelTest

      # The default endpoint for testing
      @endpoint StelganoWeb.Endpoint
    end
  end

  setup tags do
    Stelgano.DataCase.setup_sandbox(tags)
    :ok
  end
end
