# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.PaymentCallbackHTML do
  @moduledoc """
  View module for the payment callback page.
  """

  use StelganoWeb, :html

  embed_templates "payment_callback_html/*"
end
