# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.PaymentCallbackController do
  @moduledoc """
  Handles the redirect from the payment provider after checkout.

  Displays a simple confirmation page telling the user to return to
  their chat to activate the extension. No sensitive data is displayed.
  """

  use StelganoWeb, :controller

  alias Stelgano.Monetization

  @spec show(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def show(conn, %{"reference" => _reference}) do
    if Monetization.enabled?() do
      render(conn, :show, paid_ttl_days: Monetization.paid_ttl_days())
    else
      redirect(conn, to: ~p"/")
    end
  end

  def show(conn, _params) do
    redirect(conn, to: ~p"/")
  end
end
