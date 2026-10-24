"""The shared HTTP client: every request (Jupiter, RPC, Jito, Telegram) gives up after 15 s."""

import httpx

HTTP_TIMEOUT_S = 15.0


def make_client(timeout_s: float = HTTP_TIMEOUT_S, transport=None) -> httpx.AsyncClient:
    # Without a timeout a hung connection would block the main loop for minutes.
    return httpx.AsyncClient(timeout=httpx.Timeout(timeout_s), transport=transport, follow_redirects=True)
