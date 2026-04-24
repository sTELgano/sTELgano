# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.Helpers.PriceFormatter do
  @moduledoc """
  Formats prices from smallest currency unit (cents) to display strings.

  Used by pricing pages, steg number generator, and chat plan selection.
  """

  @doc "Formats a price in cents to a display string with currency symbol."
  @spec format_price(integer(), String.t()) :: String.t()
  def format_price(cents, currency) do
    major = div(cents, 100)
    minor = rem(cents, 100)

    symbol =
      case currency do
        "USD" -> "$"
        "EUR" -> "€"
        "GBP" -> "£"
        "KES" -> "KSh "
        "NGN" -> "₦"
        "GHS" -> "GH₵"
        "ZAR" -> "R"
        _other -> "#{currency} "
      end

    "#{symbol}#{major}.#{String.pad_leading(Integer.to_string(minor), 2, "0")}"
  end
end
