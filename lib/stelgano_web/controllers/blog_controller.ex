# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.BlogController do
  @moduledoc "Handles the blog index and individual blog post pages."

  use StelganoWeb, :controller

  @posts [
    %{
      slug: "why-your-privacy-app-shouldnt-look-like-one",
      title: "Why Your Privacy App Shouldn't Look Like a Privacy App",
      summary:
        "The best hiding place is one nobody thinks to look. We explain the philosophy behind contact-layer steganography and why discretion beats overt encryption.",
      date: "2026-04-14",
      category: "Philosophy",
      reading_time: "6 min read"
    },
    %{
      slug: "understanding-contact-layer-steganography",
      title: "Understanding Contact-Layer Steganography",
      summary:
        "A deep dive into the cryptographic technique that hides encrypted communication channels inside ordinary phone contacts.",
      date: "2026-04-10",
      category: "Technical",
      reading_time: "8 min read"
    },
    %{
      slug: "the-n1-principle",
      title: "The N=1 Principle: Why We Only Keep One Message",
      summary:
        "Most messengers hoard your history forever. sTELgano keeps exactly one message per room at any time. Here's why that's a feature, not a limitation.",
      date: "2026-04-06",
      category: "Design",
      reading_time: "5 min read"
    },
    %{
      slug: "client-side-encryption-your-browser-is-the-vault",
      title: "Client-Side Encryption: Your Browser Is the Vault",
      summary:
        "How the Web Crypto API turns your browser into a zero-knowledge encryption engine, and why the server never sees your plaintext.",
      date: "2026-04-02",
      category: "Technical",
      reading_time: "7 min read"
    },
    %{
      slug: "what-stelgano-protects-against",
      title: "What sTELgano Protects Against (And What It Doesn't)",
      summary:
        "An honest look at our threat model. We tell you exactly who we defend against and where our protection ends.",
      date: "2026-03-28",
      category: "Security",
      reading_time: "6 min read"
    },
    %{
      slug: "the-passcode-test",
      title: "The Passcode Test: How We Design Every Feature",
      summary:
        "Every design decision at sTELgano must pass one question: what does a suspicious partner see when they unlock your phone?",
      date: "2026-03-24",
      category: "Design",
      reading_time: "5 min read"
    },
    %{
      slug: "why-elixir-and-phoenix",
      title: "Why We Chose Elixir and Phoenix for Real-Time Privacy",
      summary:
        "The technical reasons behind our choice of Elixir, Phoenix Channels, and the BEAM VM for building a privacy-first messaging platform.",
      date: "2026-03-20",
      category: "Engineering",
      reading_time: "7 min read"
    },
    %{
      slug: "pbkdf2-and-600000-iterations",
      title: "PBKDF2 and 600,000 Iterations: Slowing Down Attackers",
      summary:
        "Why we make your browser work hard for two seconds every time you log in, and how key stretching protects your PIN from brute force.",
      date: "2026-03-16",
      category: "Cryptography",
      reading_time: "6 min read"
    },
    %{
      slug: "open-source-privacy-why-agpl-matters",
      title: "Open Source Privacy: Why AGPL-3.0 Matters",
      summary:
        "Privacy software you can't audit is privacy software you can't trust. We explain why AGPL-3.0 is the right licence for a security tool.",
      date: "2026-03-12",
      category: "Open Source",
      reading_time: "5 min read"
    },
    %{
      slug: "self-hosting-stelgano",
      title: "Self-Hosting sTELgano: Your Server, Your Rules",
      summary:
        "A practical guide to running your own sTELgano instance. Full control over your infrastructure, your data, and your trust boundary.",
      date: "2026-03-08",
      category: "Guide",
      reading_time: "9 min read"
    }
  ]

  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _params) do
    render(conn, :index, page_title: "Blog — sTELgano", posts: @posts)
  end

  @spec show(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def show(conn, %{"slug" => slug}) do
    case Enum.find(@posts, &(&1.slug == slug)) do
      nil ->
        conn
        |> put_status(:not_found)
        |> put_view(StelganoWeb.ErrorHTML)
        |> render(:"404")

      post ->
        template =
          slug
          |> String.replace("-", "_")
          |> String.to_existing_atom()

        render(conn, template,
          page_title: "#{post.title} — sTELgano",
          post: post
        )
    end
  end
end
