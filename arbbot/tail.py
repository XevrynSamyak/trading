import os


def tail_lines(path: str, max_lines: int, max_bytes: int = 64 * 1024) -> list[str]:
    """Last lines of a possibly large file, reading only its end."""
    if not os.path.exists(path):
        return []
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        f.seek(max(0, size - max_bytes))
        text = f.read().decode("utf-8", errors="replace")
    return [l for l in text.split("\n") if l][-max_lines:]
