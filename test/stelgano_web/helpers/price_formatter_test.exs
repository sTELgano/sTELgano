# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.Helpers.PriceFormatterTest do
  @moduledoc "Tests for the PriceFormatter helper."

  use ExUnit.Case, async: true

  alias StelganoWeb.Helpers.PriceFormatter

  describe "format_price/2" do
    test "formats USD cents" do
      assert PriceFormatter.format_price(200, "USD") == "$2.00"
      assert PriceFormatter.format_price(999, "USD") == "$9.99"
      assert PriceFormatter.format_price(50, "USD") == "$0.50"
    end

    test "formats EUR cents" do
      assert PriceFormatter.format_price(200, "EUR") == "€2.00"
    end

    test "formats GBP pence" do
      assert PriceFormatter.format_price(500, "GBP") == "£5.00"
    end

    test "formats KES cents" do
      assert PriceFormatter.format_price(20_000, "KES") == "KSh 200.00"
    end

    test "formats NGN kobo" do
      assert PriceFormatter.format_price(100_000, "NGN") == "₦1000.00"
    end

    test "formats GHS pesewas" do
      assert PriceFormatter.format_price(1500, "GHS") == "GH₵15.00"
    end

    test "formats ZAR cents" do
      assert PriceFormatter.format_price(3500, "ZAR") == "R35.00"
    end

    test "formats unknown currency with code prefix" do
      assert PriceFormatter.format_price(200, "JPY") == "JPY 2.00"
    end

    test "pads minor units with leading zero" do
      assert PriceFormatter.format_price(105, "USD") == "$1.05"
      assert PriceFormatter.format_price(1, "USD") == "$0.01"
    end
  end
end
