# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.PageHTML do
  use StelganoWeb, :html

  import StelganoWeb.Helpers.PriceFormatter, only: [format_price: 2]

  embed_templates "page_html/*"
end
